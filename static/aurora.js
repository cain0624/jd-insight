/* ==================== 背景动效 Aurora ====================
   来源：React Bits 的 <Aurora />（原版 React + ogl）。
   这个项目是零依赖单文件前端、没有构建步骤，为它引 React + ogl 不划算
   （ogl 一个库就一百多 KB，换的是一层装饰性背景），所以着色器逐字搬过来，
   只重写宿主代码：

     · ogl 的 Renderer   → canvas.getContext('webgl2', {...}) + 手写 setSize
     · ogl 的 Program    → createProgram（顶点/片元着色器一字未改）
     · ogl 的 Triangle   → 一个盖满屏幕的三角形（片元只用 gl_FragCoord，
                           几何形状不影响任何像素，还少一个顶点）
     · ogl 的 Mesh       → drawArrays(TRIANGLES, 0, 3)
     · ogl 的 Color      → hex → [0,1] 三元组
     · 原版那 4 行 CSS   → aurora.css

   用法（和原版是同一套 prop 名，可对着 React Bits 文档调参）：
     Aurora.create(document.getElementById('bgfx'), {
       colorStops: ['#3A29FF', '#FF94B4', '#FF3232'],
       blend: 0.5, amplitude: 1.0, speed: 0.5,
     })
   由 kb/server.py 的 /static/ 路由提供，浏览器直接加载，无需打包。

   与原版的差异（都有理由，逐条记下）：
     1. **顶点属性写 2 分量**。ogl 的 Triangle 提供的是 3 分量
        [-1,-1,0, 3,-1,0, -1,3,0]，而顶点着色器只声明 `in vec2 position`，
        第三个数反正被丢掉。这里直接写 2 分量，语义完全一样。
     2. **uResolution 传「绘制缓冲尺寸」（设备像素），不是 offsetWidth（CSS 像素）**。
        原版 `uv = gl_FragCoord.xy / uResolution`，而 uResolution 是 CSS 尺寸；
        在 DPR=2 的屏幕上 gl_FragCoord 到 2×width，于是 uv 落在 [0,2] 而不是 [0,1]
        —— 色带被压进左半边、右半边靠 mix 外插，`height` 里又直接用 uv.y，
        整条光带的上下位置也跟着屏幕 DPR 变。这是原版的一个 bug（视网膜屏上尤其明显）。
        这里按「uv 铺满整块画布」的本意取设备像素；DPR 上限 2（3x 屏按 3x
        渲染是白烧 2.25 倍像素）。
     3. **不做 sRGB→线性转换**。ogl 的 Color 就是 parseInt 后 /255，这里照做，
        色值所见即所得。（上一版 PixelBlast 对齐的是 three，three 会转线性，
        两者不同 —— 换组件时这类颜色空间的差异最容易让「同一个色号看起来不一样」。）
     4. **颜色只在 set() 时解析一次**。原版每帧都 `new Color(hex)` 三遍，
        一帧 9 次 parseInt，纯属浪费。
     5. **创建时同步画一帧**。原版交给第一次 requestAnimationFrame，代价是
        `create()` 返回到首帧之间画布是空的 —— 首屏、以及任何早于 rAF 的抓取
        看到的都是纯背景。这一帧的成本与之后每帧相同，没有理由拖。
     6. **补齐生命周期**：ResizeObserver / 页面隐藏 / 滚出视口 / destroy。
        原版这些由 React 的 useEffect 负责，搬到零依赖宿主里得自己接；
        `prefers-reduced-motion` 时只画一帧静态图（图案在，只是不动）。
     7. **多出 probe()**：同步重画一帧再 readPixels 读回若干采样点。
        不是装饰代码 —— headless 浏览器的截图里不含 WebGL 图层（实测过：
        `has-bgfx` 加上了、canvas 也建了，整张截图背景仍是纯平色），
        要证明「着色器真的在出图」只能直接读帧缓冲。

   拿不到 WebGL2、着色器编译失败、用户开了「减少动态效果」，都静默降级：
   不报错、不留空白占位。 */

const AURORA_VERT = `#version 300 es
in vec2 position;
void main() {
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

/* 与原版 FRAG 逐字一致，一个字都没改（含 #define 的行连接符）。
   注意：JS 模板串里 `\` + 换行是「续行转义」，会把反斜杠和换行一起吃掉，
   所以宏里每个行尾的 `\` 必须写成 `\\`，否则整段宏会被拼成一行、编译不过。 */
const AURORA_FRAG = `#version 300 es
precision highp float;

uniform float uTime;
uniform float uAmplitude;
uniform vec3 uColorStops[3];
uniform vec2 uResolution;
uniform float uBlend;
uniform float uLightMode;

out vec4 fragColor;

vec3 permute(vec3 x) {
  return mod(((x * 34.0) + 1.0) * x, 289.0);
}

float snoise(vec2 v){
  const vec4 C = vec4(
      0.211324865405187, 0.366025403784439,
      -0.577350269189626, 0.024390243902439
  );
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod(i, 289.0);

  vec3 p = permute(
      permute(i.y + vec3(0.0, i1.y, 1.0))
    + i.x + vec3(0.0, i1.x, 1.0)
  );

  vec3 m = max(
      0.5 - vec3(
          dot(x0, x0),
          dot(x12.xy, x12.xy),
          dot(x12.zw, x12.zw)
      ), 
      0.0
  );
  m = m * m;
  m = m * m;

  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);

  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

struct ColorStop {
  vec3 color;
  float position;
};

#define COLOR_RAMP(colors, factor, finalColor) {              \\
  int index = 0;                                            \\
  for (int i = 0; i < 2; i++) {                               \\
     ColorStop currentColor = colors[i];                    \\
     bool isInBetween = currentColor.position <= factor;    \\
     index = int(mix(float(index), float(i), float(isInBetween))); \\
  }                                                         \\
  ColorStop currentColor = colors[index];                   \\
  ColorStop nextColor = colors[index + 1];                  \\
  float range = nextColor.position - currentColor.position; \\
  float lerpFactor = (factor - currentColor.position) / range; \\
  finalColor = mix(currentColor.color, nextColor.color, lerpFactor); \\
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  
  ColorStop colors[3];
  colors[0] = ColorStop(uColorStops[0], 0.0);
  colors[1] = ColorStop(uColorStops[1], 0.5);
  colors[2] = ColorStop(uColorStops[2], 1.0);
  
  vec3 rampColor;
  COLOR_RAMP(colors, uv.x, rampColor);
  
  float height = snoise(vec2(uv.x * 2.0 + uTime * 0.1, uTime * 0.25)) * 0.5 * uAmplitude;
  height = exp(height);
  height = (uv.y * 2.0 - height + 0.2);
  float intensity = 0.6 * height;
  
  float midPoint = 0.20;
  float auroraAlpha = smoothstep(midPoint - uBlend * 0.5, midPoint + uBlend * 0.5, intensity);
  
  vec3 auroraColor = intensity * rampColor;
  
  if (uLightMode > 0.5) {
    float energy = clamp(max(intensity, 0.0), 0.0, 1.0);
    float coverage = clamp(auroraAlpha * (0.55 + 0.45 * energy), 0.0, 0.86);
    vec3 chroma = pow(clamp(rampColor, 0.0, 1.0), vec3(1.2));
    float chromaPeak = max(chroma.r, max(chroma.g, chroma.b));
    chroma /= max(chromaPeak, 0.0001);
    fragColor = vec4(mix(vec3(1.0), chroma, min(coverage * 1.08, 0.94)), 1.0);
  } else {
    fragColor = vec4(auroraColor * auroraAlpha, auroraAlpha);
  }
}
`;

/* 原版 props 默认值。注意两份来源不一致：Props 表写的是
   ['#3A29FF','#FF94B4','#FF3232']，而组件函数签名里的默认值写的是
   ['#5227FF','#7cff67','#5227FF']。这里取 Props 表那份（对外承诺的那份）。 */
const AURORA_DEFAULTS = {
  colorStops: ["#3A29FF", "#FF94B4", "#FF3232"],
  speed: 1.0,
  blend: 0.5,
  amplitude: 1.0,
  lightMode: false,
  dprMax: 2,          // 移植版新增：3x 屏按 3x 渲染是白烧像素
  antialias: true,    // 移植版新增（对齐原版 Renderer 的 antialias: true）
  className: "",
};

/** '#abc' / '#aabbcc' → [r,g,b]，各分量在 [0,1]。非法值退回 fallback，不抛。 */
function auroraParseHex(hex, fallback) {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(String(hex || "").trim());
  if (!m) return fallback.slice();
  let s = m[1];
  if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
  const n = parseInt(s, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** 三个色号 → 9 个 float 的扁平数组（uniform3fv 要的就是扁平数组）。 */
function auroraStops(list) {
  const src = Array.isArray(list) && list.length >= 3
    ? list.slice(0, 3)
    : AURORA_DEFAULTS.colorStops;
  const out = [];
  for (let i = 0; i < 3; i++) {
    // 缺/坏的那个槽位退回默认色，不至于因为一个错色号整层不出图
    const c = auroraParseHex(src[i], auroraParseHex(AURORA_DEFAULTS.colorStops[i], [1, 1, 1]));
    out.push(c[0], c[1], c[2]);
  }
  return out;
}

function auroraShader(gl, type, src, label) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.warn("[Aurora] " + label + " 编译失败：", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function auroraProgram(gl, vertSrc, fragSrc) {
  const vs = auroraShader(gl, gl.VERTEX_SHADER, vertSrc, "顶点着色器");
  const fs = auroraShader(gl, gl.FRAGMENT_SHADER, fragSrc, "片元着色器");
  if (!vs || !fs) {
    if (vs) gl.deleteShader(vs);
    if (fs) gl.deleteShader(fs);
    return null;
  }
  const p = gl.createProgram();
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  /* 属性位置写死 0 并显式绑定：ogl 会去查 activeAttributes，裸 GL 里
     显式 bindAttribLocation 比 getAttribLocation 更确定（而且必须在 link 前）。 */
  gl.bindAttribLocation(p, 0, "position");
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.warn("[Aurora] 程序链接失败：", gl.getProgramInfoLog(p));
    gl.deleteProgram(p);
    return null;
  }
  return p;
}

/** 盖满屏幕的三角形。片元只用 gl_FragCoord，所以三个顶点足够、不用四边形。
    对应 ogl 的 new Triangle(gl)（它给的是 3 分量，这里的 z 反正被丢掉）。 */
const AURORA_TRI = new Float32Array([-1, -1, 3, -1, -1, 3]);

/** 在 container 里创建 Aurora。返回 {ok, canvas, set, probe, pause, resume, destroy}。 */
function createAurora(container, options) {
  const o = Object.assign({}, AURORA_DEFAULTS, options || {});
  const noop = {
    ok: false, canvas: null,
    set() {}, probe() { return { ok: false }; },
    pause() {}, resume() {}, destroy() {},
  };
  if (!container) return noop;

  const reduce = !!(window.matchMedia
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches);

  const canvas = document.createElement("canvas");
  canvas.className = "aurora-container " + (o.className || "");
  canvas.setAttribute("aria-hidden", "true");
  /* 这一层是背景：不吃指针事件（Aurora 本身也不需要指针输入）。 */
  canvas.style.pointerEvents = "none";

  const gl = canvas.getContext("webgl2", {
    alpha: true,
    premultipliedAlpha: true,   // 对齐原版 Renderer 的默认值
    antialias: !!o.antialias && !reduce,
    depth: false,
    stencil: false,
    powerPreference: "high-performance",
  });
  if (!gl) {
    console.warn("[Aurora] 这个浏览器/环境没有 WebGL2，背景动效跳过");
    return noop;
  }

  const prog = auroraProgram(gl, AURORA_VERT, AURORA_FRAG);
  if (!prog) return noop;

  container.appendChild(canvas);
  canvas.setAttribute("aria-label", "Aurora background");

  const vbo = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
  gl.bufferData(gl.ARRAY_BUFFER, AURORA_TRI, gl.STATIC_DRAW);
  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  gl.disable(gl.DEPTH_TEST);
  gl.disable(gl.CULL_FACE);
  gl.disable(gl.SCISSOR_TEST);

  /* 原版在 effect 开头干的三件事，照搬 */
  gl.clearColor(0, 0, 0, 0);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  const U = {
    uTime: gl.getUniformLocation(prog, "uTime"),
    uAmplitude: gl.getUniformLocation(prog, "uAmplitude"),
    /* 数组 uniform：标准写法是取 name[0]；个别驱动只认不带下标的写法，
       两个都试一次，成本极低。 */
    uColorStops: gl.getUniformLocation(prog, "uColorStops[0]")
      || gl.getUniformLocation(prog, "uColorStops"),
    uResolution: gl.getUniformLocation(prog, "uResolution"),
    uBlend: gl.getUniformLocation(prog, "uBlend"),
    uLightMode: gl.getUniformLocation(prog, "uLightMode"),
  };

  let stops = auroraStops(o.colorStops);
  let size = { w: 0, h: 0, dpr: 1 };
  let time = 0;               // 单位：秒 × speed，等价于原版的 uTime
  let raf = 0;
  let running = false;
  let onScreen = true;
  let manualPaused = false;

  /* ---------- 尺寸 ----------
     container 是 position:fixed;inset:0，所以尺寸就是视口。
     原版把 uResolution 设成 offsetWidth（CSS 像素），见文件头的差异 2。 */
  function resize() {
    const w = Math.max(1, container.clientWidth || container.offsetWidth || 1);
    const h = Math.max(1, container.clientHeight || container.offsetHeight || 1);
    const dpr = Math.min(window.devicePixelRatio || 1, o.dprMax);
    const dw = Math.max(1, Math.round(w * dpr));
    const dh = Math.max(1, Math.round(h * dpr));
    if (dw === size.w && dh === size.h) return;
    size = { w: dw, h: dh, dpr };
    canvas.width = dw;
    canvas.height = dh;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
  }

  function draw(t) {
    time = t;
    gl.viewport(0, 0, size.w, size.h);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniform1f(U.uTime, t);
    gl.uniform1f(U.uAmplitude, o.amplitude);
    gl.uniform3fv(U.uColorStops, stops);
    gl.uniform2f(U.uResolution, size.w, size.h);
    gl.uniform1f(U.uBlend, o.blend);
    gl.uniform1f(U.uLightMode, o.lightMode ? 1 : 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  /* 原版的时间口径：uTime = (t_ms * 0.01) * speed * 0.1 = t_秒 * speed。
     也就是说 speed 就是「每秒推进多少个噪声单位」。 */
  const clock = { t0: performance.now(), elapsed: 0 };

  const shouldRun = () => !manualPaused
    && !reduce
    && onScreen
    && !document.hidden
    && !gl.isContextLost();

  function frame() {
    if (!shouldRun()) { running = false; raf = 0; return; }
    clock.elapsed = (performance.now() - clock.t0) / 1000;
    draw(clock.elapsed * o.speed);
    raf = requestAnimationFrame(frame);
  }
  function kick() {
    if (running || !shouldRun()) return;
    running = true;
    raf = requestAnimationFrame(frame);
  }

  /* ---------- 尺寸 / 可见性 ---------- */
  const ro = new ResizeObserver(() => {
    resize();
    draw(time);      // 尺寸变了要立刻按新分辨率重画，否则会被拉伸
    kick();
  });
  ro.observe(container);

  const io = "IntersectionObserver" in window
    ? new IntersectionObserver(es => {
        onScreen = es.some(x => x.isIntersecting);
        kick();
      }, { threshold: 0 })
    : null;
  if (io) io.observe(container);

  const onVis = () => kick();
  document.addEventListener("visibilitychange", onVis);

  resize();
  /* 创建时同步出一帧（差异 5）。减少动态效果时也只画这一帧：图案在，只是不动。 */
  draw(reduce ? 12.5 * o.speed : 0);
  if (!reduce) kick();

  return {
    ok: true,
    canvas,
    pause() { manualPaused = true; kick(); },
    resume() { manualPaused = false; clock.t0 = performance.now() - clock.elapsed * 1000; kick(); },
    set(next) {
      Object.assign(o, next);
      if ("colorStops" in next) stops = auroraStops(o.colorStops);
      resize();
      draw(time);
      kick();
    },
    /* ---------- 诊断 ----------
       同步重画一帧，然后直接 readPixels 读回采样点。readPixels 读的是真帧缓冲，
       不经过合成阶段，所以 headless 里截图看不到 WebGL 图层、这里却能读到内容。
       只要读和画在同一个任务里完成（中间不让出事件循环），即使
       preserveDrawingBuffer:false 也读得到。 */
    probe() {
      if (gl.isContextLost()) return { ok: false, reason: "context lost" };
      draw(time);
      const rows = [0.08, 0.25, 0.5, 0.85];          // 从上到下四条横带
      const cw = Math.min(size.w, 96);
      const x = Math.max(0, Math.round((size.w - cw) / 2));
      const samples = [];
      const buf = new Uint8Array(cw * 4);
      let mn = [255, 255, 255];
      let mx = [0, 0, 0];
      let sum = [0, 0, 0];
      for (const ry of rows) {
        /* gl_FragCoord 原点在左下，采样按「从上往下」的观感取，所以要翻转 */
        const y = Math.max(0, Math.min(size.h - 1, Math.round((1 - ry) * size.h)));
        gl.readPixels(x, y, cw, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
        for (let i = 0; i < cw; i++) {
          const r = buf[i * 4], g = buf[i * 4 + 1], b = buf[i * 4 + 2];
          samples.push([x + i, y, r, g, b]);
          for (let k = 0; k < 3; k++) {
            const v = [r, g, b][k];
            if (v < mn[k]) mn[k] = v;
            if (v > mx[k]) mx[k] = v;
            sum[k] += v;
          }
        }
      }
      const n = samples.length;
      const mean = sum.map(v => Math.round(v / n));
      const span = Math.max(mx[0] - mn[0], Math.max(mx[1] - mn[1], mx[2] - mn[2]));
      return {
        ok: true, w: size.w, h: size.h, dpr: size.dpr, time,
        blend: o.blend, amplitude: o.amplitude, lightMode: !!o.lightMode,
        colorStops: o.colorStops, min: mn, max: mx, mean,
        span, flat: span <= 2,                    // 整条都是同一个色 = 没画出东西
        samples,
      };
    },
    destroy() {
      running = false;
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVis);
      ro.disconnect();
      if (io) io.disconnect();
      gl.deleteProgram(prog);
      gl.deleteBuffer(vbo);
      gl.deleteVertexArray(vao);
      gl.getExtension("WEBGL_lose_context")?.loseContext();
      canvas.remove();
    },
  };
}

window.Aurora = {
  create: createAurora,
  DEFAULTS: AURORA_DEFAULTS,
  /* 导出着色器源码：离线测试要靠它对着源码查 uniform 名（拼错是静默的），
     否则只能去读宿主代码。 */
  SHADERS: { vert: AURORA_VERT, frag: AURORA_FRAG },
};
