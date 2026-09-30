const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const DEFAULTS = {
  port: 8787,
  intervalMinutes: 10,
  // 采集失败后沿用上次成功值的最长时间（分钟），超过则判定为真正失败
  staleMaxMinutes: 180,
  timezone: 'Asia/Shanghai',
  // 横放方向：设备顶部朝哪边。left = 顶部朝左，right = 顶部朝右，none = 不旋转（输出 1024x758）
  orientation: 'left',
  platforms: {},
};

// 环境变量可覆盖凭证；设置后自动启用对应平台
const ENV_MAP = {
  DEEPSEEK_API_KEY: ['deepseek', 'apiKey'],
  CHATGPT_COOKIE: ['chatgpt', 'cookie'],
  WORKBUDDY_TOKEN: ['workbuddy', 'token'],
};

function load() {
  const file = path.join(__dirname, '..', 'config.yaml');
  let cfg = { ...DEFAULTS, platforms: {} };

  if (fs.existsSync(file)) {
    const parsed = YAML.parse(fs.readFileSync(file, 'utf8')) || {};
    cfg = { ...cfg, ...parsed };
    cfg.platforms = { ...(parsed.platforms || {}) };
  } else if (process.env.MOCK !== '1') {
    console.warn('[config] 未找到 config.yaml，使用默认配置（复制 config.example.yaml 填写）');
  }

  for (const [env, [id, field]] of Object.entries(ENV_MAP)) {
    const v = process.env[env];
    if (!v) continue;
    cfg.platforms[id] = { ...(cfg.platforms[id] || {}), [field]: v, enabled: true };
  }

  cfg.port = Number(process.env.PORT || cfg.port) || 8787;
  cfg.intervalMinutes = Number(cfg.intervalMinutes) || 10;
  return cfg;
}

module.exports = { load };
