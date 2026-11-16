/**
 * 在 main.js 执行完之后运行：往 webpack 的 chunk 队列里塞一个空 chunk，
 * 借它的 runtime 回调拿到 __webpack_require__，后续即可在模块缓存里找运行时对象。
 */
(function () {
  try {
    var g = window.webpackChunkneko;
    if (!g || typeof g.push !== 'function') {
      window.__KNP_LOG && window.__KNP_LOG.push('no webpackChunkneko');
      return;
    }
    g.push([[987654321], {}, function (req) { window.__knReq = req; }]);
    setTimeout(function () {
      if (window.__knReq && window.__KNP_LOG) window.__KNP_LOG.push('runtime 已取得，模块数=' + Object.keys(window.__knReq.c || {}).length);
    }, 300);
  } catch (e) {
    try { window.__KNP_LOG.push('kn-after 失败 ' + e.message); } catch (_) {}
  }
})();
