/* 端点路由层：把 `kb/server.py` 的 `/api/*` 整个搬到浏览器里。
 *
 * ## 为什么要有这一层
 *
 * 发布版要满足一个硬约束：**`kb/web/index.html` 一行都不改**。
 * 那份前端是本地版与线上版共用的唯一事实来源 —— 一旦为了上线去 fork 一份，
 * 两边的界面就会各自演化，改了这边忘那边，而且没人会发现。
 *
 * 前端与后端之间只有一种耦合：`fetch("/api/xxx")` 加一个 JSON 形状的响应。
 * 所以这里把这套耦合在浏览器里**原样重建**：拦下 `/api/*` 的请求，
 * 就地用已移植到 JS 的引擎算出同一份响应体。前端察觉不到区别。
 *
 * ## 这一层做什么、不做什么
 *
 * 做：路由、请求体归一化、响应序列化（对应 server.py 的 `_serialize` 与
 * `explain`）、会话池、反馈落盘（改成 localStorage）。
 * 不做：任何业务计算。计算全在已对拍过的引擎模块里（ask / profile / resume …），
 * 这一层**只搬运**。唯一一处自己算的是 `stats()` 的几条 count —— 那本来就是
 * 一次 SQL，没有口径可言。
 *
 * ## 与本地版的四处刻意分歧
 *
 * 这四处**必须**不一样，不是没对齐，是浏览器里做不到/不该那样做。集中记在这里，
 * 免得日后有人当成 bug 去「修」：
 *
 *  ① **key 的来源**：本地读 `config.json`，线上读 localStorage（`llm.js` 的
 *     `STORAGE_KEY`）。连带给用户的提示语也换了 —— 线上说「点右上角设置」，
 *     说「改 config.json」是错的。
 *  ② **反馈落地**：本地写 `data/clean/feedback.json`，线上写 localStorage。
 *     另外线上还把「确认正确」的 SQL 沉淀进样例库（同一个 `JDExamples`），
 *     那份沉淀只在自己浏览器里生效 —— 所以线上每个人有一套自己的 few-shot。
 *  ③ **缓存**：本地有磁盘缓存（带知识库指纹失效），线上是内存 Map，
 *     关掉标签页即消失。所以 `stats().cache` 只报内存条数。
 *  ④ **会话池**：本地是进程内存、上限 200；线上是页面内存、同样上限 200，
 *     但刷新页面就全没了（`sid` 由前端存在内存变量里，本来也活不过刷新）。
 *
 * ## 第五处「分歧」，其实是我们选择**不**复刻一个瑕疵
 *
 * Python 的 `_payload()` 把年限做了 `float()`，所以本地版画像里那句门槛文案是
 * 「你填的是 **3.0** 年」；线上这里是 `Number()`，输出「你填的是 **3** 年」。
 *
 * 这一处**不打算对齐**，理由是：`3.0 年` 是 `float()` 带出来的瑕疵，不是口径。
 * 想真正对齐得同时动两处 —— 把 `profile.js` 的 `threshold()` 里 `mine` 改成
 * `pyFloatStr(mine)`，**并且**把 `port_check_profile.mjs` 的年限入参从整数
 * 改成小数（那份脚本现在直接喂 `years: 3`，走的是「绕过 _payload」的路径，
 * 只有它看得见「3」）。只改一边会让那边的对拍变红，所以两边一起改才行。
 *
 * 这一条在 `port_check_api.mjs` 里有**专门断言钉住**（要求线上文案是
 * 「你填的是 3 年」且不含 `.0 年`），免得日后有人只改一边把它改成半吊子。
 *
 * ## 一处不对齐，是**故意**的
 *
 * `_serialize` 里生成追问建议时，Python 传的是 `session=None`（因为
 * `_serialize(out)` 拿不到会话对象），于是「换实体」那类候选永远不出现。
 * 线上这边**照抄这个行为**：`suggest(ctx.JD, q, null, mode)`。
 * 传会话进来会让线上比本地多出几条候选 —— 那是**功能分叉**，比对拍失败更麻烦。
 * 要改就两边一起改，改完重跑对拍。
 *
 * ## 响应契约
 *
 * `handle()` 返回 `{status, body}`；`install()` 把它包成真的 `Response` 对象。
 * 前端只看 `r.error` / `r.ok` 这些**字段**，不看 HTTP 状态码 —— 但状态码照样
 * 给对，因为将来可能有别的调用方（curl、测试脚本）依赖它。
 */
(function (root, factory) {
  var api = factory(root);
  root.JDAPI = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  /* ======================= 与 server.py 逐字对齐的常量 ======================= */

  /** 推荐问题。与 `kb/server.py` 的 `EXAMPLES` 逐字一致 —— 这十条本身是
   *  「指标层能覆盖什么」的产品说明，改了要两边一起改。 */
  var EXAMPLES = [
    "真 AI PM 占比是多少？哪些公司最高？",
    "各公司岗位数排行",
    "同时要求 RAG 和 Agent 的岗位有哪些？",
    "技能提及率 Top10",
    "北京有多少个要求 RAG 的岗位？",
    "RAG 经验在 JD 里一般怎么写？",
    "任职要求里通常需要具备哪些能力？",
    "大模型评测方向的岗位要求是什么样的？",
    "按月看岗位数变化",
    "字节跳动招哪些岗位族？",
  ];

  /** 从 SQL 里抠出表名，用于 explain 面板的「这条 SQL 碰了哪些表」。 */
  var _SRC_TABLE = /\b(?:from|join)\s+([A-Za-z_][\w]*)/gi;

  var ROUTE_LABEL = { sql: "结构化统计", rag: "原文检索", both: "混合" };

  var FEEDBACK_KEY = "jd_insight_feedback";
  var FEEDBACK_MAX = 200;      // 对齐 server.py 的 `items[-200:]`

  var MAX_SESSIONS = 200;      // 对齐 kb/session.py 的 MAX_SESSIONS

  // 见文件头分歧 ①。这两句话是**唯一**提到 key 该填哪儿的用户可见文案。
  var NO_KEY_ERROR =
    "未配置 API key。请点页面右上角「设置」把 key 填进去 —— " +
    "key 只保存在你自己的浏览器里，不会上传到任何服务器。";
  var NO_KEY_HINT =
    "这个问题需要模型来生成 SQL。在「设置」里填一个 API key 就能开启完整问答；" +
    "指标层覆盖的问题（如「各公司岗位数排行」）无需 key。";

  /* ======================= 小工具 ======================= */

  /** Python 语义复刻层（round 的银行家舍入、按码点切串…）。
   *  这一层由 profile.js 导出、各移植文件共用 —— 见那里的长注释：
   *  同一个语义各抄一份，就是给「只在某个具体数值上分叉」多开一个入口。 */
  function Py() { return root.JDProfile; }
  function cpSlice(s, a, b) { return root.JDRetrieval.cpSlice(s, a, b); }

  /** Python 的 `round(x)`（不带 ndigits → 返回整数，且是银行家舍入）。 */
  function pyIntRound(x) { return Py().pyRound(x); }

  function nowMs() {
    return (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
  }

  /** Python 的 `str.strip()`。**不能**用 JS 的 `trim()`：两边的空白集合不同 ——
   *  strip() 认 \x1c-\x1f 与 \x85，trim() 认 \ufeff，各有各的独有字符。
   *  这不只是理论差异：从 Word / PDF 里粘过来的文本经常带 \x1c、\u0085，
   *  用 trim() 会让这个词在两侧一个带空白一个不带，接着影响实体识别。 */
  function pyStrip(s) { return Py().pyStrip(s); }

  /* 把「用户填进来的字符串」归一化：Python 那边第一步永远是 `str.strip()`。
   * 这里收成一个函数名，是为了让「哪些字段过的是 Python 语义」一眼可查。
   *
   * 用 `!v` 而不是 `v === ""`：Python 的 `(x or dflt)` 把 `0`/`False`/`None`
   * 一并当缺省（表单里 direction 传 0 这种事不会发生，但语义照抄不用另作解释）。 */
  function pyStr(v, dflt) {
    return pyStrip(v ? String(v) : (dflt === undefined ? "" : dflt));
  }

  /* ======================= 会话池 ======================= */

  var SESSIONS = Object.create(null);

  function newSid() {
    // 对齐 kb/session.py 的 `uuid.uuid4().hex[:12]`：12 位十六进制。
    // 线上不需要密码学强度，但要**不撞车**，所以用 crypto 而不是 Math.random。
    var a = new Uint8Array(6), src = root.crypto || root.msCrypto;
    if (src && src.getRandomValues) src.getRandomValues(a);
    else for (var i = 0; i < 6; i++) a[i] = Math.floor(Math.random() * 256);
    var s = "";
    for (var j = 0; j < 6; j++) s += ("0" + a[j].toString(16)).slice(-2);
    return s;
  }

  function newSession() {
    var s = root.JDSession.newSession(newSid());
    SESSIONS[s.sid] = s;
    evictSessions();
    return s;
  }

  function getSession(sid) {
    if (!sid) return null;
    return SESSIONS[sid] || null;
  }

  /** 超出上限就淘汰最老的。与 Python 的 `_evict` 同一套规则（按 created 升序）。 */
  function evictSessions() {
    var ids = Object.keys(SESSIONS);
    if (ids.length <= MAX_SESSIONS) return;
    ids.sort(function (a, b) { return SESSIONS[a].created - SESSIONS[b].created; });
    for (var i = 0; i < ids.length - MAX_SESSIONS; i++) delete SESSIONS[ids[i]];
  }

  /** 给测试与「新建会话」用：不传 sid 就新开一个。 */
  function ensureSession(sid) { return getSession(sid) || newSession(); }

  /* ======================= 反馈落地（分歧 ②） ======================= */

  var NOOP_STORE = {
    read: function () { return []; },
    write: function () {},
  };

  /** localStorage 适配器。任何一步失败都退化成「不落盘」而**不是抛错**：
   *  无痕模式下 localStorage 一写就抛，那不该让「反馈」这个动作整个失败 ——
   *  用户点了按钮，至少要得到「已记录」这个反馈。 */
  function localStore(key) {
    return {
      read: function () {
        try {
          var raw = root.localStorage && root.localStorage.getItem(key);
          var v = raw ? JSON.parse(raw) : [];
          return Array.isArray(v) ? v : [];
        } catch (e) { return []; }
      },
      write: function (v) {
        try {
          if (root.localStorage) {
            root.localStorage.setItem(key, JSON.stringify(v));
          }
        } catch (e) { /* 存不下就算了，不打断主流程 */ }
      },
    };
  }

  /* ======================= stats ======================= */

  /** 对应 server.py 的 `stats()`。
   *
   *  字段顺序与 Python 的插入顺序一致 —— 对拍脚本按 `JSON.stringify` 比，
   *  顺序不同会被当成差异报出来（这倒不是洁癖：字段顺序是字典契约的一部分，
   *  对拍能看见它，就能防住「顺手把某个键删了」）。 */
  function stats(ctx) {
    var JD = ctx.JD;
    var out = {
      jobs: JD.val("SELECT count(*) FROM job"),
      companies: JD.val("SELECT count(DISTINCT company) FROM job"),
      skills: JD.val("SELECT count(DISTINCT skill) FROM job_skill"),
      skill_rows: JD.val("SELECT count(*) FROM job_skill"),
      months: JD.all("SELECT DISTINCT month FROM job ORDER BY month")
        .map(function (r) { return r[0]; }),
      /* 并列必须有显式打破键 —— 只写 `ORDER BY count(*) DESC` 时，名次并列的
       * 那几行顺序由 SQLite 的分组实现决定，于是「Python 侧读源库」与
       * 「JS 侧读导出库」会给出不同的顺序（实测 1991 条时「伪 AI PM」与
       * 「半 AI PM」都是 706 条）。与 kb/profile.py 的 ai_levels 同口径。 */
      ai_levels: JD.all("SELECT ai_level, count(*) FROM job GROUP BY ai_level "
        + "ORDER BY count(*) DESC, ai_level").map(function (r) {
          return { name: r[0], n: r[1] };
        }),
    };
    // 分歧 ①：本地读 config.json，线上读 localStorage。`llm_model` 两边都给
    // 「当前默认模型」而不是「有 key 时的模型」—— 与 Python 一致（Python 也无条件
    // 返回 cfg["model"]），前端据此显示一堆 badge。
    var cfg = root.JDLLM.load();
    out.llm_ready = !!ctx.llm;
    out.llm_model = cfg.model || null;
    out.metrics = root.JDMetrics.loadMetrics(JD).length;
    out.examples_learned = root.JDExamples.stats().learned;
    // 分歧 ③：本地是带指纹失效的磁盘缓存，线上是内存 Map。
    // api.js 只报条数，`total` 与 `live` 同值 —— 线上没有 TTL 这个概念。
    var n = root.JDAsk.cacheSize();
    out.cache = { total: n, live: n, ttl_hours: 24,
                  fingerprint: JD.meta("n_chunks") || "browser",
                  path: "(浏览器内存)" };
    out.sessions = Object.keys(SESSIONS).length;
    return out;
  }

  /* ======================= explain ======================= */

  /** 对应 server.py 的 `explain()`：讲清「这个数是怎么算出来的」，
   *  以及**这个口径是哪来的**（人写的指标 / 模型生成的 SQL）。 */
  function explain(ctx, sqlResult, resolved) {
    var sql = sqlResult.sql || "";
    var seen = Object.create(null), tables = [];
    var m;
    _SRC_TABLE.lastIndex = 0;
    while ((m = _SRC_TABLE.exec(sql)) !== null) {
      var t = m[1].toLowerCase();
      if (!seen[t]) { seen[t] = 1; tables.push(t); }
    }
    tables.sort();

    if (sqlResult.source === "metric") {
      var key = sqlResult.metric || "";
      var hit = null;
      root.JDMetrics.loadMetrics(ctx.JD).forEach(function (x) {
        if (hit === null && x.name === key) hit = x;
      });
      return {
        kind: "metric",
        title: "指标层 · 口径已固化",
        definition: hit ? hit.desc : "",
        key: hit ? hit.key : "",
        tables: tables,
        note: "命中了预定义指标，SQL 由人编写并审计，未调用模型 —— "
            + "因此换个时间问同一个问题，数字不会漂移。",
      };
    }
    return {
      kind: "llm",
      title: "模型生成 · 经预检后执行",
      definition: "",
      tables: tables,
      fewshot: sqlResult.fewshot || [],
      /* 这个 `undefined → null` 不是洁癖：Python 的 attempts 每条都带
       * `"error": a.get("error")`（成功的那些是 None），JSON 里一定出现这个键。
       * 直接写 `a.error` 的话 JS 会**把键整个丢掉**，前端 `.error` 拿到的
       * 是 undefined 而不是 null —— 对拍里这一条就是这么红的。 */
      attempts: (sqlResult.attempts || []).map(function (a) {
        return { sql: a.sql || "", ok: a.ok,
                 error: a.error === undefined ? null : a.error };
      }),
      note: "这条 SQL 由模型生成。执行前先做了 EXPLAIN 预检；"
          + "报错会回喂重生成。如果结果符合预期，建议点「结果正确」把它"
          + "沉淀进样例库 —— 下次同类问题会更稳。",
    };
  }

  /* ======================= _serialize ======================= */

  /** 对应 server.py 的 `_serialize()`：把引擎的内部结构翻成前端的契约。
   *
   *  为什么不直接让 `ask()` 返回前端结构：内部结构里带着 `attempts`、原始
   *  `fewshot` 对象这些调试用的东西，而前端要的是 `explain` 摘要。
   *  隔一层，是为了「引擎怎么算」和「界面看什么」能各自演化。
   *
   *  键的**插入顺序**与 Python 逐行对齐（对拍按字符串比，顺序会被看见）。 */
  function serialize(ctx, out) {
    var r = {
      mode: out.mode,
      question: out.question,
      resolved: out.resolved,
      rewrite: out.rewrite || {},
      cached: !!out.cached,
      chart: out.chart === undefined ? null : out.chart,
      insights: out.insights || [],
      route_label: ROUTE_LABEL[out.mode] || out.mode,
    };

    if (out.sql_result) {
      var s = out.sql_result;
      r.sql = {
        ok: s.ok,
        error: s.error === undefined ? null : s.error,
        sql: s.sql || "",
        cols: s.cols || [],
        // None → ""：前端直接往表格里塞，不希望看到 "null" 这个字
        rows: (s.rows || []).map(function (row) {
          return row.map(function (v) {
            return (v === null || v === undefined) ? "" : v;
          });
        }),
        answer: s.answer || "",
        // Python 是 `round(time)`（无 ndigits → 整数、银行家舍入），别用 Math.round
        elapsed_ms: s.elapsed ? pyIntRound(s.elapsed * 1000) : null,
        source: s.source === undefined ? null : s.source,
        metric: s.metric === undefined ? null : s.metric,
        detail: s.detail === undefined ? null : s.detail,
        fewshot: s.fewshot || [],
      };
      r.explain = explain(ctx, s, out.resolved || out.question || "");
    }

    if (out.rag_result) {
      var g = out.rag_result;
      r.rag = {
        ok: g.ok,
        error: g.error === undefined ? null : g.error,
        answer: g.answer || "",
        // 引擎给的命中是 [score, chunk] 二元组；契约里是带字段的对象。
        // 分数保留两位（给人看），文本截到 600 字（按**码点**截，见 cpSlice）。
        hits: (g.hits || []).map(function (h) {
          var sc = h[0], c = h[1];
          return {
            score: Py().pyRound(sc, 2),
            company: c.company,
            title: c.title,
            city: c.city === undefined ? null : c.city,
            date: c.publish_date === undefined ? null : c.publish_date,
            kind: c.kind,
            url: c.url === undefined ? null : c.url,
            text: cpSlice(c.text || "", 0, 600),
          };
        }),
      };
    }

    // 见文件头「一处不对齐，是故意的」：sess 传 null，与 Python 一致。
    try {
      r.suggestions = root.JDSession.suggest(
        ctx.JD, out.resolved || out.question || "", null, out.mode);
    } catch (e) {
      r.suggestions = [];
    }
    return r;
  }

  /* ======================= 请求体归一化 ======================= */

  /** 对应 server.py 的 `_payload()`。表单里的年限可能是 `""`，
   *  不能直接当数字用 —— 这条规则搬过来，前端的表单就一行都不用改。 */
  function payload(body) {
    var d = body || {};
    var y = d.years;
    if (y === "" || y === null || y === undefined) {
      y = null;
    } else {
      y = Number(y);
      if (!isFinite(y)) y = null;
    }
    return {
      direction: pyStr(d.direction, "all"),
      skills: (Array.isArray(d.skills) ? d.skills : []).filter(function (x) {
        return !!x;
      }).map(function (x) { return String(x); }),
      // 见文件头「第五处分歧」：Python 这里做的是 float()，我们是 Number()，
      // 于是整数年限在下游文案里少一个 ".0"。这是刻意保留的，不是漏改。
      years: y,
      city: pyStr(d.city),
      current_title: pyStr(d.current_title),
      // 经历文本长度设上限：防止有人粘一整本书进来把 prompt 撑爆。
      // 按码点截（Python 的 `[:8000]` 是码点语义）。
      experience: cpSlice(pyStr(d.experience), 0, 8000),
    };
  }

  /* ======================= 各个端点 ======================= */

  /** 未知方向：Python 抛 `KeyError("未知方向：x")`，被 server 的
   *  `except KeyError as e` 抓成 `f"未知的目标方向：{e}"` —— 而 `str(KeyError)`
   *  是**带引号**的 repr，所以本地实际的文案是 `未知的目标方向：'ai_pm'`。
   *  这里连引号一起复刻：文案是用户可见的，两边不一致就是 bug。 */
  function unknownDirection(e) {
    var msg = (e && e.message) ? e.message : String(e);
    var m = /^未知方向：([\s\S]*)$/.exec(msg);
    return m ? m[0].replace(/^未知方向：/, "未知的目标方向：'") + "'" : null;
  }

  function errBody(e, fallback) {
    return (e && e.message) ? e.message : String(e || fallback);
  }

  function apiStats(ctx) { return stats(ctx); }

  function apiMetrics(ctx) {
    return root.JDMetrics.loadMetrics(ctx.JD).map(function (m) {
      return { key: m.key, name: m.name, desc: m.desc,
               // Python 侧也做过 `" ".join(sql.split())`，这里保持一致
               sql: String(m.sql || "").replace(/\s+/g, " ").trim() };
    });
  }

  function apiDirections(ctx) {
    return {
      dims: root.JDProfile.dims(),
      directions: root.JDProfile.directions(),
    };
  }

  function apiFeedback(ctx, body) {
    var d = body || {};
    var q = pyStr(d.question);
    var sql = pyStr(d.sql);
    var verdict = d.verdict || "correct";
    if (!q) return { status: 400, body: { ok: false, error: "问题为空" } };

    if (verdict === "correct") {
      if (d.source === "metric") {
        return { status: 200, body: { ok: true, learned: false,
          note: "该结果来自指标层，口径已固化，无需沉淀。" } };
      }
      if (!sql) return { status: 400, body: { ok: false, error: "缺少 SQL" } };
      var added = root.JDExamples.add(q, sql);
      return { status: 200, body: { ok: true, learned: true, added: added,
        total: root.JDExamples.stats().total,
        note: added ? "已新增样例，下次同类问题会作为参考" : "已更新已有样例" } };
    }

    // 标记为有问题：只记录、不自动改口径（见 server.py 的注释）。
    var store = localStore(FEEDBACK_KEY);
    var items = store.read();
    if (!Array.isArray(items)) items = [];
    items.push({
      at: stamp(), question: q, sql: sql,
      note: cpSlice(pyStr(d.note), 0, 500),
      sid: d.sid === undefined ? null : d.sid,
      mode: d.mode === undefined ? null : d.mode,
      metric: d.metric === undefined ? null : d.metric,
      answer: cpSlice(pyStr(d.answer), 0, 800),
    });
    store.write(items.slice(-FEEDBACK_MAX));
    return { status: 200, body: { ok: true, logged: true, pending: items.length,
      note: "已记录，待人工核对。不会自动修改口径。" } };
  }

  /** 本地时间戳 `%Y-%m-%d %H:%M:%S`。手写而不是 toISOString()：
   *  那个给的是 UTC + 带 T/Z，和本地那份文件里的格式对不上。 */
  function stamp() {
    function p(n) { return (n < 10 ? "0" : "") + n; }
    var d = new Date();
    return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + " "
         + p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds());
  }

  function apiProfile(ctx, body) {
    var p = payload(body);
    try {
      return { status: 200, body: root.JDProfile.analyze(p) };
    } catch (e) {
      var ud = unknownDirection(e);
      if (ud) return { status: 400, body: { error: ud } };
      return { status: 400, body: { error: errBody(e) } };
    }
  }

  function apiResume(ctx, body) {
    var p = payload(body);
    if (!p.experience && !p.skills.length) {
      return { status: 400, body: {
        error: "请至少填一项：已具备技能，或工作经历描述。" } };
    }
    var an;
    try {
      an = root.JDProfile.analyze(p);
    } catch (e) {
      var ud = unknownDirection(e);
      if (ud) return { status: 400, body: { error: ud } };
      return { status: 400, body: { error: errBody(e) } };
    }
    // build() 内部自己处理「有 key / 没 key」：没 key 或调用失败都降级为规则版，
    // 所以不让 LLMError 冒到接口层（与 server.py 一致）。
    var r;
    try {
      // 注意 JS 的 build 把 llm 作为显式参数（Python 版在内部自己造 LLM）——
      // 传 null 就走规则降级，正是「没 key 也要能出东西」那条路径。
      r = root.JDResume.build(p, an, ctx.llm);
    } catch (e2) {
      return { status: 500, body: {
        error: "服务端异常：" + errBody(e2) } };
    }
    r.profile = an;                         // 顺带把画像带上，前端一次拿全
    r.used_skills = an.evidence.ticked;
    return { status: 200, body: r };
  }

  /** POST /api/ask —— 唯一一个会调模型的端点，也是唯一一个异步的。 */
  async function apiAsk(ctx, body, query) {
    var d = body || {};
    var q = pyStr(d.question);
    var mode = d.mode || "auto";
    var sid = d.sid || (query && query.sid);
    if (!q) return { status: 400, body: { error: "问题为空" } };

    var sess = getSession(sid) || newSession();

    // 没有 key 也照样能跑 —— 指标层是模板 SQL，本来就不需要模型。
    // 这里与 Python 唯一的不同是「怎么判断有没有 key」（分歧 ①）。
    var llm = ctx.llm, keyErr = null;
    if (!llm) keyErr = NO_KEY_ERROR;

    var out;
    try {
      out = await root.JDAsk.ask(
        { JD: ctx.JD, searcher: ctx.searcher, llm: llm, session: sess,
          schema: ctx.schema },
        q, mode, {});
    } catch (e) {
      return { status: 500, body: { error: "服务端异常：" + errBody(e) } };
    }

    var r = serialize(ctx, out);
    r.sid = sess.sid;

    var sqlOk = !!((out.sql_result || {}).ok);
    var ragOk = !!(((out.rag_result || {}).ok) && out.rag_result.answer);
    if (keyErr && !sqlOk && !ragOk) {
      r.error = keyErr;
      r.need_key = true;
      r.hint = NO_KEY_HINT;
    }
    return { status: 200, body: r };
  }

  /* ======================= 路由器 ======================= */

  /** 解析 `/api/xxx?a=1&b=2`。故意不用 `URL`：相对路径在 Node 里
   *  需要 base，而这里只需要 path + query 两块。 */
  function splitUrl(url) {
    var s = String(url || "");
    var i = s.indexOf("?");
    var path = i < 0 ? s : s.slice(0, i);
    var query = {};
    if (i >= 0) {
      s.slice(i + 1).split("&").forEach(function (kv) {
        if (!kv) return;
        var j = kv.indexOf("=");
        var k = j < 0 ? kv : kv.slice(0, j);
        var v = j < 0 ? "" : kv.slice(j + 1);
        try { k = decodeURIComponent(k.replace(/\+/g, " ")); } catch (e) { /* 原样 */ }
        try { v = decodeURIComponent(v.replace(/\+/g, " ")); } catch (e2) { /* 原样 */ }
        if (query[k] === undefined) query[k] = v;
      });
    }
    return { path: path, query: query };
  }

  /** 前端用的是绝对路径 `/api/xxx`；但发布在 GitHub Pages 的子路径下时，
   *  万一有人写成 `./api/xxx`，这里也要能认出来。所以只要求
   *  「路径里出现 `api/<名字>` 且它后面没有别的东西」。
   *  多认一点不会有副作用：非 `api/` 的请求一律放行走真实网络。 */
  function route(path) {
    var m = /(?:^|\/)api\/([a-z_]+)\/?$/.exec(path);
    return m ? m[1] : null;
  }

  /**
   * 处理一个请求。纯函数（除会话池与 localStorage 这两个显式的状态），
   * 所以能直接在 Node 里对拍。
   *
   * @returns Promise<{status:number, body:any}>
   */
  async function handle(ctx, method, url, body) {
    var u = splitUrl(url);
    var name = route(u.path);
    var M = String(method || "GET").toUpperCase();

    if (!name) {
      return { status: 404, body: { error: "not found" } };
    }
    if (M === "GET") {
      switch (name) {
        case "stats":
          try { return { status: 200, body: apiStats(ctx) }; }
          catch (e) { return { status: 500, body: { error: errBody(e) } }; }
        case "examples":
          return { status: 200, body: EXAMPLES.slice() };
        case "metrics":
          return { status: 200, body: apiMetrics(ctx) };
        case "history": {
          var s = getSession(u.query.sid);
          return { status: 200, body: s ? root.JDSession.history(s) : [] };
        }
        case "directions":
          try { return { status: 200, body: apiDirections(ctx) }; }
          catch (e) { return { status: 500, body: { error: errBody(e) } }; }
        case "skills":
          try { return { status: 200, body: root.JDProfile.skillCatalog() }; }
          catch (e) { return { status: 500, body: { error: errBody(e) } }; }
        case "cities":
          try {
            return { status: 200,
                     body: root.JDProfile.cities(u.query.direction) };
          } catch (e) { return { status: 500, body: { error: errBody(e) } }; }
        default:
          return { status: 404, body: { error: "not found" } };
      }
    }

    if (M === "POST") {
      switch (name) {
        case "session":
          return { status: 200, body: { sid: newSession().sid } };
        case "ask":
          return apiAsk(ctx, body, u.query);
        case "feedback":
          return apiFeedback(ctx, body);
        case "profile":
          return apiProfile(ctx, body);
        case "resume":
          return apiResume(ctx, body);
        default:
          return { status: 404, body: { error: "not found" } };
      }
    }
    return { status: 404, body: { error: "not found" } };
  }

  /* ======================= 装到 window.fetch 上 ======================= */

  /** 把 `ctx` 解析出来。两件事：
   *
   *  ① `ready` 是一道闸门。发布页必须在**数据装载完成之前**就把 fetch 装上 ——
   *     因为 index.html 那段主脚本紧接着就会跑，它的 `boot()` 会立刻打
   *     `/api/stats`。要是那时候垫片还没装好，请求就漏到真实网络去打 404，
   *     前端会显示「未连接后端服务」。所以：先装垫片（同步），
   *     请求进来后在这里等一下（异步）。装载要解 3MB 的库，几百毫秒很正常。
   *
   *  ② `ctx` 允许是「返回 ctx 的函数」。装垫片的时候对象还不存在，
   *     只能先递一个取值器进去。
   *
   *  两个都是可选的：不传就是原来的行为。 */
  async function resolveCtx(ctx, ready) {
    if (ready) await ready;
    return (typeof ctx === "function") ? await ctx() : ctx;
  }

  /**
   * 把 `/api/*` 从真实网络截下来。返回一个卸载函数（测试用）。
   *
   * 拦截判定放在**进网络之前**：命中就走本地引擎，没命中一律交回原 fetch。
   * 这一点很重要 —— 页面上还有别的资源（/static/*、外部 iframe），
   * 劫持错了会让整个页面白屏。
   */
  function install(ctx, opts) {
    opts = opts || {};
    var g = opts.global || root;
    if (!g.fetch) throw new Error("install 需要一个有 fetch 的环境");
    var orig = g.fetch.bind(g);
    var handler = async function (input, init) {
      var url = (typeof input === "string") ? input
              : (input && input.url) ? input.url : String(input);
      if (!route(splitUrl(url).path)) return orig(input, init);

      var method = (init && init.method) || (input && input.method) || "GET";
      var body = null;
      if (init && init.body) {
        try {
          body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
        } catch (e) { body = null; }
      }
      var c = await resolveCtx(ctx, opts.ready);
      /* 装载失败时给一个**说得清**的响应，而不是让它一直挂着：
         挂着的话前端会停在「分析中」转圈，比报错更难查。 */
      if (!c) {
        return makeResponse({ status: 503, body: {
          error: "知识库未能装载（数据文件缺失或浏览器不支持 WASM），"
               + "因此无法回答。刷新页面可以重试。",
        } });
      }
      var got = await handle(c, method, url, body);
      return makeResponse(got);
    };
    g.fetch = handler;
    return function uninstall() { g.fetch = orig; };
  }

  /** 包成真的 Response。前端只 `.json()`，但给真的更省事：
   *  万一以后有人 `.text()` / `.ok` / `.headers`，也不会突然少东西。 */
  function makeResponse(got) {
    var text = JSON.stringify(got.body);
    if (typeof Response === "function") {
      return new Response(text, {
        status: got.status,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    // 兜底（极老的浏览器 / 特殊沙箱）：给一个最小可用的鸭子类型
    return {
      ok: got.status >= 200 && got.status < 300,
      status: got.status,
      json: function () { return Promise.resolve(got.body); },
      text: function () { return Promise.resolve(text); },
    };
  }

  /* ======================= 启动 ======================= */

  /**
   * 装载数据与引擎，返回 `ctx`。给 `publish/index.html` 用；
   * 也能在 Node 里用（传 `SQL` 与 `bytes`，见 tools/port_check_api.mjs）。
   *
   * @param o.SQL      sql.js 的模块（浏览器里是 `initSqlJs(...)` 的结果）
   * @param o.bytes    Uint8Array；给了就不去取网络
   * @param o.dbUrl    取库地址，默认 `assets/kb.sqlite.gz`
   * @param o.plainUrl 解压不可用时的退路，默认 `assets/kb.sqlite`
   * @param o.global   挂 fetch 的目标，默认 globalThis
   * @param o.llm      覆盖 LLM 客户端（测试用；不给就按 localStorage 里的配置造）
   */
  async function boot(o) {
    o = o || {};
    var g = o.global || root;
    var bytes = o.bytes || await loadBytes(o);
    var db = root.JDDB.make(o.SQL, bytes);

    // 样例库要接上 localStorage，否则「结果正确」点下去什么也不会留下。
    root.JDExamples.storage = localStore("jd_insight_examples");

    var ctx = {
      JD: db,
      searcher: root.JDRetrieval.makeSearcher(db),
      llm: o.llm !== undefined ? o.llm
           : (root.JDLLM.ready() ? root.JDLLM.create() : null),
      schema: db.val("SELECT v FROM doc WHERE k='schema'") || "",
      db: db,
    };
    if (o.install !== false) {
      ctx.uninstall = install(ctx, { global: g, ready: o.ready });
    }
    return ctx;
  }

  /** 取库字节。优先 gzip（3.0MB vs 12.4MB），用浏览器内建的
   *  `DecompressionStream` 解 —— 不引 pako：为了一次解压多下载 50KB
   *  WASM/JS 不划算，而 DecompressionStream 现在 Safari 16.4+/Chrome 80+
   *  都有。真的没有就退回去取未压缩的那份。 */
  async function loadBytes(o) {
    var g = o.global || root;
    var f = o.fetch || g.fetch;
    if (!f) throw new Error("没有 fetch，无法取数据库");
    var gzUrl = o.dbUrl || "assets/kb.sqlite.gz";
    var plainUrl = o.plainUrl || "assets/kb.sqlite";

    if (typeof g.DecompressionStream === "function") {
      var res = await f(gzUrl);
      if (res && res.ok === false) throw new Error("取不到 " + gzUrl
        + "（HTTP " + res.status + "）");
      var stream = res.body.pipeThrough(new g.DecompressionStream("gzip"));
      var buf = await new Response(stream).arrayBuffer();
      return new Uint8Array(buf);
    }
    var res2 = await f(plainUrl);
    if (res2 && res2.ok === false) throw new Error("取不到 " + plainUrl
      + "（HTTP " + res2.status + "）");
    return new Uint8Array(await res2.arrayBuffer());
  }

  return {
    EXAMPLES: EXAMPLES,
    NO_KEY_ERROR: NO_KEY_ERROR,
    NO_KEY_HINT: NO_KEY_HINT,
    ROUTE_LABEL: ROUTE_LABEL,
    FEEDBACK_KEY: FEEDBACK_KEY,
    MAX_SESSIONS: MAX_SESSIONS,

    stats: stats,
    explain: explain,
    serialize: serialize,
    payload: payload,
    route: route,
    splitUrl: splitUrl,
    handle: handle,

    newSession: newSession,
    getSession: getSession,
    ensureSession: ensureSession,
    sessions: function () { return SESSIONS; },
    resetSessions: function () { SESSIONS = Object.create(null); },

    localStore: localStore,
    install: install,
    resolveCtx: resolveCtx,
    boot: boot,
    loadBytes: loadBytes,
  };
});
