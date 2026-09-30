// 采集失败降级：沿用该平台上一次成功的值，标记为「陈旧」
// 避免一次网络抖动就把面板上的有效数字抹成「--」
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE = path.join(DATA_DIR, 'last-good.json');

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function save(cache) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache));
  } catch (e) {
    console.warn('[stale] 缓存写入失败:', e.message);
  }
}

// results 中失败的平台，若存在未超期的上次成功值则替换；成功的平台更新缓存
function apply(results, cache, maxMinutes, now = Date.now()) {
  const out = [];
  for (const r of results) {
    if (r.ok) {
      cache[r.id] = { result: r, ts: now };
      out.push(r);
      continue;
    }
    const g = cache[r.id];
    const age = g ? now - g.ts : Infinity;
    if (!g || age > maxMinutes * 60000) {
      out.push(r); // 无缓存或缓存已过期，正常显示失败
      continue;
    }
    out.push({
      ...g.result,
      stale: true,
      staleMinutes: Math.max(1, Math.round(age / 60000)),
      error: r.error, // 保留真实原因，/api/data 里可查
    });
  }
  return out;
}

module.exports = { load, save, apply };
