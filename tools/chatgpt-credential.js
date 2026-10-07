#!/usr/bin/env node
/**
 * ChatGPT 凭证提取工具
 *
 * 推荐流程（--real）：复制日常 Chrome 的登录态到临时 profile -> 挂载打开 ChatGPT
 * （真实浏览器指纹，可过 Cloudflare）-> 已登录则直接提取，过期则在窗口里登录一次
 * -> 抓 cookie 写进 config.yaml。同时探测 /backend-api/wham/usage 的真实结构。
 *
 * 用法：
 *   node tools/chatgpt-credential.js --real     # 推荐：用日常 Chrome 的登录态
 *   node tools/chatgpt-credential.js            # 全新独立 profile，手动登录（易被 Cloudflare 卡）
 *   node tools/chatgpt-credential.js --print    # 只打印，不改配置文件
 *
 * 依赖 playwright-core（用系统 Chrome，无需下载浏览器）：
 *   npm i --no-save playwright-core
 *
 * 注意：
 *   1. 跑之前清掉代理环境变量，否则连不上本机 CDP：
 *      ( unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY all_proxy ALL_PROXY; node tools/chatgpt-credential.js --real )
 *   2. --real 模式需要先关闭所有 Chrome 窗口（Cookies 数据库被 Chrome 独占锁定）。
 *
 * cookie 过期时（面板显示「Cookie 已过期」）重跑一次即可。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const CFG = path.join(__dirname, '..', 'config.yaml');
const PROFILE_NEW = path.join(__dirname, '..', '.chrome-profile-chatgpt');
const PROFILE_REAL = path.join(__dirname, '..', '.chrome-profile-real');
const useReal = process.argv.includes('--real');
const printOnly = process.argv.includes('--print');
const PROFILE = useReal ? PROFILE_REAL : PROFILE_NEW;

const PROBE_URLS = ['/backend-api/wham/usage'];

// 在页面里跑：确认登录态 + 探测额度接口
async function probe(page) {
  return page.evaluate(async (urls) => {
    const out = {};
    const sess = await fetch('/api/auth/session', { credentials: 'include' })
      .then((r) => r.json()).catch(() => null);
    const token = sess && sess.accessToken;
    out.sessionOk = !!token;
    out.user = sess?.user?.email || sess?.user?.name || null;

    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    out.probes = {};
    for (const u of urls) {
      try {
        const r = await fetch(u, { credentials: 'include', headers });
        out.probes[u] = { status: r.status, body: (await r.text()).slice(0, 900) };
      } catch (e) {
        out.probes[u] = { error: String(e) };
      }
    }
    return out;
  }, PROBE_URLS);
}

function copyRealProfile() {
  const src = path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data');
  const dst = PROFILE_REAL;
  fs.mkdirSync(path.join(dst, 'Default', 'Network'), { recursive: true });
  fs.copyFileSync(path.join(src, 'Local State'), path.join(dst, 'Local State'));
  fs.copyFileSync(path.join(src, 'Default', 'Network', 'Cookies'), path.join(dst, 'Default', 'Network', 'Cookies'));
}

function replaceBlock(cfg, key, block) {
  const lines = cfg.split('\n');
  const start = lines.findIndex((l) => new RegExp(`^  ${key}:\\s*$`).test(l));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^\s{2}\S/.test(lines[end])) end++;
  return [...lines.slice(0, start), ...block.replace(/\n$/, '').split('\n'), ...lines.slice(end)].join('\n');
}

(async () => {
  if (useReal) {
    try {
      console.log('复制日常 Chrome 登录态（需要 Chrome 已全部关闭）...');
      copyRealProfile();
      console.log('复制完成');
    } catch (e) {
      console.error('复制失败：' + e.message);
      console.error('请先关闭所有 Chrome 窗口再运行（Cookies 数据库被 Chrome 独占锁定）。');
      process.exit(1);
    }
  }

  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    console.error('缺少依赖：请先执行  npm i --no-save playwright-core');
    process.exit(1);
  }

  console.log('启动浏览器（系统 Chrome），请在其中登录 chatgpt.com ...');
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chrome',
    headless: false,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  if (!page.url().includes('chatgpt.com')) {
    await page.goto('https://chatgpt.com/', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  }

  console.log('等待登录完成（最长 15 分钟）...');
  let info = null;
  for (let i = 0; i < 300; i++) {
    await page.waitForTimeout(3000);
    const p = await probe(page).catch(() => null);
    if (p && p.sessionOk) { info = p; break; }
    if (i > 0 && i % 10 === 0) console.log('  仍在等待登录...（若卡在 Cloudflare 验证，请在窗口里手动点一下）');
  }
  if (!info) {
    console.error('超时：15 分钟内未检测到登录成功');
    await ctx.close();
    process.exit(2);
  }

  console.log(`\n已登录：${info.user || '(未知用户)'}`);
  console.log('\n--- 额度接口探测结果 ---');
  for (const [u, r] of Object.entries(info.probes)) {
    console.log(`${u} -> ${r.status ?? r.error}`);
    if (r.body) console.log('   ' + r.body.replace(/\s+/g, ' ').slice(0, 400));
  }

  const cdp = await ctx.newCDPSession(page);
  const { cookies } = await cdp.send('Network.getAllCookies');
  const header = cookies
    .filter((c) => /(^|\.)(chatgpt|openai)\.com$/.test(c.domain))
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');
  if (!header) {
    console.error('未取到 chatgpt.com 的 cookie');
    await ctx.close();
    process.exit(1);
  }

  if (printOnly) {
    console.log('\n--- 填入 config.yaml 的 platforms.chatgpt ---');
    console.log(`cookie: '${header.replace(/'/g, "''")}'`);
  } else {
    const cfg = fs.readFileSync(CFG, 'utf8');
    const block =
      '  chatgpt:\n' +
      '    enabled: true\n' +
      `    cookie: '${header.replace(/'/g, "''")}'\n`;
    const next = replaceBlock(cfg, 'chatgpt', block);
    if (next == null) {
      console.error('config.yaml 里没有 chatgpt 配置块');
      await ctx.close();
      process.exit(1);
    }
    fs.writeFileSync(CFG, next);
    console.log(`\n已更新 ${CFG}（cookie ${header.length} 字符）`);
    console.log('重启服务生效：docker compose restart 或 node src/index.js');
  }
  await ctx.close();

  // 清理含登录态的 profile 副本，避免泄露
  try {
    fs.rmSync(PROFILE, { recursive: true, force: true });
    console.log('已清理临时 profile（含登录态）');
  } catch {}

  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
