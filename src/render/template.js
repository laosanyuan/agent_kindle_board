// 1024x758 横屏灰度模板（Kindle Paperwhite 1 横放）
// 设计原则：纯白底、深灰/黑元素、大字号、无渐变，墨水屏友好

const { icon } = require('./icons');

const W = 1024;
const H = 758;
const FONT = "'Noto Sans CJK SC','Microsoft YaHei','PingFang SC',sans-serif";

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function fmtDateTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
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

function truncate(s, n) {
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// 单个额度窗口：标签 + 百分比 + 进度条 + 重置倒计时
function metricRow(m, x, y, w, now) {
  const fillW = Math.max(2, Math.round((w * m.percent) / 100));
  const cd = fmtCountdown(m.resetAt, now);
  let out = `<text x="${x}" y="${y}" font-size="13" fill="#666">${esc(m.label)}</text>`;
  out += `<text x="${x + w}" y="${y}" text-anchor="end" font-size="13" font-weight="600" fill="#111">${m.percent}%</text>`;
  out += `<rect x="${x}" y="${y + 10}" width="${w}" height="14" rx="7" fill="#e3e3e3"/>`;
  out += `<rect x="${x}" y="${y + 10}" width="${fillW}" height="14" rx="7" fill="#1a1a1a"/>`;
  if (cd) {
    out += clockIcon(x + 7, y + 44);
    out += `<text x="${x + 19}" y="${y + 48}" font-size="12" fill="#555">${esc(cd)}</text>`;
  }
  return out;
}

function card(r, x, y, w, h, now) {
  const cx = x + w / 2;
  const hasMetrics = r.ok && Array.isArray(r.metrics) && r.metrics.length > 0;
  let out = `<g>
<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="14" fill="#ffffff" stroke="#c9c9c9" stroke-width="1.5"/>
${icon(r.id, x + 22, y + 22, 52)}
<text x="${x + 88}" y="${y + 48}" font-size="22" font-weight="600" fill="#111">${esc(r.name)}</text>
<circle cx="${x + 93}" cy="${y + 66}" r="4" fill="${r.ok ? '#111' : '#888'}"/>
<text x="${x + 103}" y="${y + 71}" font-size="13" fill="#666">${r.ok ? '正常' : '异常'}</text>
<line x1="${x + 22}" y1="${y + 94}" x2="${x + w - 22}" y2="${y + 94}" stroke="#ddd" stroke-width="1"/>`;

  // 大数字区
  if (r.ok) {
    const unitSize = r.unit && r.unit.length > 3 ? 16 : 24;
    out += `<text x="${cx}" y="${y + 190}" text-anchor="middle" font-size="60" font-weight="600" fill="#0a0a0a">${esc(r.big)}<tspan font-size="${unitSize}" font-weight="400" fill="#333">${r.unit ? ' ' + esc(r.unit) : ''}</tspan></text>`;
  } else {
    out += `<text x="${cx}" y="${y + 190}" text-anchor="middle" font-size="60" font-weight="600" fill="#999">--</text>`;
  }
  out += `<text x="${cx}" y="${y + 220}" text-anchor="middle" font-size="14" fill="#666">${esc(r.sub)}</text>`;

  if (hasMetrics) {
    // 窗口额度行（ChatGPT 的 5 小时 / 周额度等）
    const mw = w - 44;
    let my = y + 256;
    for (const m of r.metrics) {
      out += metricRow(m, x + 22, my, mw, now);
      my += 80;
    }
  } else if (r.ok) {
    out += `<text x="${cx}" y="${y + 262}" text-anchor="middle" font-size="14" fill="#555">按量计费 · 无总额上限</text>`;
    if (r.detail) {
      out += `<text x="${cx}" y="${y + 292}" text-anchor="middle" font-size="13" fill="#888">${esc(truncate(r.detail, 30))}</text>`;
    }
  } else {
    out += warnIcon(x + 22, y + 250);
    out += `<text x="${x + 46}" y="${y + 263}" font-size="13" font-weight="600" fill="#111">采集失败</text>`;
    out += `<text x="${x + 22}" y="${y + 292}" font-size="13" fill="#555">${esc(truncate(r.error, 24))}</text>`;
    out += `<text x="${x + 22}" y="${y + 314}" font-size="13" fill="#555">${esc(truncate(String(r.error).slice(23), 24))}</text>`;
  }

  out += `<text x="${x + 22}" y="${y + h - 24}" font-size="12" fill="#999">采集于 ${fmtTime(now)}</text>`;
  if (hasMetrics && r.detail) {
    out += `<text x="${x + w - 22}" y="${y + h - 24}" text-anchor="end" font-size="12" fill="#999">${esc(truncate(r.detail, 22))}</text>`;
  }
  out += '</g>';
  return out;
}

function buildSVG(results, now) {
  const margin = 32;
  const gap = 24;
  const cardY = 86;
  const cardH = 500;
  const cardW = (W - margin * 2 - gap * 2) / 3;

  const okCount = results.filter((r) => r.ok).length;
  const alerts = results.filter((r) => !r.ok);

  let body = '';
  results.forEach((r, i) => {
    body += card(r, margin + i * (cardW + gap), cardY, cardW, cardH, now);
  });

  let footer = `<line x1="${margin}" y1="622" x2="${W - margin}" y2="622" stroke="#ccc" stroke-width="1"/>
<text x="${margin}" y="656" font-size="14" fill="#555">每 10 分钟采集 · 最后更新 ${fmtDateTime(now)}</text>
<text x="${W - margin}" y="656" text-anchor="end" font-size="13" fill="#999">agent-kindle-board · ${okCount}/${results.length} 正常</text>`;

  if (alerts.length > 0) {
    footer += warnIcon(margin, 674);
    footer += `<text x="${margin + 26}" y="688" font-size="14" fill="#111">${esc(truncate(alerts.map((a) => `${a.name}: ${a.error}`).join('；'), 72))}</text>`;
  } else {
    footer += `<text x="${margin}" y="688" font-size="13" fill="#999">所有平台运行正常</text>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<rect width="${W}" height="${H}" fill="#ffffff"/>
<g font-family="${FONT}">
<text x="${margin}" y="50" font-size="28" font-weight="600" fill="#0a0a0a">AI 额度监控</text>
<text x="${W - margin}" y="50" text-anchor="end" font-size="16" fill="#666">${fmtDateTime(now)}</text>
${body}
${footer}
</g>
</svg>`;
}

module.exports = { buildSVG, W, H };
