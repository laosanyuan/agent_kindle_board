// 1024x758 横屏灰度模板（Kindle Paperwhite 1 横放）
// 设计原则：纯白底、深灰/黑元素、大字号、无渐变，墨水屏友好
//
// 注意：Kindle 帧缓冲是 758x1024（竖屏原生），eips 不会旋转图片。
// 因此横放观看时，实际输出画布为 758x1024，内容整体旋转 90° 写入。

const { icon } = require('./icons');

const CW = 1024; // 内容画布宽（设计尺寸）
const CH = 758;  // 内容画布高
const FONT = "'Noto Sans CJK SC','Microsoft YaHei','PingFang SC',sans-serif";

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 估算文本宽度：CJK/全角按 1em，其余按 0.55em
function textWidth(s, size) {
  let w = 0;
  for (const ch of String(s)) w += ch.codePointAt(0) > 0x2e80 ? 1 : 0.55;
  return w * size;
}

// 按可用像素宽度截断（比按字符数截断可靠，中英文混排也不会溢出）
function fit(s, maxWidth, size) {
  s = String(s);
  if (textWidth(s, size) <= maxWidth) return s;
  let out = '';
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxWidth) break;
    out += ch;
  }
  return out + '…';
}

// 时间格式化：不受容器 TZ 影响，按 config.timezone 输出
function timeParts(ts, tz) {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  const p = {};
  for (const part of fmt.formatToParts(new Date(ts))) p[part.type] = part.value;
  return p;
}

function fmtTime(ts, tz) {
  const p = timeParts(ts, tz);
  return `${p.hour}:${p.minute}`;
}

function fmtDateTime(ts, tz) {
  const p = timeParts(ts, tz);
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
}

function fmtCountdown(resetAt, now) {
  if (!resetAt) return null;
  const diff = resetAt - now;
  if (diff <= 0) return '已到重置时间';
  const m = Math.floor(diff / 60000);
  const d = Math.floor(m / 1440);
  const h = Math.floor((m % 1440) / 60);
  const mm = m % 60;
  if (d > 0) return `${d}天 ${h}小时后重置`;
  if (h > 0) return `${h}小时 ${mm}分后重置`;
  return `${mm}分钟后重置`;
}

function clockIcon(cx, cy) {
  return `<circle cx="${cx}" cy="${cy}" r="7" fill="none" stroke="#555" stroke-width="1.5"/>
<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - 4}" stroke="#555" stroke-width="1.5" stroke-linecap="round"/>
<line x1="${cx}" y1="${cy}" x2="${cx + 3}" y2="${cy}" stroke="#555" stroke-width="1.5" stroke-linecap="round"/>`;
}

function warnIcon(x, y) {
  return `<path d="M${x + 9} ${y} L${x + 18} ${y + 16} L${x} ${y + 16} Z" fill="none" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/>
<line x1="${x + 9}" y1="${y + 6}" x2="${x + 9}" y2="${y + 11}" stroke="#111" stroke-width="1.6" stroke-linecap="round"/>
<circle cx="${x + 9}" cy="${y + 13.5}" r="1" fill="#111"/>`;
}

// 单个额度窗口：标签 + 百分比 + 进度条 + 重置倒计时
function metricRow(m, x, y, w, now, tz) {
  const fillW = Math.max(2, Math.round((w * m.percent) / 100));
  const cd = fmtCountdown(m.resetAt, now);
  const pct = `${m.percent}%`;
  const labelW = w - textWidth(pct, 13) - 12;
  let out = `<text x="${x}" y="${y}" font-size="13" fill="#666">${esc(fit(m.label, labelW, 13))}</text>`;
  out += `<text x="${x + w}" y="${y}" text-anchor="end" font-size="13" font-weight="600" fill="#111">${pct}</text>`;
  out += `<rect x="${x}" y="${y + 10}" width="${w}" height="14" rx="7" fill="#e3e3e3"/>`;
  out += `<rect x="${x}" y="${y + 10}" width="${fillW}" height="14" rx="7" fill="#1a1a1a"/>`;
  if (cd) {
    out += clockIcon(x + 7, y + 44);
    out += `<text x="${x + 19}" y="${y + 48}" font-size="12" fill="#555">${esc(fit(cd, w - 19, 12))}</text>`;
  }
  return out;
}

// 大数字 + 单位，按可用宽度自动缩字号
function bigNumber(value, unit, cx, y, maxWidth) {
  const unitSize0 = unit && unit.length > 3 ? 16 : 24;
  let size = 60;
  let unitSize = unitSize0;
  const w0 = textWidth(value, size) + (unit ? textWidth(' ' + unit, unitSize) : 0);
  if (w0 > maxWidth) {
    const ratio = maxWidth / w0;
    size = Math.max(24, Math.floor(size * ratio));
    unitSize = Math.max(10, Math.floor(unitSize * ratio));
  }
  return `<text x="${cx}" y="${y}" text-anchor="middle" font-size="${size}" font-weight="600" fill="#0a0a0a">${esc(value)}${unit ? `<tspan font-size="${unitSize}" font-weight="400" fill="#333"> ${esc(unit)}</tspan>` : ''}</text>`;
}

function card(r, x, y, w, h, now, tz) {
  const cx = x + w / 2;
  const pad = w < 260 ? 16 : 22;
  const inner = w - pad * 2;
  const metrics = r.ok && Array.isArray(r.metrics) ? r.metrics.slice(0, 3) : [];
  const hasMetrics = metrics.length > 0;

  let out = `<g>
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#ffffff" stroke="#c9c9c9" stroke-width="1.5"/>
${icon(r.id, x + pad, y + 22, w < 260 ? 42 : 52)}
<text x="${x + pad + (w < 260 ? 50 : 66)}" y="${y + 48}" font-size="22" font-weight="600" fill="#111">${esc(fit(r.name, inner - (w < 260 ? 50 : 66), 22))}</text>
${r.ok ? (r.stale ? `<circle cx="${x + pad + 71}" cy="${y + 66}" r="4" fill="none" stroke="#111" stroke-width="1.5"/>` : `<circle cx="${x + pad + 71}" cy="${y + 66}" r="4" fill="#111"/>`) : `<circle cx="${x + pad + 71}" cy="${y + 66}" r="4" fill="#888"/>`}
<text x="${x + pad + 81}" y="${y + 71}" font-size="13" fill="${r.stale ? '#111' : '#666'}">${r.ok ? (r.stale ? `陈旧 ${r.staleMinutes} 分钟` : '正常') : '异常'}</text>
<line x1="${x + pad}" y1="${y + 94}" x2="${x + w - pad}" y2="${y + 94}" stroke="#ddd" stroke-width="1"/>`;

  // 大数字区
  if (r.ok) {
    out += bigNumber(r.big, r.unit, cx, y + 190, inner);
  } else {
    out += `<text x="${cx}" y="${y + 190}" text-anchor="middle" font-size="60" font-weight="600" fill="#999">--</text>`;
  }
  out += `<text x="${cx}" y="${y + 220}" text-anchor="middle" font-size="14" fill="#666">${esc(fit(r.sub, inner, 14))}</text>`;

  if (hasMetrics) {
    // 窗口额度行（ChatGPT 的 5 小时 / 周额度等），最多 3 行，行距按剩余高度自适应
    const top = y + 256;
    const avail = h - 24 - 8 - 256;
    const step = Math.min(80, Math.floor(avail / metrics.length));
    let my = top;
    for (const m of metrics) {
      out += metricRow(m, x + pad, my, inner, now, tz);
      my += step;
    }
  } else if (r.ok) {
    out += `<text x="${cx}" y="${y + 262}" text-anchor="middle" font-size="14" fill="#555">${esc(fit('按量计费 · 无总额上限', inner, 14))}</text>`;
    if (r.detail) {
      out += `<text x="${cx}" y="${y + 292}" text-anchor="middle" font-size="13" fill="#888">${esc(fit(r.detail, inner, 13))}</text>`;
    }
  } else {
    // 失败态：原因最多两行，按宽度截断
    const reason = String(r.error || '未知原因');
    const lines = [];
    let rest = reason;
    for (let i = 0; i < 2 && rest; i++) {
      const piece = fit(rest, inner, 13);
      if (piece === rest) { lines.push(piece); rest = ''; }
      else { lines.push(piece); rest = rest.slice(piece.length - 1); }
    }
    out += warnIcon(x + pad, y + 250);
    out += `<text x="${x + pad + 24}" y="${y + 263}" font-size="13" font-weight="600" fill="#111">采集失败</text>`;
    lines.forEach((ln, i) => {
      out += `<text x="${x + pad}" y="${y + 292 + i * 22}" font-size="13" fill="#555">${esc(ln)}</text>`;
    });
  }

  const footY = y + h - 24;
  out += `<text x="${x + pad}" y="${footY}" font-size="12" fill="#999">采集于 ${fmtTime(now, tz)}</text>`;
  if (hasMetrics && r.detail) {
    const timeW = textWidth(`采集于 ${fmtTime(now, tz)}`, 12) + 12;
    out += `<text x="${x + w - pad}" y="${footY}" text-anchor="end" font-size="12" fill="#999">${esc(fit(r.detail, inner - timeW, 12))}</text>`;
  }
  out += '</g>';
  return out;
}

function buildSVG(results, now, opts = {}) {
  const { orientation = 'left', timezone = 'Asia/Shanghai', intervalMinutes = 10 } = opts;
  const margin = 32;
  const gap = 24;
  const cardY = 86;
  const cardH = 500;
  const cols = Math.max(1, Math.min(results.length || 1, 4));
  const cardW = (CW - margin * 2 - gap * (cols - 1)) / cols;

  const okCount = results.filter((r) => r.ok && !r.stale).length;
  const staleCount = results.filter((r) => r.stale).length;
  const alerts = results.filter((r) => !r.ok || r.stale);

  let body = '';
  results.forEach((r, i) => {
    body += card(r, margin + i * (cardW + gap), cardY, cardW, cardH, now, timezone);
  });

  const footerLine = `<line x1="${margin}" y1="622" x2="${CW - margin}" y2="622" stroke="#ccc" stroke-width="1"/>`;
  const leftFoot = `每 ${intervalMinutes} 分钟采集 · 最后更新 ${fmtDateTime(now, timezone)}`;
  const rightFoot = `agent-kindle-board · ${okCount}/${results.length} 正常${staleCount ? ` · ${staleCount} 陈旧` : ''}`;

  let footer = `${footerLine}
<text x="${margin}" y="656" font-size="14" fill="#555">${esc(leftFoot)}</text>
<text x="${CW - margin}" y="656" text-anchor="end" font-size="13" fill="#999">${esc(rightFoot)}</text>`;

  if (alerts.length > 0) {
    // 陈旧用「沿用 N 分钟前的数值」表述，失败用真实原因
    const msg = alerts
      .map((a) => (a.stale ? `${a.name}: 沿用 ${a.staleMinutes} 分钟前的数值` : `${a.name}: ${a.error}`))
      .join('；');
    footer += warnIcon(margin, 674);
    footer += `<text x="${margin + 26}" y="688" font-size="14" fill="#111">${esc(fit(msg, CW - margin * 2 - 26, 14))}</text>`;
  } else {
    footer += `<text x="${margin}" y="688" font-size="13" fill="#999">所有平台运行正常</text>`;
  }

  const content = `<text x="${margin}" y="50" font-size="28" font-weight="600" fill="#0a0a0a">AI 额度监控</text>
<text x="${CW - margin}" y="50" text-anchor="end" font-size="16" fill="#666">${fmtDateTime(now, timezone)}</text>
${body}
${footer}`;

  // 输出画布：横放时旋转 90°，画布为 758x1024（匹配帧缓冲）
  let width = CW;
  let height = CH;
  let transform = '';
  if (orientation === 'left') {
    width = CH; height = CW;
    transform = `translate(${CH},0) rotate(90)`;
  } else if (orientation === 'right') {
    width = CH; height = CW;
    transform = `translate(0,${CW}) rotate(-90)`;
  }

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<rect width="${width}" height="${height}" fill="#ffffff"/>
<g font-family="${FONT}">
<g${transform ? ` transform="${transform}"` : ''}>${content}</g>
</g>
</svg>`;

  return { svg, width, height };
}

module.exports = { buildSVG, CW, CH };
