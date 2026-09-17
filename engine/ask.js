/* 问答链路：Text-to-SQL + RAG + 路由编排
 * （kb/text2sql.py + kb/rag.py + kb/ask.py 的同构移植）。
 *
 * 三条处理链照搬：① 指标层短路（零 token）② 样例库 few-shot ③ 护栏 + 自纠错。
 *
 * ## 与 Python 版的一处能力差异，必须说清楚
 *
 * 本地版用 `set_progress_handler` 同时卡**步数**和**墙钟时间**，
 * 防止一条笛卡尔积把进程挂死。sql.js 跑在浏览器主线程里，是同步执行 ——
 * 调用期间没有 JS 能插进去中断它，所以这个熔断**在浏览器里做不到**。
 *
 * 补偿手段有三条，都能写进代码：只读副本（写不进去）、EXPLAIN 预检
 * （把「列名写错」这类常见错误挡在执行之前，且很快）、以及自动补 LIMIT
 * （结果集一定有限）。真正跑飞时最坏结果是页面卡住、刷新即恢复，
 * 代价明确，所以这里选择**如实说明而不是假装有超时**。
 */
(function (root, factory) {
  var api = factory();
  root.JDAsk = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_ROWS = 50;          // 明细类查询最多返回行数
  var METRIC_MAX_ROWS = 200;  // 指标层是聚合结果，行数上限放宽
  var RETRY = 2;              // SQL 失败后的重试次数
  var FEWSHOT_K = 2;
  var FEWSHOT_MIN = 0.25;

  var FEWSHOT_NOTE =
    "【相似的已解决问题 —— 只参考写法（JOIN 方式、别名、LIMIT 的写法），" +
    "**不要照搬它的统计口径**。聚合函数（count / avg / sum）与过滤条件" +
    "必须以当前问题的要求为准，别因为和某个样例看起来像就套用它的口径】";

  /* 没有模型可用时，SQL / 归纳这两条链各自的提示语。
   *
   * 这是**移植里唯一一处刻意不一致的文案**：Python 那边抛的是
   * `kb/llm.py` 的 `LLMError`，内容教人「把 key 填进 config.json 的 api_key
   * 字段，或设置环境变量 LLM_API_KEY」—— 在浏览器里这句是错的，用户既没有
   * config.json 也没有环境变量。所以这里换成中性说法；「该去哪儿填 key」
   * 由 api.js 的 `NO_KEY_ERROR` / `NO_KEY_HINT` 统一说（那里才知道线上是
   * 「点右上角设置」）。对拍脚本把这条差异单独断言，不做静默放过。 */
  var NO_LLM_SQL_ERROR = "需要模型生成 SQL，但当前没有可用的模型配置。";
  var NO_LLM_RAG_ERROR = "原文检索已命中片段，但「归纳成回答」这一步需要模型。";

  /* ---------- 安全护栏 ---------- */
  var FORBIDDEN = new RegExp(
    "\\b(?:insert\\s+into|update\\s+[\\w\"`\\[]+\\s+set|delete\\s+from|" +
    "drop\\s+(?:table|view|index|trigger)|alter\\s+table|" +
    "create\\s+(?:table|view|index|trigger|virtual)|replace\\s+into|" +
    "attach\\s+database|detach\\s+database|pragma|vacuum|reindex|" +
    "truncate\\s+table|grant|revoke)\\b", "i");
  var LEADING_OK = /^\s*(select|with)\b/i;
  var LIMIT_RE = /\blimit\b/i;

  function stripFence(sql) {
    var s = String(sql || "").trim();
    if (s.indexOf("```") >= 0) {
      var m = s.match(/```(?:sql)?\s*([\s\S]*?)```/i);
      if (m) s = m[1].trim();
    }
    s = s.replace(/--[^\n]*/g, " ");
    s = s.replace(/\/\*[\s\S]*?\*\//g, " ");
    return s.trim();
  }

  function validateSql(sql) {
    var s = stripFence(sql).replace(/;+\s*$/, "").trim();
    if (!s) throw new Error("SQL 为空");
    if (s.indexOf(";") >= 0) throw new Error("只允许单条语句（检测到分号）");
    if (!LEADING_OK.test(s)) throw new Error("只允许 SELECT / WITH 开头的查询语句");
    var m = FORBIDDEN.exec(s);
    if (m) throw new Error("包含被禁止的关键字：" + m[0].toUpperCase());
    if (!LIMIT_RE.test(s)) s = s + "\nLIMIT " + MAX_ROWS;
    return s;
  }

  /* ---------- 执行 ---------- */
  function runSql(JD, sql, maxRows, params, check) {
    var safe = check === false ? sql : validateSql(sql);
    var r;
    try {
      r = JD.q(safe, params || []);
    } catch (e) {
      throw new Error("SQLite 执行错误：" + (e && e.message ? e.message : e));
    }
    var rows = r.rows.slice(0, maxRows || MAX_ROWS);
    return [r.cols, rows, safe];
  }

  /** EXPLAIN 预检：SQLite 编译但不执行。列名/表名写错在这里就暴露。 */
  function dryRun(JD, sql) {
    var safe = validateSql(sql);
    try {
      JD.raw.exec("EXPLAIN " + safe);
    } catch (e) {
      throw new Error("SQL 预检失败（EXPLAIN）：" + (e && e.message ? e.message : e));
    }
    return safe;
  }

  /* ---------- 提示词（与 kb/text2sql.py 逐字一致） ---------- */
  var SQL_SYSTEM = "你是 SQLite 专家。把用户的中文问题翻译成**一条** SQL 查询。\n\n" +
    "硬性规则：\n" +
    "1. 只输出 SQL 本身。不要解释、不要 Markdown 围栏、不要分号结尾。\n" +
    "2. 表名与字段名必须严格来自给定 schema，绝不臆造不存在的列。\n" +
    "3. `city` 字段可能是多值字符串（如 `北京/上海`），筛选城市必须用\n" +
    "   `city LIKE '%北京%'`，不能用 `city = '北京'`。\n" +
    "4. 问「多少岗位要求 X 技能」这类问题，必须 JOIN `job_skill` 表，\n" +
    "   用 `WHERE s.skill = '技能规范名'` 精确匹配；技能名必须来自 schema 枚举。\n" +
    "5. 求占比用 `round(100.0 * 分子 / 分母, 1)`；求 Top N 用 `ORDER BY ... DESC LIMIT n`。\n" +
    "6. 「真 AI 岗位」用 `ai_level = '真 AI PM'`，**不要**用 `is_ai = 1`\n" +
    "   （后者只表示标题含关键词，口径完全不同）。\n" +
    "7. 需要写中文别名时用不含空格的写法，如 `count(*) AS 岗位数`。\n" +
    "8. 明细查询要加 LIMIT（不超过 50）。";

  var ANSWER_SYSTEM = "你是 AI 产品经理 JD 数据分析师。用户问了一个问题，系统执行 SQL 得到了结果。\n\n" +
    "要求：\n" +
    "1. 用简体中文直接回答用户的问题，**把关键数字讲清楚**。\n" +
    "2. 不要复述 SQL，除非用户问的就是 SQL。\n" +
    "3. 如果结果为空，说明查不到，并给出可能的原因（比如公司名写法、字段为空）。\n" +
    "4. 如果结果行数多，用 Markdown 表格呈现，并挑出最值得注意的几条做解读。\n" +
    "5. **不要编造结果里没有的数字**。\n" +
    "6. 如果这个结论受口径影响（例如 work_years 字段大量为空），主动提示一句。\n" +
    "7. 不要写客套话和免责声明。";

  var RAG_SYSTEM = "你是「AI 产品经理 JD 知识库」的分析助手。用户会问关于 AI 产品经理招聘要求的问题，\n" +
    "你只能依据下方【检索片段】作答。\n\n" +
    "硬性规则：\n" +
    "1. **不得编造**。片段里没有的岗位、公司、技能、数字，一律不能出现在回答里。\n" +
    "2. **必须引用来源**。每一条结论后面用 `【公司 · 岗位名】` 标注它来自哪条片段。\n" +
    "3. **不得把片段数说成占比**。你看到的是检索命中的少量片段，不是全库统计。\n" +
    "   如果问题问的是数量、比例、排名这类统计口径，明确说明「这需要查结构化数据」，\n" +
    "   并给出你从片段中观察到的趋势作为补充。\n" +
    "4. 片段不足以回答时，直接说「知识库中没有检索到相关记录」，不要硬答。\n" +
    "5. 归纳共性时，按「能力项 → 原文表述 → 出处」的结构写，便于用户直接对照。\n\n" +
    "输出用简体中文，Markdown 格式，不要写客套话。";

  function buildUserMsg(question, schema, fewshot) {
    var parts = ["【Schema】\n" + schema];
    if (fewshot) parts.push(FEWSHOT_NOTE + "\n" + fewshot);
    parts.push("【问题】\n" + question + "\n\nSQL：");
    return parts.join("\n\n");
  }

  /* ---------- 结果渲染 ---------- */
  function renderRows(cols, rows) {
    if (rows.length === 1 && cols.length === 1) return String(rows[0][0]);
    var out = ["| " + cols.join(" | ") + " |",
               "| " + cols.map(function () { return "---"; }).join(" | ") + " |"];
    rows.forEach(function (r) {
      out.push("| " + r.map(function (v) { return v === null || v === undefined ? "—" : String(v); })
                       .join(" | ") + " |");
    });
    return out.join("\n");
  }

  /** 指标命中的确定性渲染 —— 不调模型，也就不可能编造数字。 */
  function metricAnswer(hit, cols, rows) {
    if (!rows.length) return "没有查到「" + hit.name + "」的数据。";
    var tail = hit.detail ? "（筛选：" + hit.detail + "）" : "";
    if (rows.length === 1 && cols.length === 1) {
      return hit.name + "：**" + rows[0][0] + "**" + tail;
    }
    return "**" + hit.name + "**" + tail + "\n\n" + renderRows(cols, rows);
  }

  /* ---------- Text-to-SQL ---------- */
  /**
   * `llm` 需要实现 `chat(messages, temperature) -> Promise<string>`。
   * 传 null 时只走指标层；指标层未命中会返回 `ok:false` + 一句中性提示
   * （形状与 `kb/text2sql.py` 的「LLM 不可用」那条返回逐键对齐）。
   */
  async function askSql(JD, question, llm, opts) {
    opts = opts || {};
    var schema = opts.schema || (JD.val("SELECT v FROM doc WHERE k='schema'") || "");
    var t0 = now();

    // ① 指标层短路
    if (opts.useMetrics !== false) {
      var hit = JDMetrics.match(JD, question);
      if (hit) {
        try {
          var r = runSql(JD, hit.sql, METRIC_MAX_ROWS, hit.params, true);
          return { ok: true, sql: JDMetrics.preview(hit), cols: r[0], rows: r[1],
                   answer: metricAnswer(hit, r[0], r[1]), elapsed: (now() - t0) / 1000,
                   attempts: [{ sql: JDMetrics.preview(hit), ok: true,
                                source: "metric", name: hit.name }],
                   error: null, source: "metric", metric: hit.name,
                   detail: hit.detail };
        } catch (e) { /* 指标层执行失败就回退 LLM，与 Python 一致 */ }
      }
    }

    if (!llm) {
      /* 形状**逐键对齐** `kb/text2sql.py` 里「LLM 不可用」那条返回：
       * `{"ok": False, "error": ..., "sql": "", "rows": [], "cols": [], "answer": ""}`。
       *
       * 第一版这里多带了 `source: "llm"` 与 `need_key: true` 两个键。多带的后果
       * 不是报错，是 `_serialize` 会把 `source` 原样透出去 ——
       * Python 那边是 `null`（键根本不存在），线上是 `"llm"`，
       * 于是「本地/线上一致」这件事在对拍里红了一格。need_key 更没用：
       * 「要不要提示用户配置 key」是 server / api.js 根据**顶层**结果判断的
       * （`key_err and not sql_ok and not rag_ok`），不在这一层。 */
      return { ok: false, error: NO_LLM_SQL_ERROR,
               sql: "", answer: "", cols: [], rows: [], attempts: [] };
    }

    // ② few-shot
    var fewshot = "", fewshotNames = [];
    if (opts.useFewshot !== false) {
      var hits = JDExamples.search(question, FEWSHOT_K, FEWSHOT_MIN);
      if (hits.length) {
        fewshot = JDExamples.formatFewshot(hits);
        fewshotNames = hits.map(function (h) { return h[1].question; });
      }
    }

    // ③ 生成 → 预检 → 执行 → 报错回喂重生成
    var sql = "", err = null, attempts = [], ok = false, cols = [], rows = [];
    var lastT0 = now();
    for (var i = 0; i <= RETRY; i++) {
      var raw;
      try {
        raw = i === 0
          ? await llm.chat([{ role: "system", content: SQL_SYSTEM },
                            { role: "user", content: buildUserMsg(question, schema, fewshot) }],
                           { temperature: 0 })
          : await llm.chat([{ role: "system", content: SQL_SYSTEM },
                            { role: "user", content: buildUserMsg(question, schema, fewshot) +
                              "\n\n【上一次生成的 SQL（有错）】\n" + sql + "\n\n" +
                              "【错误信息】\n" + err + "\n\n请修正后重新输出 SQL，只输出 SQL：" }],
                           { temperature: 0 });
      } catch (e) {
        return { ok: false, error: "LLM 调用失败：" + (e && e.message ? e.message : e),
                 sql: sql, answer: "", cols: [], rows: [], attempts: attempts,
                 source: "llm" };
      }
      sql = stripFence(raw);
      lastT0 = now();
      try {
        var safe = dryRun(JD, sql);
        var out = runSql(JD, safe, MAX_ROWS, [], false);
        cols = out[0]; rows = out[1]; sql = out[2];
        attempts.push({ sql: sql, ok: true, source: "llm" });
        ok = true;
        break;
      } catch (e2) {
        err = e2 && e2.message ? e2.message : String(e2);
        attempts.push({ sql: sql, ok: false, error: err, source: "llm" });
      }
    }
    if (!ok) {
      return { ok: false, error: "SQL 生成失败：" + err, sql: sql, answer: "",
               cols: [], rows: [], attempts: attempts, source: "llm" };
    }

    var elapsed = (now() - lastT0) / 1000;
    var table = rows.length
      ? cols.join(" | ") + "\n" + rows.map(function (r) {
          return r.map(function (v) { return v === null || v === undefined ? "" : String(v); }).join(" | ");
        }).join("\n")
      : "(无结果)";
    var answer = await llm.chat(
      [{ role: "system", content: ANSWER_SYSTEM },
       { role: "user", content: "【用户问题】\n" + question + "\n\n" +
         "【SQL 结果】共 " + rows.length + " 行，耗时 " + Math.round(elapsed * 1000) + "ms\n" + table }],
      { temperature: 0.2 });

    return { ok: true, sql: sql, cols: cols, rows: rows, answer: answer,
             elapsed: elapsed, attempts: attempts, error: null, source: "llm",
             fewshot: fewshotNames };
  }

  /* ---------- RAG ---------- */
  var KIND_LABEL = { meta: "岗位信息", duty: "岗位职责", req: "任职要求",
                     full: "岗位描述" };

  function formatContext(hits, maxChars) {
    maxChars = maxChars || 800;
    return hits.map(function (h, i) {
      var c = h[1];
      var kind = KIND_LABEL[c.kind] || c.kind;
      var head = "[" + (i + 1) + "] 【" + c.company + " · " + c.title + "】（" +
                 (c.city || "未标注") + "｜" + (c.publish_date || "") + "｜" + kind + "）";
      return head + "\n" + JDRetrieval.cpSlice(c.text || "", 0, maxChars);
    }).join("\n\n");
  }

  async function ragAsk(JD, searcher, question, topK, filters, llm) {
    var hits = searcher.search(question, topK || 8, filters, "job");
    if (!hits.length) {
      return { answer: "知识库中没有检索到相关记录。可以换个说法，或放宽公司/城市限制。",
               hits: [] };
    }
    if (!llm) {
      return { answer: "", hits: hits, need_key: true, error: NO_LLM_RAG_ERROR };
    }
    var user = "【检索片段】\n" + formatContext(hits) + "\n\n【用户问题】\n" + question +
               "\n\n请依据上述片段作答，并标注来源。";
    var answer = await llm.chat([{ role: "system", content: RAG_SYSTEM },
                                 { role: "user", content: user }], { temperature: 0.2 });
    return { answer: answer, hits: hits };
  }

  /* ---------- 路由 ---------- */
  var QUANT = new RegExp(
    "多少|几个|几条|几家|占比|比例|百分比|百分之|排行|排名|top\\s*\\d*|" +
    "分布|统计|数量|总数|合计|平均|最多|最少|最大|最小|第一|前\\s*\\d+|" +
    "各(公司|城市|岗位|月)|按.{0,6}(分|统计|看)|超过|大于|少于|" +
    "有没有.{0,10}的岗位$", "i");
  var QUAL = new RegExp(
    "怎么写|如何描述|怎么描述|一般怎么|通常怎么|怎么做|什么样|是什么样|" +
    "要求是|通常要求|一般要求|需要具备|看重什么|关注什么|举例|例子|原文|" +
    "表述|措辞|话术|怎么表达|有什么要求|需要什么|哪些能力|哪些技能|" +
    "如何体现|怎么写|长什么样", "i");

  function route(question) {
    var q = question || "";
    var isQ = QUANT.test(q), isL = QUAL.test(q);
    if (isQ && !isL) return "sql";
    if (isL && !isQ) return "rag";
    return "both";
  }

  /* ---------- 编排 ---------- */
  function now() {
    return (typeof performance !== "undefined" && performance.now)
      ? performance.now() : Date.now();
  }

  var _cache = new Map();

  function cacheable(out) {
    var s = out.sql_result, g = out.rag_result;
    if (s && !s.ok) return false;
    if (g && !g.ok) return false;
    if (s && s.source === "metric" && !g) return false;
    return !!(s || g);
  }

  /**
   * 统一问答入口。`ctx` = {JD, searcher, llm, session}。
   * 返回值与 kb/server.py 的 `_serialize` 对齐（api.js 直接用这个结构当响应体）。
   */
  async function ask(ctx, question, mode, opts) {
    opts = opts || {};
    var JD = ctx.JD, topK = opts.topK || 6;
    var sess = ctx.session;
    var rw = JDSession.resolve(JD, question, sess);
    var q = rw.question;
    var m = (!mode || mode === "auto") ? route(q) : mode;

    var out = { mode: m, question: question, resolved: q,
                rewrite: { question: rw.question, changed: rw.changed,
                           changes: rw.changes, from: rw.from,
                           note: rw.changed ? "继承上一轮：" + rw.changes.join("；") : "" },
                cached: false };

    if (opts.useCache !== false && q) {
      var hit = _cache.get(q + "\u0000" + m);
      if (hit) {
        Object.keys(hit).forEach(function (k) { out[k] = hit[k]; });
        out.cached = true;
        out.rewrite = { question: rw.question, changed: rw.changed,
                        changes: rw.changes, from: rw.from,
                        note: rw.changed ? "继承上一轮：" + rw.changes.join("；") : "" };
        remember(ctx, question, q, out, rw);
        return out;
      }
    }

    if (m === "sql" || m === "both") {
      out.sql_result = await askSql(JD, q, ctx.llm, { schema: ctx.schema });
    }
    if (m === "rag" || m === "both") {
      try {
        var g = await ragAsk(JD, ctx.searcher, q, topK, null, ctx.llm);
        out.rag_result = { ok: !g.need_key, answer: g.answer, hits: g.hits,
                           error: g.error || null };
      } catch (e) {
        out.rag_result = { ok: false, error: e && e.message ? e.message : String(e),
                           hits: ctx.searcher.search(q, topK, null, "job"),
                           answer: "" };
      }
    }

    // 出图与洞察：只对确定性结果做，失败不影响主流程
    out.chart = null; out.insights = [];
    var s = out.sql_result;
    if (s && s.ok && s.rows && s.rows.length) {
      try {
        out.chart = JDChart.build(s.cols || [], s.rows || [], out.resolved || question);
        out.insights = JDChart.insights(s.cols || [], s.rows || [], out.chart);
      } catch (e) { out.chart = null; out.insights = []; }
    }

    if (opts.useCache !== false && cacheable(out)) {
      var copy = {};
      Object.keys(out).forEach(function (k) { if (k !== "rewrite") copy[k] = out[k]; });
      _cache.set(q + "\u0000" + m, copy);
    }
    remember(ctx, question, q, out, rw);
    return out;
  }

  function remember(ctx, question, resolved, out, rw) {
    if (!ctx.session) return;
    var src = (out.sql_result || {}).source || "";
    ctx.session.turns.length;   // noop：保持与 Python 的调用顺序一致
    JDSession.record(ctx.session, question, resolved, out.mode, src,
                     JDMetrics.entitiesOf(ctx.JD, resolved), rw.changed, rw.changes);
  }

  function clearCache() { _cache.clear(); }

  /* 缓存条数。给 api.js 的 `/api/stats` 用：本地版那里报的是磁盘缓存文件
   * 的条目数（kb/cache.py 的 stats()），线上只有这个内存 Map，能报的
   * 就是它的 size。两者语义不同 —— 差异写在 api.js 文件头的分歧 ③ 里。 */
  function cacheSize() { return _cache.size; }

  return {
    MAX_ROWS: MAX_ROWS, METRIC_MAX_ROWS: METRIC_MAX_ROWS, RETRY: RETRY,
    stripFence: stripFence, validateSql: validateSql, dryRun: dryRun,
    runSql: runSql, renderRows: renderRows, metricAnswer: metricAnswer,
    askSql: askSql, ragAsk: ragAsk, formatContext: formatContext,
    route: route, ask: ask, clearCache: clearCache, cacheSize: cacheSize,
    NO_LLM_SQL_ERROR: NO_LLM_SQL_ERROR, NO_LLM_RAG_ERROR: NO_LLM_RAG_ERROR,
    SQL_SYSTEM: SQL_SYSTEM, ANSWER_SYSTEM: ANSWER_SYSTEM, RAG_SYSTEM: RAG_SYSTEM,
    QUANT: QUANT, QUAL: QUAL
  };
});
