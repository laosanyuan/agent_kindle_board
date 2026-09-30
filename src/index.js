const http = require('http');
const config = require('./config').load();
const { collectAll } = require('./providers');
const store = require('./store');
const { renderBoard } = require('./render/render');

let latestPng = null;
let latestData = null;
let lastError = null;

async function refresh() {
  const now = Date.now();
  try {
    const results = await collectAll(config);
    store.append(results, config.historyDays);
    latestPng = await renderBoard(results, now);
    latestData = { updatedAt: now, platforms: results };
    lastError = null;
    console.log(`[refresh] ${new Date(now).toLocaleString()} ok=${results.filter((r) => r.ok).length}/${results.length}`);
  } catch (e) {
    lastError = String(e && e.message ? e.message : e);
    console.error('[refresh] 失败:', lastError);
  }
}

const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/image.png') {
    if (!latestPng) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('首次渲染尚未完成');
    }
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Cache-Control': 'no-store',
      'Content-Length': latestPng.length,
    });
    return res.end(latestPng);
  }
  if (url === '/api/data') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ ...latestData, lastError }, null, 2));
  }
  if (url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, updatedAt: latestData && latestData.updatedAt }));
  }
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('路由: /image.png /api/data /health');
});

refresh();
setInterval(refresh, config.intervalMinutes * 60 * 1000);
server.listen(config.port, () => {
  console.log(`agent-kindle-board 已启动: http://0.0.0.0:${config.port}/image.png`);
});
