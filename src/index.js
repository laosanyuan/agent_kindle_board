const http = require('http');
const crypto = require('crypto');
const config = require('./config').load();
const { collectAll } = require('./providers');
const stale = require('./stale');
const { renderBoard } = require('./render/render');

const renderOpts = {
  orientation: config.orientation,
  timezone: config.timezone,
  intervalMinutes: config.intervalMinutes,
};

const STALE_MAX = Number(config.staleMaxMinutes) || 180;

let latestPng = null;
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

  if (url === '/api/data') {
    return send(res, 200, 'application/json; charset=utf-8',
      JSON.stringify({ ...(latestData || {}), lastError }, null, 2));
  }

  if (url === '/health') {
    return send(res, 200, 'application/json; charset=utf-8',
      JSON.stringify({ ok: true, updatedAt: latestData ? latestData.updatedAt : null, hash: latestHash, lastError }));
  }

  if (url === '/') {
    return send(res, 200, 'text/html; charset=utf-8',
      '<meta charset="utf-8"><h3>agent-kindle-board</h3>'
      + '<p><a href="/image.png">/image.png</a> — 面板图（Kindle 拉这个，已按横放方向旋转）'
      + '<br><a href="/image.png?raw=1">/image.png?raw=1</a> — 未旋转版，浏览器查看用'
      + '<br><a href="/api/etag">/api/etag</a> — 数据指纹（Kindle 按需刷新用）'
      + '<br><a href="/api/data">/api/data</a> — 原始 JSON'
      + '<br><a href="/health">/health</a> — 健康检查</p>');
  }

  return send(res, 404, 'text/plain; charset=utf-8', '路由: / /image.png /api/etag /api/data /health');
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
