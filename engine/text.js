/* 中英混合分词 + 技能词典桥接（kb/text.py 的同构移植）。
 *
 * 逐字对齐 Python 版是有原因的：这一层决定了**检索能不能召回**，
 * 切分规则差一个字，命中集合就变，而「答案看着还挺像」会掩盖这种变化。
 * 所以 tools/port_check_engine.mjs 会拿同一批语料对拍两边的 token 与权重。
 *
 * 与 Python 的一处刻意差异：Python 用 `re.I`，JS 不用 flag 而是先把文本
 * `.toLowerCase()`。两者在 ASCII 上等价，在极少数「与 ASCII 同形的非 ASCII
 * 字母」（长 s、无点 i）上会分叉 —— 本语料里没有这类字符。
 */
(function (root, factory) {
  var api = factory();
  root.JDText = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var ASCII_RE = /[a-z][a-z0-9+#._\-]*/g;   // 技术英文词：c++ / c# / node.js / 0-1
  var NUM_RE = /\d{2,}/g;                    // 纯数字（年份、年限），长度 >= 2 才有区分度
  var CJK_RE = /[\u4e00-\u9fff]+/g;

  var SKILL_TAG = "\u00a7";                  // § —— 技能 token 前缀，避开自然词
  var W_SKILL = 3.0;                         // 查询里技能 token 的权重
  var W_ALIAS = 0.5;                         // 同义词扩展的权重（低于字面词，别淹没原意）
  var W_TERM = 1.0;

  function tokenize(text) {
    var out = [];
    if (!text) return out;
    var low = String(text).toLowerCase();
    var m;
    ASCII_RE.lastIndex = 0;
    while ((m = ASCII_RE.exec(low))) out.push(m[0]);
    NUM_RE.lastIndex = 0;
    while ((m = NUM_RE.exec(low))) out.push(m[0]);
    var segs = low.match(CJK_RE) || [];
    for (var s = 0; s < segs.length; s++) {
      var seg = segs[s];
      if (seg.length === 1) { out.push(seg); continue; }
      // 中文用 bigram 而不是分词：「检索增强生成」切成 检索/索增/增强/强生/生成，
      // 查询「检索增强」也能命中，召回上界更高。代价是索引大一点，这批数据量无压力。
      for (var i = 0; i + 2 <= seg.length; i++) out.push(seg.substr(i, 2));
    }
    return out;
  }

  /* ---------- 技能词典 ----------
   * 词典不从代码里写第二遍，而是从导出库的 `skill_dim` 表读 ——
   * 单一事实来源仍是 analyze/skills.py，这里只是换了个读取姿势。 */
  var _skills = null;      // {group: [[name, RegExp]]}
  var _aliasTokens = null; // {name: [token]}

  function _pattern(alias) {
    // 纯 ASCII 别名加显式边界，避免 'rag' 命中 'storage'。
    // Python 用 \b 是不行的：中文也算 \w，所以两边都用「前后不是 [a-z0-9]」。
    if (/^[a-z0-9][a-z0-9.\-/ ]*$/.test(alias)) {
      return "(?<![a-z0-9])" + _esc(alias) + "(?![a-z0-9])";
    }
    return _esc(alias);
  }

  function _esc(s) { return s.replace(/[.*+?^${}()|[\]\\\/\-]/g, "\\$&"); }

  function _load(JD) {
    if (_skills) return;
    _skills = {};
    _aliasTokens = {};
    // 取 `grp` 而**不是** `dim`：两者是不同粒度的分类，见 web_export._insert_dims。
    //   dim 5 类（ai/pm/data/soft/biz）  = 画像雷达图维度
    //   grp 6 类（ai_tech/ai_platform/pm_hard/data/soft/biz） = 技能词典一级分组
    // Python 的 match_skills 返回的是 grp。前端第一版读的 dim，
    // 结果 `LLM/大模型` 报成 `ai`、`Roadmap/规划` 报成 `pm`，和本地版对不上。
    var rows = JD.all("SELECT skill, grp, aliases FROM skill_dim");
    for (var i = 0; i < rows.length; i++) {
      var name = rows[i][0], grp = rows[i][1];
      var aliases = [];
      try { aliases = JSON.parse(rows[i][2] || "[]"); } catch (e) { aliases = []; }
      if (!aliases.length || !grp) continue;
      (_skills[grp] = _skills[grp] || []).push([
        name, new RegExp(aliases.map(_pattern).join("|"), "g")
      ]);
      var toks = {};
      for (var a = 0; a < aliases.length; a++) {
        var ts = tokenize(aliases[a]);
        for (var t = 0; t < ts.length; t++) toks[ts[t]] = 1;
      }
      _aliasTokens[name] = Object.keys(toks);
    }
  }

  var DOC_GROUPS = { ai_tech: 1, ai_platform: 1, pm_hard: 1, data: 1 };

  /** 命中技能 → [[技能名, 组, 命中次数]]。scope='doc' 只含技术/产品/数据类。 */
  function matchSkills(JD, text, scope) {
    _load(JD);
    var out = [];
    if (!text) return out;
    var low = String(text).toLowerCase();
    for (var g in _skills) {
      if (scope === "doc" && !DOC_GROUPS[g]) continue;
      var arr = _skills[g];
      for (var i = 0; i < arr.length; i++) {
        var name = arr[i][0], pat = arr[i][1];
        pat.lastIndex = 0;
        var n = 0, m;
        while ((m = pat.exec(low))) {
          n++;
          if (m.index === pat.lastIndex) pat.lastIndex++;   // 空匹配保护
        }
        if (n) out.push([name, g, n]);
      }
    }
    return out;
  }

  /** 查询侧词权重：原词 > 技能 token > 同义词扩展。 */
  function queryTerms(JD, q) {
    _load(JD);
    var w = Object.create(null);
    var ts = tokenize(q);
    for (var i = 0; i < ts.length; i++) {
      if (!(w[ts[i]] >= W_TERM)) w[ts[i]] = W_TERM;
    }
    var hits = matchSkills(JD, q, "all");
    for (var h = 0; h < hits.length; h++) {
      var name = hits[h][0], tag = SKILL_TAG + name;
      if (!(w[tag] >= W_SKILL)) w[tag] = W_SKILL;
      // 同义词展开是「问知识库 ≈ 找 RAG」的关键：JD 里写 RAG，用户问知识库。
      var toks = _aliasTokens[name] || [];
      for (var t = 0; t < toks.length; t++) {
        if (!(w[toks[t]] >= W_ALIAS)) w[toks[t]] = W_ALIAS;
      }
    }
    return w;
  }

  return {
    tokenize: tokenize,
    matchSkills: matchSkills,
    queryTerms: queryTerms,
    SKILL_TAG: SKILL_TAG, W_SKILL: W_SKILL, W_ALIAS: W_ALIAS, W_TERM: W_TERM,
    /** 词典是否已加载（测试用） */
    loaded: function () { return !!_skills; },
    reset: function () { _skills = null; _aliasTokens = null; }
  };
});
