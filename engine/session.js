/* 多轮追问：省略句改写（kb/session.py 的同构移植）。
 *
 * 路线是**继承式改写**而不是指代消解：把上一轮的完整问句当底稿，
 * 用本轮出现的新实体/新维度去替换或前置，改出一句能独立成立的完整问句。
 * 好处是可解释（改写差异能直接打给人看）、可降级（认不出来就不改）、零训练。
 *
 * 与 Python 版的一处结构差异：本地版把会话放在服务进程的内存里，
 * 线上版没有服务进程，所以 Session 的存取交给调用方（api.js 用内存 Map，
 * 刷新页面就没了 —— 这是浏览器版的天然边界，不假装能持久化）。
 */
(function (root, factory) {
  var api = factory();
  root.JDSession = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var MAX_TURNS = 20;
  var MAX_CORE = 8;    // 剥掉承接词后，剩余内容多长以内才算「省略句」
  var MAX_ECHO = 4;    // 剩余内容这么短时，允许「沿用上一轮」

  var LABEL = { skill: "技能", company: "公司", city: "城市" };

  // 总量词：前置追问实体时先摘掉，否则会改出「北京总计有多少个岗位」这种句子
  var LEAD_FILLER = /^\s*(总计|总共|一共|合计|全库|全部)/;

  // 追问触发词：句首的承接词，或句尾的「呢」。没有这些信号一律不改写。
  var FOLLOWUP = new RegExp(
    "^\\s*(那|那么|换成|换为|换|改成|改为|只看|再看|再|还|另外|接着|同样|然后)" +
    "|呢\\s*[？?]?\\s*$", "g");
  var FOLLOWUP_TEST = new RegExp(
    "^\\s*(那|那么|换成|换为|换|改成|改为|只看|再看|再|还|另外|接着|同样|然后)" +
    "|呢\\s*[？?]?\\s*$");
  var TAIL_NE = /呢\s*[？?。]?\s*$/g;
  var STRIP_CHARS = " 　？?。，,、：:";

  var DIM_CANON = { company: "各公司", city: "各城市", skill: "各技能",
                    month: "按月", title_norm: "各岗位族", ai_level: "各真伪分级" };
  var DIM_SRC = {
    company: "各公司|各家公司|按公司|分公司的?|公司维度|公司分布|哪些公司|哪家公司",
    city: "各城市|按城市|分城市的?|城市维度|城市分布|哪些城市|哪个城市",
    skill: "各技能|按技能|技能维度|技能分布|技能排行|技能排名|技能提及率|哪些技能",
    month: "按月份?|月度|每月|各个月份|时间趋势|岗位数变化",
    title_norm: "各岗位族|按岗位族|岗位族|各岗位类型|岗位类型分布",
    ai_level: "真伪分级|ai_level|真伪|含金量"
  };
  var DIM_PAT = {};
  for (var dk in DIM_SRC) DIM_PAT[dk] = new RegExp(DIM_SRC[dk]);

  /** Python 的 str.strip(chars)：按字符集合剥。JS 的 trim 只剥空白，不够用。 */
  function stripSet(s, chars) {
    var i = 0, j = s.length;
    while (i < j && chars.indexOf(s[i]) >= 0) i++;
    while (j > i && chars.indexOf(s[j - 1]) >= 0) j--;
    return s.slice(i, j);
  }

  /** 问句里的聚合维度（最长匹配优先）。 */
  function dimOf(question) {
    var best = null;
    for (var dim in DIM_PAT) {
      var m = DIM_PAT[dim].exec(question || "");
      if (m && (best === null || m[0].length > best[1].length)) best = [dim, m[0]];
    }
    return best ? best[0] : null;
  }

  function dimSpan(question, dim) {
    var m = DIM_PAT[dim].exec(question || "");
    return m ? m[0] : "";
  }

  /**
   * 剥掉承接词与语气词之后剩下的实质内容。
   *
   * 触发追问不能只看「有没有『那』」——「那小米的岗位要求什么？」也是「那」开头，
   * 但它是一句完整的独立新问题，按追问改写会答非所问。所以再看剩下的实质内容
   * 有多短：只剩一个实体或干脆为空，才是省略句。
   * 反复剥是因为 `^` 锚定只吃一个词：「那换成按城市看呢」要剥两轮。
   */
  function core(question) {
    var s = question || "", prev = null;
    while (s !== prev) {
      prev = s;
      s = s.replace(TAIL_NE, "").replace(FOLLOWUP, "");
    }
    return stripSet(s, STRIP_CHARS);
  }

  /* ---------- 会话 ---------- */
  function newSession(sid) {
    return { sid: sid, turns: [], created: Date.now() };
  }

  function last(sess) { return sess && sess.turns.length ? sess.turns[sess.turns.length - 1] : null; }

  function record(sess, question, resolved, mode, source, ents, rewritten, changes) {
    var prev = last(sess);
    // 实体做累积：上一轮已有的实体在本轮省略时仍然有效
    // （「那北京呢」之后接「有多少真 AI 岗」，公司/城市限制不该丢）
    var merged = prev ? JSON.parse(JSON.stringify(prev.entities || {})) : {};
    for (var k in (ents || {})) {
      var vals = (merged[k] || []).slice();
      (ents[k] || []).forEach(function (v) { if (vals.indexOf(v) < 0) vals.push(v); });
      merged[k] = vals;
    }
    sess.turns.push({ question: question, resolved: resolved, mode: mode || "auto",
                      source: source || "", entities: merged,
                      rewritten: !!rewritten, changes: changes || [] });
    if (sess.turns.length > MAX_TURNS) sess.turns = sess.turns.slice(-MAX_TURNS);
  }

  function history(sess) {
    return (sess ? sess.turns : []).map(function (t) {
      return { question: t.question, resolved: t.resolved, mode: t.mode,
               source: t.source, rewritten: t.rewritten, changes: t.changes };
    });
  }

  /** 把省略式追问改写成完整问句。不改写时 changed=false，question 原样返回。 */
  function resolve(JD, question, sess) {
    var q = (question || "").trim();
    var prev = last(sess);
    // 每次都新建一个 noop，不共享对象 —— 调用方会往返回体里塞 sid 之类的东西。
    function unchanged() {
      return { question: q, changed: false, changes: [], from: "" };
    }
    if (!q || !prev || !prev.resolved) return unchanged();

    var pairs = JDMetrics.entityPairs(JD, q);
    var newDim = dimOf(q), prevDim = dimOf(prev.resolved);
    var coreText = core(q);

    // 触发判定：**必须先是省略句**（剥掉承接词后只剩一点内容），
    // 再要求「有承接词」或「换了聚合维度」二者之一。长度这一关不能省，踩过两次：
    //   · 「那小米的岗位要求什么？」—— 有「那」，但是完整独立问题；
    //   · 「换个话题：各城市岗位数排行」—— 有「换」且维度确实变了，但它不是追问。
    // 误改一个完整问句的代价远大于不享受上下文，所以宁严勿宽。
    var triggered = coreText.length <= MAX_CORE &&
      (FOLLOWUP_TEST.test(q) || (!!newDim && !!prevDim && newDim !== prevDim));
    if (!triggered) return unchanged();

    var prevPairs = JDMetrics.entityPairs(JD, prev.resolved);
    var out = prev.resolved, changes = [];

    // ① 实体：同类已有 → 替换；同类没有 → 前置追加
    for (var kind in pairs) {
      var key = pairs[kind][0][0], value = pairs[kind][0][1];
      var olds = prevPairs[kind] || [];
      if (olds.length) {
        var oldKey = olds[0][0];
        if (oldKey === key) continue;            // 同一个实体，不是追问
        if (out.indexOf(oldKey) >= 0) {
          out = out.split(oldKey).join(key);   // Python 的 str.replace 是替换全部
          changes.push((LABEL[kind] || kind) + " " + oldKey + " → " + key);
          continue;
        }
      }
      // 上一轮没有这类实体 —— 作为附加限定前置。
      // 用库中真实值而非用户写法，避免简称前置后歧义；
      // 前置前先摘掉「总计/一共」这类总量词，否则会改出「北京总计有多少个岗位？」
      out = value + out.replace(LEAD_FILLER, "");
      changes.push("追加" + (LABEL[kind] || kind) + "「" + value + "」");
    }

    // ② 维度：换聚合口径（「各公司…」→「各城市…」）
    if (newDim && prevDim && newDim !== prevDim) {
      var span = dimSpan(prev.resolved, prevDim);
      if (span) {
        out = out.replace(span, DIM_CANON[newDim]);
        changes.push("聚合维度 " + span + " → " + DIM_CANON[newDim]);
      }
    }

    if (!changes.length || out.trim() === q) {
      // 改不出来（或改完和原句一样），但确实是句省略话（「那北京呢」而上一轮
      // 已经限定过北京）。这时它的意思只可能是「就按上一轮再看一遍」。
      if (coreText.length <= MAX_ECHO) {
        return { question: prev.resolved, changed: true,
                 changes: ["沿用上一轮的口径"], from: prev.resolved };
      }
      return unchanged();
    }
    return { question: out, changed: true, changes: changes, from: prev.resolved };
  }

  /* ---------- 追问建议 ---------- */
  var SUGGEST_DIMS = [["company", "各公司岗位数排行"], ["city", "各城市岗位数排行"],
                      ["skill", "技能提及率 Top10"], ["month", "按月看岗位数变化"],
                      ["title_norm", "各岗位族分布"]];

  /** 把库中真实值收成适合给人看的短写法（`RAG/知识库` → `RAG`）。 */
  function short(kind, value) {
    var v = String(value == null ? "" : value).trim();
    if (kind === "skill" && v.indexOf("/") >= 0) {
      var head = v.split("/")[0].trim();
      return /[A-Za-z0-9]/.test(head) ? head : v;
    }
    if (kind === "city" && v.indexOf("/") >= 0) return v.split("/")[0].trim();
    return v;
  }

  /** 同类实体里最值得作为「换个对象看」的几个。 */
  function topAlternatives(JD, kind, value, n) {
    n = n || 5;
    var rows = [];
    if (kind === "company" || kind === "city") {
      rows = JD.all("SELECT " + kind + " FROM job WHERE " + kind + " IS NOT NULL " +
                    "GROUP BY " + kind + " ORDER BY count(*) DESC LIMIT 40")
               .map(function (r) { return r[0]; });
    } else if (kind === "skill") {
      rows = JD.all("SELECT skill FROM job_skill GROUP BY skill " +
                    "ORDER BY count(DISTINCT job_id) DESC LIMIT 60")
               .map(function (r) { return r[0]; });
    }
    var vals = rows.map(function (r) { return short(kind, r); });
    if (kind === "skill") {
      // 技能的频次榜被「跨部门协同」这类泛能力词占据，但人想换着看的是
      // 有技术指代的那几个（RAG / Agent / Python…），所以把它们提到前面。
      vals = vals.map(function (s, i) { return [s, i]; })
                 .sort(function (a, b) {
                   var ra = /[A-Za-z0-9]/.test(a[0]) ? 0 : 1;
                   var rb = /[A-Za-z0-9]/.test(b[0]) ? 0 : 1;
                   return (ra - rb) || (a[1] - b[1]);
                 }).map(function (x) { return x[0]; });
    }
    var out = [];
    for (var i = 0; i < vals.length; i++) {
      var v = String(vals[i] || "").trim();
      if (!v || v === value || v === short(kind, value)) continue;
      if (kind === "skill" && v.indexOf("/") >= 0) continue;   // 带斜杠的点出来像乱码
      if (out.indexOf(v) >= 0) continue;
      out.push(v);
      if (out.length >= n) break;
    }
    return out;
  }

  function suggest(JD, question, sess, mode, limit) {
    limit = limit || 4;
    var q = (question || "").trim();
    var ents = JDMetrics.entitiesOf(JD, q);
    var curDim = dimOf(q);
    var cands = [];

    // ① 换维度：把「没用过的维度」里最值的几条提出来
    SUGGEST_DIMS.forEach(function (d) { if (d[0] !== curDim) cands.push(d[1]); });

    // ② 换实体
    if (sess) {
      for (var kind in ents) {
        var alts = topAlternatives(JD, kind, ents[kind][0]);
        if (alts.length) cands.unshift("那" + alts[0] + "呢");
      }
    }

    // ③ 定性 / 定量互补：统计问完给原文问法，反之亦然
    if (ents.skill && ents.skill.length) {
      var sk = short("skill", ents.skill[0]);
      cands.unshift(mode === "rag" ? "有多少岗位要求 " + sk + "？"
                                   : sk + " 经验在 JD 里一般怎么写？");
    }

    var out = [], seen = {};
    for (var i = 0; i < cands.length; i++) {
      var c = String(cands[i] || "").trim();
      if (!c || seen[c]) continue;
      seen[c] = 1;
      // 和当前问题太像的建议没意义（bigram 相似度做去重阈值）
      if (JDExamples.similarity(c, q) > 0.9) continue;
      out.push(c);
      if (out.length >= limit) break;
    }
    return out;
  }

  return { MAX_TURNS: MAX_TURNS, newSession: newSession, last: last, record: record,
           history: history, resolve: resolve, suggest: suggest, dimOf: dimOf,
           core: core, short: short, topAlternatives: topAlternatives,
           stripSet: stripSet };
});
