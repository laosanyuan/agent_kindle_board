const sharp = require('sharp');
const { buildSVG } = require('./template');

// results: provider 结果数组
async function renderBoard(results, now = Date.now()) {
  const svg = buildSVG(results, now);
  return sharp(Buffer.from(svg))
    .flatten({ background: '#ffffff' })
    .grayscale()
    .png()
    .toBuffer();
}

module.exports = { renderBoard };
