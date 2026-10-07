const { withTimeout, fail } = require('./base');
const { httpFetch } = require('../proxy');

const ID = 'chatgpt';
const NAME = 'ChatGPT';

const SESSION_URL = 'https://chatgpt.com/api/auth/session';
// Cloudflare 会拦默认 UA 的机器请求，需伪装成浏览器（与提取 cookie 的浏览器一致）
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';
const BROWSER_HEADERS = {
  'User-Agent': UA,
  Accept: 'application/json',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://chatgpt.com/',
  Origin: 'https://chatgpt.com',
};
// 2026-10 实测：只有 /backend-api/wham/usage 有效，
// /backend-api/rate_limits 与 /backend-api/conversation_limit 均已返回 404（保留作兜底）。
const USAGE_URLS = [
  'https://chatgpt.com/backend-api/wham/usage',
  'https://chatgpt.com/backend-api/rate_limits',
  'https://chatgpt.com/backend-api/conversation_limit',
];

/**
 * ChatGPT Plus/Pro 订阅额度无公开 API。
 * 方案：浏览器 Cookie → /api/auth/session 取 accessToken → /backend-api/wham/usage 取窗口额度。
 * wham/usage 返回形如：
 *   { plan_type: "plus", rate_limit: { primary_window: {used_percent,reset_at,limit_window_seconds},
 *                                      secondary_window: {...} } }
 */
async function fetchQuota(cfg) {
  const cookie = (cfg && cfg.cookie) || process.env.CHATGPT_COOKIE;
  if (!cookie) return fail(ID, NAME, '未配置 cookie');

  try {
    // 1) 用 cookie 换 accessToken；拿不到也不算失败，继续用 cookie 直接打接口
    let token = null;
    const sessionRes = await withTimeout(
      httpFetch(SESSION_URL, {
        headers: { ...BROWSER_HEADERS, Cookie: cookie },
      }, ID),
      15000,
      'ChatGPT 会话获取'
    );
    if (sessionRes.ok) {
      const session = await sessionRes.json().catch(() => null);
      token = (session && session.accessToken) || null;
    }

    // 2) 取额度：token 与 cookie 都带上，任一可用即可
    const headers = { ...BROWSER_HEADERS, Cookie: cookie };
    if (token) headers.Authorization = `Bearer ${token}`;

    let payload = null;
    let lastStatus = null;
    let lastBody = '';
    for (const url of USAGE_URLS) {
      const res = await withTimeout(httpFetch(url, { headers }, ID), 15000, 'ChatGPT 额度查询');
      if (!res.ok) {
        lastStatus = res.status;
        lastBody = (await res.text().catch(() => '')).slice(0, 500);
        continue;
      }
      const body = await res.json().catch(() => null);
      if (body && typeof body === 'object' && Object.keys(body).length > 0) { payload = body; break; }
    }
    if (lastStatus === 401) {
      return fail(ID, NAME, 'Cookie 已过期，需更新');
    }
    if (lastStatus === 403) {
      // Cloudflare 拦截返回 403 + HTML 页；真未授权是 401 + JSON
      const isChallenge = /<html|cf-mitigated|just a moment|challenge/i.test(lastBody);
      if (isChallenge) {
        return fail(ID, NAME, '被 Cloudflare 拦截：服务端需能访问 chatgpt.com（配代理出口）');
      }
      return fail(ID, NAME, 'Cookie 已过期，需更新');
    }
    if (!payload) {
      return fail(ID, NAME, lastStatus ? `额度接口 HTTP ${lastStatus}（接口可能已变化）` : '额度接口返回为空');
    }

    const metrics = parseMetrics(payload);
    if (!metrics.length) return fail(ID, NAME, '额度接口结构变化，需更新解析');

    // 主数字取剩余最少（最紧急）的那个窗口
    const tightest = metrics.reduce((a, b) => (a.percent <= b.percent ? a : b));
    const plan = payload.plan_type ? String(payload.plan_type) : null;
    const planText = plan ? { plus: 'Plus', pro: 'Pro', free: 'Free', team: 'Team' }[plan.toLowerCase()] || plan : '订阅';

    return {
      id: ID, name: NAME, ok: true,
      big: String(tightest.percent), unit: '%', sub: `${tightest.label}窗口剩余`,
      percent: tightest.percent,
      resetAt: tightest.resetAt,
      metrics,
      detail: `${planText} · 窗口额度`,
      error: null,
    };
  } catch (e) {
    return fail(ID, NAME, e);
  }
}

function normalizeReset(v) {
  // 字符串：ISO 时间（"2026-09-30T12:00:00Z"）或数字字符串
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) return normalizeReset(Number(s));
    const t = Date.parse(s);
    return Number.isNaN(t) ? null : t;
  }
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (v > 1e12) return v;              // 毫秒时间戳
  if (v > 1e9) return v * 1000;        // 秒时间戳
  return Date.now() + v * 1000;        // 剩余秒数（reset_after_seconds）
}

function labelForWindow(seconds) {
  if (!seconds) return '额度';
  if (seconds <= 6 * 3600) return '5 小时';
  if (seconds >= 6 * 24 * 3600) return '周额度';
  if (seconds >= 24 * 3600) return '日额度';
  return `${Math.round(seconds / 3600)} 小时`;
}

// 从窗口对象里取 {percent, resetAt, label}
function windowToMetric(w) {
  if (!w || typeof w !== 'object') return null;
  let percent = null;
  if (typeof w.remaining_percent === 'number') percent = w.remaining_percent;
  else if (typeof w.used_percent === 'number') percent = 100 - w.used_percent;
  else if (typeof w.remaining === 'number' && typeof w.limit === 'number' && w.limit > 0) {
    percent = (w.remaining / w.limit) * 100;
  }
  if (percent == null) return null;
  return {
    label: labelForWindow(w.limit_window_seconds),
    percent: Math.round(Math.max(0, Math.min(100, percent))),
    resetAt: normalizeReset(w.reset_at ?? w.reset_after_seconds),
  };
}

// 兼容已知返回形态
function parseMetrics(payload) {
  const metrics = [];

  // 形态 A（当前真实）：rate_limit.primary_window / secondary_window
  const root = payload.rate_limit && typeof payload.rate_limit === 'object' ? payload.rate_limit : payload;
  for (const key of ['primary_window', 'secondary_window']) {
    const m = windowToMetric(root[key]);
    if (m) metrics.push(m);
  }
  if (metrics.length) return metrics;

  // 形态 B：rate_limits 数组
  if (Array.isArray(root.rate_limits)) {
    for (const item of root.rate_limits) {
      const m = windowToMetric(item);
      if (m) metrics.push({ ...m, label: m.label || item.name || '额度' });
    }
    if (metrics.length) return metrics;
  }

  // 形态 C：message_cap / messages_remaining（旧版 conversation_limit）
  const cap = root.message_cap ?? root.conversation_limit?.message_cap;
  const remaining = root.messages_remaining ?? root.conversation_limit?.messages_remaining;
  if (typeof cap === 'number' && cap > 0 && typeof remaining === 'number') {
    metrics.push({
      label: '对话额度',
      percent: Math.round((remaining / cap) * 100),
      resetAt: normalizeReset(root.reset_at ?? root.conversation_limit?.reset_at),
    });
  }
  return metrics;
}

module.exports = { id: ID, name: NAME, fetchQuota, parseMetrics };
