// 生成预览图：MOCK=1 node src/preview.js [输出路径] [--kindle]
// 默认输出未旋转的 1024x758（便于在电脑上查看）；加 --kindle 则按 config.orientation 旋转，与 Kindle 上一致
// MOCK=0 且未配置凭证时会走真实 provider，失败的卡片显示错误原因（用于验证告警排版）
const fs = require('fs');
const path = require('path');
const config = require('./config').load();
const { collectAll } = require('./providers');
const { renderBoard } = require('./render/render');

(async () => {
  const kindle = process.argv.includes('--kindle');
  const now = Date.now();
  const results = await collectAll(config);
  const png = await renderBoard(results, now, {
    orientation: kindle ? config.orientation : 'none',
    timezone: config.timezone,
    intervalMinutes: config.intervalMinutes,
  });
  const out = process.argv[2] || path.join(__dirname, '..', 'preview.png');
  fs.writeFileSync(out, png);
  console.log('预览图已生成:', out, kindle ? `(旋转: ${config.orientation})` : '(未旋转)');
  for (const r of results) {
    console.log(` - ${r.name}: ${r.ok ? `${r.big}${r.unit ? ' ' + r.unit : ''}` : `失败(${r.error})`}`);
  }
})();
