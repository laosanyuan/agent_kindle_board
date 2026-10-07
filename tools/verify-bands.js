// 临时：拉 NAS 的 16 条灰度条带拼成整图，与 Kindle 帧缓冲 raw 逐像素比对
const fs = require('fs');
const sharp = require('sharp');

const BASE = 'http://192.168.100.218:8787';
const W = 758, H = 1024, BH = 64, FB_STRIDE = 768;

async function main() {
  const expected = Buffer.alloc(W * H, 255);
  let expectRows = 0;
  for (let i = 0; i < 16; i++) {
    const buf = await sharp(await fetch(`${BASE}/band/${i}.png`).then((r) => r.arrayBuffer()))
      .toColourspace('b-w').raw().toBuffer();
    const bh = Math.min(BH, H - i * BH);
    buf.copy(expected, i * BH * W, 0, Math.min(buf.length, W * bh));
    expectRows += bh;
  }
  console.log('expected rows:', expectRows);

  const fbRaw = fs.readFileSync('outputs/fb018.raw');
  // 找出与期望最接近的那个 fb 页（fb 有 6 页缓冲）
  let best = { diff: 1e9, page: -1 };
  for (let page = 0; page < 6; page++) {
    let diff = 0;
    for (let y = 0; y < H; y++) {
      const fbOff = page * H * FB_STRIDE + y * FB_STRIDE;
      for (let x = 0; x < W; x++) {
        const a = fbRaw[fbOff + x];
        const b = expected[y * W + x];
        if (Math.abs(a - b) > 24) diff++;
      }
    }
    if (diff < best.diff) best = { diff, page };
  }
  const pct = ((best.diff / (W * H)) * 100).toFixed(2);
  console.log(`最接近的帧缓冲页: ${best.page}, 差异像素 ${best.diff} (${pct}%)`);

  // 输出该页的图片便于肉眼确认
  const out = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    fbRaw.copy(out, y * W, best.page * H * FB_STRIDE + y * FB_STRIDE, best.page * H * FB_STRIDE + y * FB_STRIDE + W);
  }
  await sharp(out, { raw: { width: W, height: H, channels: 1 } }).png().toFile('outputs/kindle-018-final.png');
  console.log('written outputs/kindle-018-final.png');
}
main().catch((e) => console.error(e));
