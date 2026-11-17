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
    if (tryHook() || ++tries > 6000) clearInterval(iv);
    if (S.hooked && !S.scanned) scanWarp();
  }, 10);

  /* ---------- 2a. warp 预算：扫描解释器实例并可选下调阈值 ---------- */
  // 官方内核给 warp（超强模式）死循环留了保护：每步 1e4 次迭代 / 100ms。
  // 但这是"每个线程"的额度，实体一多（11 个实体 = 1.1s/帧）整帧就被烧光。
  // 这里能把额度调小，或由主进程在卡帧时自动下调，用于"卡死保护"。
  function scanWarp() {
    var rm = getRm();
    if (!rm) return;
    var found = [];
    var walk = function (o, path, d) {
      if (!o || typeof o !== 'object' || d > 3 || found.length > 40) return;
      try {
        if ('max_warp_iterations_per_interpreter_step' in o) {
          found.push({ path: path, it: o.max_warp_iterations_per_interpreter_step, ms: o.warp_interpreter_millisecond_time_limit, obj: o });
        }
      } catch (e) {}
      if (d === 3) return;
      var ks; try { ks = Object.keys(o); } catch (e) { return; }
      for (var i = 0; i < ks.length && found.length <= 40; i++) {
        var v; try { v = o[ks[i]]; } catch (e) { continue; }
        if (v && typeof v === 'object') walk(v, path + '.' + ks[i], d + 1);
      }
    };
    walk(rm, 'rm', 0);
    S.scanned = true;
    var dk = Object.keys(rm);
    var dump = { rm: dk, sizes: {} };
    dk.forEach(function (k) {
      try {
        var v = rm[k];
        if (v && typeof v === 'object') {
          var ks = Object.keys(v);
          dump.sizes[k] = ks.slice(0, 12).join(',');
          if (Array.isArray(v)) dump.sizes[k] = 'array ' + v.length;
        } else if (typeof v !== 'function') dump.sizes[k] = String(v).slice(0, 20);
      } catch (e) {}
    });
    // 克隆上限：验证"克隆风暴"是不是真正的开销来源
    var clones = [];
    var cloneWalk = function (o, path, d) {
      if (!o || typeof o !== 'object' || d > 3 || clones.length > 20) return;
      try { if ('per_entity_clone_limit' in o) clones.push({ path: path, obj: o }); } catch (e) {}
      if (d === 3) return;
      var ks; try { ks = Object.keys(o); } catch (e) { return; }
      for (var i = 0; i < ks.length && clones.length <= 20; i++) {
        var v; try { v = o[ks[i]]; } catch (e) { continue; }
        if (v && typeof v === 'object') cloneWalk(v, path + '.' + ks[i], d + 1);
      }
    };
    cloneWalk(rm, 'rm', 0);
    dump.clones = clones.map(function (c) { return c.path; });
    var cl = parseFloat(matchParam('k4p_clone'));
    if (cl > 0) clones.forEach(function (c) { c.obj.per_entity_clone_limit = cl; });
    if (cl > 0) dump.cloneApplied = cl;
    S.dump = dump;
    S.warp = { count: found.length, list: found.map(function (f) { return f.path + '=' + f.it + '/' + f.ms; }) };

    var it = parseFloat(matchParam('k4p_warp_it'));
    var ms = parseFloat(matchParam('k4p_warp_ms'));
    if (found.length && (it > 0 || ms > 0)) {
      found.forEach(function (f) {
        if (it > 0) f.obj.max_warp_iterations_per_interpreter_step = it;
        if (ms > 0) f.obj.warp_interpreter_millisecond_time_limit = ms;
      });
      S.warp.applied = { it: it > 0 ? it : null, ms: ms > 0 ? ms : null };
    }
  }

  function matchParam(name) {
    var m = new RegExp('[?&]' + name + '=([^&]*)').exec(location.search);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /* ---------- 2c. 帧耗时基准（?k4p_bench=1）----------
   * 页面常在后台，rAF 会被节流，fps 读数不可信。
   * 这里直接连续调用 run_mgr.update(N) 计时，得到与可见性无关的单帧脚本耗时。
   */
  if (/[?&]k4p_bench=1/.test(location.search)) {
    var N = parseFloat(matchParam('k4p_bench_n')) || 200;
    var benchDone = false;
    var waitHook = setInterval(function () {
      var rm = getRm();
      if (!rm || typeof rm.update !== 'function' || ++tries > 6000) return;
      clearInterval(waitHook);
      setTimeout(function () {
        try {
          var t0 = performance.now(), times = [];
          for (var i = 0; i < N; i++) {
            var a = performance.now();
            rm.update(16.67);
            times.push(performance.now() - a);
          }
          var dt = performance.now() - t0;
          times.sort(function (x, y) { return x - y; });
          S.bench = {
            n: N,
            totalMs: Math.round(dt * 10) / 10,
            perFrameMs: Math.round(dt / N * 1000) / 1000,
            medMs: Math.round(times[Math.floor(times.length / 2)] * 10) / 10,
            maxMs: Math.round(times[times.length - 1] * 10) / 10,
          };
        } catch (e) {
          S.bench = { error: String(e && e.message || e) };
        }
        benchDone = true;
      }, 8000);
    }, 20);
  }

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
    // 页面被同步死循环占满时，隔离世界的脚本探针读不到 DOM 属性；
    // 标题属于浏览器层，用 page_info 就能拿到，作为兜底通道。
    if (json.length < 1200) { try { document.title = 'K4P' + json; } catch (e) {} }
    try { console.log('[k4p:probe]', json); } catch (e) {}
  }
  setInterval(publish, 500);
})();
