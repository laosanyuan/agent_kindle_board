const zlib = require('zlib');
const sharp = require('sharp');
const { buildSVG } = require('./template');

// results: provider 结果数组
// opts: { orientation, timezone, intervalMinutes }
async function renderBoard(results, now = Date.now(), opts = {}) {
  const { svg, width, height } = buildSVG(results, now, opts);
  // 输出 RGB PNG：给浏览器 / 免越狱网页版 board.html 用。
  // ⚠️ 注意：这张图不能直接喂给 Kindle 的 eips —— 见 renderGrayBands 的注释。
  return sharp(Buffer.from(svg), { density: 96 })
    .resize(width, height)
    .flatten({ background: '#ffffff' })
    .toColourspace('srgb')
    .png({ compressionLevel: 9 })
    .toBuffer();
}

// —— Kindle eips 专用的灰度条带 ————————————————————————————————
// KPW1（固件 5.3.4）实测结论（2026-10-07，逐像素比对帧缓冲验证）：
//   1. eips 内置 PNG 解码器画 RGB(colortype 2) 大图会输出「不同区域不同缩放」的
//      拼贴花屏；colortype、滤波器、辅助块、文件切条与否都无关，只要内容复杂就花。
//   2. 灰度(colortype 0) 小图则 1:1 精确绘制，-x/-y 定位也准确。
//   3. 单文件体积是硬门槛：~12KB 的复杂图正常，≥16KB 开始花屏。
//   4. sharp 的 .greyscale() 输出的仍是 colortype 2（3 通道），骗了我们很久 ——
//      必须自编码 colortype 0 的 PNG。
// 因此给 eips 的图 = 758x1024 灰度图切成 64 行/条（16 条，实测最大 ~8KB），
// Kindle 端逐条 `eips -g band.png -x 0 -y <i*64>` 绘制。
const BAND_H = 64;

// PNG CRC32（Node 22 的 zlib.crc32 存在，但为了兼容性自己实现）
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// 最小灰度 PNG 编码器：colortype 0、8bit、filter 全部 None（eips 已验证可解码）
function encodeGrayPng(width, height, gray) {
  const stride = width + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter type: None
    gray.copy(raw, y * stride + 1, y * width, (y + 1) * width);
  }
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // colour type: 灰度（关键！colortype 2 会触发 eips 花屏）
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// 渲染并切条。返回 Buffer[]（每条一个灰度 PNG，758x64，最后一条可能略矮）
async function renderGrayBands(results, now = Date.now(), opts = {}) {
  const { svg, width, height } = buildSVG(results, now, opts);
  const raw = await sharp(Buffer.from(svg), { density: 96 })
    .resize(width, height)
    .flatten({ background: '#ffffff' })
    .toColourspace('b-w')   // 1 通道灰度
    .raw().toBuffer();

  const channels = width * height === raw.length ? 1 : raw.length / (width * height);
  if (channels !== 1) {
    // 理论上 b-w 就是 1 通道；万一 sharp 版本行为变化，退化成手工算亮度
    const gray = Buffer.alloc(width * height);
    for (let i = 0; i < width * height; i++) {
      gray[i] = (raw[i * 3] * 299 + raw[i * 3 + 1] * 587 + raw[i * 3 + 2] * 114) / 1000;
    }
    return sliceBands(width, height, gray);
  }
  return sliceBands(width, height, raw);
}

function sliceBands(width, height, gray) {
  const bands = [];
  for (let top = 0; top < height; top += BAND_H) {
    const bh = Math.min(BAND_H, height - top);
    const band = Buffer.alloc(width * bh);
    gray.copy(band, 0, top * width, (top + bh) * width);
    bands.push(encodeGrayPng(width, bh, band));
  }
  return bands;
}

module.exports = { renderBoard, renderGrayBands, BAND_H };
