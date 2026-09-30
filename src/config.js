const fs = require('fs');
const path = require('path');
const YAML = require('yaml');

const DEFAULTS = {
  port: 8787,
  intervalMinutes: 10,
  historyDays: 7,
  platforms: {},
};

function load() {
  const file = path.join(__dirname, '..', 'config.yaml');
  let cfg = { ...DEFAULTS };
  if (fs.existsSync(file)) {
    cfg = { ...cfg, ...YAML.parse(fs.readFileSync(file, 'utf8')) };
  } else if (process.env.MOCK !== '1') {
    console.warn('[config] 未找到 config.yaml，使用默认配置（复制 config.example.yaml 填写）');
  }
  cfg.port = Number(process.env.PORT || cfg.port);
  return cfg;
}

module.exports = { load };
