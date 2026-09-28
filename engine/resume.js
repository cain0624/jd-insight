/* 简历优化（`kb/resume.py` 的同构移植）。
 *
 * 这个模块的价值不在「改简历」，在于**每一条改写都挂在真实 JD 原文上**。所以
 * 移植后必须一模一样的是「引证链」：检索到哪几条原文、引号里的字能不能在原文里
 * 逐字找到、找不到时怎么摘引号。全是纯规则，能逐字对，也就必须逐字对
 * （tools/port_check_resume.mjs 拿 kb/resume.py 当基准）。
 *
 * 移植时差点咬到人的五处，下面都在**代码旁边**写了「为什么」：
 *   · `len()` 数码点、JS `.length` 数 UTF-16 码元（emoji 会让截断错位）；
 *   · Python 的 `\s` 与 JS 的 `\s` 不是同一个集合（PY_WS）；
 *   · `str.splitlines()` 的断点比 `split("\n")` 多（splitLines）；
 *   · `round()` 与 `f"{x:.0f}"` 都是银行家舍入（复用 JDProfile 的精确实现）；
 *   · `set` 的迭代顺序进程间不可复现 —— **已从源头消除**：命中词列表改成
 *     「全收集 → 按码点排序去重 → 取前 6」（见 retrieval.js 同款注释），
 *     不再靠对拍容忍度兜着，matched 现在是逐元素（含顺序）对拍。
 *
 * **与 Python 刻意不一致的只有一处**，对拍脚本里有专门断言：
 *   · `build(..., llm, ...)`：传 null/undefined 时直接走规则降级，不尝试构造
 *     LLM（浏览器里没有 kb/llm.py 那套 requests 后端），所以 `reason` 是固定串，
 *     不是 config.json 那条内插了本机绝对路径的报错原文。
 *
 * 另外记一笔：`_rule_md` 的硬门槛原先在 Python 侧是**会崩的** —— 原来直接取
 * `th['years']['verdict']`，而 `_threshold` 只在用户填了数字年限时才写这个键，
 * 于是「年限留空 + 规则降级」= KeyError。这不是边角情形：模型调用失败也会落到
 * 规则降级，而浏览器版里访客不填 Key 时**只有**规则版。所以没有把崩溃照搬过来，
 * 而是改成「有 verdict 才输出该行」，然后**回头把基准也修了**（kb/resume.py 同一个
 * 改法）—— 现在两边逐字一致，那段从「刻意分歧」变成了真比对。
 */
(function (root, factory) {
  var api = factory();
  root.JDResume = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  /* 装载顺序是「先 eval 脚本、再由 JDDB.make() 挂 globalThis.JD」，
   * 所以依赖必须**调用期**取，装载期取只会拿到 undefined。 */
  function JD() {
    var d = globalThis.JD;
    if (!d) throw new Error("JDResume：请先装载 db.js 并挂好 globalThis.JD");
    return d;
  }
  function P() { return globalThis.JDProfile; }
  function RD() { return globalThis.JDRetrieval; }

  /* =================== Python 语义复刻层 =================== */

  /* Python `re` 里 \s 与 `str.strip()` 的空白集合（两者相同）：
   * 比 JS 多 \x1c-\x1f 与 \x85，少 \ufeff。含 BOM 的 JD 正文两边会分叉。 */
  var PY_WS = "\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000";
  var RE_WS_ALL = new RegExp("[" + PY_WS + "]", "g");
  /* _norm_term 的 r"[\s/·、\-]" —— 顺序不能动，`\-` 必须留在末尾附近的转义形态 */
  var RE_NORM = new RegExp("[" + PY_WS + "/·\\-、]", "g");
  /* verify/downgrade 里的 r"[\s“”\"「」]" */
  var RE_QUOTE_STRIP = new RegExp("[" + PY_WS + "“”\"「」]", "g");

  function cpLen(s) { return RD().cpLen(s); }

  /** 对应 `re.sub(r"\s", "", s)`。 */
  function stripWs(s) { return String(s).replace(RE_WS_ALL, ""); }

  function normTerm(s) {
    return String(s === null || s === undefined ? "" : s).replace(RE_NORM, "").toLowerCase();
  }

  /* 对应 Python 的 `str.splitlines()`：\r\n / \r / \n / \v / \f / \x1c-\x1e /
   * \x85 / \u2028 / \u2029 都是断点，且**结尾的断点不产生空尾巴**
   * （"a\n".splitlines() == ["a"]，不是 ["a", ""]）。 */
  function splitLines(s) {
    if (!s) return [];
    var out = [], buf = "";
    for (var i = 0; i < s.length; i++) {
      var ch = s.charAt(i);
      if (ch === "\r" || ch === "\n" || ch === "\v" || ch === "\f" ||
          ch === "\x1c" || ch === "\x1d" || ch === "\x1e" || ch === "\x85" ||
          ch === "\u2028" || ch === "\u2029") {
        out.push(buf); buf = "";
        if (ch === "\r" && s.charAt(i + 1) === "\n") i++;
      } else buf += ch;
    }
    if (buf !== "") out.push(buf);
    return out;
  }

  /* =================== 术语表（对应 resume.py 的 _TERM） ===================
   * Python 侧是 `{_norm_term(s) for s in P.SKILL_DIM} | {固定几个英文缩写}`。
   * 技能名从导出库的 skill_dim 读（web_export 写的就是 P.SKILL_DIM 的全集），
   * 不再从别处拼一份 —— 两份词典就有两个事实源。 */
  var EXTRA_TERMS = ["rag", "llm", "agent", "mcp", "prompt", "mvp", "prd",
                     "coze", "dify"];
  var _terms = null;
  function terms() {
    if (_terms) return _terms;
    _terms = Object.create(null);
    JD().all("SELECT skill FROM skill_dim").forEach(function (r) {
      _terms[normTerm(r[0])] = 1;
    });
    EXTRA_TERMS.forEach(function (s) { _terms[s] = 1; });
    return _terms;
  }
  function isTerm(key) {
    var k = normTerm(key);
    return terms()[k] === 1 ||
      (k.length >= 2 && k.slice(-2) === "方向" && terms()[k.slice(0, -2)] === 1);
  }

  /* =================== 引号核对 =================== */
  /* resume.py 的 _QUOTE：开引号 「 “ "，闭引号 」 ” "，内容不含换行、至少 2 字。
   * 内容里排掉了闭引号字符，所以贪婪 {2,} 实际等价于「吃到第一个闭引号」。 */
  var QUOTE_RE = /[「“"]([^」”"\n]{2,})[」”"]/g;
  var QUOTE_MIN = 6;    // 短于这个长度的引文多是术语（「RAG」「MCP」），查他只会制造噪音

  function findQuotes(md) {
    var out = [], m;
    QUOTE_RE.lastIndex = 0;
    while ((m = QUOTE_RE.exec(md)) !== null) out.push(m[1]);
    return out;
  }

  function blobOf(ev) {
    return stripWs((ev || []).map(function (e) { return (e && e.text) || ""; }).join(""));
  }

  /** 对应 resume.py 的 verify_quotes。返回 [核对条数, 未通过清单]。 */
  function verifyQuotes(md, ev) {
    var blob = blobOf(ev), checked = 0, bad = [];
    var qs = findQuotes(String(md === null || md === undefined ? "" : md));
    for (var i = 0; i < qs.length; i++) {
      var key = qs[i].replace(RE_QUOTE_STRIP, "");
      if (cpLen(key) < QUOTE_MIN || isTerm(key)) continue;
      checked++;
      if (blob.indexOf(key) === -1) bad.push(qs[i]);
    }
    return [checked, bad];
  }

  /** 对应 resume.py 的 downgrade_quotes。返回 [新 md, 被摘掉引号的处数]。 */
  function downgradeQuotes(md, ev) {
    var blob = blobOf(ev), n = 0;
    var s = String(md === null || md === undefined ? "" : md);
    QUOTE_RE.lastIndex = 0;
    var out = s.replace(QUOTE_RE, function (whole, inner) {
      var key = String(inner).replace(RE_QUOTE_STRIP, "");
      if (cpLen(key) < QUOTE_MIN || isTerm(key) || blob.indexOf(key) !== -1) {
        return whole;
      }
      n++;
      return inner;            // 摘引号：内容留着，只是不再声称它是原文
    });
    return [out, n];
  }

  /* =================== 证据检索 =================== */

  var _searcher = null, _searcherJD = null;
  function searcher() {
    var d = JD();
    if (!_searcher || _searcherJD !== d) { _searcher = RD().makeSearcher(d); _searcherJD = d; }
    return _searcher;
  }

  /* 对应 resume.py 的 anchors()。排序键是 (pct, skill) 的**全序**，所以不受
   * t.dims 迭代顺序影响；pct 并列时比 skill，而 Python 的 str 比较按码点
   * —— 用 pyStrCmp。Python 的 `sorted(reverse=True)` 保留并列项的原有次序
   * （不是把结果倒过来），JS 的 Array.sort 自 ES2019 起也稳定，所以两边一致。 */
  function anchors(dirKey, k, extra) {
    if (k === undefined || k === null) k = 5;
    var t = P().targetProfile(dirKey), ranked = [];
    Object.keys(t.dims).forEach(function (dk) {
      (t.dims[dk].top || []).forEach(function (x) { ranked.push([x.pct, x.skill]); });
    });
    ranked.sort(function (a, b) {
      if (a[0] !== b[0]) return b[0] - a[0];
      return P().pyStrCmp(b[1], a[1]);
    });
    var out = [];
    for (var i = 0; i < ranked.length; i++) {
      var skill = ranked[i][1];
      if (out.indexOf(skill) === -1) out.push(skill);
      if (out.length >= k) break;          // break 在 append 之后、判长之后
    }
    (extra || []).forEach(function (s) { if (out.indexOf(s) === -1) out.push(s); });
    return out.slice(0, k + 3);
  }

  /* 对应 resume.py 的 evidence()。
   * Python 走 rag_mod.search(...) == get_index().search(..., agg="job")，
   * 这里必须接到**同一个** JDRetrieval.makeSearcher 上：导出库的 5041 个块
   * 与源库的 5037 个块不是同一批（公司名换了别名，切块边界跟着变），
   * 基准取错会报出一屏假差异。 */
  function evidence(dirKey, extra, k, perCompany) {
    if (k === undefined || k === null) k = 8;
    if (perCompany === undefined || perCompany === null) perCompany = 1;
    var t = P().targetProfile(dirKey);
    var hot = anchors(dirKey, 5, extra);
    var query = t.name + " 岗位任职要求 " + hot.join(" ");
    var filters = { kind: "req" };
    if (dirKey !== "all") filters.skills = hot;
    var hits = [];
    try { hits = searcher().search(query, k * 4, filters, "job"); }
    catch (e) { hits = []; }
    if (!hits.length && filters.skills) {
      // 技能过滤太紧时放宽一次，宁可证据泛一点，也别返回空
      try { hits = searcher().search(query, k * 4, { kind: "req" }, "job"); }
      catch (e2) { hits = []; }
    }

    var seen = Object.create(null), out = [];
    for (var i = 0; i < hits.length; i++) {
      var score = hits[i][0], c = hits[i][1] || {}, termsHit = hits[i][2] || [];
      var comp = c.company || "";
      if ((seen[comp] || 0) >= perCompany) continue;
      seen[comp] = (seen[comp] || 0) + 1;
      out.push({
        score: P().pyRound(score, 2), company: comp, title: c.title,
        city: c.city, date: c.publish_date, url: c.url, kind: c.kind,
        matched: termsHit.slice(0, 6),
        /* `(c.get("text") or "")[:900]` 是**按码点**截 —— 用 .slice 会在正文
         * 含 emoji 时提前一个字截断，摘出来的原文就跟 Python 版差一个字。 */
        text: RD().cpSlice(c.text || "", 0, 900),
      });
      if (out.length >= k) break;
    }
    return out;
  }

  /* =================== prompt 拼装 =================== */

  function fmtStats(an) {
    var lines = [
      "目标方向：" + an.direction.name + "（" + an.direction.scope + "）",
      "整体达成度：" + an.overall + "%", "",
      "五维对照（目标 / 你 / 该维人均要求项数）：",
    ];
    an.dims.forEach(function (d) {
      lines.push("- " + d.name + "：目标 " + d.target + " / 你 " + d.self +
        "（该方向人均要求 " + P().pyFloatStr(d.need) + " 项，你具备 " +
        d.have + " 项） → " + d.level_label);
      if (d.missing && d.missing.length) {
        lines.push("  缺口：" + d.missing.map(function (m) {
          return m.skill + "（该方向 " + P().fmt0(m.pct * 100) + "% 的岗位提及）";
        }).join("、"));
      }
    });
    return lines.join("\n");
  }

  function fmtUser(payload, an) {
    /* `payload.get("years") if ... is not None else "未填"`：0 年也要印 "0"，
     * 所以这里**不能**用 `||`（0 是假值）。 */
    var y = payload.years;
    var ys = (y === null || y === undefined) ? "未填" : String(y);
    return "工作年限：" + ys + "\n"
      + "当前职位：" + (payload.current_title || "未填") + "\n"
      + "期望城市：" + (payload.city || "未填") + "\n"
      + "已具备技能（候选人勾选）：" + (an.evidence.ticked.join("、") || "无") + "\n"
      + "从经历文本中识别到的技能：" + (an.evidence.from_text.join("、") || "无") + "\n"
      + "\n【候选人提供的经历原文】\n"
      + (payload.experience || "（候选人未填写经历）");
  }

  function fmtEvidence(ev) {
    if (!ev || !ev.length) return "（未检索到岗位要求原文）";
    var out = [];
    for (var i = 0; i < ev.length; i++) {
      var e = ev[i];
      out.push("[" + (i + 1) + "] 【" + e.company + " · " + e.title + "】（"
        + (e.city || "未标注") + "）\n" + e.text);
    }
    return out.join("\n\n");
  }

  /* 与 kb/resume.py 的 SYSTEM 逐字相同（含换行）。写成拼接而不是模板串，是为了让
   * 每一条硬性规则各占一行、和 Python 那份能并排看 —— 这段文本差一个字都算漂移。 */
  var SYSTEM = "你是资深的 AI 产品经理求职顾问，正在帮一位候选人针对特定方向优化简历。\n"
    + "你只能依据【岗位要求原文】和【候选人提供的经历】这两份材料工作。\n\n"
    + "硬性规则，违反任何一条都算失败：\n"
    + "1. **绝对不得编造候选人的经历**。候选人没有提供的公司名、项目名、数字、指标、\n   技术栈，一个字都不能出现在简历正文里。你的工作是「换表述、调顺序、对齐术语」，\n   不是替候选人补事实。\n"
    + "2. **每条改写都要挂依据**。改写的每条经历后面用 `← 依据：…（[序号]）` 标注，\n   序号对应【岗位要求原文】里的编号。需要引用原句时逐字照抄并加引号；\n   只做概括就不要加引号，直接写关键词 + 序号即可。\n   找不到对应要求的经历，就不要写这一条。\n"
    + "3. **不得把检索片段数说成市场占比**。你看到的是检索命中的少量片段，\n   不是全库统计。需要讲占比时，只能引用【统计结果】里给出的数字。\n"
    + "4. **缺口不写进简历**。候选人尚未覆盖的关键要求，单独列进「缺口」一节，\n   并在那里给出补齐建议；写进简历正文等于让他面试时答不出来。\n"
    + "5. 术语对齐：把候选人的口语表述换成这一方向的行业写法（如「知识库问答」→「RAG」），\n   但含义不能变。\n"
    + "6. **只有逐字原文才能加引号**。引号（`\"\"`「」）里的内容必须能在【岗位要求原文】里\n   逐字找到。要概括、要提术语、要写自己的判断，一律不带引号直接写。\n   这条会被程序逐条核对：把概括句放进引号 = 伪造岗位要求，等于失败。\n\n"
    + "输出 Markdown，简体中文，结构为：\n## 一句话定位\n## 技能栏（按该方向提及率排序）\n"
    + "## 经历改写\n## 缺口与补齐建议\n不要写任何客套话和结尾祝福。";

  /* =================== 降级：规则版 =================== */
  /* payload 与 Python 同签名但同样未被用到 —— 保留是为了签名对齐，
   * 读代码的人不该在这里找「是不是漏用了一个字段」。 */
  function ruleMd(payload, an, ev, hot) {
    var d = an.direction;
    var L = ["# 简历优化建议（规则版 · 未调用模型）", "",
      "> 目标方向：**" + d.name + "**（" + d.scope + "）　整体达成度 **"
        + an.overall + "%**",
      "> 这一版不依赖模型：给的是**该方向岗位的原文要求**和**你的缺口**，",
      "> 你照着原文自己改。配好 API key 后可以改成模型代写。", ""];

    L = L.concat(["## 一、技能栏该怎么排", ""]);
    an.dims.forEach(function (dim) {
      if (!dim.mine || !dim.mine.length) return;
      L.push("- **" + dim.name + "**（" + dim.level_label + "）："
        + dim.mine.join("、"));
    });
    var extra = an.evidence.from_text;
    if (extra && extra.length) {
      L = L.concat(["", "以下是你在经历里提到过、但没勾进技能栏的，建议补上：" + extra.join("、")]);
    }
    L = L.concat(["", "该方向提及率最高的技能是：" + hot.join("、")
      + " —— 技能栏里用这些词，别用自己的口语写法（HR 和系统都在按这些词筛）。"]);

    L = L.concat(["", "## 二、缺口（不要在简历里硬写）", ""]);
    if (!an.advice.some(function (x) { return x.kind === "gap" || x.kind === "near"; })) {
      L.push("五维均已达到该方向门槛，没有明显缺口。");
    }
    an.dims.forEach(function (dim) {
      if ((dim.level !== "gap" && dim.level !== "near") ||
          !dim.missing || !dim.missing.length) return;
      L.push("- **" + dim.name + "**：该方向人均要求 " + P().pyFloatStr(dim.need)
        + " 项，你具备 " + dim.have + " 项。缺："
        + dim.missing.map(function (m) {
          return m.skill + "（" + P().fmt0(m.pct * 100) + "%）";
        }).join("、"));
    });
    L = L.concat(["", "> 这些项写进简历但答不出来，面试反而扣分。要么真补，"
      + "要么用你已经会的相邻经验去对标。", ""]);

    var th = an.threshold;
    if (("years" in th) || ("city" in th)) {
      L = L.concat(["## 三、硬门槛", ""]);
      /* Python 这里原先是 `th['years']['verdict']` 直接取键，而 profile._threshold
       * 只在用户填了**数字**年限时才写 verdict —— 于是「年限留空 + 走规则降级」
       * 在 Python 侧是 KeyError（实测 `--years` 省略就复现）。那是基准自己的 bug，
       * 已回头修成同一个判断（`kb/resume.py` 也用 .get），两边现在逐字一致。
       * 保留 `th.years &&` 这一层是因为空字典在两边都是假值，行为更稳。 */
      if (("years" in th) && th.years && th.years.verdict) {
        L.push("- " + th.years.verdict);
      }
      if ("city" in th) L.push("- " + th.city.verdict);
      L.push("");
    }

    L = L.concat(["## 四、该方向岗位的原文要求（照这个口径改写你的经历）", ""]);
    if (!ev.length) L.push("（未检索到岗位要求原文）");
    ev.forEach(function (e, idx) {
      var head = "**[" + (idx + 1) + "] " + e.company + " · " + e.title + "**";
      if (e.city) head += "　" + e.city;
      L.push(head);
      L.push("");
      // `["> " + ln.strip() for ln in text.splitlines() if ln.strip()][:14]`
      var body = splitLines(e.text).map(function (ln) { return "> " + P().pyStrip(ln); })
        .filter(function (s) { return s.length > 2; });
      L = L.concat(body.slice(0, 14));
      if (e.url) L.push("> 原始 JD：" + e.url);
      L.push("");
    });

    L = L.concat(["---", "*口径：" + an.basis + "*"]);
    return L.join("\n");
  }

  /* =================== 生成 =================== */

  /* 没有 key 时的固定文案，会**直接显示给用户**（前端把它渲染进一个黄色提示条，
   * 后面紧跟「已自动降级为规则版，功能不受影响」）。
   *
   * 所以这里**不能**照抄 Python 那句：Python 的是
   * 「未配置 API key。请把 key 填进 config.json 的 api_key 字段，或设置环境变量
   * LLM_API_KEY。」—— 浏览器里既没有 config.json 也没有环境变量，让用户去改那个
   * 文件是纯粹的误导。留短的、只陈述状态的半句，剩下的交给前端那句「不受影响」。
   * （「该去哪儿填 key」由 api.js 的 NO_KEY_ERROR 统一说，那里才知道线上是
   * 「点右上角设置」。） */
  var NO_LLM_REASON = "未配置 API key";

  /* Python 只捕获 LLMError；JS 侧没有那个类，约定「name === 'LLMError'」。
   * 不宽到 catch-all：真正写错的 TypeError 应该冒出来，而不是被伪装成降级。 */
  function isLlmError(e) {
    return !!e && (e.name === "LLMError" || e.llmError === true);
  }

  function build(payload, an, llm, k) {
    an = an || P().analyze(payload);
    if (k === undefined || k === null) k = 8;
    var dirKey = an.direction.key;
    // `[s for d in an["dims"] for s in (x["skill"] for x in d["missing"])]`
    var gaps = [];
    an.dims.forEach(function (d) { (d.missing || []).forEach(function (x) { gaps.push(x.skill); }); });
    var ev = evidence(dirKey, gaps.slice(0, 6), k);
    var hot = anchors(dirKey, 5);

    if (llm === null || llm === undefined) {
      return { ok: true, mode: "rule", reason: NO_LLM_REASON,
               markdown: ruleMd(payload, an, ev, hot), evidence: ev, anchors: hot };
    }

    var user = "【统计结果】\n" + fmtStats(an) + "\n\n"
      + "【候选人信息】\n" + fmtUser(payload, an) + "\n\n"
      + "【岗位要求原文】\n" + fmtEvidence(ev) + "\n\n"
      + "请按系统提示的结构输出优化后的简历。";
    var md;
    try {
      md = llm.chat([{ role: "system", content: SYSTEM },
                     { role: "user", content: user }], { temperature: 0.3 });
    } catch (e) {
      if (!isLlmError(e)) throw e;
      return { ok: true, mode: "rule", reason: "模型调用失败：" + e.message,
               markdown: ruleMd(payload, an, ev, hot), evidence: ev, anchors: hot };
    }

    var chk = verifyQuotes(md, ev);
    var checked = chk[0], bad = chk[1], retried = false;
    if (bad.length) {
      /* 先回喂一次。与 text2sql 那边「SQL 报错回喂重生成」是同一个套路：
       * 把机器能判定的错误原样丢回去，比在 prompt 里反复叮嘱管用。 */
      retried = true;
      var fix = "你上一版里有下面这些引号内容，在【岗位要求原文】里逐字找不到：\n"
        + bad.slice(0, 8).map(function (b) { return "- " + b; }).join("\n")
        + "\n\n请重写全文：引号里只能放【岗位要求原文】的原字句，可以只截取其中"
        + "一段（要能逐字对上）。概括、术语、自己的判断一律不要加引号。"
        + "其余结构与内容保持不变。";
      try {
        var md2 = llm.chat([{ role: "system", content: SYSTEM },
          { role: "user", content: user + "\n\n【上一版输出】\n" + md
            + "\n\n【必须修正的问题】\n" + fix }], { temperature: 0.2 });
        var chk2 = verifyQuotes(md2, ev);
        // 只有「未命中变少」才采纳。模型重写经常换一批新错，这条是防它越改越糟。
        if (chk2[1].length < bad.length) { md = md2; checked = chk2[0]; bad = chk2[1]; }
      } catch (e2) {
        if (!isLlmError(e2)) throw e2;      // 重写失败就沿用上一版，继续往下走
      }
    }

    /* 兜底：重写没解决（或换了一批新错）的，直接把引号摘掉。
     * 不指望模型每次都听话，改成让输出满足一条**可验证**的性质：
     * 凡是带引号的，都能在岗位原文里逐字找到。 */
    var dg = downgradeQuotes(md, ev);
    md = dg[0];
    var still = verifyQuotes(md, ev);
    return {
      ok: true, mode: "llm", markdown: md, evidence: ev, anchors: hot,
      quote_check: {
        checked: still[0], verified: still[0] - still[1].length,
        unverified: still[1], retried: retried, downgraded: dg[1],
      },
    };
  }

  return {
    build: build, verifyQuotes: verifyQuotes, downgradeQuotes: downgradeQuotes,
    anchors: anchors, evidence: evidence, ruleMd: ruleMd,
    fmtStats: fmtStats, fmtUser: fmtUser, fmtEvidence: fmtEvidence,
    normTerm: normTerm, isTerm: isTerm, splitLines: splitLines,
    SYSTEM: SYSTEM, QUOTE_MIN: QUOTE_MIN,
  };
});
