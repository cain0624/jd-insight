/* 发布版的启动器：把「数据 + 引擎 + fetch 垫片 + 设置面板」按正确的时序装起来。
 *
 * ## 为什么需要一个独立的启动器
 *
 * 因为这个页面里有两段代码在赛跑：
 *
 *   · `index.html` 的主脚本 —— 它跑起来就会 `fetch("/api/stats")`，
 *     并且**假设后端已经在那儿了**（本地版确实在）。
 *   · 我们这边 —— 要把 3MB 的知识库取下来、解压、初始化 sql.js。
 *
 * 本地版里后端先于浏览器存在，所以没有这个赛跑。发布版没有后端，
 * 数据是**页面自己**异步装的。谁先谁后必须显式安排，不能靠运气。
 *
 * 安排如下（每一步的顺序都是有理由的，改之前先想清楚）：
 *
 *   ① 本文件在 `<head>` 里、在 index.html 的主脚本**之前**执行。
 *      所以第一件事就是同步地把 fetch 垫片装上，并把「数据还没好」这件事
 *      变成一道闸门交给它 —— 请求进来先等着，而不是漏到真实网络去打 404。
 *      这一步晚一行都不行：主脚本就在下一个 `<script>` 里。
 *
 *   ② 然后才开始异步装载（sql.js → 知识库字节 → 引擎 ctx）。装完开闸。
 *
 *   ③ 设置面板要等 DOM 就绪再挂 —— 本文件在 `<head>` 里跑的时候，
 *      `<body>` 里连 `.head-row` 都还不存在。
 *
 * ## 装载失败怎么办
 *
 * 不能让请求一直挂着（前端会停在「分析中」转圈，比报错更难查）。
 * 所以失败时也要开闸，把 ctx 置为 null —— `api.js` 的 resolveCtx 收到 null
 * 会回一个 503 加一句人话。同时把那条横幅改成说明问题。
 */
(function (root) {
  "use strict";

  var d = root.document;
  var ctxBox = null;
  var readyResolve;
  var ready = new Promise(function (r) { readyResolve = r; });

  /** 把话说清楚，别让用户对着转圈猜。 */
  function fatal(msg) {
    ctxBox = null;
    readyResolve(null);
    var box = d.getElementById("banner");
    if (box) {
      box.style.display = "block";
      box.setAttribute("data-kp-patched", "1");   // 别让面板的横幅改写逻辑再动它
      box.textContent = msg;
    }
    if (root.console && root.console.error) root.console.error(msg);
  }

  /* ---------- ① 先装垫片（同步，必须在主脚本之前） ---------- */

  if (!root.JDAPI) {
    // api.js 都没加载成功，说明构建产物不完整。这时候连 /api/* 都拦不住，
    // 页面会退化成「静态预览」，但仍要告诉用户为什么。
    d.addEventListener("DOMContentLoaded", function () {
      fatal("页面脚本未能加载完整（api.js 缺失），无法连接知识库。请刷新重试。");
    });
    return;
  }
  root.JDAPI.install(function () { return ctxBox; }, { ready: ready });

  /* ---------- ② 异步装载 ---------- */

  async function load() {
    try {
      if (typeof root.initSqlJs !== "function") {
        throw new Error("sql.js 没加载出来（vendor/sql-wasm.js 缺失？）");
      }
      var SQL = await root.initSqlJs({
        // wasm 与 js 同目录。写死成 "vendor/" 是因为页面在 GitHub Pages 的
        // 子路径下（/仓库名/），用相对路径才能同时对 file:// 与线上成立。
        locateFile: function (f) { return "vendor/" + f; },
      });
      ctxBox = await root.JDAPI.boot({ SQL: SQL, install: false });
      readyResolve(ctxBox);
    } catch (e) {
      fatal("知识库装载失败：" + ((e && e.message) || String(e))
            + "　刷新页面可以重试。");
    }
  }

  /* ---------- ③ 设置面板 ---------- */

  function mountPanel() {
    if (!root.JDKeyPanel) return;
    root.JDKeyPanel.mount({
      onApply: function () {
        /* api.js 的 ctx 里握着一份 LLM 客户端（boot() 造的时候就定了）。
           用户刚填完 key，那份旧的必须换掉 —— 否则界面会一直说「没配 key」。
           这一步是「保存后立刻生效」的关键。 */
        if (ctxBox) {
          ctxBox.llm = root.JDLLM.ready() ? root.JDLLM.create() : null;
        }
      },
    });
  }

  load().then(function () {
    if (d.readyState === "loading") {
      d.addEventListener("DOMContentLoaded", mountPanel);
    } else {
      mountPanel();
    }
  });
})(typeof globalThis !== "undefined" ? globalThis : this);
