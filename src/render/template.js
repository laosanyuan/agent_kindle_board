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
  return `<circle cx="${cx}" cy="${cy}" r="8" fill="none" stroke="#333" stroke-width="2"/>
<line x1="${cx}" y1="${cy}" x2="${cx}" y2="${cy - 4.5}" stroke="#333" stroke-width="2" stroke-linecap="round"/>
<line x1="${cx}" y1="${cy}" x2="${cx + 3.5}" y2="${cy}" stroke="#333" stroke-width="2" stroke-linecap="round"/>`;
}

function warnIcon(x, y) {
  return `<path d="M${x + 9} ${y} L${x + 18} ${y + 16} L${x} ${y + 16} Z" fill="none" stroke="#111" stroke-width="2" stroke-linejoin="round"/>
<line x1="${x + 9}" y1="${y + 6}" x2="${x + 9}" y2="${y + 11}" stroke="#111" stroke-width="2" stroke-linecap="round"/>
<circle cx="${x + 9}" cy="${y + 13.5}" r="1.2" fill="#111"/>`;
}

// 单个额度窗口：标签 + 百分比 + 进度条 + 重置倒计时
// 墨水屏适配：槽改为白底深描边（浅灰槽在 e-ink 上发灰），文字加深加粗
function metricRow(m, x, y, w, now, tz) {
  const fillW = Math.max(3, Math.round((w * m.percent) / 100));
  const cd = fmtCountdown(m.resetAt, now);
  const pct = `${m.percent}%`;
  const labelW = w - textWidth(pct, 14) - 12;
  let out = `<text x="${x}" y="${y}" font-size="14" font-weight="500" fill="#333">${esc(fit(m.label, labelW, 14))}</text>`;
  out += `<text x="${x + w}" y="${y}" text-anchor="end" font-size="14" font-weight="700" fill="#111">${pct}</text>`;
  out += `<rect x="${x}" y="${y + 10}" width="${w}" height="16" rx="8" fill="#ffffff" stroke="#444" stroke-width="2"/>`;
  out += `<rect x="${x + 3}" y="${y + 13}" width="${Math.max(0, fillW - 6)}" height="10" rx="5" fill="#1a1a1a"/>`;
  if (cd) {
    out += clockIcon(x + 7, y + 45);
    out += `<text x="${x + 21}" y="${y + 50}" font-size="13" fill="#444">${esc(fit(cd, w - 21, 13))}</text>`;
  }
  return out;
}

// 大数字 + 单位，按可用宽度自动缩字号（墨水屏：字重拉满到 700/800）
function bigNumber(value, unit, cx, y, maxWidth, size0 = 60) {
  const unitSize0 = unit && unit.length > 3 ? 16 : 24;
  let size = size0;
  let unitSize = unitSize0;
  const w0 = textWidth(value, size) + (unit ? textWidth(' ' + unit, unitSize) : 0);
  if (w0 > maxWidth) {
    const ratio = maxWidth / w0;
    size = Math.max(24, Math.floor(size * ratio));
    unitSize = Math.max(10, Math.floor(unitSize * ratio));
  }
  return `<text x="${cx}" y="${y}" text-anchor="middle" font-size="${size}" font-weight="700" fill="#000000">${esc(value)}${unit ? `<tspan font-size="${unitSize}" font-weight="500" fill="#111"> ${esc(unit)}</tspan>` : ''}</text>`;
}

function card(r, x, y, w, h, now, tz) {
  const cx = x + w / 2;
  const pad = w < 260 ? 16 : 22;
  const inner = w - pad * 2;
  const metrics = r.ok && Array.isArray(r.metrics) ? r.metrics.slice(0, 3) : [];
  const hasMetrics = metrics.length > 0;

  let out = `<g>
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#ffffff" stroke="#333" stroke-width="2.5"/>
${icon(r.id, x + pad, y + 22, w < 260 ? 42 : 52)}
<text x="${x + pad + (w < 260 ? 50 : 66)}" y="${y + 48}" font-size="22" font-weight="700" fill="#000">${esc(fit(r.name, inner - (w < 260 ? 50 : 66), 22))}</text>
${r.ok ? (r.stale ? `<circle cx="${x + pad + 71}" cy="${y + 66}" r="4.5" fill="none" stroke="#111" stroke-width="2"/>` : `<circle cx="${x + pad + 71}" cy="${y + 66}" r="4.5" fill="#111"/>`) : `<circle cx="${x + pad + 71}" cy="${y + 66}" r="4.5" fill="#666"/>`}
<text x="${x + pad + 81}" y="${y + 71}" font-size="14" font-weight="500" fill="${r.stale ? '#111' : '#444'}">${r.ok ? (r.stale ? `陈旧 ${r.staleMinutes} 分钟` : '正常') : '异常'}</text>
<line x1="${x + pad}" y1="${y + 94}" x2="${x + w - pad}" y2="${y + 94}" stroke="#888" stroke-width="2"/>`;

  // 三张卡片的大数字必须横向对齐，所以头部（大数字 + 副标题）走固定基线，不参与居中。
  // 下方内容（窗口行 / 徽章 / 补充）在剩余空间内垂直居中：内容少的卡片留白均分到上下，
  // 既不会在底部堆出空白，也不会让大数字错位。
  const top = y + 106;
  const bottom = y + h - 18;
  const bigSize = 68;
  const step = hasMetrics ? 86 : 0;
  const subGap = 34;   // 大数字基线 → 副标题基线
  const headGap = 26;  // 副标题 → 下方内容
  const badgeH = r.extra ? 38 : 0;
  const detailH = r.detail ? 28 : 0;
  const plainH = hasMetrics ? 0 : 58; // 无额度条时：「按量计费」一行 + 补充一行
  const lowerH = metrics.length * step + badgeH + detailH + plainH;

  const bigBase = top + bigSize;
  const subBase = bigBase + subGap;
  const contentTop = subBase + headGap;
  let cy = contentTop + Math.max(0, (bottom - contentTop - lowerH) / 2);

  if (r.ok) {
    out += bigNumber(r.big, r.unit, cx, bigBase, inner, bigSize);
  } else {
    out += `<text x="${cx}" y="${bigBase}" text-anchor="middle" font-size="60" font-weight="700" fill="#666">--</text>`;
  }
  out += `<text x="${cx}" y="${subBase}" text-anchor="middle" font-size="15" font-weight="500" fill="#333">${esc(fit(r.sub, inner, 15))}</text>`;

  if (!r.ok) {
    // 失败态：原因最多两行，按宽度截断
    const reason = String(r.error || '未知原因');
    const lines = [];
    let rest = reason;
    for (let i = 0; i < 2 && rest; i++) {
      const piece = fit(rest, inner, 14);
      if (piece === rest) { lines.push(piece); rest = ''; }
      else { lines.push(piece); rest = rest.slice(piece.length - 1); }
    }
    out += warnIcon(x + pad, cy - 13);
    out += `<text x="${x + pad + 24}" y="${cy}" font-size="14" font-weight="700" fill="#111">采集失败</text>`;
    lines.forEach((ln, i) => {
      out += `<text x="${x + pad}" y="${cy + 29 + i * 22}" font-size="14" fill="#444">${esc(ln)}</text>`;
    });
    out += '</g>';
    return out;
  }

  if (hasMetrics) {
    for (const m of metrics) {
      out += metricRow(m, x + pad, cy, inner, now, tz);
      cy += step;
    }
  } else {
    out += `<text x="${cx}" y="${cy}" text-anchor="middle" font-size="15" font-weight="500" fill="#333">${esc(fit('按量计费 · 无总额上限', inner, 15))}</text>`;
    cy += 30;
  }

  // 附加徽章（如 ChatGPT 的额度重置次数）：白底深描边，墨水屏上比浅灰块清楚
  if (r.extra) {
    const badge = String(r.extra);
    const bw = Math.min(inner, textWidth(badge, 15) + 24);
    out += `<rect x="${x + pad}" y="${cy - 2}" width="${bw}" height="30" rx="8" fill="#ffffff" stroke="#333" stroke-width="2"/>`;
    out += `<text x="${x + pad + 12}" y="${cy + 19}" font-size="15" font-weight="600" fill="#111">${esc(fit(badge, bw - 20, 15))}</text>`;
    cy += badgeH;
  }

  if (r.detail) {
    out += `<text x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="14" fill="#444">${esc(fit(r.detail, inner, 14))}</text>`;
  }
  out += '</g>';
  return out;
}

function buildSVG(results, now, opts = {}) {
  const { orientation = 'left', timezone = 'Asia/Shanghai' } = opts;
  const margin = 32;
  const gap = 24;
  const cardY = 86;
  const cols = Math.max(1, Math.min(results.length || 1, 4));
  const cardW = (CW - margin * 2 - gap * (cols - 1)) / cols;

  const alerts = results.filter((r) => !r.ok || r.stale);
  // 无异常时卡片占满整页高度（采集时间与状态汇总都省掉了，空间全给额度数据）；
  // 有异常才在底部让出一行告警。
  const cardH = CH - margin - cardY - (alerts.length ? 60 : 0);

  let body = '';
  results.forEach((r, i) => {
    body += card(r, margin + i * (cardW + gap), cardY, cardW, cardH, now, timezone);
  });

  // 底部只在有异常时出现，页面右上角已有更新时间，不再重复
  let footer = '';
  if (alerts.length > 0) {
    // 陈旧用「沿用 N 分钟前的数值」表述，失败用真实原因
    const msg = alerts
      .map((a) => (a.stale ? `${a.name}: 沿用 ${a.staleMinutes} 分钟前的数值` : `${a.name}: ${a.error}`))
      .join('；');
    const ay = cardY + cardH + 40;
    footer += warnIcon(margin, ay - 14);
    footer += `<text x="${margin + 26}" y="${ay}" font-size="15" font-weight="500" fill="#111">${esc(fit(msg, CW - margin * 2 - 26, 15))}</text>`;
  }

  const content = `<text x="${margin}" y="51" font-size="30" font-weight="700" fill="#000">AI 额度监控</text>
<text x="${CW - margin}" y="50" text-anchor="end" font-size="17" font-weight="500" fill="#333">${fmtDateTime(now, timezone)}</text>
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
