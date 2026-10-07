const http = require('http');
const crypto = require('crypto');
const config = require('./config').load();
const { collectAll } = require('./providers');
const stale = require('./stale');
require('./proxy').initProxy(config);
const { renderBoard, renderGrayBands } = require('./render/render');

const renderOpts = {
  orientation: config.orientation,
  timezone: config.timezone,
  intervalMinutes: config.intervalMinutes,
};

const STALE_MAX = Number(config.staleMaxMinutes) || 180;

let latestPng = null;
let latestBands = null; // Kindle eips 用的灰度条带（见 render.js 顶部注释）
let latestData = null;
let latestHash = null;
let lastError = null;
let busy = false;
const cache = stale.load();

// 数据指纹：只依据额度数值，不含时间戳。
// Kindle 靠它判断「值是否真的变了」，没变就不刷屏（省电 + 少闪烁）。
function dataHash(results) {
  const payload = results.map((r) => ({
    id: r.id, ok: r.ok, big: r.big, unit: r.unit, sub: r.sub,
    percent: r.percent, detail: r.detail, stale: !!r.stale,
    metrics: (r.metrics || []).map((m) => [m.label, m.percent]),
  }));
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

async function refresh() {
  if (busy) return; // 上一次采集尚未结束，跳过本轮
  busy = true;
  const now = Date.now();
  try {
    const collected = await collectAll(config);
    const results = stale.apply(collected, cache, STALE_MAX, now);
    stale.save(cache);

    latestPng = await renderBoard(results, now, renderOpts);
    latestBands = await renderGrayBands(results, now, renderOpts);
    latestHash = dataHash(results);
    latestData = { updatedAt: now, hash: latestHash, platforms: results };
    lastError = null;

    const ok = results.filter((r) => r.ok && !r.stale).length;
    const old = results.filter((r) => r.stale).length;
    console.log(`[refresh] ${new Date(now).toLocaleString()} 正常 ${ok} / 陈旧 ${old} / 失败 ${results.length - ok - old} · hash=${latestHash}`);
  } catch (e) {
    lastError = String(e && e.message ? e.message : e);
    console.error('[refresh] 失败:', lastError);
  } finally {
    busy = false;
  }
}

function send(res, code, type, body, headers = {}) {
  res.writeHead(code, { 'Content-Type': type, ...headers });
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const [url, query] = req.url.split('?');
  const params = new URLSearchParams(query || '');

  // Kindle 先取这个和上次比对，相同就不必下载和刷屏
  if (url === '/api/etag') {
    return send(res, 200, 'text/plain; charset=utf-8', latestHash || '', { 'Cache-Control': 'no-store' });
  }

  if (url === '/image.png') {
    if (!latestPng) return send(res, 503, 'text/plain; charset=utf-8', '首次渲染尚未完成');
    // ?raw=1 输出未旋转的 1024x758，便于在电脑/浏览器上查看
    const png = params.get('raw')
      ? await renderBoard(latestData.platforms, latestData.updatedAt, { ...renderOpts, orientation: 'none' })
      : latestPng;
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'Content-Length': png.length,
      ETag: `"${latestHash}"`,
      'X-Data-Hash': latestHash,
    });
    return res.end(png);
  }

  // Kindle 逐条拉取的灰度条带（eips 兼容格式，见 render.js 注释）
  const bandMatch = url.match(/^\/band\/(\d{1,2})\.png$/);
  if (bandMatch) {
    const i = Number(bandMatch[1]);
    if (!latestBands || !latestBands[i]) {
      return send(res, 503, 'text/plain; charset=utf-8', '首次渲染尚未完成');
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'Content-Length': latestBands[i].length,
      ETag: `"${latestHash}-b${i}"`,
    });
    return res.end(latestBands[i]);
  }

  if (url === '/api/data') {
    return send(res, 200, 'application/json; charset=utf-8',
      JSON.stringify({ ...(latestData || {}), lastError }, null, 2));
  }

  if (url === '/health') {
    return send(res, 200, 'application/json; charset=utf-8',
      JSON.stringify({ ok: true, updatedAt: latestData ? latestData.updatedAt : null, hash: latestHash, lastError }));
  }

  // 网页版面板：给没有 root shell 的 Kindle 用自带浏览器打开（免越狱兜底方案）。
  // 页面定时轮询 /api/etag，额度变了才换图，避免无谓闪烁；KINDLE_RELOAD 兜底整页刷新。
  if (url === '/board.html') {
    const secs = Math.max(60, Number(params.get('refresh')) || 600);
    const html = `<!doctype html>
<html><head><meta charset="utf-8">
<title>board</title>
<meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<meta http-equiv="refresh" content="${secs * 3}">
<style>html,body{margin:0;padding:0;background:#fff;overflow:hidden}
#b{display:block;margin:0 auto}</style></head>
<body><img id="b" alt="board">
<script>
var last='';
function fit(){var i=document.getElementById('b');
  if(window.innerHeight&&window.innerWidth){i.style.height=window.innerHeight+'px';i.style.width='auto';}}
// 先在后台把新图下载完再替换，避免换图瞬间白屏
function update(){
  var pre=new Image();
  pre.onload=function(){var i=document.getElementById('b');i.src=pre.src;fit();};
  pre.onerror=function(){var i=document.getElementById('b');i.src='/image.png?t='+Date.now();fit();};
  pre.src='/image.png?t='+Date.now();
}
function check(){try{var x=new XMLHttpRequest();x.open('GET','/api/etag',true);
  x.onreadystatechange=function(){if(x.readyState===4&&x.status===200){
    if(last===''){last=x.responseText;}
    else if(x.responseText!==last){last=x.responseText;update();}}};x.send();}catch(e){}}
update();check();setInterval(check,${secs * 1000});
setInterval(function(){location.reload();},${secs * 3000});
</script></body></html>`;
    return send(res, 200, 'text/html; charset=utf-8', html, { 'Cache-Control': 'no-store' });
  }

  if (url === '/') {
    return send(res, 200, 'text/html; charset=utf-8',
      '<meta charset="utf-8"><h3>agent-kindle-board</h3>'
      + '<p><a href="/image.png">/image.png</a> — 面板图（Kindle 拉这个，已按横放方向旋转）'
      + '<br><a href="/image.png?raw=1">/image.png?raw=1</a> — 未旋转版，浏览器查看用'
      + '<br><a href="/board.html">/board.html</a> — 网页版面板（Kindle 浏览器打开，自动刷新）'
      + '<br><a href="/api/etag">/api/etag</a> — 数据指纹（Kindle 按需刷新用）'
      + '<br><a href="/band/0.png">/band/0.png … /band/15.png</a> — eips 灰度条带（Kindle 直刷用）'
      + '<br><a href="/api/data">/api/data</a> — 原始 JSON'
      + '<br><a href="/health">/health</a> — 健康检查</p>');
  }

  return send(res, 404, 'text/plain; charset=utf-8', '路由: / /image.png /band/N.png /api/etag /api/data /health');
});

process.on('unhandledRejection', (e) => console.error('[unhandledRejection]', e));
process.on('uncaughtException', (e) => console.error('[uncaughtException]', e));

// 先完成首次采集再监听，避免 Kindle 首次拉图拿到 503
(async () => {
  await refresh();
  setInterval(refresh, config.intervalMinutes * 60 * 1000);
  server.listen(config.port, () => {
    console.log(`agent-kindle-board 已启动: http://0.0.0.0:${config.port}/image.png (${config.orientation}, ${config.timezone})`);
  });
})();

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    console.log(`[${sig}] 退出`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000);
  });
}
