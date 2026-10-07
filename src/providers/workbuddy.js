const { withTimeout, fail } = require('./base');
const { httpFetch } = require('../proxy');

const ID = 'workbuddy';
const NAME = 'WorkBuddy';

// 两种认证模式（二选一）：
// A. cookie 模式（推荐）：Web 版同源接口，cookie + X-User-Id 认证
//    POST {ORIGIN}/billing/meter/get-user-resource-summary
//    userId 未配置时自动从 GET /console/accounts 取
// B. token 模式：桌面客户端接口，Bearer token 认证
//    POST {ORIGIN}/v2/billing/meter/get-user-resource-summary
// 两者返回结构一致：data.Packages/packages[]，按 PackageCode 分类。
const ORIGIN = 'https://www.workbuddy.cn';
const WEB_PATH = '/billing/meter/get-user-resource-summary';
const DESKTOP_PATH = '/v2/billing/meter/get-user-resource-summary';
const ACCOUNTS_PATH = '/console/accounts';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36';

// 套餐基础积分（付费套餐 + 加购包）
const PAID_CODES = [
  'TCACA_code_002_AkiJS3ZHF5', // proMon
  'TCACA_code_005_maRGyrHhw1', // proMonPlus
  'TCACA_code_003_FAnt7lcmRT', // proYear
  'TCACA_code_023_4xbGhMrE6q', // youth
  'TCACA_code_026_BaESVICNoi', // advanced
  'TCACA_code_027_0FCGVA6vSa', // flagship
  'TCACA_code_009_0XmEQc2xOf', // extra
  'TCACA_code_038_OhvqZtiPKr', // extra38
  'TCACA_code_036_lupO5WgNdG', // extraIntl
];

// 平台奖励积分（免费额度、赠送、活动、试用）
const FREE_CODES = [
  'TCACA_code_001_PqouKr6QWV', // free
  'TCACA_code_006_DbXS0lrypC', // gift
  'TCACA_code_007_nzdH5h4Nl0', // activity
  'TCACA_code_008_cfWoLwvjU4', // freeMon
  'TCACA_code_035_ArVxJcGDsm', // freeMonIntl
  'TCACA_code_039_KRcQj7wUat', // proTrialMon
  'TCACA_code_040_mi9rCYg46x', // proTrialYear
  'TCACA_code_028_NtpWi0jzXs', // bonus28
  'TCACA_code_029_6wCGEWquYy', // bonus29
  'TCACA_code_030_BjSt89qTvr', // bonus30
  'TCACA_code_037_WxOD3MpI2o', // bonusIntl
];

// 字段命名在 web/桌面两处接口略有差异，多种写法都兼容
function pick(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  }
  return null;
}

function pickTime(obj, keys) {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) return v > 1e12 ? v : v * 1000;
    if (typeof v === 'string') {
      const t = Date.parse(v.includes('T') || v.includes('-') ? v : `${v}Z`);
      if (!Number.isNaN(t)) return t;
    }
  }
  return null;
}

function classify(pkg) {
  const code = pkg.PackageCode ?? pkg.packageCode ?? pkg.SubscriptionPackageCode ?? '';
  if (PAID_CODES.includes(code)) return 'base';
  if (FREE_CODES.includes(code)) return 'bonus';
  return null; // 未知编码
}

function post(url, headers, body = '{}') {
  return withTimeout(
    httpFetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...headers }, body }, ID),
    15000,
    'WorkBuddy 额度查询'
  );
}

async function resolveUserId(cookie) {
  const res = await withTimeout(
    httpFetch(`${ORIGIN}${ACCOUNTS_PATH}`, {
      headers: { Cookie: cookie, 'User-Agent': UA, Referer: `${ORIGIN}/app`, Accept: 'application/json' },
    }, ID),
    15000,
    'WorkBuddy 账户查询'
  );
  if (!res.ok) return null;
  const json = await res.json().catch(() => null);
  const accounts = json?.data?.accounts;
  if (!Array.isArray(accounts) || accounts.length === 0) return null;
  const cur = accounts.find((a) => a.lastLogin) || accounts[0];
  return cur?.uid || null;
}

async function fetchQuota(cfg) {
  const cookie = (cfg && cfg.cookie) || process.env.WORKBUDDY_COOKIE;
  const token = (cfg && cfg.token) || process.env.WORKBUDDY_TOKEN;

  let headers;
  let url;
  if (cookie) {
    // Web cookie 模式
    let userId = (cfg && cfg.userId) || process.env.WORKBUDDY_USER_ID;
    if (!userId) {
      userId = await resolveUserId(cookie);
      if (!userId) return fail(ID, NAME, 'cookie 已失效（无法获取用户 ID），需重新提取');
    }
    headers = {
      Cookie: cookie,
      'X-User-Id': userId,
      'User-Agent': UA,
      Origin: ORIGIN,
      Referer: `${ORIGIN}/app`,
    };
    url = `${ORIGIN}${WEB_PATH}`;
  } else if (token) {
    // 桌面 Bearer 模式
    headers = { Authorization: `Bearer ${token}`, 'Accept-Language': 'zh' };
    url = `${ORIGIN}${DESKTOP_PATH}`;
  } else {
    return fail(ID, NAME, '未配置 cookie（web）或 token（桌面）');
  }

  try {
    const res = await post(url, headers);
    if (res.status === 401 || res.status === 403) {
      return fail(ID, NAME, cookie ? 'cookie 已失效，需重新提取' : 'token 已过期，需更新');
    }
    if (!res.ok) return fail(ID, NAME, `HTTP ${res.status}`);

    const json = await res.json();
    if (json && json.code !== 0) return fail(ID, NAME, `接口 code=${json.code} ${json.msg || ''}`.trim());

    const data = json?.data || {};
    const packages = data.Packages || data.packages;
    if (!Array.isArray(packages) || packages.length === 0) return fail(ID, NAME, '接口无额度数据');

    const groups = {
      base: { total: 0, left: 0, resetAt: null },
      bonus: { total: 0, left: 0, resetAt: null },
      unknown: { total: 0, left: 0, resetAt: null },
    };

    for (const p of packages) {
      const g = groups[classify(p) || 'unknown'];
      const total = pick(p, ['CycleTotalCapacity', 'cycleTotal', 'CycleTotal', 'CycleCapacity', 'CapacityTotal']) || 0;
      const left = pick(p, ['CycleRemainCapacity', 'cycleRemain', 'CycleRemain', 'CycleCapacityRemain', 'CapacityRemain']) || 0;
      g.total += total > 0 ? total : 0;
      g.left += left > 0 ? left : 0;
      // 基础积分看周期重置时间，奖励积分看到期时间，取最近的一个
      const t = pickTime(p, ['cycleResetTime', 'CycleResetTime', 'ExpireTime', 'expireAt', 'ExpireAt', 'expireTime']);
      if (t && (g.resetAt === null || t < g.resetAt)) g.resetAt = t;
    }

    const metrics = [];
    if (groups.base.total > 0) {
      metrics.push({
        label: '套餐基础',
        percent: Math.round(Math.max(0, Math.min(100, (groups.base.left / groups.base.total) * 100))),
        resetAt: groups.base.resetAt,
      });
    }
    if (groups.bonus.total > 0) {
      metrics.push({
        label: '平台奖励',
        percent: Math.round(Math.max(0, Math.min(100, (groups.bonus.left / groups.bonus.total) * 100))),
        resetAt: groups.bonus.resetAt,
      });
    }
    if (metrics.length === 0) {
      if (groups.unknown.total <= 0) return fail(ID, NAME, '额度总量为 0');
      metrics.push({
        label: '积分额度',
        percent: Math.round((groups.unknown.left / groups.unknown.total) * 100),
        resetAt: groups.unknown.resetAt,
      });
    }

    const left = groups.base.left + groups.bonus.left + groups.unknown.left;
    const total = groups.base.total + groups.bonus.total + groups.unknown.total;
    const plan = data.SubscriptionPackageName || '';

    return {
      id: ID, name: NAME, ok: true,
      big: String(Math.round(left)), unit: 'credits', sub: '积分剩余（基础 + 奖励）',
      percent: total > 0 ? Math.round((left / total) * 100) : null,
      resetAt: groups.base.resetAt,
      metrics,
      detail: [plan, total > 0 ? `周期总额 ${Math.round(total)}` : ''].filter(Boolean).join(' · '),
      error: null,
    };
  } catch (e) {
    return fail(ID, NAME, e);
  }
}

module.exports = { id: ID, name: NAME, fetchQuota };
