/* 结果集的自动图表与自动洞察 —— `kb/chart.py` 的同构移植。
 *
 * 这边是浏览器版，逻辑一行不差地照抄 Python：选图型靠列数、列名语义与值的形态，
 * 洞察靠结果集直接算，**两边都不调模型**。所以这个文件里没有任何网络调用，
 * 也没有随机性 —— 同一份 (cols, rows) 在两地必须得到同一个对象。
 * 它是「同构」而不是「重写」：字段名、字段顺序、判断分支、甚至格式化出来的字符串
 * 都对齐，`tools/port_check_chart.mjs` 逐字段对拍。
 *
 * 移植时踩到并显式复刻的 Python 语义（都是「看着一样、跑起来不一样」的地方）：
 *
 *  1. `_as_num`：Python 的 `float()` 认 `1_000` / `.5` / `1.` / `inf`，**不认** `0x10`；
 *     JS 的 `Number()` 恰好反过来。空串 / `—` / `-` / `NULL` / `null` 算缺失，
 *     千分位逗号与 `%` 是**先全去掉再判断**（所以 `"1,234.5%"` → 1234.5）。
 *  2. `str.strip()` 的空白集与 JS `trim()` 不同（多 `\x1c-\x1f`、`\x85`，少 `\ufeff`），
 *     这里写成显式字符类，不用 `\s`。
 *  3. `round()` / `f"{x:,.1f}"` 是**银行家舍入**，而且作用在 double 的**精确值**上。
 *     JS 的 `toFixed` 是四舍五入：`f"{0.25:,.1f}"` 是 "0.2"，`(0.25).toFixed(1)` 是 "0.3"。
 *     更坑的是「先乘 10 看小数位」这种简化实现会被 `0.05` 骗过（`0.05*10` 在 double 里
 *     正好塌成 0.5，看着像平局，其实精确值是 0.500000000000000027…，Python 判它进位）。
 *     所以格式化走 `_roundScaled`：用 BigInt 把 double 还原成精确十进制再决定舍入方向，
 *     不碰浮点近似。这是移植正确性的一部分，不是炫技。
 *  4. 时间轴排序用 `str(值)` 且 Python 按**码点**比大小（JS 的 `<` 按 UTF-16 码元，
 *     遇到增补平面字符会反着来），故用 `_cmpStr` 逐码点比，并显式带原序号兜底稳定性。
 *
 * 唯一一处**做不到逐位一致**：`kb/chart.py` 没有 `**0.5`，洞察里的除法与 `_fmt` 都是
 * 精确可控的，所以本文件没有这个缺口 —— 缺口在 examples.js 的 similarity，那里有说明。
 */
(function (root) {
  "use strict";

  var MAX_ITEMS = 20;   // 图里最多画几根柱子/几个点
  var DONUT_MAX = 8;    // 超过 8 段就不适合做环形图

  /* Python 的 `$` 允许字符串末尾有一个换行，JS 的 `$` 不允许。`率\n?$` / `…\n?$`
   * 就是 Python `率$` / `^\d{4}…$` 的等价写法 —— 数据里真出现带换行的列名很罕见，
   * 但既然要逐字段对拍，就不留这种「理论上会差」的口子。 */
  var TIME_COL = /月|月份|日期|时间|年|date|month|time|year|季度/i;
  var TIME_VAL = /^\p{Nd}{4}([-/]\p{Nd}{1,2}){0,2}\n?$/u;
  var RATIO_COL = /占比|比例|百分比|提及率|覆盖率|率\n?$|percent|ratio/i;
  /* chart.py 里的 `_NUM_COL` 当前没有任何调用点，故意不搬 —— 少一段没有出口的死代码，
   * 真是哪天真用上了，再连测试一起补。 */

  // ------------------------------------------------------------ Python 语义复刻
  var PY_WS = "\\t\\n\\v\\f\\r\\x1c-\\x1f \\u0085\\u00a0\\u1680" +
              "\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000";
  var STRIP_L = new RegExp("^[" + PY_WS + "]+");
  var STRIP_R = new RegExp("[" + PY_WS + "]+$");

  function _strip(s) {
    return String(s).replace(STRIP_L, "").replace(STRIP_R, "");
  }

  var PY_FLOAT = /^[+-]?(?:inf(?:inity)?|nan|(?:\d(?:_?\d)*(?:\.(?:\d(?:_?\d)*)?)?|\.\d(?:_?\d)*)(?:[eE][+-]?\d(?:_?\d)*)?)$/i;

  function _pyFloat(s) {
    if (!PY_FLOAT.test(s)) return null;
    if (/^[+-]?inf(?:inity)?$/i.test(s)) return s.charAt(0) === "-" ? -Infinity : Infinity;
    if (/^[+-]?nan$/i.test(s)) return NaN;
    return Number(s.replace(/_/g, ""));
  }

  /** 能当数字用就返回数字，否则 null。空串 / — / None 一律算缺失。 */
  function _asNum(v) {
    if (v === null || v === undefined || typeof v === "boolean") return null;
    if (typeof v === "number") return v;          // Python 那边是 float(v)，原样
    var s = _strip(v).replace(/,/g, "").replace(/%/g, "");
    if (!s || s === "—" || s === "-" || s === "NULL" || s === "null") return null;
    return _pyFloat(s);
  }

  /** Python `str(v)`：None 才是 "None"，JS 的 null 得手动翻。 */
  function _pyStr(v) {
    if (v === null || v === undefined) return "None";
    if (v === true) return "True";
    if (v === false) return "False";
    return String(v);
  }

  var DV = new DataView(new ArrayBuffer(8));

  /** double → {m, e}，满足 v = m × 2^e。把浮点还原成精确定义域的入口。 */
  function _exact(v) {
    DV.setFloat64(0, v);
    var hi = DV.getUint32(0), lo = DV.getUint32(4);
    var exp = (hi >>> 20) & 0x7ff;
    var m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    if (exp === 0) return { m: m, e: -1074 };              // 次正规数
    return { m: m + (1n << 52n), e: exp - 1075 };
  }

  /** round(v × 10^k)，逢半取偶（Python 的 round / format 语义），v 必须非负。 */
  function _roundScaled(v, k) {
    var p = _exact(v), e = p.e + k;            // v × 10^k = m × 2^(e+k) × 5^k
    var n = p.m, d = 1n;
    if (e >= 0) n = n << BigInt(e); else d = 1n << BigInt(-e);
    if (k) n = n * (5n ** BigInt(k));
    var q = n / d, r = n % d, twice = r * 2n;
    if (twice > d || (twice === d && (q & 1n) === 1n)) q += 1n;
    return q;
  }

  /** round(浮点数) → 精确整数（Python 的 round(x) 不带 ndigits 时返回 int）。
   *  刻意的例外：`inf` / `nan` 在 Python 侧是**抛异常**的（OverflowError / ValueError），
   *  这里不复刻异常 —— 结果集里出现 inf/nan 只能来自人为构造的字符串，SQL 聚合不会产出。 */
  function _pyRound(v) {
    var q = _roundScaled(Math.abs(v), 0);
    return v < 0 ? -q : q;
  }

  /** `f"{整数:,}"`：三位一组的千分位。 */
  function _group(bigint) {
    return bigint.toString().replace(/\B(?=(\d{3})+$)/g, ",");
  }

  /** `f"{v:.kf}"`（`group` 为真时是 `f"{v:,.kf}"`，才带千分位 —— Python 的
   *  逗号是格式串里的显式选项，洞察里的 `:.0f` / `:.1f` 是**不带**千分位的，
   *  这里必须跟着走，否则「12346 倍」会被写成「12,346 倍」）。
   *  k 只有 0 和 1 两种用法。注意 `:.0f` 会印出 "-0"（Python 也这样），
   *  而 `f"{int(round(x)):,}"` 不会 —— 两个分支不能互相顶替，
   *  所以 `_fmt` 的整数分支走 `_pyRound` 而不是这里。 */
  function _fixed(v, k, group) {
    var neg = v < 0 || (v === 0 && 1 / v < 0);
    var s = _roundScaled(Math.abs(v), k).toString();
    if (s.length <= k) s = new Array(k + 2 - s.length).join("0") + s;
    var ip = s.slice(0, s.length - k), fp = s.slice(s.length - k);
    if (group) ip = _group(BigInt(ip));
    return (neg ? "-" : "") + ip + (k ? "." + fp : "");
  }

  /** Python `_fmt`：整数补千分位、非整数保留 1 位小数。 */
  function _fmt(v) {
    var n = _asNum(v);
    if (n === null) return _pyStr(v);
    var iv = _pyRound(n);                      // f"{int(round(n)):,}"
    if (Math.abs(n - Number(iv)) < 1e-9) {
      return (iv < 0n ? "-" : "") + _group(iv < 0n ? -iv : iv);
    }
    return _fixed(n, 1, true);                 // f"{n:,.1f}"
  }

  /** Python 的字符串比大小按码点，JS 的 `<` 按 UTF-16 码元。 */
  function _cmpStr(a, b) {
    if (a === b) return 0;
    var x = Array.from(a), y = Array.from(b), n = Math.min(x.length, y.length);
    for (var i = 0; i < n; i++) {
      var cx = x[i].codePointAt(0), cy = y[i].codePointAt(0);
      if (cx !== cy) return cx < cy ? -1 : 1;
    }
    return x.length - y.length;
  }

  /** Python 的 `v or ""`：None / "" / 0 / False 都取空串。 */
  function _orEmpty(v) {
    return (v === null || v === undefined || v === "" || v === 0 || v === false)
      ? "" : String(v);
  }

  // ------------------------------------------------------------ 基础判断
  /** 每列判定为 'num' / 'time' / 'text'。全空列算 text。 */
  function _colKinds(cols, rows) {
    var kinds = [];
    for (var i = 0; i < cols.length; i++) {
      var vals = rows.map(function (r) { return r[i]; });
      var nonnull = vals.filter(function (v) {
        return _asNum(v) !== null ||
               (v !== null && v !== undefined &&
                ["", "—", "-"].indexOf(_strip(v)) < 0);
      });
      var nums = vals.filter(function (v) { return _asNum(v) !== null; });
      // nums ⊆ nonnull 恒成立，所以「长度相等 + 非空」= 非空值全是数字
      if (nums.length === nonnull.length && nonnull.length) {
        kinds.push("num");
        continue;
      }
      var name = _pyStr(cols[i]);
      var sample = vals.filter(function (v) {
        return v !== null && v !== undefined && _strip(v) !== "";
      }).map(function (v) { return String(v); }).slice(0, 5);
      if (TIME_COL.test(name) ||
          (sample.length && sample.every(function (s) { return TIME_VAL.test(s); }))) {
        kinds.push("time");
      } else {
        kinds.push("text");
      }
    }
    return kinds;
  }

  // ------------------------------------------------------------ 图表规格
  /** 返回图表规格普通对象，或 null（这张结果集不适合画图）。 */
  function build(cols, rows, question, maxItems) {
    cols = (cols || []).slice();
    rows = (rows || []).map(function (r) { return r.slice(); });
    if (question === undefined || question === null) question = "";
    if (maxItems === undefined || maxItems === null) maxItems = MAX_ITEMS;
    if (!cols.length || !rows.length) return null;

    var kinds = _colKinds(cols, rows);

    // 单值结果 → 大数字卡。1×1 直接给数；1×2 把文本列当标签。
    if (rows.length === 1) {
      var nums = [];
      kinds.forEach(function (k, idx) { if (k === "num") nums.push(idx); });
      if (nums.length === 1) {
        var i = nums[0], label = "";
        for (var j = 0; j < cols.length; j++) {
          if (j !== i && kinds[j] !== "num") { label = _pyStr(cols[j]); break; }
        }
        if (kinds[0] === "num") {
          label = cols.length > 1 ? _pyStr(cols[1]) : "";
        }
        return {
          type: "kpi",
          title: question || (label || "结果"),
          value: _fmt(rows[0][i]),
          raw: _asNum(rows[0][i]),
          label: label || _pyStr(cols[i]),
          unit: RATIO_COL.test(_pyStr(cols[i])) ? "%" : "",
        };
      }
    }

    // 多行 → 找一条分类轴 + 最多两条数值轴
    var xi = null;
    for (var a = 0; a < kinds.length; a++) {
      if (kinds[a] === "text" || kinds[a] === "time") { xi = a; break; }
    }
    var yis = [];
    kinds.forEach(function (k, idx) { if (k === "num") yis.push(idx); });
    if (xi === null || !yis.length) return null;

    // 聚合结果常返回「岗位数 + 占比」这样一对派生列 —— 占比是岗位数除以总数，
    // 两个都画等于把同一件事说两遍。只留分子，把「有占比」这个事实单独记下来，
    // 它决定了这组数据是不是「构成」（构成才适合环形图）。
    var ratioPresent = RATIO_COL.test(_pyStr(cols[yis[0]]));
    if (yis.length >= 2 && RATIO_COL.test(_pyStr(cols[yis[1]])) && !ratioPresent) {
      ratioPresent = true;
      yis = yis.slice(0, 1);
    } else {
      yis = yis.slice(0, 2);
    }

    var nt = kinds[xi] === "time";
    var truncated = false;
    if (nt) {                                // 时间轴必须按时间升序，否则折线会来回跳
      var order = rows.map(function (_v, idx) { return idx; });
      order.sort(function (m, n) {
        var c = _cmpStr(_orEmpty(rows[m][xi]), _orEmpty(rows[n][xi]));
        return c !== 0 ? c : m - n;          // 显式带序号，不依赖引擎是否稳定排序
      });
      rows = order.map(function (idx) { return rows[idx]; });
    } else if (rows.length > maxItems) {     // 分类轴按原序取前 N（通常是已排序的 Top N）
      truncated = true;
      rows = rows.slice(0, maxItems);
    }

    var x = rows.map(function (r) { return r[xi] == null ? "" : String(r[xi]); });
    var series = yis.map(function (i2) {
      return {
        label: _pyStr(cols[i2]),
        values: rows.map(function (r) {
          var n = _asNum(r[i2]);
          return n !== null ? n : (r[i2] == null ? "" : String(r[i2]));
        }),
        ratio: RATIO_COL.test(_pyStr(cols[i2])),
      };
    });

    var ctype;
    if (nt) ctype = "line";
    else if (yis.length === 2) ctype = "grouped_bar";
    else if (ratioPresent && rows.length <= DONUT_MAX) ctype = "donut";
    else ctype = rows.length > 6 ? "hbar" : "bar";

    return {
      type: ctype,
      title: question || "结果",
      x: { label: _pyStr(cols[xi]), values: x },
      x_kind: kinds[xi],
      series: series,
      truncated: truncated,
      shown: rows.length,
    };
  }

  // ------------------------------------------------------------ 自动洞察
  /** 从结果集里确定性地提取几条观察。算不出来就返回空数组，不硬凑。 */
  function insights(cols, rows, spec, limit) {
    cols = (cols || []).slice();
    rows = (rows || []).map(function (r) { return r.slice(); });
    if (limit === undefined || limit === null) limit = 3;
    if (!cols.length || !rows.length) return [];
    // Python 的 `spec or build(cols, rows) or {}`：**空 dict 也是假值**，JS 里 `{}` 是真值。
    // 少这一句，`insights(cols, rows, {})` 就会走错分支（该自建 spec 却当成「无 type」）。
    if (!spec || (typeof spec === "object" && !Array.isArray(spec) &&
                  Object.keys(spec).length === 0)) {
      spec = build(cols, rows) || {};
    }
    var t = spec.type === undefined ? null : spec.type;
    var out = [];

    if (t === "kpi") return [];               // 单值没有可比较的对象，没什么可说的

    var kinds = _colKinds(cols, rows);
    var xi = null;
    for (var a = 0; a < kinds.length; a++) {
      if (kinds[a] === "text" || kinds[a] === "time") { xi = a; break; }
    }
    var yis = [];
    kinds.forEach(function (k, idx) { if (k === "num") yis.push(idx); });
    yis = yis.slice(0, 2);
    if (xi === null || !yis.length) return [];
    var yi = yis[0];

    var pairs = [];
    rows.forEach(function (r) {
      var n = _asNum(r[yi]);
      if (n !== null) pairs.push([r[xi] == null ? "" : String(r[xi]), n]);
    });
    if (pairs.length < 2) return [];

    // Python 的 max/min 在同值时取**靠前**那个，_maxBy/_minBy 照此实现
    function maxBy(ps) {
      var best = ps[0];
      for (var i = 1; i < ps.length; i++) if (ps[i][1] > best[1]) best = ps[i];
      return best;
    }
    function minBy(ps) {
      var best = ps[0];
      for (var i = 1; i < ps.length; i++) if (ps[i][1] < best[1]) best = ps[i];
      return best;
    }

    if (kinds[xi] === "time") {
      var first = pairs[0], last = pairs[pairs.length - 1];
      if (first[1]) {
        var delta = (last[1] - first[1]) / Math.abs(first[1]) * 100;
        if (Math.abs(delta) >= 5) {
          out.push("趋势：从 " + first[0] + " 的 " + _fmt(first[1]) + " 变为 " +
                   last[0] + " 的 " + _fmt(last[1]) + "，" +
                   (delta > 0 ? "上升" : "下降") + " " + _fixed(Math.abs(delta), 0) + "%。");
        }
      }
      var peak = maxBy(pairs), low = minBy(pairs);
      out.push("峰值在 " + peak[0] + "（" + _fmt(peak[1]) + "），" +
               "低谷在 " + low[0] + "（" + _fmt(low[1]) + "）。");
      return out.slice(0, limit);
    }

    var total = 0;
    pairs.forEach(function (p) { total += p[1]; });
    var top = maxBy(pairs), bot = minBy(pairs);

    if (total > 0) {
      var share = top[1] / total * 100;
      if (t === "donut") {
        out.push("第一大类是 " + top[0] + "，占 " + _fixed(share, 1) + "%。");
      } else {
        out.push(top[0] + " 最高（" + _fmt(top[1]) + "），占这 " + pairs.length +
                 " 项合计的 " + _fixed(share, 1) + "%。");
      }
    }

    if (bot[1] >= 3 && top[1] / bot[1] >= 3) {
      // 要求最低项本身不小于 3 —— 否则「最低的那个只招了 1 个人」会把比值
      // 拉到几百倍，结论正确但没有任何信息量。
      out.push("极差较大：最高（" + top[0] + "）是最低（" + bot[0] + "）的 " +
               _fixed(top[1] / bot[1], 0) + " 倍。");
    }

    if (pairs.length >= 4 && total > 0) {
      // 头部集中度：前 3 项占比。用来判断「是不是少数几个对象撑起了大多数」
      var sorted = pairs.slice().sort(function (m, n) {
        return m[1] < n[1] ? 1 : (m[1] > n[1] ? -1 : 0);
      });
      var head3 = 0;
      sorted.slice(0, 3).forEach(function (p) { head3 += p[1]; });
      var ratio = head3 / total * 100;
      if (ratio >= 60) out.push("头部集中：前 3 项合计占 " + _fixed(ratio, 0) + "%。");
      else if (ratio <= 25) out.push("分布分散：前 3 项合计仅占 " + _fixed(ratio, 0) + "%。");
    }

    return out.slice(0, limit);
  }

  root.JDChart = { build: build, insights: insights, MAX_ITEMS: MAX_ITEMS, DONUT_MAX: DONUT_MAX };
})(typeof globalThis !== "undefined" ? globalThis : this);
