/* 检索层：切块文本重建 + BM25 打分（kb/chunk.py + kb/index.py 的同构移植）。
 *
 * ## 为什么文本是「重建」的
 *
 * 导出库的 `chunk` 表**不存文本**（省 5MB 下载量），只存 `(job_id, kind, seg)`。
 * 文本是 `job` 字段的纯函数：
 *   meta 块 = meta_text(job 的若干字段拼一句)
 *   duty 块 = _split_long(responsibility)[seg]
 *   req  块 = _split_long(requirement)[seg]
 *   full 块 = _split_long(jd_text)[seg]（两段都缺时的兜底）
 *
 * 代价是「两边的切分规则不能悄悄漂移」。所以 tools/port_check_engine.mjs
 * 会把**全部 chunk** 的 JS 重建结果与 Python 的 build_chunks() 逐字对拍 ——
 * 一个字都不一样才算通过。这条断言很便宜（5000 次字符串比较），
 * 但它是「省 5MB」这个决定能不能成立的前提。
 *
 * ## 打分
 *
 * 倒排是打包好的 BLOB（`inverted.blob`）：重复 [varint(cid 增量), varint(tf)]。
 * 解码是 30 行，换回 6.5MB 下载量。打分公式与 kb/index.py 完全一致。
 */
(function (root, factory) {
  var api = factory();
  root.JDRetrieval = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  var SKILL_TAG = "\u00a7";
  var MAX_CHUNK_CHARS = 900;   // 与 kb/chunk.py 的 MAX_CHARS 一致
  var MIN_CHUNK_CHARS = 30;    // 与 MIN_CHARS 一致

  /* ---------- Python 语义的小复制品 ----------
   * 不是「顺手写的工具函数」，是移植正确性的一部分：
   * Python 的 str(None) 是 "None"、round() 是银行家舍入，
   * JS 的默认行为不一样，而差异会直接改写输出文本。 */
  function pyStr(v) {
    if (v === null || v === undefined) return "None";
    return String(v);
  }
  /** Python 的 round(x, n)：四舍六入五成双，且作用在二进制精确值上。 */
  function pyRound(x, n) {
    if (!isFinite(x)) return x;
    var f = Math.pow(10, n);
    var scaled = x * f;
    var fl = Math.floor(scaled);
    var diff = scaled - fl;
    var r;
    if (Math.abs(diff - 0.5) < 1e-9) {
      // 平局看整数部分的奇偶（这正是 Python 与 JS 分叉的地方）
      var isOdd = Math.abs(fl % 2) === 1;
      r = isOdd ? fl + 1 : fl;
    } else {
      r = Math.round(scaled);
    }
    return r / f;
  }

  /* ---------- 切块（kb/chunk.py 的 _split_long / meta_text） ---------- */

  /* **Python 的 len() 数的是码点，JS 的 .length 数的是 UTF-16 码元。**
   * JD 正文里有 emoji（「🌟📚💪」这类），一个 emoji 在 JS 里算 2。
   * 实测 5041 个块里有 2 个因此切错边界 —— 900 字的阈值判到 898 还是 902，
   * 整段的分段就跟着移位，top-K 召回的块与 Python 版不是同一批。
   *
   * 这个差异极小、极隐蔽（只有一个字符长度差），所以先判有没有代理对：
   * 99.9% 的字符串走快路径，只有含 emoji 的才付出 Array.from 的代价。 */
  var PAIR = /[\uD800-\uDBFF][\uDC00-\uDFFF]/;
  var PAIR_G = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;

  function cpLen(s) {
    if (!PAIR.test(s)) return s.length;
    var m = s.match(PAIR_G);
    return s.length - (m ? m.length : 0);
  }

  function cpSlice(s, start, end) {
    if (!PAIR.test(s)) return end === undefined ? s.slice(start) : s.slice(start, end);
    var arr = Array.from(s);
    return (end === undefined ? arr.slice(start) : arr.slice(start, end)).join("");
  }

  var SENT_END = { "。": 1, "；": 1, ";": 1, "！": 1, "？": 1, "!": 1, "?": 1, "\n": 1 };

  function sentSplit(text) {
    // 等价于 Python 的 re.split(r"(?<=[。；;！？!?\n])", text)：在标点**之后**切，
    // 且切出来的片段带标点。手写而不用 lookbehind，是为了不依赖引擎对
    // 后行断言的实现差异（Safari 直到 16.4 才支持）。
    var out = [], buf = "";
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      buf += ch;
      if (SENT_END[ch]) { out.push(buf); buf = ""; }
    }
    if (buf) out.push(buf);
    return out;
  }

  function splitLong(text, headLimit) {
    headLimit = headLimit || MAX_CHUNK_CHARS;
    var parts = sentSplit(String(text || "")).filter(function (p) {
      return p && p.trim();
    });
    var out = [], buf = "";
    for (var i = 0; i < parts.length; i++) {
      var p = parts[i];
      if (cpLen(buf) + cpLen(p) <= headLimit) {
        buf += p;
      } else {
        if (buf) out.push(buf.trim());
        while (cpLen(p) > headLimit) {
          out.push(cpSlice(p, 0, headLimit).trim());
          p = cpSlice(p, headLimit);
        }
        buf = p;
      }
    }
    if (buf.trim()) out.push(buf.trim());
    // 收尾：把过碎的块并进前一块
    var merged = [];
    for (var j = 0; j < out.length; j++) {
      var c = out[j];
      if (merged.length && cpLen(c) < MIN_CHUNK_CHARS) merged[merged.length - 1] += c;
      else merged.push(c);
    }
    return merged;
  }

  function metaText(j) {
    var bits = ["公司：" + pyStr(j.company), "岗位：" + pyStr(j.title)];
    if (j.title_dir) bits.push("方向：" + j.title_dir);
    if (j.city) bits.push("城市：" + j.city);
    if (j.work_years) bits.push("经验要求：" + j.work_years);
    if (j.title_norm) bits.push("岗位族：" + j.title_norm);
    bits.push("发布时间：" + pyStr(j.publish_date));
    bits.push("招聘类型：" + (j.recruit_type || "未标注"));
    return bits.join(" ｜ ");
  }

  var JOB_COLS = ["job_id", "title", "title_norm", "title_dir", "company", "city",
                  "publish_date", "work_years", "recruit_type", "responsibility",
                  "requirement", "jd_text"];

  function chunkRows(JD) {
    if (!JD.__chunks) {
      JD.__chunks = JD.all("SELECT cid, job_id, kind, seg, dl, skills FROM chunk");
      JD.__chunkByCid = Object.create(null);
      for (var i = 0; i < JD.__chunks.length; i++) {
        JD.__chunkByCid[JD.__chunks[i][0]] = JD.__chunks[i];
      }
    }
    return JD.__chunks;
  }

  function jobOf(JD, jobId) {
    if (!JD.__jobs) JD.__jobs = Object.create(null);
    if (JD.__jobs[jobId] === undefined) {
      var row = JD.one("SELECT " + JOB_COLS.join(",") + " FROM job WHERE job_id = ?",
                       [jobId]);
      var o = null;
      if (row) {
        o = {};
        for (var i = 0; i < JOB_COLS.length; i++) o[JOB_COLS[i]] = row[i];
      }
      JD.__jobs[jobId] = o;
    }
    return JD.__jobs[jobId];
  }

  /** 重建某个 chunk 的文本。seg 越界返回 ""（与 Python 的切片行为一致）。 */
  function chunkText(JD, cid) {
    var row = JD.__chunkByCid && JD.__chunkByCid[cid];
    if (!row) {
      chunkRows(JD);
      row = JD.__chunkByCid[cid];
      if (!row) return "";
    }
    var kind = row[2], seg = row[3] | 0;
    var j = jobOf(JD, row[1]);
    if (!j) return "";
    if (kind === "meta") return metaText(j);
    if (kind === "duty") return splitLong((j.responsibility || "").trim())[seg] || "";
    if (kind === "req") return splitLong((j.requirement || "").trim())[seg] || "";
    return splitLong((j.jd_text || "").trim())[seg] || "";
  }

  /* ---------- 倒排解码 ---------- */
  function decodePostings(buf) {
    var out = [], pos = 0, cid = 0, n = buf.length;
    while (pos < n) {
      var shift = 0, val = 0, b;
      do { b = buf[pos++]; val |= (b & 0x7F) << shift; shift += 7; } while (b & 0x80);
      cid += val;
      var tfShift = 0, tf = 0;
      do { b = buf[pos++]; tf |= (b & 0x7F) << tfShift; tfShift += 7; } while (b & 0x80);
      out.push(cid, tf);
    }
    return out;
  }

  /* ---------- 元数据过滤 ----------
   * 本地版的 filters 走「遍历所有 chunk 比字符串」，线上版把这些字段并到
   * job 上之后只能靠 SQL 挑 cid。语义要保持一致：city 用的是**子串**匹配。 */
  function allowedSet(JD, filters) {
    if (!filters) return null;
    var where = [], params = [];
    var map = { company: "j.company = ?", title_norm: "j.title_norm = ?",
                kind: "c.kind = ?" };
    ["company", "title_norm", "kind"].forEach(function (k) {
      if (filters[k]) { where.push(map[k]); params.push(filters[k]); }
    });
    if (filters.city) { where.push("j.city LIKE ?"); params.push("%" + filters.city + "%"); }
    if (filters.is_ai !== undefined && filters.is_ai !== null) {
      where.push("COALESCE(j.is_ai,0) = ?"); params.push(Number(filters.is_ai));
    }
    if (filters.month_from) { where.push("j.month >= ?"); params.push(filters.month_from); }
    if (filters.month_to) { where.push("j.month <= ?"); params.push(filters.month_to); }
    if (filters.skills && filters.skills.length) {
      where.push("EXISTS (SELECT 1 FROM json_each(c.skills) WHERE value IN (" +
                 filters.skills.map(function () { return "?"; }).join(",") + "))");
      params = params.concat(filters.skills);
    }
    var sql = "SELECT c.cid FROM chunk c JOIN job j ON j.job_id = c.job_id" +
              (where.length ? " WHERE " + where.join(" AND ") : "");
    var set = Object.create(null);
    JD.all(sql, params).forEach(function (r) { set[r[0]] = 1; });
    return set;
  }

  /* ---------- BM25 ---------- */
  function makeSearcher(JD) {
    chunkRows(JD);                       // 先把 cid -> chunk 行的映射建好
    var meta = {
      n: Number(JD.meta("n_chunks")) || 0,
      k1: Number(JD.meta("k1")) || 1.5,
      b: Number(JD.meta("b")) || 0.75,
      avgdl: Number(JD.meta("avgdl")) || 1,
      second: Number(JD.meta("second_w")) || 0.3
    };
    var dlArr = Object.create(null);
    JD.all("SELECT cid, dl FROM chunk").forEach(function (r) { dlArr[r[0]] = r[1] || 1; });
    var chunkJob = Object.create(null);   // cid -> job_id（合并同岗位要用）
    JD.all("SELECT cid, job_id FROM chunk").forEach(function (r) { chunkJob[r[0]] = r[1]; });

    /** 返回 [[score, chunkObj, matchedTerms], ...]。chunkObj 已带 _skills/_matched。 */
    function search(question, topK, filters, agg) {
      topK = topK || 8;
      agg = agg || "job";
      var qw = JDText.queryTerms(JD, question);
      if (filters && filters.skills) {
        filters.skills.forEach(function (s) {
          var tag = SKILL_TAG + s;
          qw[tag] = Math.max(qw[tag] || 0, JDText.W_SKILL);
        });
      }
      var terms = Object.keys(qw);
      if (!terms.length) return [];
      var allow = allowedSet(JD, filters);

      var scores = Object.create(null), hits = Object.create(null), order = [];
      for (var t = 0; t < terms.length; t++) {
        var term = terms[t], w = qw[term];
        var row = JD.one("SELECT df, blob FROM inverted WHERE term = ?", [term]);
        if (!row) continue;
        var df = row[0];
        var idf = Math.log(1 + (meta.n - df + 0.5) / (df + 0.5));
        var post = decodePostings(row[1]);
        for (var i = 0; i < post.length; i += 2) {
          var cid = post[i], tf = post[i + 1];
          if (allow && !allow[cid]) continue;
          var dl = dlArr[cid] || 1;
          var denom = tf + meta.k1 * (1 - meta.b + meta.b * dl / (meta.avgdl || 1));
          var s = w * idf * (tf * (meta.k1 + 1)) / denom;
          if (scores[cid] === undefined) { scores[cid] = 0; order.push(cid); }
          scores[cid] += s;
          var h = hits[cid] || (hits[cid] = []);
          if (h.length < 6) {
            h.push(term.charAt(0) === SKILL_TAG ? term.slice(1) : term);
          }
        }
      }
      if (!order.length) return [];

      function wrap(cid) {
        var r = JD.__chunkByCid[cid];
        if (!r) return null;
        var j = jobOf(JD, r[1]) || {};
        var sk = [];
        try { sk = JSON.parse(r[5] || "[]"); } catch (e) { sk = []; }
        var c = { cid: cid, job_id: r[1], kind: r[2], company: j.company,
                  title: j.title, city: j.city, publish_date: j.publish_date,
                  url: null, text: chunkText(JD, cid), _skills: sk };
        c._matched = hits[cid];
        return c;
      }

      if (agg === "chunk") {
        var ranked = order.slice().sort(function (a, b) {
          return (scores[b] - scores[a]) || (order.indexOf(a) - order.indexOf(b));
        });
        return ranked.slice(0, topK).map(function (cid) {
          return [scores[cid], wrap(cid), hits[cid]];
        });
      }

      // job 级合并：同一份 JD 会有 meta/duty/req 多块命中，直接返回 chunk
      // 会让同一家公司刷屏。以最高分块为准，其余块按 0.3 权重加成 ——
      // 既保留「多处提及 = 更相关」的信号，又不让长 JD 因为块多而虚高。
      var best = Object.create(null), extra = Object.create(null), jorder = [];
      for (var k = 0; k < order.length; k++) {
        var c2 = order[k], sc = scores[c2], jid = chunkJob[c2];
        var cur = best[jid];
        if (cur === undefined) { best[jid] = [sc, c2]; jorder.push(jid); }
        else if (sc > cur[0]) { extra[jid] = (extra[jid] || 0) + cur[0] * meta.second;
                                best[jid] = [sc, c2]; }
        else { extra[jid] = (extra[jid] || 0) + sc * meta.second; }
      }
      var merged = jorder.map(function (jid, idx) {
        return [best[jid][0] + (extra[jid] || 0), best[jid][1], idx];
      });
      merged.sort(function (a, b) { return (b[0] - a[0]) || (a[2] - b[2]); });
      return merged.slice(0, topK).map(function (x) {
        var cid = x[1];
        return [x[0], wrap(cid), hits[cid]];
      });
    }

    return { search: search, chunkText: function (cid) { return chunkText(JD, cid); } };
  }

  return { makeSearcher: makeSearcher, chunkText: chunkText, splitLong: splitLong,
           cpLen: cpLen, cpSlice: cpSlice,
           metaText: metaText, decodePostings: decodePostings, pyRound: pyRound,
           pyStr: pyStr, sentSplit: sentSplit };
});
