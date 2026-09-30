const sharp = require('sharp');
const { buildSVG } = require('./template');

// results: provider 结果数组
// opts: { orientation, timezone, intervalMinutes }
async function renderBoard(results, now = Date.now(), opts = {}) {
  const { svg, width, height } = buildSVG(results, now, opts);
  // 输出 RGB PNG（非灰度）：Kindle 的 eips 对单通道灰度图兼容性不佳
  return sharp(Buffer.from(svg), { density: 96 })
    .resize(width, height)
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .png({ compressionLevel: 9 })
    .toBuffer();
}

module.exports = { renderBoard };
