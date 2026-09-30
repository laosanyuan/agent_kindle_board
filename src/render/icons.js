const fs = require('fs');
const path = require('path');

const ASSETS = path.join(__dirname, '..', '..', 'assets');
const cache = new Map();

// 读取品牌图标：优先 name.svg（矢量），否则 name.png（位图，转 base64 内嵌）
function icon(name, x, y, size) {
  if (!cache.has(name)) {
    const svgFile = path.join(ASSETS, `${name}.svg`);
    const pngFile = path.join(ASSETS, `${name}.png`);
    if (fs.existsSync(svgFile)) {
      const raw = fs.readFileSync(svgFile, 'utf8');
      const vb = (raw.match(/viewBox="([^"]+)"/) || [])[1] || '0 0 24 24';
      const [, , vw, vh] = vb.split(/\s+/).map(Number);
      let inner = raw.slice(raw.indexOf('>') + 1);
      inner = inner.slice(0, inner.lastIndexOf('</svg>'));
      inner = inner.replace(/<title>[\s\S]*?<\/title>/g, '');
      cache.set(name, { kind: 'svg', inner, vw: vw || 24, vh: vh || 24 });
    } else if (fs.existsSync(pngFile)) {
      const b64 = fs.readFileSync(pngFile).toString('base64');
      cache.set(name, { kind: 'png', b64 });
    } else {
      return '';
    }
  }
  const ic = cache.get(name);
  if (ic.kind === 'png') {
    return `<image x="${x}" y="${y}" width="${size}" height="${size}" href="data:image/png;base64,${ic.b64}"/>`;
  }
  const { inner, vw, vh } = ic;
  const scale = size / Math.max(vw, vh);
  const dx = (size - vw * scale) / 2;
  const dy = (size - vh * scale) / 2;
  return `<g transform="translate(${x + dx},${y + dy}) scale(${scale})">${inner}</g>`;
}

module.exports = { icon };
