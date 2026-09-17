/* 数据访问层：sql.js 的一层薄封装。
 *
 * 为什么要有这一层：本地版所有逻辑都长在 `sqlite3.connect(...)` 上。
 * 要在浏览器里跑同一套逻辑，把 `sqlite3` 换成 sql.js 就够了 —— 但换法必须
 * **只有一处**，否则「本地用 Python 查询、线上用 JS 查询」会各写一份，
 * 口径迟早分叉。所以这里只做三件事：拿连接、跑查询、读 meta。
 *
 * 刻意做成同步的：sql.js 本来就在同一线程里同步执行，套 Promise 只是噪音，
 * 还会把「查询」和「调模型」两件事混成一种写法。**只有调 LLM 是异步的。**
 *
 * 这个文件同时要在浏览器（无模块系统，挂 globalThis）与 Node（对拍测试）里跑，
 * 所以用一个 IIFE 同时挂全局和 module.exports。
 *
 * ## make() 顺手把库挂到 `globalThis.JD`
 *
 * 这一点不是顺手，是**必需**。上面那些移植过来的模块（text / metrics / retrieval /
 * session / ask / examples / profile / resume）读的都是一个模块级全局 `JD` ——
 * 这是刻意的：`kb/*.py` 里本来就有一个模块级 `DB`，逐行移植时保留同一个形状，
 * 才能一眼看出两边是不是同一套逻辑。
 *
 * 代价是「谁负责挂这个全局」。这个责任**只能放在 make() 里**：它是唯一一个
 * 「库诞生」的时刻，也是浏览器与 Node 唯一的公共入口。放在调用方就等于
 * 每个调用方都要记得挂 —— 实测踩到过：浏览器里的 `boot()` 忘了，于是
 * `/api/stats` 直接 500（`JDExamples` 抛「请先装载 db.js 并挂好 globalThis.JD」），
 * 前端退化成「未连接后端服务」的静态预览……而**对拍全绿**，因为对拍那台
 * 环境（tools/engine_env.mjs）替它挂好了。这正是「同构移植」最怕的那种分歧：
 * 两边各自跑得好好的，只有一边真实。
 */
(function (root, factory) {
  var api = factory(root);
  root.JDDB = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  /* 只读护栏。浏览器里 sql.js 操作的是内存副本，写坏了也只是本地的副本 ——
   * 但「只读」这件事本身是有意义的：模型生成的 SQL 会经过这里，
   * 而 `validate_sql` 的拦截逻辑建立在「只允许 SELECT」这个前提上。
   * 万一哪天护栏漏了一条，这里还有一道。 */
  var READONLY = [
    "PRAGMA query_only = ON"
  ];

  function make(SQL, bytes) {
    var u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var db = new SQL.Database(u8);
    READONLY.forEach(function (s) { db.run(s); });

    function q(sql, params) {
      var r = db.exec(sql, params || []);
      if (!r || !r.length) return { cols: [], rows: [] };
      return { cols: r[0].columns, rows: r[0].values };
    }

    var api = {
      raw: db,
      q: q,
      /** 全部结果集（sql.js 的 exec 对多条语句会返回多个结果集，这里取第一个）。
       *  返回 [[行], ...]，没有列名 —— 内部循环用，省一次对象构造。 */
      all: function (sql, params) { return q(sql, params).rows; },
      one: function (sql, params) {
        var rows = q(sql, params).rows;
        return rows.length ? rows[0] : null;
      },
      val: function (sql, params) {
        var r = q(sql, params).rows;
        return r.length && r[0].length ? r[0][0] : null;
      },
      /** meta 表的字符串值。meta 是「导出时算好的常量」，不是运行时算的。 */
      meta: function (k) {
        var v = this.val("SELECT v FROM meta WHERE k = ?", [k]);
        return v === null || v === undefined ? null : String(v);
      },
      metaJson: function (k) {
        var s = this.meta(k);
        if (s === null) return null;
        try { return JSON.parse(s); } catch (e) { return null; }
      },
      close: function () { db.close(); }
    };

    /* 关键的一行：把库挂到全局。上面 text/metrics/retrieval/session/ask/examples/
       profile/resume 八个模块读的都是 `globalThis.JD`。理由与教训见文件头。 */
    root.JD = api;
    return api;
  }

  return { make: make };
});
