const { withTimeout, fail } = require('./base');

const ID = 'workbuddy';
const NAME = 'WorkBuddy';

// 接口来自 WorkBuddy 客户端源码（workbuddy-server / agent-ui）：
//   POST {origin}/v2/billing/meter/get-user-resource-summary   （桌面端走 /v2 前缀 + Bearer token）
// 返回 data.packages[]，每项含 cycleTotal / cycleRemain / cycleUsed / cycleResetTime / PackageCode。
const ORIGIN = 'https://www.workbuddy.cn';
const PATH = '/v2/billing/meter/get-user-resource-summary';

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

// 字段命名在 summary / packages 两处略有差异，两种写法都兼容
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

async function fetchQuota(cfg) {
  const token = (cfg && cfg.token) || process.env.WORKBUDDY_TOKEN;
  if (!token) return fail(ID, NAME, '未配置 token');

  try {
    const res = await withTimeout(
      fetch(`${ORIGIN}${PATH}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Accept-Language': 'zh',
        },
        body: '{}',
      }),
      15000,
      'WorkBuddy 额度查询'
    );
    if (res.status === 401 || res.status === 403) return fail(ID, NAME, 'token 已过期，需更新');
    if (!res.ok) return fail(ID, NAME, `HTTP ${res.status}`);

    const json = await res.json();
    if (json && json.code !== 0) return fail(ID, NAME, `接口 code=${json.code} ${json.msg || ''}`.trim());

    const packages = json?.data?.packages;
    if (!Array.isArray(packages) || packages.length === 0) return fail(ID, NAME, '接口无额度数据');

    const groups = {
      base: { total: 0, left: 0, resetAt: null },
      bonus: { total: 0, left: 0, resetAt: null },
      unknown: { total: 0, left: 0, resetAt: null },
    };

    for (const p of packages) {
      const g = groups[classify(p) || 'unknown'];
      const total = pick(p, ['cycleTotal', 'CycleTotal', 'CycleCapacity', 'CapacityTotal']) || 0;
      const left = pick(p, ['cycleRemain', 'CycleRemain', 'CycleCapacityRemain', 'CapacityRemain']) || 0;
      g.total += total > 0 ? total : 0;
      g.left += left > 0 ? left : 0;
      // 基础积分看周期重置时间，奖励积分看到期时间，取最近的一个
      const t = pickTime(p, ['cycleResetTime', 'CycleResetTime', 'expireAt', 'ExpireAt', 'expireTime']);
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

    return {
      id: ID, name: NAME, ok: true,
      big: String(Math.round(left)), unit: 'credits', sub: '积分剩余（基础 + 奖励）',
      percent: total > 0 ? Math.round((left / total) * 100) : null,
      resetAt: groups.base.resetAt,
      metrics,
      detail: `周期总额 ${Math.round(total)}`,
      error: null,
    };
  } catch (e) {
    return fail(ID, NAME, e);
  }
}

module.exports = { id: ID, name: NAME, fetchQuota };
