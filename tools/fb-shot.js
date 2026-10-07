// 临时：把 Kindle /dev/fb0 raw（8bpp 灰度，stride 768）转成 PNG 看真机效果
// 用法: node tools/_fb_shot.js <raw> <out.png> [rowOffsetBytes]
const fs = require('fs');
const sharp = require('sharp');

const [raw, out, offArg] = process.argv.slice(2);
const W = 768, H = 1024;
const off = offArg ? parseInt(offArg, 10) : 0;
const buf = fs.readFileSync(raw).slice(off, off + W * H);
sharp(buf, { raw: { width: W, height: H, channels: 1 } })
  .resize(758, 1024)
  .png()
  .toFile(out)
  .then(() => console.log('written', out))
  .catch((e) => console.error(e));
