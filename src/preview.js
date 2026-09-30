// 生成预览图：MOCK=1 node src/preview.js [输出路径]
// MOCK=0 且未配置凭证时会走真实 provider，失败的卡片会显示错误原因（用于验证告警排版）
const fs = require('fs');
const path = require('path');
const config = require('./config').load();
const { collectAll } = require('./providers');
const store = require('./store');
const { renderBoard } = require('./render/render');

(async () => {
  const now = Date.now();
  const results = await collectAll(config);
  if (process.env.MOCK !== '1') store.append(results, config.historyDays);
  const png = await renderBoard(results, now);
  const out = process.argv[2] || path.join(__dirname, '..', 'preview.png');
  fs.writeFileSync(out, png);
  console.log('预览图已生成:', out);
  for (const r of results) {
    console.log(` - ${r.name}: ${r.ok ? `${r.big}${r.unit ? ' ' + r.unit : ''}` : `失败(${r.error})`}`);
  }
})();
