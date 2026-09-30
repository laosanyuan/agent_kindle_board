const { withTimeout, fail } = require('./base');

const ID = 'chatgpt';
const NAME = 'ChatGPT';

// ChatGPT Plus/Pro 订阅额度无公开 API。
// 方案：浏览器 Cookie → /api/auth/session 取 accessToken → 内部接口取窗口额度。
// 内部接口结构未文档化，三种已知形态都做兼容解析（见 parseMetrics）。
async function fetchQuota(cfg) {
  const cookie = (cfg && cfg.cookie) || process.env.CHATGPT_COOKIE;
  if (!cookie) return fail(ID, NAME, '未配置 cookie');

  try {
    const sessionRes = await withTimeout(
      fetch('https://chatgpt.com/api/auth/session', {
        headers: { Cookie: cookie, Accept: 'application/json' },
      }),
      15000,
      'ChatGPT 会话获取'
    );
    if (sessionRes.status === 401 || sessionRes.status === 403) {
      return fail(ID, NAME, 'Cookie 已过期，需更新');
    }
    if (!sessionRes.ok) return fail(ID, NAME, `会话接口 HTTP ${sessionRes.status}`);

    const session = await sessionRes.json();
    const token = session && session.accessToken;
    if (!token) return fail(ID, NAME, '未拿到 accessToken（Cookie 可能失效）');

    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };

    // 优先 /backend-api/rate_limits，失败回退 conversation_limit
    let payload = null;
    for (const url of [
      'https://chatgpt.com/backend-api/rate_limits',
      'https://chatgpt.com/backend-api/conversation_limit',
    ]) {
      const res = await withTimeout(fetch(url, { headers }), 15000, 'ChatGPT 额度查询');
      if (res.ok) {
        payload = await res.json();
        if (payload) break;
      }
    }
    if (!payload) return fail(ID, NAME, '额度接口不可用（Cookie 或接口已变化）');

    const metrics = parseMetrics(payload);
    if (!metrics.length) return fail(ID, NAME, '额度接口结构变化，需更新解析');

    // 主数字取剩余最少（最紧急）的那个窗口
    const tightest = metrics.reduce((a, b) => (a.percent <= b.percent ? a : b));

    return {
      id: ID, name: NAME, ok: true,
      big: String(tightest.percent), unit: '%', sub: `${tightest.label}窗口剩余`,
      percent: tightest.percent,
      resetAt: tightest.resetAt,
      metrics,
      detail: 'Plus 订阅窗口额度',
      error: null,
    };
  } catch (e) {
    return fail(ID, NAME, e);
  }
}

function normalizeReset(v) {
  if (typeof v !== 'number') return null;
  if (v > 1e12) return v;              // 毫秒时间戳
  if (v > 1e9) return v * 1000;        // 秒时间戳
  return Date.now() + v * 1000;        // 剩余秒数
}

function labelForWindow(seconds) {
  if (!seconds) return '额度';
  if (seconds <= 6 * 3600) return '5 小时';
  if (seconds >= 6 * 24 * 3600) return '周额度';
  if (seconds >= 24 * 3600) return '日额度';
  return `${Math.round(seconds / 3600)} 小时`;
}

// 兼容三种已知返回形态
function parseMetrics(payload) {
  const metrics = [];

  // 形态 A：primary_window / secondary_window（used_percent + reset_at + limit_window_seconds）
  for (const key of ['primary_window', 'secondary_window']) {
    const w = payload[key];
    if (!w || typeof w !== 'object') continue;
    let percent = null;
    if (typeof w.remaining_percent === 'number') percent = w.remaining_percent;
    else if (typeof w.used_percent === 'number') percent = 100 - w.used_percent;
    else if (typeof w.remaining === 'number' && typeof w.limit === 'number' && w.limit > 0) {
      percent = (w.remaining / w.limit) * 100;
    }
    if (percent == null) continue;
    metrics.push({
      label: labelForWindow(w.limit_window_seconds),
      percent: Math.round(Math.max(0, Math.min(100, percent))),
      resetAt: normalizeReset(w.reset_at),
    });
  }
  if (metrics.length) return metrics;

  // 形态 B：rate_limits 数组
  if (Array.isArray(payload.rate_limits)) {
    for (const item of payload.rate_limits) {
      let percent = null;
      if (typeof item.remaining_percent === 'number') percent = item.remaining_percent;
      else if (typeof item.usage === 'number') percent = (1 - item.usage) * 100;
      else if (typeof item.remaining === 'number' && typeof item.limit === 'number' && item.limit > 0) {
        percent = (item.remaining / item.limit) * 100;
      }
      if (percent == null) continue;
      metrics.push({
        label: labelForWindow(item.limit_window_seconds) || item.name || '额度',
        percent: Math.round(Math.max(0, Math.min(100, percent))),
        resetAt: normalizeReset(item.reset_at ?? item.resets_at),
      });
    }
    if (metrics.length) return metrics;
  }

  // 形态 C：message_cap / messages_remaining（旧版 conversation_limit）
  const cap = payload.message_cap ?? payload.conversation_limit?.message_cap;
  const remaining = payload.messages_remaining ?? payload.conversation_limit?.messages_remaining;
  if (typeof cap === 'number' && cap > 0 && typeof remaining === 'number') {
    metrics.push({
      label: '对话额度',
      percent: Math.round((remaining / cap) * 100),
      resetAt: normalizeReset(payload.reset_at ?? payload.conversation_limit?.reset_at),
    });
  }
  return metrics;
}

module.exports = { id: ID, name: NAME, fetchQuota };
