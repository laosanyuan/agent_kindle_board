// 对比 Kindle 帧缓冲 dump 与设备上的 PNG：验证 eips 偏移是否消失
// 用法: node tools/fb-diff.js <fb_raw> <board_png>
const sharp = require('sharp');
const path = require('path');
const fs = require('fs');

(async () => {
  const raw = process.argv[2] || '_fb2.raw';
  const png = process.argv[3] || '_board_device.png';
  const W = 758, STRIDE = 768, H = 1024;

  // raw 数据必须用 Buffer 传入：按文件名（.raw 扩展名）传会被 sharp 当成未知格式拒绝
  const r = await sharp(fs.readFileSync(path.resolve(raw)), { raw: { width: STRIDE, height: H, channels: 1 } }).raw().toBuffer();
  const out = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) r.copy(out, y * W, y * STRIDE, y * STRIDE + W);

  await sharp(out, { raw: { width: W, height: H, channels: 1 } }).png().toFile(raw.replace(/\.raw$/, '.png'));

  const a = await sharp(path.resolve(png)).greyscale().raw().toBuffer();
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - out[i]) > 30) diff++;
  console.log('差异像素:', diff, '占比', (100 * diff / a.length).toFixed(2) + '%');
  console.log('可视化:', raw.replace(/\.raw$/, '.png'));
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
