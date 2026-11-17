'use strict';
/**
 * 编程猫通用作品运行器 —— 本地服务
 *
 * 设计：
 *  - 纯 Node，零第三方依赖；一个端口同时承担「外壳页面」「播放器页面」「作品数据」
 *  - 作品以 token 绑定，多个标签页可各玩各的
 *  - Kitten4 走官方 player_v2（本地已打性能补丁），KittenN 走 neko 运行时
 *  - 积木异常隔离由 patches/resilience.js 在页面侧完成
 */
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');

const ROOT = __dirname;
const CACHE = path.join(ROOT, '.cache');
const K4DIR = path.join(ROOT, 'k4');
const SHELL = path.join(ROOT, 'shell');

// ---------------------------------------------------------------- IR 编译缓存
// 本地 .bcm4 是编辑器工作区格式，必须先在页面侧编译成运行时格式。这一步是冷启动的主要耗时。
// 这里按「文件内容 SHA1」把编译结果持久化，同一个文件再次打开直接读盘，完全跳过编译。
const IRDIR = path.join(CACHE, 'ir');
const IR_LIMIT = 120;          // 最多保留 120 份，按最近使用淘汰

let IR_HITS = 0;
let IR_MISSES = 0;

function hashText(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function irFile(h) { return path.join(IRDIR, h + '.json'); }

function loadIr(h) {
  if (!h) return null;
  try {
    const f = irFile(h);
    if (!fs.existsSync(f)) return null;
    const buf = fs.readFileSync(f);
    if (!buf.length) return null;
    const now = new Date();
    try { fs.utimesSync(f, now, now); } catch (_) {}   // 触碰 mtime，作为 LRU 依据
    return buf;
  } catch (_) { return null; }
}

function saveIr(h, buf) {
  if (!h || !buf || !buf.length) return;
  try {
    mkdirp(IRDIR);
    fs.writeFileSync(irFile(h), buf);
    pruneIr();
  } catch (_) {}
}

function pruneIr() {
  try {
    const files = fs.readdirSync(IRDIR)
      .map((f) => { try { return { f, m: fs.statSync(path.join(IRDIR, f)).mtimeMs }; } catch (_) { return null; } })
      .filter(Boolean)
      .sort((a, b) => b.m - a.m);
    for (const it of files.slice(IR_LIMIT)) {
      try { fs.rmSync(path.join(IRDIR, it.f), { force: true }); } catch (_) {}
    }
  } catch (_) {}
}

function irCount() {
  try { return fs.readdirSync(IRDIR).length; } catch (_) { return 0; }
}

// ---------------------------------------------------------------- 素材缓存
// 在线作品的素材在 bcmcdn 上，播放器是「舞台启动时才逐个请求」的，缓存没命中等网络就会卡。
// 做法：打开作品时后台把素材全部预取到本地，作品 JSON 里的素材 URL 改写成 /asset/<key>，
// 播放时直接读本地文件，不再等网络。
const ASSETDIR = path.join(CACHE, 'assets');
const ASSETINDEX = path.join(CACHE, 'assets.index.json');
const ASSET_URL_RE = /https?:\/\/(?:[\w-]+\.)*bcmcdn\.com\/[^"'\\\s<>]*|https?:\/\/cdn\.codemao\.cn\/[^"'\\\s<>]*/g;

let ASSET_HITS = 0;
let ASSET_FETCHES = 0;
const ASSET_MAP = new Map();       // key -> { u, ext }
const assetInflight = new Map();

function loadAssetIndex() {
  try {
    if (!fs.existsSync(ASSETINDEX)) return;
    const obj = JSON.parse(fs.readFileSync(ASSETINDEX, 'utf8'));
    for (const k in obj) ASSET_MAP.set(k, obj[k]);
  } catch (_) {}
}
function saveAssetIndex() {
  try {
    mkdirp(CACHE);
    fs.writeFileSync(ASSETINDEX, JSON.stringify(Object.fromEntries(ASSET_MAP)), 'utf8');
  } catch (_) {}
}
let assetSaveTimer = null;
function scheduleSaveAssetIndex() {
  if (assetSaveTimer) return;
  assetSaveTimer = setTimeout(() => { assetSaveTimer = null; saveAssetIndex(); }, 800);
}
function assetFileCount() {
  try {
    return fs.readdirSync(ASSETDIR).filter((f) => !f.endsWith('.part')).length;
  } catch (_) { return 0; }
}
function assetKey(u) { return crypto.createHash('sha1').update(u).digest('hex'); }function extOfType(t) {
  const m = String(t || '').split(';')[0].trim().toLowerCase();
  const map = {
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
    'image/svg+xml': '.svg', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/ogg': '.ogg',
    'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a',
  };
  return map[m] || '.bin';
}

function httpGetFollow(u, redirects = 3) {
  return new Promise((resolve, reject) => {
    const lib = u.startsWith('https') ? https : http;
    const req = lib.get(u, { headers: { 'User-Agent': 'Mozilla/5.0', Referer: '' } }, (res) => {
      const code = res.statusCode;
      if (code >= 300 && code < 400 && res.headers.location && redirects > 0) {
        res.resume();
        let next;
        try { next = new URL(res.headers.location, u).toString(); } catch (_) { return reject(new Error('bad redirect')); }
        return resolve(httpGetFollow(next, redirects - 1));
      }
      if (code !== 200) { res.resume(); return reject(new Error('HTTP ' + code)); }
      resolve({ stream: res, type: res.headers['content-type'] || '' });
    });
    req.on('error', reject);
    req.setTimeout(20000, () => req.destroy(new Error('timeout')));
  });
}

async function fetchAsset(u) {
  const key = assetKey(u);
  const known = ASSET_MAP.get(key);
  if (known && fs.existsSync(path.join(ASSETDIR, key + known.ext))) return key;
  if (assetInflight.has(key)) return assetInflight.get(key);

  const job = (async () => {
    const { stream, type } = await httpGetFollow(u);
    const ext = extOfType(type);
    mkdirp(ASSETDIR);
    const tmp = path.join(ASSETDIR, key + '.part');
    await new Promise((resolve, reject) => {
      const ws = fs.createWriteStream(tmp);
      stream.pipe(ws);
      ws.on('finish', resolve);
      ws.on('error', reject);
      stream.on('error', reject);
    });
    fs.renameSync(tmp, path.join(ASSETDIR, key + ext));
    ASSET_MAP.set(key, { u, ext });
    ASSET_FETCHES++;
    scheduleSaveAssetIndex();
    return key;
  })().finally(() => assetInflight.delete(key));

  assetInflight.set(key, job);
  return job;
}

/** 后台预取：打开作品时就把素材拉到本地（不阻塞响应） */
function prefetchAssets(jsonText) {
  const urls = [];
  try {
    const seen = new Set();
    for (const m of jsonText.matchAll(ASSET_URL_RE)) {
      const u = m[0];
      if (!u || seen.has(u)) continue;
      seen.add(u);
      urls.push(u);
    }
  } catch (_) {}
  if (!urls.length || urls.length > 400) return;
  let idx = 0;
  const worker = async () => {
    while (idx < urls.length) {
      const u = urls[idx++];
      try { await fetchAsset(u); } catch (_) {}
    }
  };
  for (let i = 0; i < 6; i++) worker();
}

/** 把作品 JSON 里的素材 URL 换成本地 /asset/<key> */
function localizeAssets(rec, buf) {
  try {
    if (rec._locSrcLen === buf.length && rec._locBuf) return rec._locBuf;
    const s = buf.toString('utf8');
    let touched = false;
    const out = s.replace(ASSET_URL_RE, (u) => {
      touched = true;
      const key = assetKey(u);
      if (!ASSET_MAP.has(key)) {
        // 还没预取到就改写，服务端收到请求再补下载
        ASSET_MAP.set(key, { u, ext: '.bin' });
      }
      return '/asset/' + key;
    });
    const res = touched ? Buffer.from(out, 'utf8') : buf;
    rec._locSrcLen = buf.length;
    rec._locBuf = res;
    return res;
  } catch (_) { return buf; }
}

const OFFICIAL_CLOUD_API = 'https://socketcv.codemao.cn';
const OFFICIAL_CLOUD_WSS = 'wss://socketcv.codemao.cn:9096';
const K4_WORK_API = 'https://api-creation.codemao.cn/kitten/r2/work/player/load/';

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.m4a': 'audio/mp4',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function mkdirp(p) { try { fs.mkdirSync(p, { recursive: true }); } catch (_) {} }
mkdirp(CACHE);

/** token -> {type, file, name, meta, workId, buffer} */
const projects = new Map();          // token -> rec（十六进制 token，K4 与 KN 都可用）
const numericIds = new Map();        // numId -> rec（纯数字，仅 KittenN 播放器需要，因为它会 Number(workId)）
const TOKEN_RE = /^[0-9a-f]{16}$/;

function newToken() { return crypto.randomBytes(8).toString('hex'); }

/**
 * KittenN 播放器会把 URL 里的 workId 当数字处理（Number(workId)），
 * 所以 KN 作品额外分配一个纯数字 id：首位非 0（否则前导零被吃掉）、15 位（小于 2^53 不丢精度）
 */
function newNumId() {
  let t = String(crypto.randomInt(1, 10));
  for (let i = 0; i < 14; i++) t += crypto.randomInt(0, 10);
  return t;
}

/** 统一按 key 找作品：数字 id 与 hex token 都能命中 */
function findProject(key) {
  return projects.get(String(key)) || numericIds.get(String(key)) || null;
}

/** 播放用的公开 key：KN 用数字 id，K4 用 hex token */
function playKey(rec) {
  return rec.type === 'kn' ? rec.numId : rec.token;
}

function safeName(n) {
  return String(n || 'work').replace(/[\\/:*?"<>|]/g, '_').slice(-120);
}

/** 识别作品类型：看扩展名，再看 JSON 结构 */
function detectType(name, text) {
  const ext = path.extname(String(name || '')).toLowerCase();
  if (ext === '.bcmkn' || ext === '.bcmknk' || ext === '.bcmknh') return 'kn';
  if (ext === '.bcm4' || ext === '.bcm5') return 'k4';
  if (ext === '.bcm') return 'bcm';
  let obj = null;
  try { obj = JSON.parse(text); } catch (_) { return null; }
  if (obj && obj.theatre && Array.isArray(obj.compile_result)) return 'k4';
  if (obj && obj.theatre) return 'k4';
  if (obj && (obj.nekoBlockJsonList || obj.workJson || obj.projectJson)) return 'kn';
  if (obj && obj.fileType) return /BCMKN|BCMKNK|BCMKNH|GUYUKN/.test(String(obj.fileType)) ? 'kn' : 'k4';
  if (ext === '.json') return 'k4';
  return null;
}

function storeProject({ name, text, type, meta, workId }) {
  const token = newToken();
  const numId = type === 'kn' ? newNumId() : '';
  const dir = path.join(CACHE, token);
  mkdirp(dir);
  const file = path.join(dir, safeName(name || 'work.json'));
  fs.writeFileSync(file, text, 'utf8');
  const rec = { token, numId, type, file, name: name || path.basename(file), meta: meta || null, workId: workId || '', createdAt: Date.now() };
  // Kitten4：内容哈希作为 IR 缓存键，命中则免编译直接播放
  if (type === 'k4') {
    rec.hash = hashText(text);
    const ir = loadIr(rec.hash);
    if (ir) { rec.compileCache = ir; rec.irHit = true; IR_HITS++; } else { IR_MISSES++; }
    prefetchAssets(text);          // 后台把素材拉到本地
  }
  projects.set(token, rec);
  if (numId) numericIds.set(numId, rec);
  // 只保留最近 20 个，防止缓存无限长
  if (projects.size > 20) {
    const oldest = [...projects.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt)[0];
    if (oldest) {
      projects.delete(oldest[0]);
      if (oldest[1].numId) numericIds.delete(oldest[1].numId);
      try { fs.rmSync(oldest[1].file, { force: true }); } catch (_) {}
    }
  }
  return rec;
}

// ---------------------------------------------------------------- HTTP

class Server {
  constructor({ port = 0, host = '127.0.0.1', user = null } = {}) {
    this.port = port;
    this.host = host;
    this.user = user;
    this.server = null;
    this.startTime = Date.now();
    this.loadLog = [];
  }

  get origin() { return `http://${this.host}:${this.port}`; }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.port, this.host, () => { this.port = this.server.address().port; resolve(); });
    });
    return this.port;
  }

  stop() { try { this.server && this.server.close(); } catch (_) {} }

  cors(req) {
    const origin = (req.headers && req.headers.origin) || '*';
    return {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Credentials': 'true',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    };
  }

  sendJson(res, obj, cors, code = 200) {
    const buf = Buffer.from(JSON.stringify(obj), 'utf8');
    res.writeHead(code, { ...(cors || {}), 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  }

  sendText(res, text, cors, code = 200, ct = 'text/html; charset=utf-8') {
    const buf = Buffer.from(text, 'utf8');
    res.writeHead(code, { ...(cors || {}), 'Content-Type': ct, 'Content-Length': buf.length, 'Cache-Control': 'no-store' });
    res.end(buf);
  }

  sendFile(res, file, cors, extra = {}) {
    let st;
    try { st = fs.statSync(file); } catch (_) { res.writeHead(404, cors || {}); return res.end('not found'); }
    if (!st.isFile()) { res.writeHead(404, cors || {}); return res.end('not found'); }
    const headers = {
      ...(cors || {}),
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Content-Length': st.size,
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...extra,
    };
    res.writeHead(200, headers);
    if (res.req && res.req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  }

  // ------------------------------------------------------------ 路由

  handle(req, res) {
    let url;
    try { url = new URL(req.url, 'http://x'); } catch (_) { res.writeHead(400); return res.end('bad url'); }
    const p = decodeURIComponent(url.pathname);
    const cors = this.cors(req);

    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    // 外壳
    if (p === '/' || p === '/index.html') return this.serveShell(res, cors);
    if (p.startsWith('/shell/')) {
      const f = path.join(SHELL, p.slice('/shell/'.length));
      if (this.inside(f, SHELL)) return this.sendFile(res, f, cors);
      res.writeHead(404); return res.end('not found');
    }

    // 外壳接口
    if (p === '/api/state') return this.sendJson(res, this.state(), cors);
    if (p === '/api/open-file' && req.method === 'POST') return this.openFile(req, res, cors);
    if (p === '/api/open-path' && req.method === 'POST') return this.openPath(req, res, cors);
    if (p === '/api/online' && req.method === 'POST') return this.openOnline(req, res, cors);
    if (p === '/api/samples') return this.sendJson(res, this.samples(), cors);
    if (p === '/api/logs') return this.sendJson(res, this.loadLog.slice(-60), cors);

    // 播放跳转
    if (p.startsWith('/play/')) {
      const key = p.slice('/play/'.length);
      const rec = findProject(key);
      if (!rec) return this.sendText(res, '作品已失效，请重新打开', cors, 404);
      const q = '?token=' + playKey(rec) + '&type=' + rec.type + '&name=' + encodeURIComponent(rec.name || '作品');
      res.writeHead(302, { ...cors, Location: '/' + q });
      return res.end();
    }

    // 运行时异常列表（外壳轮询用）
    if (p === '/api/errors') {
      return this.sendJson(res, { ok: true, errors: (this.errorLog || []).slice(-80) }, cors);
    }

    // 本地素材（作品里的 bcmcdn 素材已改写到这里）
    if (p.startsWith('/asset/')) {
      const key = p.slice('/asset/'.length).split('.')[0].split('/')[0];
      return this.sendAsset(res, key, cors);
    }

    // KittenN 作品数据（本地注入用）
    if (p.startsWith('/kn-work/')) {
      const rec = findProject(p.slice('/kn-work/'.length));
      if (!rec) return this.sendJson(res, { error: 'not found' }, cors, 404);
      let out = fs.readFileSync(rec.file, 'utf8');
      try { out = JSON.stringify(normalizeKn(JSON.parse(out))); } catch (_) {}
      return this.sendText(res, out, cors, 200, 'application/json; charset=utf-8');
    }

    // KittenN 播放器宿主（与官方同路径，便于其内部路由生效）
    if (p === '/player' || p === '/player/' || p.startsWith('/player/')) {
      const qt = url.searchParams.get('workId') || url.searchParams.get('work_id') || '';
      const rec = qt ? findProject(qt) : null;
      return this.sendKnPage(res, rec, cors);
    }

    // 官方播放器需要的客户端配置
    if (p === '/new/client_config.json') return this.sendJson(res, this.clientConfig(), cors);
    if (p === '/api/work/info/' || p.startsWith('/api/work/info/')) {
      return this.sendJson(res, this.workInfo(p.slice('/api/work/info/'.length)), cors);
    }
    if (p.startsWith('/web/users/details')) {
      if (this.user) return this.sendJson(res, this.user, cors);
      res.writeHead(401, { ...cors, 'Content-Type': 'application/json' });
      return res.end('{"status":401,"error":"unauthorized"}');
    }
    if (p.startsWith('/socket') || p.startsWith('/cloudstorage')) { res.writeHead(204, cors); return res.end(); }

    // 运行时静态资源
    if (p.startsWith('/kn/build/')) {
      const f = path.join(K4DIR, 'build', p.slice('/kn/build/'.length));
      if (this.inside(f, path.join(K4DIR, 'build'))) return this.sendFile(res, f, cors);
      res.writeHead(404, cors); return res.end('not found');
    }
    // KittenN 作品详情接口：本地 token 直接伪造官方响应，其余回源官方
    if (p.startsWith('/neko/works/player/work-detail/') || p.startsWith('/neko/works/')) {
      const id = p.split('/').filter(Boolean).pop();
      const rec = findProject(id);
      if (rec && rec.type !== 'k4') return this.sendJson(res, this.knWorkDetail(id, rec), cors);
      if (rec) return this.sendJson(res, { code: 40204002, error: '该作品不是 KittenN 作品' }, cors, 422);
      return this.proxy(req, res, 'api-creation.codemao.cn', p, cors);
    }

    // 同源代理：把页面里对官方接口的调用转成本地路径，绕开 CORS
    if (p.startsWith('/p/creation/') || p.startsWith('/p/api/') || p.startsWith('/p/kncdn/')) {
      // 代理路径下同样要优先命中本地作品，避免请求真的打到官方
      if (p.startsWith('/p/creation/neko/works/')) {
        const id = p.split('/').filter(Boolean).pop();
        const rec = findProject(id);
        if (rec && rec.type !== 'k4') return this.sendJson(res, this.knWorkDetail(id, rec), cors);
      }
      const hostMap = { '/p/creation': 'api-creation.codemao.cn', '/p/api': 'api.codemao.cn', '/p/kncdn': 'kn-cdn.codemao.cn' };
      for (const pre in hostMap) {
        if (p.startsWith(pre + '/')) return this.proxy(req, res, hostMap[pre], p.slice(pre.length), cors);
      }
    }

    // KittenN 静态资源（/neko/... 与官方 CDN 同构）
    if (p.startsWith('/neko/')) {
      return this.sendNeko(res, p.slice('/neko/'.length), req, cors);
    }

    // 页面侧注入脚本
    if (p === '/k4p/compile.js') return this.sendFile(res, path.join(K4DIR, 'compile.js'), cors, { 'Content-Type': 'application/javascript; charset=utf-8' });
    if (p === '/k4p/cloud.js') return this.sendFile(res, path.join(K4DIR, 'cloud.js'), cors, { 'Content-Type': 'application/javascript; charset=utf-8' });
    if (p === '/k4p/profiler.js') return this.sendFile(res, path.join(K4DIR, 'profiler.js'), cors, { 'Content-Type': 'application/javascript; charset=utf-8' });
    if (p === '/k4p/resilience.js') return this.sendFile(res, path.join(ROOT, 'patches', 'resilience.js'), cors, { 'Content-Type': 'application/javascript; charset=utf-8' });
    if (p === '/k4p/resilience-kn.js') return this.sendFile(res, path.join(ROOT, 'patches', 'resilience-kn.js'), cors, { 'Content-Type': 'application/javascript; charset=utf-8' });
    if (p === '/k4p/kn-after.js') return this.sendFile(res, path.join(ROOT, 'patches', 'kn-after.js'), cors, { 'Content-Type': 'application/javascript; charset=utf-8' });
    if (p === '/k4p/kn-net.js') return this.sendFile(res, path.join(ROOT, 'patches', 'kn-net.js'), cors, { 'Content-Type': 'application/javascript; charset=utf-8' });
    if (p === '/k4p/probe.js') return this.sendFile(res, path.join(ROOT, 'patches', 'probe.js'), cors, { 'Content-Type': 'application/javascript; charset=utf-8' });

    // 编译结果回传
    if (p === '/k4p/compile-result' && req.method === 'POST') return this.collectCompile(req, res, cors);
    if (p === '/k4p/report-error' && req.method === 'POST') return this.collectErrors(req, res, cors);

    // 作品：页面 or 数据
    if (p.startsWith('/new/')) {
      const token = p.slice('/new/'.length).split('/')[0];
      const rec = findProject(token);
      const dest = String(req.headers['sec-fetch-dest'] || '');
      const accept = String(req.headers['accept'] || '');
      const isDoc = dest === 'document' || dest === 'iframe' || dest === 'frame' || dest === 'embed' || (dest === '' && accept.includes('text/html'));
      if (isDoc) {
        if (!rec) return this.sendText(res, '作品已失效，请重新打开', cors, 404);
        return this.sendPlayerPage(res, rec, cors);
      }
      if (!rec) return this.sendJson(res, { status: 404, error: 'no project loaded' }, cors, 404);
      return this.sendProjectData(req, res, rec, cors);
    }

    res.writeHead(404, cors);
    res.end('not found');
  }

  /** 伪造官方 work-detail 响应，把 work_url 指向本地作品 */
  knWorkDetail(id, rec) {
    const now = Math.floor(Date.now() / 1000);
    return {
      work_id: 123456789,
      name: String(rec.name || 'local-work').replace(/\.(bcmkn|bcm|bcmknk|bcmknh)$/i, ''),
      user_id: 0,
      work_url: this.origin + '/kn-work/' + id,
      bcm_version: '0.9.0',
      work_type: 15,
      preview_url: '',
      update_time: now,
      create_time: now,
      work_classify: 0,
      code: '',
      invte_url: '',
      invite_url_updated_at: 0,
      if_shared: 2,
      stage_type: 2,
      published_status: 0,
      hardware_mode: 1,
      blink_mode: '',
      fork_enable: 0,
      check_result: 1,
      if_default_cover: 1,
      has_display_check_result: 1,
      include_ai_resource: 0,
      work_js_url: '',
    };
  }

  /** 同源反向代理：伪装 Host 转发到官方域名，解决页面被 CORS 挡住的问题 */
  proxy(req, res, host, restPath, cors) {
    const body = [];
    req.on('data', (c) => body.push(c));
    req.on('end', () => {
      const headers = {};
      for (const k in req.headers) {
        if (['host', 'origin', 'referer', 'connection', 'content-length', 'accept-encoding'].includes(k)) continue;
        headers[k] = req.headers[k];
      }
      headers.host = host;
      const payload = body.length ? Buffer.concat(body) : null;
      if (payload) headers['content-length'] = payload.length;

      const up = https.request({ host, path: restPath, method: req.method, headers, timeout: 30000 }, (ur) => {
        const out = { ...cors };
        for (const k of ['content-type', 'cache-control', 'etag', 'last-modified', 'content-encoding']) {
          if (ur.headers[k]) out[k] = ur.headers[k];
        }
        out['access-control-allow-origin'] = '*';
        res.writeHead(ur.statusCode || 502, out);
        ur.pipe(res);
      });
      up.on('timeout', () => { try { up.destroy(); } catch (_) {} });
      up.on('error', (e) => {
        try {
          res.writeHead(502, { ...cors, 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: 'upstream failed', detail: String(e.message || e) }));
        } catch (_) {}
      });
      if (payload) up.write(payload);
      up.end();
    });
  }

  inside(child, parent) {
    const rel = path.relative(parent, child);
    return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  serveShell(res, cors) {
    const f = path.join(SHELL, 'index.html');
    let html = fs.readFileSync(f, 'utf8');
    html = html.replace('__ORIGIN__', this.origin);
    return this.sendText(res, html, cors);
  }

  // ------------------------------------------------------------ 作品打开

  readBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }

  async openFile(req, res, cors) {
    // 原始字节上传：/?name=xx.bcm4
    const name = safeName(new URL(req.url, 'http://x').searchParams.get('name') || 'work.bcm4');
    const buf = await this.readBody(req);
    const text = buf.toString('utf8');
    const type = detectType(name, text);
    if (!type) return this.sendJson(res, { ok: false, error: '无法识别该文件（支持 .bcm4 / .bcmkn / .bcm）' }, cors, 200);
    this.errorLog = [];
    const rec = storeProject({ name, text, type });
    this.loadLog.push({ t: Date.now(), name, type, size: buf.length, source: 'file' });
    this.sendJson(res, { ok: true, token: playKey(rec), type, name: rec.name, url: '/play/' + playKey(rec) }, cors);
  }

  async openPath(req, res, cors) {
    let body = null;
    try { body = JSON.parse((await this.readBody(req)).toString('utf8')); } catch (_) {}
    const file = body && body.path ? path.resolve(String(body.path)) : '';
    if (!file || !fs.existsSync(file)) return this.sendJson(res, { ok: false, error: '文件不存在' }, cors);
    const text = fs.readFileSync(file, 'utf8');
    const type = detectType(file, text);
    if (!type) return this.sendJson(res, { ok: false, error: '无法识别该文件' }, cors);
    this.errorLog = [];
    const rec = storeProject({ name: path.basename(file), text, type });
    this.loadLog.push({ t: Date.now(), name: rec.name, type, size: text.length, source: 'path' });
    this.sendJson(res, { ok: true, token: playKey(rec), type, name: rec.name, url: '/play/' + playKey(rec) }, cors);
  }

  async openOnline(req, res, cors) {
    let body = null;
    try { body = JSON.parse((await this.readBody(req)).toString('utf8')); } catch (_) {}
    const raw = String((body && body.input) || '').trim();
    const parsed = parseOnlineInput(raw);
    if (!parsed) return this.sendJson(res, { ok: false, error: '请输入作品号或作品链接' }, cors);
    try {
      const rec = await this.fetchOnline(parsed);
      this.loadLog.push({ t: Date.now(), name: rec.name, type: rec.type, size: fs.statSync(rec.file).size, source: 'id:' + (rec.workId || '') });
      return this.sendJson(res, { ok: true, token: playKey(rec), type: rec.type, name: rec.name, url: '/play/' + playKey(rec) }, cors);
    } catch (e) {
      return this.sendJson(res, { ok: false, error: String((e && e.message) || e) }, cors);
    }
  }

  /** 线上作品：先查缓存，再下载 */
  async fetchOnline({ kind, id }) {
    const dir = path.join(CACHE, 'online', safeName(kind + '-' + id));
    mkdirp(dir);
    const metaFile = path.join(dir, 'meta.json');
    const dataFile = path.join(dir, 'work.json');
    let meta = null;
    try { meta = JSON.parse(fs.readFileSync(metaFile, 'utf8')); } catch (_) {}

    if (kind === 'k4') {
      const info = await httpJson(K4_WORK_API + id, 8000);
      if (!info || !info.source_urls || !info.source_urls.length) throw new Error('作品不存在或不可公开访问');
      const latest = info.source_urls[0];
      if (meta && meta.sourceUrl === latest && fs.existsSync(dataFile)) {
        const text = fs.readFileSync(dataFile, 'utf8');
        this.errorLog = [];
        const rec = storeProject({ name: (info.name || '作品') + '.bcm4', text, type: 'k4', meta: info, workId: id });
        return rec;
      }
      const body = await httpText(latest, 30000);
      fs.writeFileSync(dataFile, body, 'utf8');
      fs.writeFileSync(metaFile, JSON.stringify({ sourceUrl: latest, info }, null, 2), 'utf8');
      return storeProject({ name: (info.name || '作品') + '.bcm4', text: body, type: 'k4', meta: info, workId: id });
    }
    throw new Error('暂不支持该类型的在线作品号，可直接打开本地文件');
  }

  // ------------------------------------------------------------ 播放页

  sendPlayerPage(res, rec, cors) {
    const inject = '<script>window.__K4P_WORK_ID=' + JSON.stringify(rec.workId || '')
      + ';window.__K4P_LOGGED_IN=' + (this.user ? 'true' : 'false')
      + ';window.__K4P_TOKEN=' + JSON.stringify(rec.token)
      + ';window.__K4P_TYPE=' + JSON.stringify(rec.type) + ';</script>';
    if (rec.type === 'kn') {
      let html = fs.readFileSync(path.join(ROOT, 'kn', 'page.html'), 'utf8');
      html = html.replace('<!--KNP_INJECT-->', inject);
      return this.sendText(res, html, cors);
    }
    let html = fs.readFileSync(path.join(K4DIR, 'page.html'), 'utf8');
    html = html.replace('<!--K4P_INJECT-->', inject);
    return this.sendText(res, html, cors);
  }

  sendKnPage(res, rec, cors) {
    let html = fs.readFileSync(path.join(ROOT, 'kn', 'page.html'), 'utf8');
    const inject = '<script>window.__KNP_WORK_TOKEN=' + JSON.stringify(rec ? rec.token : '')
      + ';window.__KNP_WORK_NAME=' + JSON.stringify(rec ? rec.name : '')
      + ';window.__KNP_WORK_ID=' + JSON.stringify(rec ? rec.workId || '' : '') + ';</script>';
    html = html.replace('<!--KNP_INJECT-->', inject);
    return this.sendText(res, html, cors);
  }

  async sendProjectData(req, res, rec, cors) {
    if (req.method === 'HEAD') { res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8' }); return res.end(); }

    if (rec.type === 'kn') {
      // KittenN：运行时直接吃工作区 JSON；必要时做结构补全
      const text = fs.readFileSync(rec.file, 'utf8');
      let out = text;
      try { out = JSON.stringify(normalizeKn(JSON.parse(text))); } catch (_) {}
      const buf = Buffer.from(out, 'utf8');
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
      return res.end(buf);
    }

    let buf = rec.compileCache || prepareK4(rec) || null;
    if (!buf) { try { buf = fs.readFileSync(rec.file); } catch (_) { buf = Buffer.from('{}', 'utf8'); } }
    buf = localizeAssets(rec, buf);
    res.writeHead(200, { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length });
    return res.end(buf);
  }

  /** 本地素材：命中磁盘直接发，未命中去 bcmcdn 拉一次落盘 */
  async sendAsset(res, key, cors) {
    const head = 'public, max-age=31536000, immutable';
    const known = ASSET_MAP.get(key);
    if (known && known.ext && fs.existsSync(path.join(ASSETDIR, key + known.ext))) {
      ASSET_HITS++;
      return this.pipeAsset(res, path.join(ASSETDIR, key + known.ext), known.ext, cors, head);
    }
    const u = known && known.u;
    if (!u) { res.writeHead(404, cors); return res.end('not found'); }
    try {
      await fetchAsset(u);
      ASSET_HITS++;
      const meta = ASSET_MAP.get(key);
      return this.pipeAsset(res, path.join(ASSETDIR, key + meta.ext), meta.ext, cors, head);
    } catch (e) {
      // 拉不到就回源，播放器自己再试一次网络
      res.writeHead(302, { ...cors, Location: u });
      return res.end();
    }
  }

  pipeAsset(res, file, ext, cors, cache) {
    try {
      const st = fs.statSync(file);
      res.writeHead(200, { ...cors, 'Content-Type': MIME[ext] || 'application/octet-stream', 'Content-Length': st.size, 'Cache-Control': cache });
      fs.createReadStream(file).pipe(res);
    } catch (_) { res.writeHead(404, cors); res.end('gone'); }
  }

  async collectCompile(req, res, cors) {
    try {
      const body = (await this.readBody(req)).toString('utf8');
      let token = new URL(req.url, 'http://x').searchParams.get('token');
      if (!token) {
        const ref = String(req.headers.referer || '');
        const m = ref.match(/\/new\/([0-9a-fA-F]{8,20})/);
        if (m) token = m[1];
      }
      if (!token) token = [...projects.keys()].pop();
      const rec = projects.get(token || '');
      if (!rec) throw new Error('未知作品');
      const cr = JSON.parse(body);
      const parsed = JSON.parse(fs.readFileSync(rec.file, 'utf8'));
      normalizeK4(parsed);
      const th = parsed.theatre || {};
      for (const e of Object.values(th.scenes || {})) delete e.block_data_json;
      for (const e of Object.values(th.actors || {})) delete e.block_data_json;
      parsed.compile_result = cr;
      rec.compileCache = Buffer.from(JSON.stringify(parsed), 'utf8');
      rec._prep = undefined;
      rec.irHit = false;
      saveIr(rec.hash, rec.compileCache);      // 写盘，下次同一文件直接命中
      this.sendJson(res, { ok: true, size: rec.compileCache.length, cached: !!rec.hash, irCount: irCount() }, cors);
    } catch (e) {
      this.sendJson(res, { ok: false, error: String((e && e.message) || e) }, cors, 500);
    }
  }

  async collectErrors(req, res, cors) {
    try {
      const body = JSON.parse((await this.readBody(req)).toString('utf8'));
      this.lastRuntimeErrors = body;
      this.errorLog = this.errorLog || [];
      this.errorLog.push({
        time: Date.now(),
        where: body.where || '',
        message: String(body.message || ''),
        stack: String(body.stack || ''),
        ref: String(req.headers.referer || ''),
        block: body.block || '',
      });
      if (this.errorLog.length > 300) this.errorLog.splice(0, this.errorLog.length - 300);
      this.sendJson(res, { ok: true }, cors);
    } catch (_) { this.sendJson(res, { ok: false }, cors); }
  }

  // ------------------------------------------------------------ 配置

  clientConfig() {
    if (!this._cfg) {
      try { this._cfg = JSON.parse(fs.readFileSync(path.join(K4DIR, 'client_config.json'), 'utf8')); } catch (_) { this._cfg = {}; }
    }
    const cfg = JSON.parse(JSON.stringify(this._cfg));
    cfg.creation_api = this.origin;
    cfg.api = { ...(cfg.api || {}), host: this.origin, port: '' };
    cfg.open_service_api = this.origin;
    if (this.user) {
      cfg.cloud_storage_api = cfg.cloud_storage_api || OFFICIAL_CLOUD_API;
      cfg.wss_cloud_storage_api = cfg.wss_cloud_storage_api || OFFICIAL_CLOUD_WSS;
    } else {
      cfg.cloud_storage_api = this.origin;
      cfg.wss_cloud_storage_api = '';
    }
    return cfg;
  }

  workInfo(id) {
    const rec = projects.get(String(id));
    const meta = (rec && rec.meta) || {};
    return {
      id: Number(id) || id,
      name: meta.name || (rec && rec.name) || '作品',
      preview: meta.preview || '',
      author_nickname: '',
      author_id: 0,
      work_name: meta.name || (rec && rec.name) || '作品',
      source_urls: [this.origin + '/new/' + (rec ? rec.token : id)],
      is_bcmc: true,
      ide_type: rec && rec.type === 'kn' ? 'NEKO' : 'KITTEN',
      version: '4.11.20',
      updated_time: Math.floor(Date.now() / 1000),
      extra_info: { author_nickname: '', author_id: 0, preview: meta.preview || '' },
    };
  }

  state() {
    return {
      origin: this.origin,
      uptime: Math.round((Date.now() - this.startTime) / 1000),
      projects: [...projects.values()].map((r) => ({ token: r.token, name: r.name, type: r.type, workId: r.workId, irHit: !!r.irHit })),
      loggedIn: !!this.user,
      errors: this.lastRuntimeErrors || null,
      ir: { files: irCount(), hits: IR_HITS, misses: IR_MISSES },
      assets: { files: assetFileCount(), hits: ASSET_HITS, fetches: ASSET_FETCHES },
    };
  }

  samples() {
    const dir = path.join(ROOT, 'samples');
    const out = [];
    try {
      for (const f of fs.readdirSync(dir)) {
        if (/\.(bcm4|bcmkn|bcm)$/i.test(f)) out.push({ name: f, url: '/samples/' + encodeURIComponent(f) });
      }
    } catch (_) {}
    return out;
  }

  /** KittenN 静态资源：本地有就发本地，没有回源官方 CDN 并写盘 */
  sendNeko(res, rel, req, cors) {
    const local = path.join(ROOT, 'kn', 'static', rel.replace(/\\/g, '/'));
    if (this.inside(local, path.join(ROOT, 'kn', 'static')) && fs.existsSync(local)) {
      return this.sendFile(res, local, cors);
    }
    const target = 'https://creation.bcmcdn.com/neko/web/release/' + rel;
    httpsGetToFile(target, local, 25000, (err) => {
      if (!err && fs.existsSync(local)) return this.sendFile(res, local, cors);
      // 失败就 302 到官方，保证作品还能跑
      res.writeHead(302, { ...cors, Location: target });
      res.end();
    });
  }
}

// ---------------------------------------------------------------- 作品格式处理

/** Kitten4：编辑器工作区格式 -> 运行时格式（补场景角色层） */
function normalizeK4(obj) {
  const th = obj && obj.theatre;
  if (!th || !th.scenes || !th.actors) return obj;
  const groups = th.groups || {};
  for (const sid of Object.keys(th.scenes)) {
    const sc = th.scenes[sid];
    if (!sc) continue;
    if (Array.isArray(sc.actors) && sc.actors.length) continue;
    const order = [];
    const seen = new Set();
    const walk = (gid) => {
      const g = groups[gid];
      if (!g) return;
      if (g.is_group) { for (const c of g.group_order || g.groups || []) walk(c); return; }
      for (const a of g.actors || []) if (!seen.has(a)) { seen.add(a); order.push(a); }
    };
    for (const gid of sc.group_order || []) walk(gid);
    order.reverse();
    for (const [aid, a] of Object.entries(th.actors)) {
      if (a && a.scene === sid && !seen.has(aid)) order.push(aid);
    }
    sc.actors = order;
  }
  if (!th.current_scene) th.current_scene = (th.scenes_order && th.scenes_order[0]) || Object.keys(th.scenes)[0] || '';
  if (!th.current_entity) th.current_entity = Object.keys(th.actors)[0] || '';
  if (!th.style_collections) th.style_collections = {};
  return obj;
}

/** KittenN：确保最小可运行字段 */
function normalizeKn(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (!obj.theatre) {
    // 有些导出把 theatre 放在 workJson 下
    if (obj.workJson && obj.workJson.theatre) obj = { ...obj, ...obj.workJson };
  }
  const th = obj.theatre;
  if (th) {
    if (!th.current_scene && th.scenes) th.current_scene = (th.scenes_order && th.scenes_order[0]) || Object.keys(th.scenes)[0] || '';
    if (!th.style_collections) th.style_collections = {};
  }
  return obj;
}

function prepareK4(rec) {
  if (rec._prep !== undefined) return rec._prep;
  rec._prep = null;
  try {
    const st = fs.statSync(rec.file);
    if (st.size > 96 * 1024 * 1024) return null;
    const obj = JSON.parse(fs.readFileSync(rec.file, 'utf8'));
    if (!Array.isArray(obj.compile_result)) return null;
    const th = obj.theatre;
    if (!th || !th.scenes || !th.actors) return null;
    let need = false;
    for (const sid of Object.keys(th.scenes)) {
      const sc = th.scenes[sid];
      if (sc && (!Array.isArray(sc.actors) || !sc.actors.length)) { need = true; break; }
    }
    if (!need) return null;
    normalizeK4(obj);
    for (const e of Object.values(th.scenes)) delete e.block_data_json;
    for (const e of Object.values(th.actors)) delete e.block_data_json;
    rec._prep = Buffer.from(JSON.stringify(obj), 'utf8');
    return rec._prep;
  } catch (_) { return null; }
}

/** 解析作品号 / 链接 */
function parseOnlineInput(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (/^\d{3,12}$/.test(s)) return { kind: 'k4', id: s };
  let m = s.match(/player\.codemao\.cn\/new\/(\d+)/);
  if (m) return { kind: 'k4', id: m[1] };
  m = s.match(/shequ\.codemao\.cn\/work\/(\d+)/);
  if (m) return { kind: 'k4', id: m[1] };
  m = s.match(/pickcat\.dao3\.fun\/works\/([0-9a-fA-F-]{20,})/);
  if (m) return { kind: 'pickcat', id: m[1] };
  m = s.match(/kn\.codemao\.cn\/.*?work(?:Id|=)\/?(\d{3,12})/i);
  if (m) return { kind: 'kn', id: m[1] };
  return null;
}

// ---------------------------------------------------------------- HTTP helpers

function httpText(url, timeout = 20000, redirects = 5) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? require('https') : require('http');
    const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120' }, timeout }, (r) => {
      if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location && redirects > 0) {
        r.resume();
        return httpText(new URL(r.headers.location, url).href, timeout, redirects - 1).then(resolve, reject);
      }
      if (r.statusCode !== 200) {
        let b = '';
        r.on('data', (c) => (b += c));
        r.on('end', () => reject(new Error('HTTP ' + r.statusCode + ' ' + b.slice(0, 80))));
        return;
      }
      let d = '';
      r.setEncoding('utf8');
      r.on('data', (c) => (d += c));
      r.on('end', () => resolve(d));
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

function httpJson(url, timeout) {
  return httpText(url, timeout).then((t) => JSON.parse(t));
}

function httpsGetToFile(url, file, timeout, cb) {
  mkdirp(path.dirname(file));
  const lib = url.startsWith('https') ? require('https') : require('http');
  const req = lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 Chrome/120' }, timeout }, (r) => {
    if (r.statusCode >= 300 && r.statusCode < 400 && r.headers.location) { r.resume(); return httpsGetToFile(new URL(r.headers.location, url).href, file, timeout, cb); }
    if (r.statusCode !== 200) { r.resume(); return cb(new Error('HTTP ' + r.statusCode)); }
    const tmp = file + '.tmp';
    const ws = fs.createWriteStream(tmp);
    r.pipe(ws);
    ws.on('finish', () => { try { fs.renameSync(tmp, file); cb(null); } catch (e) { cb(e); } });
    ws.on('error', (e) => cb(e));
  });
  req.on('error', cb);
  req.on('timeout', () => req.destroy(new Error('timeout')));
}

module.exports = { Server, detectType, parseOnlineInput, projects };

// 直接运行时启动
if (require.main === module) {
  loadAssetIndex();
  const s = new Server({ port: Number(process.env.PORT || 0) });
  s.start().then((port) => {
    console.log('Kitten Runner on http://127.0.0.1:' + port);
  });
  process.on('exit', () => { try { saveAssetIndex(); } catch (_) {} });
}
