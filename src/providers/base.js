// Provider 统一约定：
// fetchQuota(cfg) => {
//   id, name, ok,
//   big,        // 大数字主显示，如 "83.42" / "62"
//   unit,       // 单位，如 "¥" / "%"
//   sub,        // 主显示下方的说明，如 "剩余对话额度"
//   percent,    // 0-100 剩余百分比，无概念则为 null
//   resetAt,    // 额度重置时间戳(ms)，无则为 null
//   metrics,    // 分段额度，如 ChatGPT 的 5 小时窗口 / 周额度
//               // 每项：{label, percent, resetAt}
//   extra,      // 卡片上的附加徽章文本，如 ChatGPT 的 "可重置 2 次"（可为 null）
//   detail,     // 卡片底部补充信息（可为 null）
//   error,      // 失败原因（ok=false 时）
// }

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超时(${ms}ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function fail(id, name, error) {
  return {
    id, name, ok: false,
    big: '--', unit: '', sub: '采集失败',
    percent: null, resetAt: null, metrics: [], extra: null, detail: null,
    error: String(error && error.message ? error.message : error),
  };
}

module.exports = { withTimeout, fail };
