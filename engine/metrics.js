/* 指标层 + 实体识别（kb/metrics.py 的同构移植）。
 *
 * 这一层是「零 Key 也能问」的关键：命中命名指标就用模板 SQL，完全不调模型。
 * 所以它是线上版最该保证正确的部分 —— 出错不会报异常，只会**安静地给错数字**。
 *
 * 命名指标本身不写在这里，而是从导出库的 `metric` 表读（源头仍是
 * kb/metrics.py 的 METRICS），避免两侧各维护一份别名表。
 */
(function (root, factory) {
  var api = factory();
  root.JDMetrics = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  // 「计数」问法才走参数化聚合；问「有哪些」是明细查询，必须交回 LLM。
  var COUNT_HINT = /多少|几个|有几|几家|几条|数量|总数|多少个|多家|几家/;

  // 额外限定词：一旦出现，说明问的不是「某实体的总量」而是带条件的子集统计
  // （如「百度有多少**真 AI** 岗」）。这时简单 count 必然答非所问 ——
  // 问「百度有多少真 AI 岗」会被答成「百度总岗位数」。命中这张表就交回 LLM。
  var EXTRA_FILTER = new RegExp(
    "真\\s*ai|伪\\s*ai|半\\s*ai|真伪|ai_level|" +
    "实习|校招|正式岗|社招|外包|" +
    "本科|硕士|博士|学历|" +
    "平均|中位|最大|最小|最长|最短|" +
    "上半年|下半年|季度|" +
    "强信号|strong_signals|role_kind", "i");

  function hasAscii(s) { return /[A-Za-z0-9]/.test(s); }

  function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\\/\-]/g, "\\$&"); }

  /** 英文/数字要求词边界（否则 `storage` 会命中 `RAG`），中文直接子串。 */
  function contains(haystack, needle) {
    if (!needle) return false;
    if (hasAscii(needle)) {
      return new RegExp("(?<![A-Za-z0-9])" + escRe(needle) + "(?![A-Za-z0-9])", "i")
        .test(haystack);
    }
    return haystack.indexOf(needle) >= 0;
  }

  /* ---------- 实体表 ---------- */
  function entities(JD) {
    if (JD.__ents) return JD.__ents;
    var skills = {}, cities = {}, companies = {};
    JD.all("SELECT DISTINCT skill FROM job_skill").forEach(function (r) {
      var s = r[0] == null ? "" : String(r[0]);
      s.split("/").forEach(function (part) {
        part = part.trim();
        if (part.length >= 2 && skills[part] === undefined) skills[part] = s;
      });
    });
    // 城市先算：注册公司简称时要拿它做排他判断，顺序不能反。
    JD.all("SELECT DISTINCT city FROM job").forEach(function (r) {
      String(r[0] == null ? "" : r[0]).split(/[/、,，|]/).forEach(function (part) {
        part = part.trim();
        if (part.length >= 2 && cities[part] === undefined) cities[part] = part;
      });
    });
    JD.all("SELECT DISTINCT company FROM job").forEach(function (r) {
      var c = String(r[0] == null ? "" : r[0]).trim();
      if (!c) return;
      if (companies[c] === undefined) companies[c] = c;
      // 前两字注册成简称，让简称也能命中全名。
      // 但若前两字本身是城市名，绝不能注册：库里存在「北京元渡咨询管理」
      // 这类公司，注册后会与城市实体撞车 —— 用户问「那北京呢」会同时命中
      // 「城市·北京」和「公司·北京元渡咨询管理」，追问改写就拼出
      // 「北京北京元渡咨询管理有多少个岗位？」这种句子。
      if (c.length >= 4 && cities[c.substr(0, 2)] === undefined
          && companies[c.substr(0, 2)] === undefined) {
        companies[c.substr(0, 2)] = c;
      }
    });
    JD.__ents = { skills: skills, companies: companies, cities: cities };
    return JD.__ents;
  }

  function findAll(question, table) {
    var found = {};   // {库中真实值: 命中的匹配键}
    for (var key in table) {
      if (contains(question, key)) {
        var val = table[key], prev = found[val];
        if (prev === undefined || key.length > prev.length) found[val] = key;
      }
    }
    return found;
  }

  function longest(found) {
    var bestKey = null, bestVal = null;
    for (var val in found) {
      if (bestKey === null || found[val].length > bestKey.length) {
        bestKey = found[val]; bestVal = val;
      }
    }
    return bestKey === null ? null : [bestKey, bestVal];
  }

  /* ---------- 命名指标 ---------- */
  function loadMetrics(JD) {
    if (JD.__metrics) return JD.__metrics;
    JD.__metrics = JD.all("SELECT key, name, aliases, descr, sql FROM metric")
      .map(function (r) {
        var aliases = [];
        try { aliases = JSON.parse(r[2] || "[]"); } catch (e) { aliases = []; }
        return { key: r[0], name: r[1], aliases: aliases, desc: r[3], sql: r[4] };
      });
    return JD.__metrics;
  }

  function matchFixed(JD, question) {
    var best = null;
    loadMetrics(JD).forEach(function (m) {
      m.aliases.forEach(function (a) {
        if (contains(question, a) && (best === null || a.length > best[1])) {
          best = [m, a.length];
        }
      });
    });
    return best ? best[0] : null;
  }

  function buildCount(sk, co, ci) {
    var conds = [], params = [], bits = [], join = "";
    if (sk) {
      join = " JOIN job_skill s ON s.job_id = j.job_id";
      conds.push("s.skill = ?"); params.push(sk[1]); bits.push("技能=" + sk[1]);
    }
    if (ci) { conds.push("j.city LIKE ?"); params.push("%" + ci[1] + "%"); bits.push("城市=" + ci[1]); }
    if (co) { conds.push("j.company = ?"); params.push(co[1]); bits.push("公司=" + co[1]); }
    var where = conds.length ? " WHERE " + conds.join(" AND ") : "";
    return {
      name: conds.length ? "岗位数统计" : "岗位总数",
      sql: "SELECT count(DISTINCT j.job_id) AS 岗位数 FROM job j" + join + where,
      params: params,
      detail: bits.join("、"),
      source: "metric"
    };
  }

  function preview(hit) {
    var s = hit.sql;
    (hit.params || []).forEach(function (p) {
      s = s.replace("?", "'" + p + "'");
    });
    return s.replace(/\s+/g, " ").trim();
  }

  /** 返回 Match 或 null（null = 交给 LLM 生成）。 */
  function match(JD, question) {
    var q = (question || "").trim();
    if (!q) return null;
    var e = entities(JD);
    var skAll = findAll(q, e.skills), coAll = findAll(q, e.companies),
        ciAll = findAll(q, e.cities);
    var sk = longest(skAll), co = longest(coAll), ci = longest(ciAll);
    var hasEntity = !!(sk || co || ci);

    // 并列 / 对比句式（「A 和 B 各多少」）里会有多个同类实体，
    // 而参数化聚合只支持单实体 —— 硬答必然漏条件，一律交回 LLM 拼 JOIN 和 IN。
    var multi = Math.max(Object.keys(skAll).length, Object.keys(coAll).length,
                         Object.keys(ciAll).length) > 1;

    // ① 固定指标：只有在没识别出实体时才敢用。
    //    否则会出现「问某公司的岗位族分布，答全库的岗位族分布」这种答非所问。
    var fixed = matchFixed(JD, q);
    if (fixed && !hasEntity) {
      return { name: fixed.name, sql: fixed.sql, params: [], detail: fixed.key,
               source: "metric" };
    }

    // ② 实体 + 计数问法 → 参数化聚合（带额外限定词或多实体时交回 LLM）
    if (hasEntity && !multi && COUNT_HINT.test(q) && !EXTRA_FILTER.test(q)) {
      return buildCount(sk, co, ci);
    }
    return null;
  }

  /* ---------- 对外：实体抽取 ---------- */
  function entityPairs(JD, question) {
    var q = (question || "").trim();
    if (!q) return {};
    var e = entities(JD), out = {};
    [["skill", e.skills], ["company", e.companies], ["city", e.cities]]
      .forEach(function (kv) {
        var found = findAll(q, kv[1]);
        var pairs = [];
        for (var val in found) pairs.push([found[val], val]);
        if (pairs.length) out[kv[0]] = pairs;
      });
    return out;
  }

  function entitiesOf(JD, question) {
    var pairs = entityPairs(JD, question), out = {};
    for (var k in pairs) out[k] = pairs[k].map(function (p) { return p[1]; });
    return out;
  }

  return { match: match, entityPairs: entityPairs, entitiesOf: entitiesOf,
           preview: preview, matchFixed: matchFixed, buildCount: buildCount,
           contains: contains, loadMetrics: loadMetrics,
           reset: function (JD) { JD.__ents = null; JD.__metrics = null; } };
});
