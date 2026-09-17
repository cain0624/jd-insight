/* 求职画像（五维能力模型）的浏览器版 —— `kb/profile.py` 的同构移植。
 *
 * 为什么要有这一份：GitHub Pages 只能托管静态文件，本地那套「Python 后端 +
 * 单文件前端」的后端没了。但重写一遍业务逻辑等于把口径交给第二个人维护，
 * 所以规矩是：**这个文件里每一处判断都能在 profile.py 里指到对应的行**，
 * 并由 tools/port_check_profile.mjs 逐字段对拍到 0 失败才算移植完成。
 *
 * 分工是明确的「搬一半、读一半」：
 *   · 搬 —— 只有 analyze() 的统计与建议、cities() 的聚合。这两段含真正的业务
 *     判断（缺口语义、覆盖门槛、建议措辞），必须逐字对齐。
 *   · 读 —— 目标岗位画像（target 表）、维度定义（dim）、技能→维度/别名
 *     （skill_dim）、方向清单与技能清单（meta）。这些导出时已经算好，前端
 *     再算一次只是多一个「两边算得不一样」的机会，没有任何好处。
 *
 * Python 与 JS 的语义差异是要**逐个抹平**的，不能靠放宽比较精度蒙过去。
 * 这里复刻了：round() 的银行家舍入、':.0f' 的平局取值、str(float) 的 ".0"、
 * 按码点而非 UTF-16 码元的字典序、str.strip() 的空白集合、max() 取首个最大值、
 * int() 的向零截断。其中只有一部分能在当前这份数据上真的分叉（银行家舍入、
 * ':.0f'、负数年限的 int()、strip 的空白集合 —— 对拍里都有能把它打红的用例），
 * 其余是按语言规格复刻、这份数据暂时证明不了的，清单见对拍脚本的文件头。
 * 每一处下面都写了「为什么」。
 *
 * 经典脚本：无 import/export、无 require、无 Node API，用 IIFE 挂 globalThis。
 * 注意 JD 是**每次调用时**才从 globalThis 取的 —— 装载顺序是先 eval 脚本、
 * 再由 JDDB.make() 把连接挂上，装载期取只会拿到 undefined。
 */
(function (root) {
  "use strict";

  /* ============================ 数据访问 ============================ */

  function JD() {
    var d = root.JD;
    if (!d) throw new Error("JDProfile：请先装载 db.js 并挂好 globalThis.JD");
    return d;
  }

  /* 浏览器里这份库是一份只读快照，一次会话里反复 JSON.parse 同一份 target
   * payload、反复编译同一批正则纯属浪费。Python 那边缓存要按库文件指纹失效，
   * 这里不存在「库被换了」这回事，所以不抄那一套。 */
  var _memo = Object.create(null);
  function memo(key, make) {
    if (!(key in _memo)) _memo[key] = make();
    return _memo[key];
  }

  /* ======================= Python 语义复刻层 ======================= */

  /* round(x, n)：Python 是**银行家舍入**（.5 取偶），且是对它手上那个双精度的
   * 精确值做十进制舍入；JS 的 Math.round 是 .5 向上。两者在整数位会真的分叉：
   * overall 就有落在 40.5 的输入（direction=all、各维 have=1/0/0/2/1），
   * Python 给 40、Math.round 给 41。所以这里必须精确复刻，
   * 而不是「比较时放宽到整数相同」。
   *
   * n ≥ 1 也不能用 `Number(x.toFixed(n))`。曾经的理由是「平局要求
   * x = (2m+1)/(2·10^n)，分母带 5 的因子，不可能是双精度数的精确值」——
   * 这句是**错的**：只要 n 位小数以下正好是二进制可精确表示的那几个尾巴
   * 就会撞上平局。反例：96.625（= 96 + 5/8，精确可表示），
   * Python `round(96.625, 2)` 给 96.62，`(96.625).toFixed(2)` 给 "96.63"。
   * 20 万个随机双精度里有 24 个这样分叉（都是 .125/.375/.625/.875 结尾）。
   * 本地库的 ratio/pct 恰好取不到这些值，所以对拍没红 —— 但这种「恰好没撞上」
   * 不是正确性。现在统一走下面的精确路径。
   */
  function pyRound(x, n) {
    if (!isFinite(x)) return x;            // Python 在这里抛异常，正常路径到不了
    if (n === undefined || n === null || n < 1) return roundHalfEven(x);
    var f = Math.pow(10, n);
    var q = Number(roundScaled(Math.abs(x), n)) / f;
    return x < 0 ? -q : q;
  }

  /* round(x) 的整数位情形：把双精度拆成「整数尾数 × 2^指数」，
   * 在 BigInt 上做精确的十进制舍入（余数过半就进，正好一半取偶）。 */
  function _exact(v) {
    var dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v);
    var hi = dv.getUint32(0), lo = dv.getUint32(4);
    var expBits = (hi >>> 20) & 0x7ff;
    var m = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
    var e;
    if (expBits === 0) {
      e = -1074;                            // 次正规数：没有隐含的 1 位
    } else {
      m |= 1n << 52n;
      e = expBits - 1075;
    }
    return { m: m, e: e };
  }

  /** round(v × 10^k) 的精确整数值（逢半取偶），返回 BigInt。v 必须非负。 */
  function roundScaled(v, k) {
    var p = _exact(v), e = p.e + k;
    var n = p.m, d = 1n;
    if (e >= 0) n = n << BigInt(e); else d = 1n << BigInt(-e);
    if (k) n = n * (5n ** BigInt(k));       // ×10^k 里那 5^k 的部分必须显式补上
    var q = n / d, r = n % d, twice = r * 2n;
    if (twice > d || (twice === d && (q & 1n) === 1n)) q += 1n;
    return q;
  }

  function roundHalfEven(x) {
    var neg = x < 0;
    var q = roundScaled(Math.abs(x), 0);
    var r = Number(q);
    return neg ? -r : r;
  }

  /* f"{v:.0f}"：同样是银行家舍入（format(2.5, '.0f') == '2'），
   * 所以不能图省事写 Math.round —— 那会在占比文案上给出不同的整数。 */
  function fmt0(v) { return String(roundHalfEven(v)); }

  /* f"{v:.1f}"：一位小数不可能出现精确平局，toFixed 就是规格里的精确舍入。 */
  function fmt1(v) { return v.toFixed(1); }

  /* f"{cap:g}"：Python 的 'g' 默认 6 位有效数字，定点/指数形式按指数范围切换，
   * 并剥掉尾随的 0。cap 是 round(x,2) 的产物（≤2 位小数、量级 0~10），
   * 落点一定是定点形式，但这里把切换规则一并写上，免得日后 cap 变大就悄悄变形。 */
  function fmtG(v) {
    if (!isFinite(v)) return String(v);
    if (v === 0) return Object.is(v, -0) ? "-0" : "0";
    var parts = v.toExponential(5).split("e");
    var mant = parts[0], exp = parseInt(parts[1], 10);
    if (exp < -4 || exp >= 6) {
      mant = mant.replace(/0+$/, "").replace(/\.$/, "");
      return mant + "e" + (exp < 0 ? "-" : "+") +
        (Math.abs(exp) < 10 ? "0" : "") + Math.abs(exp);
    }
    var f = v.toFixed(Math.max(0, 5 - exp));
    if (f.indexOf(".") !== -1) f = f.replace(/0+$/, "").replace(/\.$/, "");
    return f;
  }

  /* str(float)：Python 一定带小数点（1.0 不写成 1），JS 的 String(1) 是 "1"。
   * 库里的 depth 是 round() 的产物、永远是 float，建议文案里直接内插它，
   * 所以整数值必须补 ".0"，否则两边会差一个字符。 */
  function pyFloatStr(v) {
    var s = String(v);
    return /^-?\d+$/.test(s) ? s + ".0" : s;
  }

  /* 字符串排序：Python 的 str 比较按**码点**，JS 的 < 按 UTF-16 码元。
   * 两者只在补充平面（U+10000 以上）分叉 —— 那里的码元是代理对 0xD800~0xDFFF，
   * 会排到 U+E000~U+FFFF 之前，而按码点应该在后面。
   * 技能名与城市名都可能出现生僻字，所以不用默认比较。 */
  function pyStrCmp(a, b) {
    if (a === b) return 0;
    var i = 0, j = 0;
    while (i < a.length && j < b.length) {
      var ca = a.codePointAt(i), cb = b.codePointAt(j);
      if (ca !== cb) return ca < cb ? -1 : 1;
      i += ca > 0xffff ? 2 : 1;
      j += cb > 0xffff ? 2 : 1;
    }
    if (i >= a.length && j >= b.length) return 0;
    return i >= a.length ? -1 : 1;
  }

  /* str.strip()：Python 的空白集合比 JS 的 trim 多 \x1c-\x1f 与 \x85，
   * 少一个 \ufeff。用户手打的城市名两边得按同一把尺子裁。 */
  var PY_WS = /^[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+|[\t\n\v\f\r \x1c-\x1f\x85\xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+$/g;
  function pyStrip(s) { return String(s).replace(PY_WS, ""); }

  /* ======================= 预计算字典（只读） ======================= */

  /* 维度定义来自 dim 表（导出时由 P.DIMS 写入）。顺序即 DIMS 顺序 ——
   * analyze 的 dims 数组顺序、建议的排序都依赖它，所以必须 ORDER BY ord。 */
  function dims() {
    return memo("dims", function () {
      return JD().all("SELECT key, name, descr FROM dim ORDER BY ord")
        .map(function (r) {
          return { key: r[0], name: r[1], desc: r[2] };
        });
    });
  }

  /* 对应 analyze/skills.py 的 _pattern()：纯 ASCII 的别名要加显式边界，
   * 否则 'rag' 会命中 'storage'。判断条件照抄那条 fullmatch 的正则 ——
   * 它决定的正是「这个别名该不该带边界」，换个写法就会换结果。
   *
   * 用 lookbehind 而不是手工查前一个字符，是为了让代码与 Python 一一对应；
   * 目标浏览器（需要 WASM 与 WebGL2 的那一档）都支持。 */
  var ASCII_ALIAS = /^[a-z0-9][a-z0-9.\-/ ]*$/;

  function aliasRe(aliases) {
    var parts = aliases.map(function (a) {
      var esc = a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return ASCII_ALIAS.test(a) ? "(?<![a-z0-9])" + esc + "(?![a-z0-9])" : esc;
    });
    return new RegExp(parts.join("|"), "gi");
  }

  /* 技能 → 维度 + 别名，全部来自 skill_dim 表（导出时由 P.SKILL_DIM 与
   * P.ALIAS_OF 写入）。前端不再从别处拼这套映射，否则「哪 47 个技能算数」
   * 就有了两个事实源。 */
  function skillMeta() {
    return memo("skillMeta", function () {
      var skillDim = Object.create(null), patterns = [];
      JD().all("SELECT skill, dim, aliases FROM skill_dim").forEach(function (r) {
        skillDim[r[0]] = r[1];
        patterns.push({ skill: r[0], dim: r[1], re: aliasRe(JSON.parse(r[2])) });
      });
      return { skillDim: skillDim, patterns: patterns };
    });
  }

  /* 对应 analyze/skills.py 的 match_skills(text, scope="all")。
   * self_profile 要的是全量词典（含 soft / biz），不是 scope="doc" 的技术子集。
   * 带 g 的 String.match 与 Python 的 findall 同语义：非重叠、从左到右。 */
  function matchSkills(text) {
    if (!text) return [];
    var low = String(text).toLowerCase();
    var pats = skillMeta().patterns, out = [];
    for (var i = 0; i < pats.length; i++) {
      var m = low.match(pats[i].re);
      if (m && m.length) out.push(pats[i].skill);
    }
    return out;
  }

  function targetProfile(dirKey) {
    return memo("target:" + dirKey, function () {
      var row = JD().one("SELECT payload FROM target WHERE dir_key = ?", [dirKey]);
      /* 对应 Python 的 KeyError：未知方向必须抛，不能「查不到就退化成全库」——
       * 那会把一次填错悄悄变成一份看着很合理的错报告。 */
      if (!row) throw new Error("未知方向：" + dirKey);
      return JSON.parse(row[0]);
    });
  }

  function directions() {
    return memo("directions", function () { return JD().metaJson("directions"); });
  }

  function skillCatalog() {
    return memo("skillCatalog", function () { return JD().metaJson("skill_catalog"); });
  }

  /* ======================= 个人能力画像 ======================= */

  /* 对应 profile.py: self_profile()。
   * 注意勾选通道只认**规范名**（47 个里的），别名是给经历文本的联想匹配用的 ——
   * 这两条通道的口径不同，别在移植时顺手「优化」成互通。 */
  function selfProfile(payload) {
    var sk = skillMeta();
    var raw = payload && payload.skills;
    var picked = [];
    if (Array.isArray(raw)) {
      for (var i = 0; i < raw.length; i++) {
        if (raw[i] in sk.skillDim) picked.push(raw[i]);
      }
    }
    /* 对应 `payload.get("experience") or ""`：空串与 null 都是「没填」。
     * analyze 本身不截断长度 —— 截断是 server 接口层的事，这里照搬会有两套口径。 */
    var text = (payload && payload.experience) || "";

    var matched = Object.create(null);
    matchSkills(text).forEach(function (n) {
      if (n in sk.skillDim) matched[n] = true;
    });
    var pickedSet = Object.create(null);
    picked.forEach(function (s) { pickedSet[s] = true; });

    var out = {}, dimsList = dims();
    for (var d = 0; d < dimsList.length; d++) {
      var key = dimsList[d].key;
      var tick = Object.create(null), from = Object.create(null);
      picked.forEach(function (s) { if (sk.skillDim[s] === key) tick[s] = true; });
      for (var n in matched) {
        if (sk.skillDim[n] === key && !(n in tick)) from[n] = true;
      }
      var ticks = Object.keys(tick).sort(pyStrCmp);
      var fromText = Object.keys(from).sort(pyStrCmp);
      out[key] = {
        have: ticks.length + fromText.length,
        skills: ticks.concat(fromText),
        ticked: ticks,
        from_text: fromText,
      };
    }
    out._unmatched_text = Object.keys(matched)
      .filter(function (s) { return !(s in pickedSet); }).sort(pyStrCmp);
    return out;
  }

  /* ======================= 城市清单 ======================= */

  /* 工作地是多值字段：库里存在「北京/上海」这类写法，直接 GROUP BY city 会把
   * 拼接串当成一个独立城市。所以一律拆开计数 —— 与 profile.py 同一条正则。 */
  var CITY_SEP = /[/、,，;；|]+/;

  function splitCities(raw) {
    if (!raw) return [];
    var out = [];
    raw.split(CITY_SEP).forEach(function (part) {
      var c = pyStrip(part);
      if (c && out.indexOf(c) === -1) out.push(c);
    });
    return out;
  }

  /* rows = [(原始 city, 岗位数)] → 按拆开后的城市聚合，降序。
   * 排序键是 (-n, name) 的全序，所以不存在「并列时顺序不定」的问题，
   * 也就不需要担心 JS 与 Python 的排序稳定性差异。 */
  function aggCities(rows) {
    var acc = Object.create(null), order = [];
    rows.forEach(function (r) {
      splitCities(r[0]).forEach(function (c) {
        if (!(c in acc)) { acc[c] = 0; order.push(c); }
        acc[c] += r[1];
      });
    });
    return order.map(function (k) { return { name: k, n: acc[k] }; })
      .sort(function (a, b) { return (b.n - a.n) || pyStrCmp(a.name, b.name); });
  }

  /* 对应 profile.py: cities()。 */
  function cities(dirKey) {
    /* 「全方向」等价于不指定方向：必须归一成 null 再缓存与返回，否则前端拿到
     * direction="all" 会当成一个真实方向，把全部城市判成「该方向无岗位」。 */
    var key = dirKey && dirKey !== "all" ? dirKey : null;
    return memo("cities:" + key, function () {
      var d = JD();
      var total = d.val("SELECT count(*) FROM job");
      var rows = d.all("SELECT city, count(*) FROM job "
        + "WHERE city IS NOT NULL GROUP BY city");
      var out = aggCities(rows).map(function (c) {
        return { name: c.name, n: c.n, pct: total ? pyRound(c.n / total, 4) : 0 };
      });

      var scopeTotal = null;
      if (key) {
        var t = targetProfile(key);            // 未知方向在这里抛，与 Python 一致
        scopeTotal = t.n;
        var by = Object.create(null);
        t.cities.forEach(function (c) { by[c.name] = c.n; });
        out.forEach(function (c) {
          var nd = by[c.name] || 0;
          c.n_dir = nd;
          c.pct_dir = scopeTotal ? pyRound(nd / scopeTotal, 4) : 0;
        });
        out.sort(function (a, b) {
          return (b.n_dir - a.n_dir) || (b.n - a.n) || pyStrCmp(a.name, b.name);
        });
      } else {
        out.forEach(function (c) { c.n_dir = null; c.pct_dir = null; });
      }
      return { total: total, scope_total: scopeTotal, direction: key, cities: out };
    });
  }

  /* ======================= 差距分析 ======================= */

  var LEVEL_LABEL = { meet: "已达门槛", near: "接近门槛", gap: "有明显缺口",
                      na: "该方向几乎不要求" };

  function level(ratio) {
    if (ratio === null || ratio === undefined) return "na";
    if (ratio >= 0.9) return "meet";
    if (ratio >= 0.6) return "near";
    return "gap";
  }

  function analyze(payload) {
    payload = payload || {};
    var t = targetProfile(payload.direction || "all");
    var s = selfProfile(payload);
    var cap = t.cap;
    var dimsList = dims();
    var outDims = [];

    for (var i = 0; i < dimsList.length; i++) {
      var dim = dimsList[i];
      var td = t.dims[dim.key];
      var have = s[dim.key].have;
      var depth = td.depth;
      var ratio = depth > 0 ? pyRound(have / depth, 3) : null;
      var lv = level(ratio);
      var mineSet = Object.create(null);
      s[dim.key].skills.forEach(function (x) { mineSet[x] = true; });
      /* 缺口只取该维提及率最高的三项，且必须排除用户已具备的 —— 把「你会的」
       * 再列进「该补的」是这类工具最伤信任的 bug。 */
      var missing = [];
      for (var j = 0; j < td.top.length && missing.length < 3; j++) {
        if (!(td.top[j].skill in mineSet)) missing.push(td.top[j]);
      }
      outDims.push({
        key: dim.key, name: dim.name, desc: dim.desc,
        target: td.score, self: Math.min(100, pyRound(have * 100 / cap)),
        need: depth, have: have, cov: td.cov,
        ratio: ratio, level: lv, level_label: LEVEL_LABEL[lv],
        mine: s[dim.key].skills,
        from_text: s[dim.key].from_text,
        missing: missing,
      });
    }

    var scored = [];
    outDims.forEach(function (d) { if (d.ratio !== null) scored.push(d.ratio); });
    var overall = 0;
    if (scored.length) {
      /* 累加顺序也要与 Python 一致：浮点加法不满足结合律，换个顺序末位就可能不同。
       * 单维超过 1.0 的按 1.0 计（超额不抵消别的维度的缺口）。 */
      var acc = 0;
      for (var k = 0; k < scored.length; k++) acc += Math.min(scored[k], 1);
      overall = pyRound(acc * 100 / scored.length);
    }

    var ticked = Object.create(null);
    outDims.forEach(function (d) {
      var mine = d.mine, mineTicked = s[d.key].ticked;
      for (var m = 0; m < mine.length; m++) {
        if (mineTicked.indexOf(mine[m]) !== -1) ticked[mine[m]] = true;
      }
    });

    return {
      direction: { key: t.key, name: t.name, n: t.n, scope: t.scope,
                   small_sample: t.small_sample },
      dims: outDims,
      overall: overall,
      advice: advice(t, outDims),
      threshold: threshold(t, payload),
      basis: basis(t, cap),
      evidence: {
        ticked: Object.keys(ticked).sort(pyStrCmp),
        from_text: s._unmatched_text,
      },
    };
  }

  /* 所有缺口技能按「该方向提及率」排序 —— 最直接的补课清单。
   * 同一项技能在多维缺口里只算一次（取最大提及率），因为一个技能只属于一维，
   * 这里的去重是防御性的：万一词典以后允许一技多维，口径不会当场崩。 */
  function missingRank(outDims) {
    var agg = Object.create(null), order = [];
    outDims.forEach(function (d) {
      d.missing.forEach(function (m) {
        var cur = agg[m.skill];
        if (!cur) {
          cur = agg[m.skill] = { skill: m.skill, dim: d.name, pct: m.pct, n: m.n };
          order.push(m.skill);
        }
        if (m.pct > cur.pct) cur.pct = m.pct;
      });
    });
    return order.map(function (k) { return agg[k]; })
      .sort(function (a, b) { return b.pct - a.pct; });
  }

  /* payload 与 Python 同签名但未被用到 —— 建议文案只依赖画像结果，
   * 与用户填的年限/城市无关（那两项在 threshold 里单独给结论）。 */
  function advice(t, outDims) {
    var out = [];
    /* 缺口最大的排前面；na 用 9 当哨兵（它本来就会被跳过，只是别排在前面）。
     * 并列时保持 DIMS 顺序 —— 两边都是稳定排序，键也相同。 */
    var ordered = outDims.slice().sort(function (a, b) {
      return (a.ratio === null ? 9 : a.ratio) - (b.ratio === null ? 9 : b.ratio);
    });

    ordered.forEach(function (d) {
      if (d.level === "na") return;

      if (d.level !== "gap" && d.level !== "near") {
        out.push({
          kind: "strength", dim: d.key,
          title: d.name + "：" + d.level_label,
          detail: "该方向人均要求 " + pyFloatStr(d.need) + " 项，你具备 "
            + d.have + " 项。这一维是你在简历里应该前置的强项。",
          skills: d.mine.slice(0, 4),
        });
        return;
      }

      var topPct = d.missing.length
        ? Math.max.apply(null, d.missing.map(function (m) { return m.pct; })) : 0;
      var miss = d.missing.map(function (m) {
        return m.skill + "（" + fmt0(m.pct * 100) + "%）";
      }).join("、");

      /* 「行业与业务」这一维的门槛要比其他维度高一截：技能可以现学，行业经历
       * 补不了，所以只有压倒性多数岗位都要同一个行业时才值得点名。
       * 实测 RAG 方向最高项 43%、次高 40%，两者几乎并列 —— 那正是「没有主导
       * 行业」的形态，用通用的 0.4 会误判成主导，给出「优先补电商/营销」这种
       * 既不可执行、又和次高项打架的建议；而汽车方向「汽车/出行」是 100%，
       * 无论门槛定多高都该点名。 */
      var gate = d.key === "biz" ? 0.6 : 0.4;
      var head = "该方向人均要求 " + pyFloatStr(d.need) + " 项，你具备 "
        + d.have + " 项（" + fmt0(d.cov * 100) + "% 的岗位提到这一维）。";
      var detail = (d.missing.length && topPct < gate)
        ? head + "但这一维没有单一主导项（最高仅 " + miss + "）——"
          + "与其补新领域，不如把已有经验讲透、在简历里展开。"
        : head + "优先补：" + (miss || "该项在该方向样本里提及率低");

      out.push({
        kind: d.level, dim: d.key,
        title: d.name + "：" + d.level_label,
        detail: detail,
        skills: d.missing.map(function (m) { return m.skill; }),
      });
    });

    var rank = missingRank(outDims);
    if (rank.length) {
      out.push({
        kind: "todo", dim: null,
        title: "补课优先级",
        detail: "按该方向的提及率排序，同一项技能在多维缺口里只算一次："
          + rank.slice(0, 5).map(function (x) {
            return x.skill + "（" + fmt0(x.pct * 100) + "%，" + x.dim + "）";
          }).join("、"),
        skills: rank.slice(0, 5).map(function (x) { return x.skill; }),
      });
    }

    if (t.cities.length) {
      out.push({
        kind: "target", dim: null,
        title: "投递优先看哪些城市 / 公司",
        detail: "岗位最集中：" + t.cities.slice(0, 4).map(function (c) {
          return c.name + "（" + c.n + "）";
        }).join("、") + "；招人最多：" + t.companies.slice(0, 4).map(function (c) {
          return c.name + "（" + c.n + "）";
        }).join("、"),
        skills: [],
      });
    }
    return out;
  }

  /* 年限、城市这类硬门槛单独校验 —— 它们不是「能力」，混进雷达图会误导。 */
  function threshold(t, payload) {
    var out = {};
    var years = t.years, tot = 0;
    years.forEach(function (y) { tot += y.n; });
    var mine = payload.years === undefined ? null : payload.years;

    if (years.length && tot) {
      /* Python 的 max() 返回**第一个**最大值，所以用严格大于比较 ——
       * 用 >= 会把并列时的取值顺序换掉（比如 2 年与 3 年岗位数相同时）。 */
      var top = years[0];
      years.forEach(function (y) { if (y.n > top.n) top = y; });
      var ge3 = 0;
      years.forEach(function (y) { if (y.min >= 3) ge3 += y.n; });
      var yv = {
        you: mine,
        mode: top.min,
        mode_pct: pyRound(top.n / tot, 3),
        ge3_pct: pyRound(ge3 / tot, 3),
        dist: years,
      };
      /* 不填年限时只给分布、不给结论 —— 无中生有一个「你不达标」是最糟的体验。 */
      if (typeof mine === "number") {
        var topPct = fmt0(top.n / tot * 100);
        if (mine < top.min) {
          /* int(mine) 是**向零截断**（int(-1.5) == -1），不是 Math.floor。 */
          yv.verdict = "该方向 " + topPct + "% 的岗位要求 " + top.min
            + " 年及以上，你填的是 " + mine + " 年 —— 优先投不设年限或要求 ≤"
            + Math.trunc(mine) + " 年的岗位，别硬碰。";
          yv.ok = false;
        } else {
          yv.verdict = "年限满足主流要求（" + top.min + " 年及以上占 "
            + topPct + "%）。";
          yv.ok = true;
        }
      }
      out.years = yv;
    }

    var city = pyStrip(payload.city || "");
    if (city && t.cities.length) {
      /* 精确优先：城市清单已经按 / 拆开，正常情况就是命中一个规范名；
       * 子串兜底只为兼容用户手打「横琴」这类不完整输入。 */
      var hit = null;
      for (var i = 0; i < t.cities.length; i++) {
        if (t.cities[i].name === city) { hit = t.cities[i]; break; }
      }
      if (!hit) {
        for (var j = 0; j < t.cities.length; j++) {
          if (t.cities[j].name.indexOf(city) !== -1) { hit = t.cities[j]; break; }
        }
      }
      var share = hit ? hit.n / t.n : 0;
      /* 一条岗位可标多个工作地 ⇒ 各城市占比之和可能超过 100%，
       * 界面上引到占比时必须带上这句，否则用户会以为算错了。 */
      var multi = t.multi_city
        ? "（部分岗位标注了多个工作地，因此各城市占比之和可能超过 100%）" : "";
      out.city = {
        you: city,
        share: pyRound(share, 4),
        verdict: hit
          ? "「" + city + "」出现在 " + hit.n + " 条该方向岗位里（占 "
            + fmt1(share * 100) + "%）" + multi
          : "该方向样本里没有以「" + city + "」为工作地的岗位 —— "
            + "要么看远程，要么考虑迁移。",
        ok: !!hit,
      };
    }
    return out;
  }

  function basis(t, cap) {
    return "口径：以 " + t.scope + "为样本；每一维的分数 = "
      + "该维人均要求的技能条目数 ÷ 本方向最深的维度（" + fmtG(cap)
      + " 项）× 100。你的分数用同一分母换算，所以两个五边形可以直接对比。"
      + "技能分组来自 analyze/skills.py 的既有词典，不是另编的一套维度。";
  }

  root.JDProfile = {
    analyze: analyze,
    cities: cities,
    directions: directions,
    skillCatalog: skillCatalog,
    targetProfile: targetProfile,

    /* `/api/directions` 要返回「五个维度是什么」。维度元数据在 `dim` 表里
     * （导出时由 profile.DIMS 写入），这里把内部那个 dims() 顺带导出，
     * 免得 api.js 再写一遍同样的 SQL —— 同一份口径两个入口，迟早分叉。 */
    dims: dims,

    /* 「Python 语义复刻层」对外暴露一份，给 resume.js 这类后续移植文件复用。
     *
     * 为什么要导出而不是让每个移植文件各抄一份：round() 的银行家舍入、
     * `f"{v:.0f}"` 的平局取值、str(float) 的 ".0"、str.strip() 的空白集合，
     * 这四样只要有一处抄歪，两边就会在**某个具体数值上**分叉，而那种分叉
     * 平时看不出来、只在对拍里炸 —— 每个文件各存一份就是给这种分叉多开一个入口。
     * 更具体的教训：`JDRetrieval.pyRound` 对 n≥1 是用「先乘 10^n 再取整」实现的，
     * 那个实现在 0.435 上给 0.44，Python 的 round(0.435, 2) 是 0.43 ——
     * 所以这一层不能随手拿一个名字像的实现顶替，必须用下面这份精确的。 */
    pyRound: pyRound, fmt0: fmt0, pyFloatStr: pyFloatStr,
    pyStrCmp: pyStrCmp, pyStrip: pyStrip,
  };
})(globalThis);
