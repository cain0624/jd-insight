/* 浏览器版 LLM 客户端 —— 从 `kb/llm.py` 移植。
 *
 * 与本地版最大的区别不是协议（协议一模一样，还是 OpenAI 兼容的
 * /chat/completions），而是**信任模型变了**：
 *
 *   本地版：key 存在 config.json 里，由服务端持有，浏览器始终看不到它。
 *   静态版：没有服务端。key 只能放在浏览器里，由浏览器**直接**发给模型厂商。
 *
 * 这带来三条硬约束，改这个文件前先读：
 *
 * ① **key 只可能存在 localStorage**，且只发往用户自己填的那个 base_url。
 *    页面上任何一段脚本（包括以后有人加的统计代码）都能读到它 —— 这是
 *    静态站点无法回避的事实，所以界面上必须明说，不能假装安全。
 *    代码这边能做的：不打印、不上报、不写进 URL、不进 catch 的日志。
 *
 * ② **CORS 是硬门槛，且无法在代码里补救**。带 `Authorization` 头 + JSON body
 *    的 POST 一定会触发预检（OPTIONS）。厂商不回 CORS 头就是不行，代理也
 *    绕不过去（除非用户自己搭代理，那是他的选择）。
 *
 *    2026-09-19 在**线上页面的真实执行环境**里逐个打过 —— 用一把故意无效的
 *    假 key，看能不能拿到 HTTP 状态码：拿得到就说明请求真的到了服务端、
 *    跨域是通的（401 正是假 key 该有的结果）。
 *      · 硅基流动  api.siliconflow.cn     → 401，579ms  ✅
 *      · DeepSeek  api.deepseek.com       → 401，351ms  ✅
 *      · 通义千问  dashscope.aliyuncs.com → 401，456ms  ✅
 *      · Kimi      api.moonshot.cn        → 401，492ms  ✅
 *      · 智谱 GLM  open.bigmodel.cn       → 401，490ms  ✅
 *      · devin-tec api.devin-tec.cn       → TypeError，373ms  ❌ 预检就被拦
 *      · OpenAI    api.openai.com         → TypeError，284ms  ❌（国内网络，
 *                                           没走到跨域这一步）
 *    所以 PRESETS 里标「已实测」的是真的打过，「未实测跨域」是真的没打 ——
 *    这个字段别凭印象改。
 *
 *    另记一笔**试过但不可行**的路：本机起一个带 CORS 头的转发代理。
 *    混合内容那关能过（loopback 属于 potentially trustworthy origin），
 *    但 Chrome 153 的 Local Network Access 会拦：
 *      blocked by CORS policy: Permission was denied for this request to
 *      access the `loopback` address space.
 *    连 CDP 预授权 `localNetworkAccess` 都无效，只有改浏览器启动参数才通。
 *    对线上访客不是一个可提的方案 —— 详情见 tools/llm_cors_proxy.mjs。
 *
 * ③ **网络错误在浏览器里分不出因**。fetch 被 CORS 拦掉、DNS 挂了、TLS 失败、
 *    用户断网，抛出来的都是同一个 `TypeError: Failed to fetch`。本地版能靠
 *    requests 的异常类型区分，这里不能。所以错误文案只能把几种可能都摆出来，
 *    而不是猜一个 —— 猜错会让用户往错的方向查半天。
 *
 * 另一处刻意的分歧：本地版 `LLM.__init__` 在缺 key 时直接抛 LLMError（服务启动
 * 即失败）；这里**构造客户端不抛错**，把「没 key」推迟到调用时。
 * 因为静态版没有"启动"这一步 —— 用户是要先看到界面、试几个零 token 的问题，
 * 才可能决定去填 key。构造即抛错会让整个页面用不了。
 */
(function (root, factory) {
  var api = factory(root);
  root.JDLLM = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function (root) {
  "use strict";

  var SK = "jd_insight_llm";        // localStorage 键名

  var DEFAULT = {
    base_url: "https://api.siliconflow.cn/v1",
    api_key: "",
    model: "deepseek-ai/DeepSeek-V4-Flash",
    temperature: 0,
    timeout: 90
  };

  /* 预设。`tested` 只标记「本项目的可行性验证真的打过这个域名」，
     不代表厂商承诺长期可用 —— 所以界面上仍要允许手填 base_url。

     `works:false` 是另一种情况：**实测过、结论是不可用**。放进来是因为
     踩过的坑不该被丢掉（下一个想接它的人会先搜到这里），但设置面板必须
     把它渲染成不可点、并写明原因 —— 可点等于给用户挖坑。 */
  var PRESETS = [
    { name: "硅基流动", base_url: "https://api.siliconflow.cn/v1",
      model: "deepseek-ai/DeepSeek-V4-Flash", tested: true,
      note: "本项目的默认值，跨域头实测可用" },
    { name: "DeepSeek", base_url: "https://api.deepseek.com/v1",
      model: "deepseek-chat", tested: true,
      note: "跨域头实测可用（回显 origin）" },
    { name: "通义千问", base_url: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      model: "qwen-plus", tested: true,
      note: "跨域实测可用（2026-09-19 在线上页面真实环境里验过，假 key 拿到 401）" },
    { name: "Kimi", base_url: "https://api.moonshot.cn/v1",
      model: "moonshot-v1-8k", tested: true,
      note: "跨域实测可用（同上）" },
    { name: "智谱 GLM", base_url: "https://open.bigmodel.cn/api/paas/v4",
      model: "glm-4-flash", tested: true,
      note: "跨域实测可用（同上）" },
    { name: "OpenAI", base_url: "https://api.openai.com/v1",
      model: "gpt-4o-mini", tested: false,
      note: "未实测跨域；国内网络通常需要代理。2026-09-19 实测：当前网络下请求"
          + "连发都没发出去（那不是跨域的结论）" },

    /* 实测记录：**浏览器直连不可用**。
     *
     * 2026-09-17 用 curl 打这个域名，POST 正常返回 200（模型是 glm-5.2，
     * 说明 glm-5.3-flash 被中转映射过），但响应里**完全没有
     * access-control-allow-origin**，OPTIONS 预检也一样；换四个 Origin
     * （github.io / localhost / 127.0.0.1 / example.com）都不回显。
     *
     * 所以结论不是「没试过」，是「试过了，不行」：带上 Authorization 与
     * application/json 的 POST 一定会触发预检，服务端不回跨域头，
     * 浏览器就会拦掉 —— 命令行能通，页面一定不能通。 */
    { name: "devin-tec 中转", base_url: "https://api.devin-tec.cn/v1",
      model: "glm-5.3-flash", tested: false, works: false,
      note: "实测该域名不回跨域头：curl 能通，浏览器会在预检阶段被拦掉，"
          + "纯前端直连用不了。2026-09-19 线上复测仍是 TypeError: Failed to "
          + "fetch，373ms 即失败（就停在预检那一步）。此处仅作记录。" },
  ];

  function LLMError(msg) {
    var e = new Error(msg);
    e.name = "LLMError";
    e.isLLMError = true;
    return e;
  }

  /* ---------- 配置读写 ---------- */

  function load() {
    var cfg = {};
    Object.keys(DEFAULT).forEach(function (k) { cfg[k] = DEFAULT[k]; });
    try {
      var raw = root.localStorage && root.localStorage.getItem(SK);
      if (raw) {
        var got = JSON.parse(raw);
        Object.keys(DEFAULT).forEach(function (k) {
          if (got[k] !== undefined && got[k] !== null) cfg[k] = got[k];
        });
      }
    } catch (e) {
      /* localStorage 被禁（隐私模式 / 三方 iframe）时退回默认值。
         不抛错：没理由因为存不了配置就让整个页面起不来。 */
    }
    return cfg;
  }

  function save(cfg) {
    try {
      root.localStorage.setItem(SK, JSON.stringify(cfg));
      return true;
    } catch (e) {
      return false;    // 让调用方去提示「这台浏览器不让你保存」
    }
  }

  function clear() {
    try { root.localStorage.removeItem(SK); } catch (e) { /* 同上 */ }
  }

  function ready(cfg) {
    return !!((cfg || load()).api_key || "").trim();
  }

  /* ---------- 工具 ---------- */

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  /** 实测过「浏览器直连不可用」的域名。用户手填上来时直接点名，
   *  别让他照着三种可能猜 —— 猜错会往错的方向查半天。 */
  function blockedNote(baseUrl) {
    var u = String(baseUrl || "").replace(/\/+$/, "");
    for (var i = 0; i < PRESETS.length; i++) {
      var p = PRESETS[i];
      if (p.works === false &&
          String(p.base_url || "").replace(/\/+$/, "") === u) return p;
    }
    return null;
  }

  function describe(e, baseUrl) {
    /* 浏览器把「跨域被拦」「断网」「DNS 失败」全压成一个 TypeError，
       这里能确定的只有「请求没到达/没拿到响应」这件事本身。 */
    var m = (e && e.message) || String(e);
    if (e && e.name === "AbortError") {
      return "请求超时：" + baseUrl + " 在超时时间内没有回响应。" +
             "可以调大超时后重试，或换一家更快的服务商。";
    }
    var bad = blockedNote(baseUrl);
    if (bad) {
      return "网络请求失败（" + m + "）：「" + bad.name + "」实测不回跨域头，"
           + "浏览器在预检那一步就会拦掉它 —— 纯前端页面里这一家用不了，"
           + "请换面板里标着「已实测」的服务商。";
    }
    return "网络请求失败（" + m + "）：请求没能拿到响应。最可能的原因是" +
           "① 该服务商不允许浏览器跨域（CORS）—— 换一家最快，面板里标" +
           "「已实测」的五家都验过；其次是 ② 网络不通或需要代理；" +
           "③ 地址填错了（要带 /v1 这类前缀，且不要带 /chat/completions）。" +
           "本次请求的是 " + baseUrl + "。";
  }

  /* 与 kb/llm.py 的 parse_json 一致：模型常把 JSON 包在 ``` 围栏里，
     也常在外面多写一句「好的，以下是...」。两层兜底：先剥围栏，再抓第一个
     平衡的 {...}。 */
  function parseJson(raw) {
    var t = (raw || "").trim();
    if (t.indexOf("```") === 0) {
      var nl = t.indexOf("\n");
      t = nl >= 0 ? t.slice(nl + 1) : t;
      var r = t.replace(/\s+$/, "");
      if (r.slice(-3) === "```") t = r.slice(0, -3);
    }
    t = t.trim();
    try { return JSON.parse(t); } catch (e) { /* 落到括号抓取 */ }

    var start = t.indexOf("{");
    if (start >= 0) {
      var depth = 0;
      for (var i = start; i < t.length; i++) {
        if (t.charAt(i) === "{") depth++;
        else if (t.charAt(i) === "}") {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(t.slice(start, i + 1)); } catch (e2) { break; }
          }
        }
      }
    }
    throw LLMError("无法解析为 JSON：" + (raw || "").slice(0, 300));
  }

  /* ---------- 客户端 ---------- */

  function create(cfg) {
    var c = cfg || load();
    var baseUrl = String(c.base_url || DEFAULT.base_url).replace(/\/+$/, "");
    var apiKey = String(c.api_key || "").trim();
    var model = c.model || DEFAULT.model;
    var temperature = (c.temperature === undefined || c.temperature === null)
      ? DEFAULT.temperature : c.temperature;
    var timeoutMs = (Number(c.timeout) || DEFAULT.timeout) * 1000;

    /* chat(messages, temperature?, maxRetry?, kw...)
       对齐 kb/llm.py 的签名与重试节奏（网络错 1.5s×(n+1)、429 用 3s×(n+1)），
       这样两边的行为在「第几次尝试成功」这件事上也是一致的。 */
    async function chat(messages, opts) {
      opts = opts || {};
      if (!apiKey) {
        throw LLMError(
          "尚未设置 API Key。点右上角「设置」填入后即可向模型提问。\n" +
          "提示：指标层覆盖的问题（例如「各公司岗位数排行」）不需要 Key，" +
          "现在就能直接问。");
      }
      var url = baseUrl + "/chat/completions";
      var body = {
        model: model,
        messages: messages,
        temperature: opts.temperature === undefined || opts.temperature === null
          ? temperature : opts.temperature
      };
      /* 多余的参数原样透传，与 Python 的 body.update(kw) 一致 */
      Object.keys(opts).forEach(function (k) {
        if (k !== "temperature" && k !== "maxRetry" && k !== "timeout") body[k] = opts[k];
      });
      var headers = {
        "Authorization": "Bearer " + apiKey,
        "Content-Type": "application/json"
      };
      var maxRetry = opts.maxRetry === undefined ? 2 : opts.maxRetry;
      var wait = opts.timeout ? Number(opts.timeout) * 1000 : timeoutMs;
      var last = null;

      for (var attempt = 0; attempt <= maxRetry; attempt++) {
        var ctl = new AbortController();
        var timer = setTimeout(function () { ctl.abort(); }, wait);
        var r;
        try {
          r = await fetch(url, {
            method: "POST", headers: headers,
            body: JSON.stringify(body), signal: ctl.signal
          });
        } catch (e) {
          clearTimeout(timer);
          last = describe(e, baseUrl);
          if (e && e.name === "AbortError") break;   // 超时不重试：再等一次还是等
          await sleep(1500 * (attempt + 1));
          continue;
        }
        clearTimeout(timer);

        if (r.status === 200) {
          var text = await r.text();
          var d;
          try { d = JSON.parse(text); }
          catch (e) { throw LLMError("响应结构异常：" + text.slice(0, 300)); }
          try { return d.choices[0].message.content; }
          catch (e) { throw LLMError("响应结构异常：" + text.slice(0, 300)); }
        }
        if (r.status === 401 || r.status === 403) {
          /* 不把响应体整个抛出去：某些网关会把请求头回显在错误里，而那里有 key。 */
          throw LLMError(
            "鉴权失败（HTTP " + r.status + "）：这把 Key 在 " + baseUrl +
            " 上不被接受（模型填的是 " + model + "）。\n" +
            "Key 与接口地址必须来自同一家服务商 —— 最常见的两种错是" +
            "「A 家的 Key 填在 B 家的地址上」和「地址漏了 /v1」。");
        }
        if (r.status === 429) {
          last = "触发限流（429）：请求太频繁或额度用尽。";
          await sleep(3000 * (attempt + 1));
          continue;
        }
        var eb = "";
        try { eb = (await r.text()).slice(0, 300); } catch (e) { /* 读不出来就算了 */ }
        last = "HTTP " + r.status + "：" + eb;
        if (r.status < 500) break;     // 4xx 重试没意义，直接给用户看
        await sleep(1500 * (attempt + 1));
      }
      throw LLMError("调用失败（" + model + " @ " + baseUrl + "）：" + last);
    }

    async function jsonChat(messages, opts) {
      return parseJson(await chat(messages, opts));
    }

    /* 连通性自检：设置面板的「测试连接」用。刻意发一条最短的消息 ——
       验证的是「跨域能不能过、key 对不对、模型名存不存在」这三件事，
       不需要它答得好。 */
    async function probe() {
      var t0 = Date.now();
      var got = await chat([{ role: "user", content: "回复 OK" }],
                           { maxRetry: 0, temperature: 0 });
      return { ok: true, ms: Date.now() - t0, reply: (got || "").trim().slice(0, 40) };
    }

    return {
      chat: chat, jsonChat: jsonChat, probe: probe,
      baseUrl: baseUrl, model: model, hasKey: !!apiKey
    };
  }

  return {
    STORAGE_KEY: SK, DEFAULT: DEFAULT, PRESETS: PRESETS,
    LLMError: LLMError, load: load, save: save, clear: clear, ready: ready,
    create: create, parseJson: parseJson
  };
});
