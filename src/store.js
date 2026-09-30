const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// 追加一条采集记录：{ts, id, trend}
function append(results, historyDays) {
  ensureDir();
  const ts = Date.now();
  const lines = results
    .filter((r) => r.trend != null)
    .map((r) => JSON.stringify({ ts, id: r.id, trend: r.trend }));
  if (lines.length) fs.appendFileSync(HISTORY_FILE, lines.join('\n') + '\n');
  trim(historyDays);
}

function trim(historyDays) {
  if (!fs.existsSync(HISTORY_FILE)) return;
  const cutoff = Date.now() - historyDays * 24 * 3600 * 1000;
  const kept = fs
    .readFileSync(HISTORY_FILE, 'utf8')
    .split('\n')
    .filter((line) => {
      if (!line.trim()) return false;
      try { return JSON.parse(line).ts >= cutoff; } catch { return false; }
    });
  fs.writeFileSync(HISTORY_FILE, kept.length ? kept.join('\n') + '\n' : '');
}

// 读取某平台最近 maxPoints 个趋势点（用于迷你趋势图）
function series(id, maxPoints = 144) {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  const points = [];
  for (const line of fs.readFileSync(HISTORY_FILE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.id === id && typeof rec.trend === 'number') points.push(rec.trend);
    } catch { /* 跳过坏行 */ }
  }
  return points.slice(-maxPoints);
}

module.exports = { append, series };
