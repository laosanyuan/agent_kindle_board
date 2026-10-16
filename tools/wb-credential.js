#!/usr/bin/env node
/**
 * WorkBuddy 凭证工具
 *
 * 提取 / 续期 www.workbuddy.cn 的登录 cookie、userId、userAgent，写进 config.yaml。
 *
 * ── 认证链路（2026-10-14 摸清，别再重复排查）────────────────────────────
 *   WorkBuddy Web 由 APISIX 的 openid-connect 插件守门：
 *     realm=copilot  client_id=console  scope="openid offline_access"
 *     redirect_uri=https://www.workbuddy.cn/console/accounts/.apisix/redirect
 *   插件把 token 加密后放在 **`session` cookie** 里，有效期**固定 7 天**
 *   （cookie 值尾部 `|<到期 unix 秒>|` 就是它的死线，不会因为访问而顺延）。
 *   到期后只能靠 Keycloak 的 SSO 会话静默换新，SSO 会话死了就必须人工登录一次。
 *   所以本工具做两件事：① 平时用轻量 HTTP 请求给 SSO 会话「保温」；
 *   ② 会话将到期时用无头浏览器走一遍静默 OIDC，拿到新的 session。
 *
 * ── 两个必须记住的坑 ────────────────────────────────────────────────────
 *   1. **UA 会被网关按 Chrome 大版本精确校验**：`Chrome/155` → 200，
 *      138/150/153/154/156/160 全部 401，而且报错伪装成「cookie 已失效」。
 *      更要命的是**无头浏览器的 UA 带 `HeadlessChrome`，必然被拒**，
 *      被拒后网关会给浏览器发一个匿名 session，把 profile 里的登录态**冲掉**。
 *      因此这里始终显式覆盖 userAgent（config.userAgent → 版本号推导）。
 *   2. Chrome 136 起禁止在**默认 profile 目录**开远程调试，所以本工具维护一个
 *      独立副本 profile（%LOCALAPPDATA%\agent-kindle-board\wbprofile），
 *      与你自己的 Chrome 完全隔离，**不需要关浏览器**。
 *
 * 用法：
 *   node tools/wb-credential.js               # 提取；未登录则弹窗让你登录一次
 *   node tools/wb-credential.js --refresh      # 非交互自动续期（计划任务用）
 *   node tools/wb-credential.js --refresh --push   # 续期成功后同步到 NAS 并重启容器
 *   node tools/wb-credential.js --print        # 只打印，不写配置
 *   node tools/wb-credential.js --headless     # 不弹窗（仅已登录 / 静默续期时可用）
 *   node tools/wb-credential.js --profile=<dir> / --fresh / --ua=<UA>
 *
 * 退出码：0 正常；2 需要人工登录（--refresh 下即「自动续期失败」）；1 其它错误。
 *
 * 依赖 playwright-core（不下载浏览器，用系统 Chrome）：
 *   npm i --no-save playwright-core
 */
const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const CFG = path.join(ROOT, 'config.yaml');
const LOG_DIR = path.join(ROOT, 'logs');

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f) => (argv.find((a) => a.startsWith(f + '=')) || '').split('=').slice(1).join('=');

const printOnly = has('--print');
const refreshMode = has('--refresh');
const pushAfter = has('--push');
const autoLogin = has('--auto-login');
const freshMode = has('--fresh');
const headlessMode = has('--headless') || refreshMode;
const profileArg = val('--profile');
const uaArg = val('--ua');
const waitSec = Number(val('--timeout') || (refreshMode ? 40 : 600));

// ---------- 状态文件：给计划任务节流，避免无脑重试 ----------
const STATE_FILE = () => path.join(LOG_DIR, 'wb-refresh.state.json');
const BROWSER_COOLDOWN = 6 * 3600e3;   // 静默续期最多每 6 小时试一次浏览器
const LOGIN_COOLDOWN = 24 * 3600e3;    // 自动弹出的登录窗最多每天一次
function readState() { try { return JSON.parse(fs.readFileSync(STATE_FILE(), 'utf8')); } catch { return {}; } }
function writeState(patch) {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.writeFileSync(STATE_FILE(), JSON.stringify({ ...readState(), ...patch }, null, 2));
  } catch { /* 无状态也能跑 */ }
}

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('缺少依赖：请先执行  npm i --no-save playwright-core');
  process.exit(1);
}

const ORIGIN = 'https://www.workbuddy.cn';
const REALM = 'copilot';
const REAL_UDD = path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'User Data');
const PERSIST_UDD = path.join(process.env.LOCALAPPDATA || '', 'agent-kindle-board', 'wbprofile');
const UDD = freshMode
  ? path.join(process.env.TEMP || '/tmp', 'wbprofile-fresh-' + Date.now())
  : profileArg || PERSIST_UDD;

const SEED_FILES = [
  'Local State',
  'Default/Preferences',
  'Default/Network/Cookies',
  'Default/Login Data',
  'Default/Web Data',
];

// ---------- 日志 ----------
const logLines = [];
function log(...a) {
  const s = a.join(' ');
  logLines.push(s);
  console.log(s);
}
function flushLog() {
  if (printOnly) return;
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, 'wb-refresh.log');
    const stamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(file, `[${stamp}] ${logLines.join('\n    ')}\n`);
    if (fs.statSync(file).size > 256 * 1024) {          // 简单轮转：留最后 ~64KB
      const buf = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, '（日志已轮转）\n' + buf.slice(-64 * 1024));
    }
  } catch { /* 日志写不进去不影响主流程 */ }
}

// ---------- config.yaml 读写 ----------
function wbBlock(text) {
  const lines = text.split('\n');
  const i = lines.findIndex((l) => l.trim() === 'workbuddy:' && l.startsWith(' '));
  if (i < 0) return null;
  const blk = [];
  for (const l of lines.slice(i + 1)) {
    if (l.trim() && !l.startsWith('    ')) break;
    blk.push(l);
  }
  return { start: i, block: blk.join('\n') };
}
function grab(block, key) {
  const m = new RegExp(key + ":\\s*'(.*)'").exec(block);
  return m ? m[1].replace(/''/g, "'") : '';
}
function loadCfg() {
  const text = fs.readFileSync(CFG, 'utf8');
  const b = wbBlock(text);
  if (!b) { console.error('config.yaml 里没有 workbuddy 配置块'); process.exit(1); }
  const cookie = grab(b.block, 'cookie');
  const map = {};
  for (const kv of cookie.split(/;\s*/)) {
    const j = kv.indexOf('=');
    if (j > 0) map[kv.slice(0, j).trim()] = kv.slice(j + 1);
  }
  return { text, cookie, map, userId: grab(b.block, 'userId'), userAgent: grab(b.block, 'userAgent') };
}
function saveCfg(text, cookie, userId, userAgent) {
  const re = /(  workbuddy:\n)(?:[^\n].*\n)*/;
  if (!re.test(text)) { console.error('config.yaml 里没有 workbuddy 配置块'); process.exit(1); }
  const block =
    '  workbuddy:\n' +
    '    enabled: true\n' +
    `    cookie: '${cookie.replace(/'/g, "''")}'\n` +
    `    userId: '${userId}'\n` +
    `    userAgent: '${userAgent.replace(/'/g, "''")}'\n`;
  fs.writeFileSync(CFG, text.replace(re, block));
  return text.replace(re, block);
}

// ---------- UA：必须显式覆盖（无头 UA 会被网关拒）----------
function chromeMajor() {
  try {
    const v = fs.readFileSync(path.join(UDD, 'Last Version'), 'utf8').trim();
    return v.split('.')[0] || '';
  } catch { return ''; }
}
function resolveUA(cfg) {
  if (uaArg) return uaArg;
  if (cfg.userAgent) return cfg.userAgent;
  if (process.env.WORKBUDDY_UA) return process.env.WORKBUDDY_UA;
  const maj = chromeMajor();
  if (maj) {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${maj}.0.0.0 Safari/537.36`;
  }
  return '';
}

// session cookie 值尾部 `|<unix 秒>|` 即到期时间
function sessionExpiry(cookieOrValue) {
  const m = /\|(\d{10})\|/.exec(cookieOrValue || '');
  return m ? Number(m[1]) * 1000 : null;
}
function humanLeft(ms) {
  if (!ms) return '未知';
  const d = (ms - Date.now()) / 86400000;
  return d > 0 ? `${d.toFixed(2)} 天` : '已过期';
}

// ---------- 轻量 HTTP：给 Keycloak SSO 会话保温 + 探静默续期 ----------
// prompt=none 时若 SSO 会话还活着，Keycloak 会 302 带 code 回来（全程无 UI）。
// ⚠️ 用 curl 而不是 fetch：Node 24 上 `await fetch()` 之后再 process.exit()
//    会在 Windows 上触发 libuv 断言（0xC0000409）崩溃 —— 计划任务里就是死在这。
function ssoKeepAlive(cookieHeader, ua) {
  const state = require('crypto').randomBytes(16).toString('hex');
  const redirect = encodeURIComponent(`${ORIGIN}/console/accounts/.apisix/redirect`);
  const url = `${ORIGIN}/auth/realms/${REALM}/protocol/openid-connect/auth` +
    `?response_type=code&client_id=console&scope=openid%20offline_access&prompt=none` +
    `&state=${state}&redirect_uri=${redirect}`;
  try {
    const r = spawnSync('curl', ['-4', '-sS', '-o', '/dev/null', '-D', '-', '--max-time', '20',
      '-A', ua, '-H', `Cookie: ${cookieHeader}`, url], { encoding: 'utf8', timeout: 30000 });
    const out = (r.stdout || '') + (r.stderr || '');
    const loc = (out.split('\n').find((l) => /^location:/i.test(l)) || '').trim();
    if (/[?&]code=/.test(loc)) return { code: true, loc };
    const err = /error=([a-z_]+)/.exec(loc);
    return { code: false, error: err ? err[1] : (loc ? 'no code' : `curl rc=${r.status}`) };
  } catch (e) {
    return { code: false, error: e.message };
  }
}

// ---------- 浏览器 ----------
function chromeRunning() {
  try {
    return execFileSync('tasklist', ['/FI', 'IMAGENAME eq chrome.exe', '/NH'], { encoding: 'utf8' })
      .toLowerCase().includes('chrome.exe');
  } catch { return false; }
}
function seedIfNeeded() {
  if (freshMode) return;
  if (fs.existsSync(path.join(UDD, 'Local State'))) return;
  if (!fs.existsSync(REAL_UDD)) { log('（未发现 Chrome 用户数据目录，跳过种子）'); return; }
  let copied = 0;
  for (const rel of SEED_FILES) {
    try {
      const dst = path.join(UDD, rel);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(path.join(REAL_UDD, rel), dst);
      copied++;
    } catch { /* 被锁 / 不存在，忽略 */ }
  }
  if (copied) log(`已从你的 Chrome 复制 ${copied} 个种子文件到副本 profile`);
  else if (chromeRunning()) log('（Chrome 正在运行导致文件被锁，副本将作为全新 profile 起步）');
}

async function launch(headless, ua) {
  const opts = {
    channel: 'chrome',
    headless,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble', '--disable-gpu'],
  };
  // ★ 必须覆盖 UA：无头 Chrome 的 UA 带 HeadlessChrome，会被网关拒 + 冲掉登录态
  if (ua) opts.userAgent = ua;
  return Promise.race([
    chromium.launchPersistentContext(UDD, opts),
    new Promise((_, rej) => setTimeout(() => rej(new Error('浏览器启动超时(45s)')), 45000)),
  ]);
}

async function safeClose(ctx, ms = 5000) {
  await Promise.race([ctx.close().catch(() => {}), new Promise((r) => setTimeout(r, ms))]);
}

// 静默续期失败时的收尾：计划任务可以自动弹一次登录窗；否则只留状态说明。
async function needLogin(ctx) {
  log('未检测到登录态：静默续期没成功（Keycloak SSO 会话已失效）。');
  const st = readState();
  if (autoLogin && Date.now() - (st.lastLoginPrompt || 0) > LOGIN_COOLDOWN) {
    writeState({ lastLoginPrompt: Date.now() });
    log('→ 自动打开登录窗口，请在弹出的 Chrome 窗口里扫码登录（最长 10 分钟）');
    await safeClose(ctx);
    const r = spawnSync(process.execPath, [__filename, '--push'], { stdio: 'inherit', timeout: 660000 });
    flushLog();
    process.exit(r.status === 0 ? 0 : 2);
  }
  writeState({ needsLogin: true, needsLoginAt: Date.now() });
  log('需要人工登录：运行  node tools/wb-credential.js  在弹出窗口里扫码一次。');
  log('（可先看 logs/wb-refresh.log 确认是「静默续期失败」而不是网络/网关问题）');
  flushLog();
  await safeClose(ctx);
  process.exit(2);
}

// 把 config 里的 cookie 注入浏览器，保证无论副本 profile 自身状态如何，都从已知可用会话起步
async function injectCookies(cdp, map) {
  let n = 0;
  for (const [name, value] of Object.entries(map)) {
    if (!value) continue;
    const url = name === 'KEYCLOAK_SESSION' ? `${ORIGIN}/auth/realms/${REALM}/` : `${ORIGIN}/`;
    try {
      await cdp.send('Network.setCookie', {
        name, value, url, secure: true,
        httpOnly: name === 'session' || name === 'session_2' || name === 'KEYCLOAK_IDENTITY',
        expires: Math.floor(Date.now() / 1000) + 7 * 86400,
      });
      n++;
    } catch { /* 个别 cookie 注不进去不影响 */ }
  }
  return n;
}

// 已登录判据：/console/accounts 返回 JSON（未登录会拿到 Keycloak 登录页 HTML）
async function probe(page, uid) {
  return page.evaluate(async (uid) => {
    const out = { accounts: null, billing: null, body: '' };
    try {
      const r = await fetch('/console/accounts', { credentials: 'include' });
      const t = await r.text();
      out.accounts = r.status;
      if (r.status === 200 && t.trim().startsWith('{')) {
        try { out.uid = (JSON.parse(t).data?.accounts || []).find((a) => a.lastLogin)?.uid || JSON.parse(t).data?.accounts?.[0]?.uid || ''; } catch {}
      }
    } catch (e) { out.accounts = 'err:' + e.message; }
    try {
      const r = await fetch('/billing/meter/get-user-resource-summary', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-User-Id': uid }, body: '{}',
      });
      const t = await r.text();
      out.billing = r.status;
      out.body = t.slice(0, 120).replace(/\s+/g, ' ');
      try { out.code = JSON.parse(t).code; } catch {}
    } catch (e) { out.billing = 'err:' + e.message; }
    return out;
  }, uid).catch((e) => ({ accounts: 'err:' + e.message, billing: 'err:' + e.message }));
}

// 只保留真正参与认证的 cookie：网关认 `session`/`session_2`，静默续期要 `KEYCLOAK_SESSION`，
// 其余（统计、tgw_l7_route 之类）每次都变，留着会让配置无谓地抖动。
const KEEP = ['session', 'session_2', 'KEYCLOAK_SESSION', 'KEYCLOAK_IDENTITY'];

async function collect(ctx, page) {
  const cdp = await ctx.newCDPSession(page);
  const { cookies } = await cdp.send('Network.getAllCookies');
  // 同名 cookie 可能因域/路径不同存在多份（注入的 + profile 原有的），
  // 取「值最长」的那份 —— 真正的登录态一定比空值/占位长。
  const best = new Map();
  for (const c of cookies) {
    if (!/workbuddy\.cn$/.test(c.domain)) continue;
    const prev = best.get(c.name);
    if (!prev || (c.value || '').length > (prev.value || '').length) best.set(c.name, c);
  }
  const names = best.has('session') ? KEEP.filter((n) => best.has(n)) : [...best.keys()];  // 兜底：拿不到 session 就全留
  const header = names.map((n) => `${n}=${best.get(n).value}`).join('; ');
  const userAgent = await page.evaluate(() => navigator.userAgent).catch(() => '');
  return { header, userAgent };
}

// ---------- 主流程 ----------
(async () => {
  const cfg = loadCfg();
  const ua = resolveUA(cfg);
  let needBrowser =
    has('--force') ||                                      // 强制走浏览器（自检用）
    !refreshMode ||                                        // 交互模式：总是开浏览器
    sessionExpiry(cfg.map.session) === null ||             // 拿不到到期时间
    sessionExpiry(cfg.map.session) - Date.now() < 2 * 86400e3; // 不到 2 天 → 该续期了

  // 计划任务每 10 分钟跑一次，但浏览器不必每 10 分钟开一次 —— 节流
  if (refreshMode && needBrowser && !printOnly && !has('--force')) {
    const last = readState().lastBrowserAttempt || 0;
    if (Date.now() - last < BROWSER_COOLDOWN) {
      log(`距上次浏览器续期尝试 ${((Date.now() - last) / 3600e3).toFixed(1)}h（节流 ${BROWSER_COOLDOWN / 3600e3}h），本次跳过`);
      needBrowser = false;
    } else {
      writeState({ lastBrowserAttempt: Date.now() });
    }
  }

  log(`模式=${refreshMode ? 'refresh' : 'interactive'} profile=${UDD}`);

  if (refreshMode && !printOnly) {
    // ① 先花 1 秒给 Keycloak SSO 会话保温（顺带探测静默续期是否可用）
    const ka = ssoKeepAlive(cfg.cookie, ua);
    log(ka.code
      ? 'SSO 保温：✓ 静默续期可用（拿到 code）'
      : `SSO 保温：✗ ${ka.error}（SSO 会话不在，届时需要登录一次）`);
    if (!needBrowser) {
      log(`不需要续期：session 剩余 ${humanLeft(sessionExpiry(cfg.map.session))}，本次跳过浏览器`);
      flushLog();
      process.exit(0);
    }
    log(`session 剩余 ${humanLeft(sessionExpiry(cfg.map.session))} → 走静默续期`);
  }

  seedIfNeeded();
  const ctx = await launch(headlessMode, ua);
  const page = ctx.pages()[0] || (await ctx.newPage());

  // ② 注入现有 cookie：副本 profile 可能已被匿名 session 覆盖，注入保证从可用会话起步。
  //    先清空（这个 profile 只存 workbuddy 的 cookie），避免同名 cookie 堆成多份。
  const cdp0 = await ctx.newCDPSession(page);
  await cdp0.send('Network.clearBrowserCookies').catch(() => {});
  const injected = await injectCookies(cdp0, cfg.map);
  log(`已注入 ${injected} 个 cookie（含 session=${cfg.map.session ? 'yes' : 'no'}）`);

  await page.goto(`${ORIGIN}/app`, { waitUntil: 'domcontentloaded', timeout: 30000 })
    .catch((e) => log('  goto: ' + e.message));
  await page.waitForTimeout(4000);

  log('检测登录状态...');
  let st = await probe(page, cfg.userId);
  log(`  /console/accounts -> ${st.accounts}；billing -> ${st.billing} ${st.body || ''}`);

  const loggedIn = () => st.accounts === 200 && st.billing === 200 && (st.code === 0 || st.code === undefined);

  if (!loggedIn()) {
    if (headlessMode) {
      await needLogin(ctx);
      return;
    }
    log(`未检测到登录态 —— 已打开浏览器窗口，请完成登录（最长等 ${waitSec}s）。`);
    const deadline = Date.now() + waitSec * 1000;
    while (Date.now() < deadline && !loggedIn()) {
      await page.waitForTimeout(5000).catch(() => {});
      st = await probe(page, cfg.userId);
    }
  }

  if (!loggedIn()) {
    log('超时：未检测到登录成功。');
    flushLog();
    await safeClose(ctx);
    process.exit(2);
  }

  const uid = st.uid || cfg.userId;
  log(`已登录 ✓ userId=${uid}`);

  const { header, userAgent } = await collect(ctx, page);
  const newUA = userAgent || ua;
  const newExp = sessionExpiry(header);
  const oldExp = sessionExpiry(cfg.map.session);
  const same = header === cfg.cookie;

  log(`session 到期：${newExp ? new Date(newExp).toISOString() : '未知'}（${humanLeft(newExp)}）`);
  log(same ? '会话值未变（仍在有效期内）' : '已拿到新的会话 cookie');

  if (printOnly) {
    log('\n--- 填入 config.yaml 的 platforms.workbuddy ---');
    log(`cookie: '${header.replace(/'/g, "''")}'`);
    log(`userId: '${uid}'`);
    log(`userAgent: '${newUA.replace(/'/g, "''")}'`);
  } else {
    saveCfg(cfg.text, header, uid, newUA);
    log(`已更新 ${CFG}（cookie ${header.length} 字符，UA=${newUA.slice(-32)}）`);
    writeState({ needsLogin: false, okAt: Date.now(), expiresAt: newExp });
    if (pushAfter && !same) syncToNas();
    else if (pushAfter) log('会话未变，跳过 NAS 同步');
  }

  flushLog();
  await safeClose(ctx);
  process.exit(0);
})().catch((e) => { log('ERR ' + (e && e.message)); flushLog(); process.exit(1); });

// ---------- 同步到 NAS ----------
function syncToNas() {
  const py = [
    path.join(process.env.USERPROFILE || '', '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe'),
    'python',
  ].find((p) => { try { return spawnSync(p, ['-c', 'import paramiko'], { stdio: 'ignore' }).status === 0; } catch { return false; } });
  if (!py) { log('⚠ 未找到带 paramiko 的 python，跳过 NAS 同步（手动执行 tools/_nas_put_chunked.py）'); return; }
  const steps = [
    [path.join(__dirname, '_nas_put_chunked.py'), [CFG, '/volume1/docker/agent_kindle_board/config.yaml']],
    [path.join(__dirname, '_nas_sudo.py'), ['docker restart agent-kindle-board']],
  ];
  for (const [script, args] of steps) {
    if (!fs.existsSync(script)) { log(`⚠ 缺少 ${path.basename(script)}，跳过`); return; }
    const r = spawnSync(py, [script, ...args], { encoding: 'utf8', timeout: 300000 });
    const tail = ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-2).join(' | ');
    log(`  ${path.basename(script)} rc=${r.status} ${tail.slice(0, 200)}`);
    if (r.status !== 0) { log('⚠ NAS 同步中断'); return; }
  }
  log('NAS 已同步并重启容器 agent-kindle-board');
}
