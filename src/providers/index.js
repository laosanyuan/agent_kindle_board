const deepseek = require('./deepseek');
const chatgpt = require('./chatgpt');
const workbuddy = require('./workbuddy');

const REGISTRY = { deepseek, chatgpt, workbuddy };

// 只有瞬时故障（网络抖动、超时、服务端 5xx）才重试；凭证缺失/过期重试无意义
const TRANSIENT = /超时|timeout|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|socket|network|TLS|HTTP 5\d\d/i;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(provider, cfg) {
  const first = await provider.fetchQuota(cfg);
  if (first.ok || !TRANSIENT.test(first.error || '')) return first;
  await sleep(2000);
  const second = await provider.fetchQuota(cfg);
  if (second.ok) return second;
  return { ...first, error: `${first.error}（已重试 1 次）` };
}

// MOCK=1 时生成假数据，便于无凭证验证排版
// 再加 MOCK_STALE=1 可把 ChatGPT 标记为「数据陈旧」，验证降级排版
function mockQuota(id, name) {
  const now = Date.now();
  if (id === 'deepseek') {
    return {
      id, name, ok: true, big: '83.42', unit: '¥', sub: 'API 账户余额',
      percent: null, resetAt: null, metrics: [],
      detail: '充值 ¥80.00 · 赠送 ¥3.42', error: null,
    };
  }
  if (id === 'chatgpt') {
    const m = {
      id, name, ok: true, big: '48', unit: '%', sub: '5 小时窗口剩余',
      percent: 48,
      resetAt: now + (2 * 60 + 41) * 60000,
      metrics: [
        { label: '5 小时', percent: 48, resetAt: now + (2 * 60 + 41) * 60000 },
        { label: '周额度', percent: 76, resetAt: now + (3 * 24 + 5) * 3600 * 1000 },
      ],
      extra: '可重置 2 次',
      detail: 'Plus 订阅', error: null,
    };
    return process.env.MOCK_STALE === '1' ? { ...m, stale: true, staleMinutes: 12 } : m;
  }
  return {
    id, name, ok: true, big: '12460', unit: 'credits', sub: '积分剩余（基础 + 奖励）',
    percent: 62, resetAt: now + (11 * 24 + 3) * 3600 * 1000,
    metrics: [
      { label: '套餐基础', percent: 58, resetAt: now + (11 * 24 + 3) * 3600 * 1000 },
      { label: '平台奖励', percent: 71, resetAt: now + (6 * 24 + 8) * 3600 * 1000 },
    ],
    detail: '周期总额 20000', error: null,
  };
}

async function collectAll(config) {
  const useMock = process.env.MOCK === '1';
  const results = [];
  for (const [id, provider] of Object.entries(REGISTRY)) {
    const cfg = (config.platforms && config.platforms[id]) || {};
    if (useMock) {
      results.push(mockQuota(id, provider.name));
      continue;
    }
    if (!cfg.enabled) continue;
    results.push(await fetchWithRetry(provider, cfg));
  }
  return results;
}

module.exports = { collectAll, REGISTRY };
