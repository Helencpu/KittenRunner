/**
 * 帧内时间分布探针（诊断用，默认不启用）
 *
 * 启用：在播放器页地址后加 ?k4p_probe=1（外壳页可透传，见 server.js）
 * 关闭：不加该参数时本脚本在首行即 return，零开销。
 *
 * 只做测量，不改任何运行时行为：把「帧间隔、一帧总耗时、脚本更新耗时」
 * 滚动平均后写到 document.documentElement 的 data-k4p-probe 属性上。
 * 之所以写 DOM 而不挂 window 对象：外部工具通常在隔离环境里读不到页面的
 * expando，DOM 属性是两边都能读的通道。
 */
(function () {
  'use strict';
  if (!/[?&]k4p_probe=1/.test(location.search)) return;
  if (window.__k4pProbeInstalled) return;
  window.__k4pProbeInstalled = true;

  var S = {
    frames: 0,          // 统计帧数
    fps: 0,             // 平均 fps
    frameMs: 0,         // 相邻 rAF 间隔均值
    scriptMs: 0,        // run_mgr.update 均值
    scriptMax: 0,       // 单帧脚本耗时峰值
    updates: 0,
    blocks: 0,          // 本帧执行积木数（若可读）
    hooked: false,
    t: Math.round(performance.now()),
  };

  var EMA = 0.08;
  function mix(prev, cur) { return prev ? prev * (1 - EMA) + cur * EMA : cur; }

  /* ---------- 1. rAF 帧间隔 ---------- */
  var lastTs = 0;
  function tick(ts) {
    if (lastTs) {
      var d = ts - lastTs;
      if (d > 0 && d < 2000) {
        S.frames++;
        S.frameMs = mix(S.frameMs, d);
        if (S.frameMs > 0) S.fps = 1000 / S.frameMs;
      }
    }
    lastTs = ts;
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);

  /* ---------- 2. 运行时 update 计时 ---------- */
  function getRm() {
    try {
      var B = window.__k4b, C = window.__k4c;
      if (!B || !C) return null;
      var fac = C.get(B.RuntimeManagerFacade);
      return (fac && fac.run_mgr) || null;
    } catch (e) { return null; }
  }

  function tryHook() {
    var rm = getRm();
    if (!rm || typeof rm.update !== 'function' || rm.__k4pProbe) return !!rm && rm.__k4pProbe;
    var orig = rm.update;
    rm.update = function () {
      var t0 = performance.now();
      var r;
      try { r = orig.apply(this, arguments); }
      finally {
        var d = performance.now() - t0;
        S.updates++;
        S.scriptMs = mix(S.scriptMs, d);
        if (d > S.scriptMax) S.scriptMax = d;
      }
      return r;
    };
    rm.__k4pProbe = true;
    S.hooked = true;
    return true;
  }

  var tries = 0;
  var iv = setInterval(function () {
    if (tryHook() || ++tries > 1200) clearInterval(iv);
  }, 10);

  /* ---------- 2b. 画笔计数（?k4p_pen=1）---------- */
  if (/[?&]k4p_pen=1/.test(location.search)) {
    S.pen = { strokes: 0, arcs: 0, texUpdates: 0, threads: 0, actors: 0, ink: 0 };
    S.pen.canvases = [];
    var P = CanvasRenderingContext2D.prototype;
    var oStroke = P.stroke, oArc = P.arc;
    function note(c) {
      if (!c || c.width < 300 || c.height < 300) return;
      var list = S.pen.canvases;
      for (var i = 0; i < list.length; i++) if (list[i] === c) return;
      if (list.length < 4) list.push(c);
    }
    P.stroke = function () {
      note(this.canvas);
      if (this.canvas && this.canvas.width > 300 && this.canvas.height > 300) {
        S.pen.strokes++;
        var t0 = performance.now();
        try { return oStroke.apply(this, arguments); }
        finally { S.pen.strokeMs += performance.now() - t0; }
      }
      return oStroke.apply(this, arguments);
    };
    P.arc = function () {
      note(this.canvas);
      if (this.canvas && this.canvas.width > 300 && this.canvas.height > 300) S.pen.arcs++;
      return oArc.apply(this, arguments);
    };

    // 纹理上传：每帧把整张画笔画布 texImage2D 传 GPU，这里计时
    S.pen.strokeMs = 0;
    S.pen.upMs = 0;
    S.pen.upCount = 0;
    S.pen.upBytes = 0;
    try {
      var W = window.WebGL2RenderingContext, W1 = window.WebGLRenderingContext;
      [W, W1].forEach(function (Ctor) {
        if (!Ctor) return;
        var oTex = Ctor.prototype.texImage2D;
        Ctor.prototype.texImage2D = function () {
          var src = arguments[5];
          if (src && src.width > 300 && src.height > 300) {
            var t0 = performance.now();
            try { return oTex.apply(this, arguments); }
            finally {
              S.pen.upMs += performance.now() - t0;
              S.pen.upCount++;
              S.pen.upBytes += src.width * src.height * 4;
            }
          }
          return oTex.apply(this, arguments);
        };
      });
    } catch (e) {}
    // 每次 publish 采样"被画笔描过的那块画布"的墨迹占比（采样步长 4，避免读全图太慢）
    S.pen.inkOf = function () {
      try {
        var list = S.pen.canvases;
        if (!list.length) return -1;
        var out = [];
        for (var k = 0; k < list.length; k++) {
          var c = list[k];
          var ctx = c.getContext && c.getContext('2d');
          if (!ctx) { out.push({ w: c.width, h: c.height, ink: -2 }); continue; }
          var d = ctx.getImageData(0, 0, c.width, c.height).data;
          var hit = 0, tot = 0;
          for (var i = 3; i < d.length; i += 4 * 7) { tot++; if (d[i] > 8) hit++; }
          out.push({ w: c.width, h: c.height, ink: Math.round(hit * 100 / (tot || 1)) });
        }
        return out;
      } catch (e) { return -3; }
    };
  }

  /* ---------- 3. 输出到 DOM ---------- */
  var prev = null;
  function publish() {
    S.blocks = 0;
    S.t = Math.round(performance.now());
    if (S.pen) {
      S.pen.ink = S.pen.inkOf();
      var cur = { s: S.pen.strokes, a: S.pen.arcs, u: S.pen.upCount, sm: S.pen.strokeMs, um: S.pen.upMs };
      if (prev) {
        // 最近 500ms 增量：strokes/s、纹理上传次数/s 与两类耗时占比
        S.pen.d = {
          strokes: cur.s - prev.s,
          arcs: cur.a - prev.a,
          ups: cur.u - prev.u,
          strokeMs: +(cur.sm - prev.sm).toFixed(2),
          upMs: +(cur.um - prev.um).toFixed(2),
        };
      }
      prev = cur;
    }
    var json = '';
    try { json = JSON.stringify(S); } catch (e) { json = '{"err":"json"}'; }
    try { document.documentElement.setAttribute('data-k4p-probe', json); } catch (e) {}
    try { console.log('[k4p:probe]', json); } catch (e) {}
  }
  setInterval(publish, 500);
})();
