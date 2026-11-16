/**
 * KittenN 网络层改写：把页面里对官方接口的绝对地址改成本地同源代理，
 * 这样官方 SDK 的 preflight 不会再被 CORS 挡住（本地服务代为转发）。
 * 必须在 main.js 之前同步执行。
 */
(function () {
  if (window.__KNP_NET__) return;
  window.__KNP_NET__ = true;

  var MAP = [
    ['https://api-creation.codemao.cn', '/p/creation'],
    ['https://api.codemao.cn', '/p/api'],
    ['https://kn-cdn.codemao.cn', '/p/kncdn']
  ];

  function rewrite(u) {
    if (typeof u !== 'string') return u;
    for (var i = 0; i < MAP.length; i++) {
      if (u.indexOf(MAP[i][0]) === 0) return location.origin + MAP[i][1] + u.slice(MAP[i][0].length);
    }
    return u;
  }
  window.__KNP_REWRITE__ = rewrite;

  // XMLHttpRequest（axios 走这条）
  var open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    var args = Array.prototype.slice.call(arguments);
    args[1] = rewrite(args[1]);
    return open.apply(this, args);
  };

  // fetch
  var rawFetch = window.fetch;
  if (rawFetch) {
    window.fetch = function (input, init) {
      try {
        if (typeof input === 'string') input = rewrite(input);
        else if (input && typeof input.url === 'string') {
          var nu = rewrite(input.url);
          if (nu !== input.url) input = new Request(nu, input);
        }
      } catch (_) {}
      return rawFetch.call(this, input, init);
    };
  }
})();
