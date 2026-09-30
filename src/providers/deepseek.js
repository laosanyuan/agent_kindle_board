const { withTimeout, fail } = require('./base');

const ID = 'deepseek';
const NAME = 'DeepSeek';

// 官方接口：GET https://api.deepseek.com/user/balance (Bearer API Key)
async function fetchQuota(cfg) {
  const apiKey = (cfg && cfg.apiKey) || process.env.DEEPSEEK_API_KEY;
  if (!apiKey) return fail(ID, NAME, '未配置 apiKey');

  try {
    const res = await withTimeout(
      fetch('https://api.deepseek.com/user/balance', {
        headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      }),
      15000,
      'DeepSeek 余额查询'
    );
    if (!res.ok) return fail(ID, NAME, `HTTP ${res.status}（apiKey 可能失效）`);

    const data = await res.json();
    const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
    if (infos.length === 0) return fail(ID, NAME, '接口返回无余额信息');

    // 优先取有正余额的条目，其次 CNY
    const pick =
      infos.find((i) => parseFloat(i.total_balance) > 0) ||
      infos.find((i) => i.currency === 'CNY') ||
      infos[0];
    const total = parseFloat(pick.total_balance);
    const granted = parseFloat(pick.granted_balance) || 0;
    const toppedUp = parseFloat(pick.topped_up_balance) || 0;
    const symbol = pick.currency === 'USD' ? '$' : '¥';

    return {
      id: ID, name: NAME, ok: true,
      big: total.toFixed(2), unit: symbol, sub: 'API 账户余额',
      percent: null, // 按量计费，无总额度概念
      resetAt: null,
      metrics: [],
      detail: `充值 ${symbol}${toppedUp.toFixed(2)} · 赠送 ${symbol}${granted.toFixed(2)}`,
      error: null,
    };
  } catch (e) {
    return fail(ID, NAME, e);
  }
}

module.exports = { id: ID, name: NAME, fetchQuota };
