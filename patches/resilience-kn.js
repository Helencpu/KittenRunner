/**
 * KittenN 播放器引导补丁
 *
 * 目的：绕开官方的那套「作品号 -> 服务端拉数据」流程，把本地作品直接喂给运行时。
 * 做法：
 *   1. 先于 main.js 建立 webpackChunkneko 并截获 runtime（window.__knReq）
 *   2. 等 SDK 初始化完成后，在已加载模块里找到 BcmInstance
 *   3. 从 /kn-work/<token> 取本地作品 JSON，调用 BcmInstance.setBcm()
 *   4. 同时把「作品不存在 / 载入中」的界面清掉
 */
(function () {
  'use strict';

  // 1) 截获 webpack runtime
  var chunkGlobal = (window.webpackChunkneko = window.webpackChunkneko || []);
  var origPush = chunkGlobal.push;
  chunkGlobal.push = function () {
    try {
      for (var i = 0; i < arguments.length; i++) {
        var c = arguments[i];
        if (c && typeof c[2] === 'function') window.__knReq = c[2];
      }
    } catch (_) {}
    return origPush.apply(this, arguments);
  };

  window.__KNP_LOG = [];
  function log() {
    try {
      window.__KNP_LOG.push([].slice.call(arguments).join(' '));
      if (window.__KNP_LOG.length > 300) window.__KNP_LOG.shift();
    } catch (_) {}
  }

  /** 在已加载模块缓存里找带 BcmInstance 的导出 */
  window.__knFindBcm = function () {
    var req = window.__knReq;
    if (!req || !req.c) return null;
    var seen = [];
    for (var id in req.c) {
      var mod = req.c[id];
      var ex = mod && mod.exports;
      if (!ex || typeof ex !== 'object') continue;
      if (ex.BcmInstance) return { id: id, inst: ex.BcmInstance, holder: ex };
      // 有时是 MobX store 上的静态属性
      if (ex.default && ex.default.BcmInstance) return { id: id, inst: ex.default.BcmInstance, holder: ex.default };
      seen.push(id);
    }
    return null;
  };

  /** 主动把一份作品 JSON 灌进运行时 */
  window.__knLoadBcm = function (bcm) {
    var hit = window.__knFindBcm();
    if (!hit || !hit.inst) { log('未找到 BcmInstance'); return false; }
    try {
      hit.inst.setBcm(bcm);
      try {
        if (bcm.stageSize) {
          var st = document.querySelector('.stage') || document.querySelector('#root');
          log('stage ' + bcm.stageSize.width + 'x' + bcm.stageSize.height);
        }
      } catch (_) {}
      log('setBcm 完成 ' + hit.id);
      return true;
    } catch (e) {
      log('setBcm 失败 ' + (e && e.message));
      return false;
    }
  };

  /** 等 SDK 就绪后自动注入本地作品 */
  (function boot() {
    var token = window.__KNP_WORK_TOKEN;
    if (!token) return;
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (tries > 400) { clearInterval(timer); return; }   // 40s 放弃
      var hit = window.__knFindBcm();
      if (!hit) return;
      clearInterval(timer);
      log('已定位 BcmInstance（模块 ' + hit.id + '），开始载入本地作品');
      fetch('/kn-work/' + token)
        .then(function (r) { return r.json(); })
        .then(function (bcm) {
          if (!window.__knLoadBcm(bcm)) log('注入失败，回退官方流程');
          else {
            window.__KNP__.ready = true;
            var boot = document.getElementById('knp-boot');
            if (boot) boot.classList.add('hide');
          }
        })
        .catch(function (e) { log('取作品失败 ' + e.message); });
    }, 100);
  })();
})();
