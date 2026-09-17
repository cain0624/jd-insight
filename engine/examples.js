/* SQL 样例库 —— `kb/example_bank.py` 的同构移植（浏览器版）。
 *
 * 为什么本地版只有一个 JSON 文件、线上却要拆成两层：本地是单机，样例库就一个
 * 文件；线上每个用户都有自己的沉淀，只能落在自己浏览器里。所以这里把存储做成
 * 可注入的 `storage`（默认空实现），主程序换成 localStorage 适配器即可，
 * 检索/相似度/格式化这套逻辑一行都不用改。
 *
 * 三层含义：
 *   · `seed()`    —— 导出时写进库里的那份快照（`example` 表，含导出于本机时的沉淀）
 *   · `storage`   —— 用户本地沉淀层，只存「库里那份之外」的样例
 *   · `load()`    —— 两层合并，同问题时本地覆盖库里那份（下次导出更新了种子样例，
 *                    用户改过的那条仍然以他改的为准，没改过的自动跟着新版本走）
 *
 * **检索不引入向量库**，理由与 Python 侧一致：样例总量只有几十条，中文短句的
 * bigram 重叠已经够准，而且相似度能直接打印出来给人看。**反馈沉淀是关键**：
 * 同一个问题第二次问，样例库里已有标准答案，模型照着改比从零生成稳得多。
 *
 * 移植时踩到并显式复刻的 Python 语义：
 *
 *  1. `_bigrams` 的正则 `[^\w\u4e00-\u9fff]+` 在 Python 里是 **Unicode 语义**的：
 *     `\w` 认中文。JS 的 `\w` 只认 ASCII，照抄会把整句中文删光、相似度全变 0
 *     （而且还不会报错，只是「搜什么都是空」，最难查的那种）。这里写成
 *     `[^\p{L}\p{N}_]`（= Python 的 `\w` 在 str 上的集合）。
 *  2. bigram 要按**码点**切，不能按 UTF-16 码元切：Python 的 `len("𠮷")` 是 1，
 *     JS 是 2。用 `Array.from` 切，两边才对得上。
 *  3. `similarity` 的分母 Python 写的是 `n ** 0.5`，走的是平台 libm 的 `pow`
 *     —— macOS 上它在约 0.14% 的输入上比正确舍入的平方根差 1 ulp（实测 30 万以内
 *     有 429 个整数），而 `Math.sqrt` 是 IEEE 正确舍入的。**这一处做不到逐位一致**：
 *     要逐位复刻就得把 Apple libm 的 pow 连同它的 128 项查表整段搬进来（为了
 *     0.14% 的输入差 1 ulp 而塞 8KB 常数，不值当），而且 Python 侧的值本来就随
 *     平台 libm 变（glibc 的 pow 是正确舍入的，同一段代码在 Linux 上跑出来又是
 *     另一个值）。所以这里选正确舍入的 `sqrt`：误差 ≤1 ulp、永远不改变排序，
 *     跨平台反而更稳定。对拍脚本里对这个差异有专门的量化断言，不做静默放过。
 *  4. `str.strip()` / `rstrip(";")` 的字符集与 JS 的 `trim()` 不同，见 `_strip`。
 */
(function (root) {
  "use strict";

  var NOOP_STORAGE = { read: function () { return []; }, write: function () {} };

  // Python str.strip() 的空白集：比 JS 的 trim() 多 \x1c-\x1f 与 \x85，少 \ufeff
  var PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\u0085\\u00a0\\u1680" +
              "\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
  var STRIP_L = new RegExp("^[" + PY_WS + "]+");
  var STRIP_R = new RegExp("[" + PY_WS + "]+$");

  function _strip(s) {
    return String(s).replace(STRIP_L, "").replace(STRIP_R, "");
  }

  function _db() {
    var d = root.JD;
    if (!d) throw new Error("JDExamples 需要先装载 JDDB（globalThis.JD）");
    return d;
  }

  // ------------------------------------------------------------ 存取
  /** 导出时写进 `example` 表的那份快照。字段与库里一致：question / sql / source。
   *  每次现查而不做内存缓存：库里那份是不可变的，缓存能省的那点开销不值得引入
   *  「什么时候该失效」这个额外状态。 */
  function seed() {
    return _db().q("SELECT question, sql, source FROM example").rows.map(function (row) {
      return { question: row[0], sql: row[1], source: row[2] };
    });
  }

  /** 库里那份 + 本地沉淀。同问题时本地覆盖库里那份，位置不变（跟 Python 的
   *  「命中就原地改」一致，顺序对 few-shot 来说是稳定的）。 */
  function load() {
    // 用无原型的对象当索引：问题文本是数据，撞上 "__proto__" 这类键名时不能变成原型写入
    var out = seed(), byQ = Object.create(null);
    out.forEach(function (e, i) { byQ[e.question] = i; });
    api.storage.read().forEach(function (e) {
      var i = byQ[e.question];
      if (i === undefined) { byQ[e.question] = out.length; out.push(e); }
      else out[i] = e;
    });
    return out;
  }

  /** 只把「库里那份之外」的样例写回沉淀层：库里那份不重复落盘，
   *  否则下次导出换了种子样例，本地那份旧快照会一直盖在新版本上面。 */
  function _persist(merged) {
    var base = Object.create(null);
    seed().forEach(function (e) { base[e.question] = e; });
    api.storage.write(merged.filter(function (e) {
      var b = base[e.question];
      return !(b && b.sql === e.sql && b.source === e.source);
    }));
  }

  // ------------------------------------------------------------ 检索
  /* `[^\w\u4e00-\u9fff]+` 的等价写法：Python 的 str `\w` = 字母 + 数字 + 下划线 */
  var DROP = /[^\p{L}\p{N}_]+/gu;

  /** 中文用 bigram；英文原样小写。与 RAG 侧的切分思路保持一致。 */
  function _bigrams(s) {
    s = (s === null || s === undefined ? "" : String(s)).toLowerCase().replace(DROP, "");
    var cp = Array.from(s);                       // 按码点切，见文件头注释 2
    if (cp.length < 2) return new Set(cp);        // 单字（或空）自成一个 bigram
    var out = new Set();
    for (var i = 0; i < cp.length - 1; i++) out.add(cp[i] + cp[i + 1]);
    return out;
  }

  /** bigram 余弦式相似度，0~1。分母开方是标准做法，避免长句被系统性压低。 */
  function similarity(a, b) {
    var x = _bigrams(a), y = _bigrams(b);
    if (!x.size || !y.size) return 0.0;
    var inter = 0;
    var small = x.size <= y.size ? x : y, big = small === x ? y : x;
    small.forEach(function (g) { if (big.has(g)) inter++; });
    if (!inter) return 0.0;
    return inter / Math.sqrt(x.size * y.size);    // 见文件头注释 3
  }

  /** 返回 [[score, example], ...]，按相似度降序，同分时种子样例优先。 */
  function search(question, k, minScore) {
    if (k === undefined || k === null) k = 3;
    if (minScore === undefined || minScore === null) minScore = 0.0;
    var scored = load().map(function (e) {
      return [similarity(question, e.question || ""), e];
    });
    scored = scored.filter(function (p) { return p[0] > 0 && p[0] >= minScore; });
    scored = scored.map(function (p, i) { return [p[0], p[1], i]; });
    scored.sort(function (m, n) {
      if (m[0] !== n[0]) return m[0] < n[0] ? 1 : -1;
      var sm = m[1].source === "seed" ? 0 : 1, sn = n[1].source === "seed" ? 0 : 1;
      return sm !== sn ? sm - sn : m[2] - n[2];   // 末位用原序号，不依赖引擎的稳定排序
    });
    return scored.slice(0, k).map(function (p) { return [p[0], p[1]]; });
  }

  function formatFewshot(matches) {
    return matches.map(function (m) {
      return "问：" + m[1].question + "\nSQL：" + m[1].sql;
    }).join("\n\n");
  }

  // ------------------------------------------------------------ 写入
  /** 新增或覆盖一条样例。返回 true 表示新增，false 表示更新了已有条目。 */
  function add(question, sql, source) {
    if (source === undefined || source === null) source = "learned";
    var q = _strip(question === null || question === undefined ? "" : question);
    var s = _strip(sql === null || sql === undefined ? "" : sql).replace(/;+$/, "");
    s = _strip(s);
    if (!q || !s) return false;
    var ex = load();
    for (var i = 0; i < ex.length; i++) {
      if (ex[i].question === q) {
        ex[i].sql = s;
        ex[i].source = source;
        _persist(ex);      // 不写 added_at：线上没有「入库日期」的展示位，库里也没这列
        return false;
      }
    }
    ex.push({ question: q, sql: s, source: source });
    _persist(ex);
    return true;
  }

  function stats() {
    var ex = load();
    function n(src) {
      return ex.filter(function (e) { return e.source === src; }).length;
    }
    return { total: ex.length, seed: n("seed"), learned: n("learned") };
  }

  var api = {
    // 默认无操作：Node 对拍与「没换适配器」的场景都不落盘
    storage: NOOP_STORAGE,
    seed: seed,
    load: load,
    similarity: similarity,
    search: search,
    formatFewshot: formatFewshot,
    add: add,
    stats: stats,
  };

  root.JDExamples = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
