/**
 * 积木错误隔离（通用，K4 / KN 共用）
 *
 * 图形化运行时的每帧执行都由 requestAnimationFrame / 定时器 / 事件回调驱动。
 * 某个积木抛出异常时，正常会中断整条执行链，表现为「作品卡住不动」。
 * 这里把这三类入口统一包上 try/catch：异常被就地吞掉并上报，调度继续，
 * 于是同一作品的其他脚本仍能继续运行 —— 这就是「出错还能继续跑」。
 */
(function () {
  if (window.__K4P_RESILIENCE__) return;
  window.__K4P_RESILIENCE__ = true;

  var MAX_KEEP = 200;
  var seen = Object.create(null);
  var errors = (window.__K4P__ = window.__K4P__ || {}).errors = window.__K4P__.errors || [];
  var REPORT_URL = '/k4p/report-error';

  function describe(e) {
    if (!e) return { message: 'unknown', stack: '' };
    if (typeof e === 'string') return { message: e, stack: '' };
    return {
      message: String(e.message || e.name || e),
      stack: String(e.stack || '').split('\n').slice(0, 6).join('\n'),
    };
  }

  function report(e, where) {
    var d = describe(e);
    var key = where + '|' + d.message;
    var rec = seen[key];
    if (rec) { rec.count++; return; }        // 同一错误刷屏时只累计，不再上报
    seen[key] = { count: 1, at: Date.now() };

    var item = { t: Date.now(), where: where, message: d.message, stack: d.stack, count: 1 };
    errors.push(item);
    if (errors.length > MAX_KEEP) errors.splice(0, errors.length - MAX_KEEP);

    try { console.warn('[k4p:isolate] ' + where + ' :: ' + d.message); } catch (_) {}
    try {
      var body = JSON.stringify(item);
      if (navigator.sendBeacon) navigator.sendBeacon(REPORT_URL, body);
      else fetch(REPORT_URL, { method: 'POST', body: body, headers: { 'Content-Type': 'application/json' } });
    } catch (_) {}
  }

  // 1) 帧循环：单帧异常不终止调度
  var rawRaf = window.requestAnimationFrame;
  if (rawRaf) {
    window.requestAnimationFrame = function (cb) {
      return rawRaf.call(window, function (ts) {
        try { return cb(ts); } catch (e) { report(e, 'frame'); }
      });
    };
  }

  // 2) 定时器不再包装：官方 SDK 与本地预编译器都依赖 setTimeout/setInterval 的
  //    时序语义，包装收益低而风险高；积木执行本身走的是下面的帧循环。

  // 3) 事件回调（点击角色、按键、收到消息）
  var rawAdd = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, fn, opts) {
    if (typeof fn !== 'function' || fn.__k4pWrapped) return rawAdd.call(this, type, fn, opts);
    var wrapped = function (ev) {
      try { return fn.call(this, ev); } catch (e) { report(e, 'event:' + type); }
    };
    wrapped.__k4pWrapped = true;
    wrapped.__k4pOriginal = fn;
    return rawAdd.call(this, type, wrapped, opts);
  };
  var rawRemove = EventTarget.prototype.removeEventListener;
  EventTarget.prototype.removeEventListener = function (type, fn, opts) {
    if (fn && fn.__k4pOriginal) return rawRemove.call(this, type, fn.__k4pOriginal, opts);
    return rawRemove.call(this, type, fn, opts);
  };

  // 4) 兜底：逃逸到全局的异常（脚本线程被打断也不影响下一帧）
  window.addEventListener('error', function (e) {
    try {
      // 资源加载失败（img/script 404）不是积木错误，直接忽略
      if (e && e.target && e.target !== window && e.target.nodeType) return;
      if (!e || (!e.error && (!e.message || /^Script error\.?$/i.test(e.message)))) return;
      report(e.error || e.message, 'global');
    } catch (_) {}
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    try { report(e && e.reason, 'promise'); } catch (_) {}
  });

  // 5) 对外接口：外壳可读，也可以手动注入一次异常做验证
  window.__K4P_RESILIENCE_API__ = {
    errors: errors,
    stats: function () {
      var out = [];
      for (var k in seen) out.push({ key: k, count: seen[k].count });
      return out;
    },
    test: function () { report(new Error('resilience self-test'), 'self-test'); },
  };
})();
