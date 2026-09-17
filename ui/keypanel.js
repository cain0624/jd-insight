/* 发布版专属的「大模型接入设置」面板 + 隐私说明。
 *
 * ## 为什么本地版没有、这一版必须有
 *
 * 本地版的 Key 由 `kb/server.py` 从 `config.json` 读，浏览器从头到尾看不到它，
 * 所以不需要任何设置界面。发布版是纯静态的 —— 没有服务端可以替用户保管 Key，
 * 它只能放在浏览器里。于是「让用户填 Key 的地方」从可选变成了必需。
 *
 * ## 这个文件只做三件事
 *
 * ① 在页头右上角挂一个齿轮按钮，点开一个设置面板（接口地址 / 模型名 / Key）
 * ② 把「未配置 Key」那条横幅里**指向 config.json 的文案**换成发布版的说法。
 *    `kb/web/index.html` 一行都不改，所以这句只能在运行时改 —— 见 patchBanner()。
 * ③ 把隐私边界写清楚（Key 存在哪、发给谁、谁能读到），而不是假装安全。
 *
 * 业务逻辑一行都没有：配置读写走 `JDLLM`，连通性自检用它现成的 `probe()`。
 * 这一层只负责界面。
 *
 * ## 与 index.html 的耦合点（只有两个，都容错）
 *
 * · `.head-row` —— 页头那一行文字，右侧本来是空的，齿轮放这儿。
 *   找不到就不挂齿轮（面板仍可用 `JDKeyPanel.open()` 打开），不至于整个页面报错。
 * · `#banner` —— 那条黄色提示条。找不到就跳过文案替换。
 *
 * 另外，保存/清除之后会调 `root.boot()`（index.html 顶层声明的函数，所以是全局）
 * 重刷顶部的徽章 —— 那里有一个「模型」徽章会随配置变化。
 */
(function (root, factory) {
  var api = factory(root);
  root.JDKeyPanel = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var mounted = false;
  var onApply = null;

  /* 本模块对外暴露的对象。工厂内部也需要引用它 —— `mount()` 有两条早退分支
     （已挂过 / 没有 document）会把 `api` 原样返回给调用者。所以它必须先声明、
     等所有函数定义完再赋值（见文件末尾），不能写成 `return { ... }` 字面量。
     踩过的坑：`api` 一度只存在于外层 wrapper 的作用域里，而这里又没声明，
     文件开着 "use strict"，于是末尾那句 `api = {...}` 直接抛
     `ReferenceError: api is not defined` —— 整个 `ui/keypanel.js` 不执行，
     `JDKeyPanel` 从头到尾没挂上。Node 那边看不出来（堆脚本环境不跑这一层）。 */
  var api;

  function doc() { return root.document; }
  function byId(id) { return doc() ? doc().getElementById(id) : null; }
  function llm() { return root.JDLLM; }

  /* 横幅里只要出现这些字样，就说明那是「本地版」的文案，得换掉。
     HTML 里原话是「把 key 填进 config.json 的 api_key 后重启服务」——
     发布版既没有 config.json 也没有「重启服务」这回事。 */
  var LOCAL_WORDS = ["config.json", "LLM_API_KEY"];

  var TEMPLATE = [
    '<div class="kp-head">',
    '  <h3>大模型接入设置</h3>',
    '  <button class="kp-close" id="kpClose" type="button" aria-label="关闭">\u00d7</button>',
    '</div>',
    '<p class="kp-lead">',
    '  发布版没有后端：模型请求由<b>你的浏览器</b>直连你填的服务商，Key 只存在这台机器上。',
    '  <b>指标类问题（如「各公司岗位数排行」）不需要 Key</b>，现在就能问。',
    '</p>',
    '<div class="kp-presets" id="kpPresets"></div>',
    '<p class="kp-presets-note" id="kpPresetsNote"></p>',
    '<div class="kp-field">',
    '  <label for="kpBase">接口地址（Base URL）</label>',
    '  <input id="kpBase" type="text" spellcheck="false" autocomplete="off"',
    '         placeholder="https://api.siliconflow.cn/v1">',
    '  <div class="kp-hint">要带 <code>/v1</code> 这类路径前缀；必须以 http(s):// 开头。</div>',
    '</div>',
    '<div class="kp-field">',
    '  <label for="kpModel">模型名</label>',
    '  <input id="kpModel" type="text" spellcheck="false" autocomplete="off"',
    '         placeholder="deepseek-ai/DeepSeek-V4-Flash">',
    '  <div class="kp-hint">本项目让它生成 SQL，所以<b>模型必须能稳定输出 JSON</b>。</div>',
    '</div>',
    '<div class="kp-field">',
    '  <label for="kpKey">API Key</label>',
    '  <input id="kpKey" type="password" spellcheck="false" autocomplete="off" placeholder="sk-...">',
    '  <div class="kp-hint">只保存在本机 localStorage，不上传。展开下方说明看边界。</div>',
    '</div>',
    '<div class="kp-actions">',
    '  <button class="kp-btn sec" id="kpTest" type="button">测试连接</button>',
    '  <button class="kp-btn" id="kpSave" type="button">保存</button>',
    '  <button class="kp-btn danger" id="kpClear" type="button">清除</button>',
    '</div>',
    '<p class="kp-result" id="kpResult"></p>',
    '<details class="kp-privacy">',
    '  <summary>隐私与安全说明（建议读一遍，30 秒）</summary>',
    '  <ul>',
    '    <li>这一版<b>没有后端</b>。页面是纯静态的，模型请求由<b>你的浏览器直接发给你填的服务商</b>；',
    '        本项目不经过、也无从看到任何中间数据。</li>',
    '    <li>Key 只存在<b>这台浏览器的 localStorage</b>，键名 <code>jd_insight_llm</code>，',
    '        关掉浏览器再打开还在。它不会被上传到本项目。</li>',
    '    <li>但要说清楚：localStorage 里的东西，<b>页面上任何一段脚本都读得到</b>。',
    '        这是纯静态站回避不了的事实，所以<b>不要填你的主力 Key</b> —— ',
    '        建议单独申请一把、设好额度上限；不用了点「清除」。</li>',
    '    <li>服务商必须<b>允许浏览器跨域（CORS）</b>。不回跨域头的接口会被浏览器在预检阶段拦掉，',
    '        这不是本页能修的 —— <b>用 curl 能通，不代表页面能用</b>。',
    '        下面标「已实测」的预设，是真的打过该域名、确认过响应带跨域头。</li>',
    '    <li>知识库数据本身<b>已脱敏</b>：公司名替换为别名，不含任何个人信息。',
    '        全站属于你的数据只有两样 —— 这把 Key 和提问历史，都只在本机。</li>',
    '    <li>不需要 Key 也能用：<b>指标层覆盖的问题</b>（「各公司岗位数排行」「技能提及率 Top10」',
    '        这类）是浏览器里的 SQLite 直接算的，根本不调模型。</li>',
    '  </ul>',
    '</details>',
  ].join("\n");

  /* ---------- 预设 ---------- */

  /** 渲染预设。
   *
   *  分两类，视觉上必须能区分：
   *  · 可点的 —— 填进去能用的（实测过跨域）
   *  · 不可点的（`works === false`）—— 留作记录，但点了只会白撞一次跨域。
   *    本项目实测过 `api.devin-tec.cn` 不回 CORS 头，所以它落在这一类。
   *    把它做成可点等于给用户挖坑，做成「看不见」又等于把踩过的坑丢掉，
   *    所以第三种做法：显示、标注、禁点。 */
  function renderPresets() {
    var box = byId("kpPresets");
    var note = byId("kpPresetsNote");
    if (!box) return;
    var list = (llm() && llm().PRESETS) || [];
    box.innerHTML = "";
    var blocked = 0;

    list.forEach(function (p) {
      var off = p.works === false;
      var b = doc().createElement("button");
      b.type = "button";
      b.className = "kp-chip" + (off ? " off" : "");
      b.setAttribute("data-base", p.base_url || "");
      b.setAttribute("data-model", p.model || "");
      b.textContent = p.name || p.base_url || "未命名";
      var tag = doc().createElement("span");
      tag.className = "tag";
      if (off) { tag.textContent = "浏览器直连不可用"; blocked++; }
      else { tag.textContent = p.tested ? "已实测" : "未实测跨域"; }
      b.appendChild(tag);
      if (off) {
        b.disabled = true;
        b.title = p.note || "该服务商不允许浏览器跨域直连";
      } else {
        b.title = p.note || "";
        b.onclick = function () {
          byId("kpBase").value = p.base_url || "";
          byId("kpModel").value = p.model || "";
          markActive();
          say("已填入「" + (p.name || "") + "」的地址与模型。填上你自己的 Key 再保存即可。", "");
        };
      }
      box.appendChild(b);
    });

    if (note) {
      note.textContent = blocked
        ? "标「浏览器直连不可用」的那些是留作记录的：实测它们不回跨域头，"
          + "纯前端直连会在预检阶段被浏览器拦掉（命令行 curl 能通也没用）。"
        : "";
    }
    markActive();
  }

  /** 高亮与当前输入匹配的那个预设，让用户一眼看出自己选的是哪家。 */
  function markActive() {
    var base = (byId("kpBase") || {}).value || "";
    var model = (byId("kpModel") || {}).value || "";
    var chips = doc().querySelectorAll("#kpPresets .kp-chip");
    for (var i = 0; i < chips.length; i++) {
      var on = chips[i].getAttribute("data-base") === base
            && chips[i].getAttribute("data-model") === model
            && !chips[i].disabled;
      chips[i].className = "kp-chip"
        + (chips[i].disabled ? " off" : "")
        + (on ? " on" : "");
    }
  }

  /* ---------- 输入回读 ---------- */

  function readInputs() {
    return {
      base_url: ((byId("kpBase") || {}).value || "").trim(),
      model: ((byId("kpModel") || {}).value || "").trim(),
      api_key: ((byId("kpKey") || {}).value || "").trim(),
    };
  }

  /** 保留用户没在面板里暴露的两项（temperature / timeout），
   *  否则一保存就会把它们悄悄重置成默认值。 */
  function withRest(cfg) {
    var old = llm().load();
    cfg.temperature = old.temperature;
    cfg.timeout = old.timeout;
    return cfg;
  }

  function say(msg, kind) {
    var box = byId("kpResult");
    if (!box) return;
    box.className = "kp-result" + (kind ? " " + kind : "");
    box.textContent = msg;
  }

  /* ---------- 开关 ---------- */

  function open() {
    if (!mounted) mount();
    var c = llm().load();
    byId("kpBase").value = c.base_url || "";
    byId("kpModel").value = c.model || "";
    byId("kpKey").value = c.api_key || "";
    say("");
    markActive();
    byId("kpMask").className = "kp-mask on";
    byId("kpModal").className = "kp-modal on";
    var f = byId("kpKey");
    if (f) f.focus();
  }

  function close() {
    var m = byId("kpMask"), p = byId("kpModal");
    if (m) m.className = "kp-mask";
    if (p) p.className = "kp-modal";
  }

  function isOpen() {
    var p = byId("kpModal");
    return !!(p && p.className.indexOf("on") >= 0);
  }

  /* ---------- 动作 ---------- */

  async function test() {
    var cfg = withRest(readInputs());
    var btn = byId("kpTest");
    if (btn) { btn.disabled = true; btn.textContent = "测试中…"; }
    say("正在发一条最短的消息验证「跨域能不能过、Key 对不对、模型名存不存在」…", "");
    try {
      var got = await llm().create(cfg).probe();
      say("连接成功（" + got.ms + " ms），模型回了：" + (got.reply || "(空)"), "ok");
    } catch (e) {
      say((e && e.message) || String(e), "err");
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = "测试连接"; }
    }
  }

  async function save() {
    var cfg = withRest(readInputs());
    if (!cfg.base_url) { say("接口地址不能为空。点上面的预设可以一键填入。", "err"); return; }
    if (!/^https?:\/\//i.test(cfg.base_url)) {
      say("接口地址要以 http:// 或 https:// 开头。", "err"); return;
    }
    if (!cfg.model) { say("模型名不能为空。", "err"); return; }

    if (!cfg.api_key) {
      say("已保存地址与模型。但还没有 Key —— 需要模型的问题仍然答不了"
          + "（指标类问题不受影响）。", "ok");
    } else {
      say("已保存。Key 只写进了这台浏览器的 localStorage。", "ok");
    }
    llm().save(cfg);
    apply();
    setTimeout(close, 700);
  }

  function clearAll() {
    llm().clear();
    var d = llm().DEFAULT;
    byId("kpBase").value = d.base_url || "";
    byId("kpModel").value = d.model || "";
    byId("kpKey").value = "";
    markActive();
    say("已清除本机保存的配置，回到默认地址与模型。", "ok");
    apply();
  }

  /** 配置变了之后让页面跟上：重建 LLM 客户端（api.js 的 ctx 里握着一份），
   *  再调一次 index.html 的 boot() 重刷顶部徽章与横幅。 */
  function apply() {
    if (typeof onApply === "function") {
      try { onApply(); } catch (e) { /* 回调出错不该让面板崩掉 */ }
    }
    if (typeof root.boot === "function") {
      try { root.boot(); } catch (e) { /* 同上 */ }
    }
    /* boot() 只会在「没 Key」时把横幅打开，不会把它关掉。
       而这里刚配好 Key，那条提示已经不对了 —— 由我们负责收掉。 */
    var b = byId("banner");
    if (b && llm().ready()) {
      b.style.display = "none";
      b.setAttribute("data-kp-patched", "");
    }
  }

  /* ---------- 横幅文案 ---------- */

  /** HTML 里那条「未配置 Key」的提示是本地版的写法：让用户去改 config.json、
   *  重启服务。发布版没有这两样东西。源码不能改，所以只能运行时替换。
   *
   *  用 MutationObserver 而不是「定时轮询」：横幅是 index.html 的 boot() 在
   *  拿到 /api/stats 之后才写的，时间点不确定（发布版还要等 3MB 的库解压完）。
   *  观察它，写完就改，比猜时间点可靠。
   *
   *  替换后立刻断开观察：否则我们自己的写入会再触发一次回调 —— 虽然靠
   *  `data-kp-patched` 标记能防住死循环，但断开更干净。 */
  function patchBanner() {
    var b = byId("banner");
    if (!b) return;
    var obs = null;

    function rewrite() {
      var text = b.textContent || "";
      var isLocal = LOCAL_WORDS.some(function (w) { return text.indexOf(w) >= 0; });
      if (!isLocal || b.getAttribute("data-kp-patched")) return;

      b.setAttribute("data-kp-patched", "1");
      b.innerHTML = "尚未配置 API key —— 需要模型的问题暂时无法回答。<br>"
        + "但<b>指标层覆盖的问题（如「各公司岗位数排行」）无需 key 即可提问</b>，"
        + "可以先用它看数据。<br>"
        + "要开启完整问答，点右上角「设置」填入<b>你自己的</b> key"
        + "（只存在这台浏览器，不会上传）。";
      var btn = doc().createElement("button");
      btn.type = "button";
      btn.className = "ghost";
      btn.textContent = "打开设置";
      btn.style.marginTop = "10px";
      btn.onclick = open;
      b.appendChild(doc().createElement("br"));
      b.appendChild(btn);

      if (obs) { obs.disconnect(); obs = null; }
    }

    if (typeof root.MutationObserver === "function") {
      obs = new root.MutationObserver(rewrite);
      obs.observe(b, { childList: true, subtree: true, characterData: true });
    }
    rewrite();     // 万一在我们挂上之前它已经写完了
  }

  /* ---------- 组装 ---------- */

  function mount(opts) {
    opts = opts || {};
    if (typeof opts.onApply === "function") onApply = opts.onApply;
    if (mounted || !doc()) return api;
    mounted = true;

    var d = doc();

    /* 遮层与弹层。注意**只造一次**：模板里的 id 是唯一的，
       造两份会让 getElementById 取到其中一个、事件却在另一个上，极难查。 */
    var mask = d.createElement("div");
    mask.className = "kp-mask";
    mask.id = "kpMask";
    mask.onclick = close;
    d.body.appendChild(mask);

    var modal = d.createElement("div");
    modal.className = "kp-modal";
    modal.id = "kpModal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "大模型接入设置");
    modal.innerHTML = TEMPLATE;
    d.body.appendChild(modal);

    byId("kpClose").onclick = close;
    byId("kpTest").onclick = test;
    byId("kpSave").onclick = save;
    byId("kpClear").onclick = clearAll;
    ["kpBase", "kpModel"].forEach(function (id) {
      var f = byId(id);
      if (f) f.oninput = markActive;
    });
    /* 捕获阶段：面板开着的时候，Esc 应该先关面板，而不是穿透到页面上
       （index.html 自己也监听 Esc，用来关「去学习」浮窗）。 */
    d.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && isOpen()) { e.stopPropagation(); close(); }
    }, true);

    renderPresets();

    /* 齿轮挂在页头那行文字的右上角（.head-row 右侧本来就是空的）。
       找不到就放弃 —— 面板仍可用 JDKeyPanel.open() 打开，
       不该因为一处 DOM 结构变了就让整页报错。 */
    var row = d.querySelector(".head-row");
    if (row) {
      var gear = d.createElement("button");
      gear.type = "button";
      gear.id = "kpGear";
      gear.className = "ghost kp-gear";
      gear.textContent = "设置";
      gear.title = "配置你自己的大模型 API";
      gear.onclick = open;
      row.appendChild(gear);
    }

    patchBanner();
    return api;
  }

  api = {
    mount: mount, open: open, close: close, isOpen: isOpen,
    patchBanner: patchBanner, _renderPresets: renderPresets,
  };
  return api;
});
