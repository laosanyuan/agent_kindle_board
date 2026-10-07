#!/usr/bin/env node
/**
 * WorkBuddy 凭证提取工具
 *
 * 打开一个浏览器窗口 -> 你登录 WorkBuddy -> 自动提取 cookie 和 userId，
 * 直接写进 config.yaml（或用 --print 只打印）。
 *
 * 用法：
 *   node tools/wb-credential.js            # 登录后自动更新 ../config.yaml
 *   node tools/wb-credential.js --print    # 只打印，不改配置文件
 *
 * 依赖 playwright-core（不需要下载浏览器，用系统 Chrome）：
 *   npm i --no-save playwright-core
 *
 * cookie 过期时（面板显示「cookie 已失效」）重跑一次即可。
 */
const fs = require('fs');
const path = require('path');

const CFG = path.join(__dirname, '..', 'config.yaml');
const printOnly = process.argv.includes('--print');

let chromium;
try {
  ({ chromium } = require('playwright-core'));
} catch {
  console.error('缺少依赖：请先执行  npm i --no-save playwright-core');
  process.exit(1);
}

(async () => {
  console.log('启动浏览器（用系统 Chrome，无痕目录），请在其中登录 workbuddy.cn ...');
  const browser = await chromium.launch({ channel: 'chrome', headless: false, args: ['--no-first-run'] });
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  await page.goto('https://www.workbuddy.cn/app', { waitUntil: 'domcontentloaded' });

  // 轮询等登录成功：/billing/meter/get-user-resource-summary 返回 200
  console.log('等待登录完成（最长 10 分钟）...');
  let ok = false;
  for (let i = 0; i < 200; i++) {
    await page.waitForTimeout(3000);
    const st = await page.evaluate(async () => {
      try {
        const r = await fetch('/billing/meter/get-user-resource-summary', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' }, body: '{}',
        });
        return r.status;
      } catch { return 0; }
    }).catch(() => 0);
    if (st === 200) { ok = true; break; }
    if (i > 0 && i % 10 === 0) console.log('  仍在等待登录...');
  }
  if (!ok) { console.error('超时：10 分钟内未检测到登录成功'); await browser.close(); process.exit(2); }

  // CDP 取 cookie（含 httpOnly）
  const cdp = await ctx.newCDPSession(page);
  const { cookies } = await cdp.send('Network.getAllCookies');
  const header = cookies.filter((c) => /workbuddy\.cn$/.test(c.domain)).map((c) => `${c.name}=${c.value}`).join('; ');

  // userId
  const res = await page.evaluate(async () => {
    const r = await fetch('/console/accounts', { credentials: 'include' });
    return r.json();
  }).catch(() => null);
  const accounts = res?.data?.accounts || [];
  const cur = accounts.find((a) => a.lastLogin) || accounts[0];
  const userId = cur?.uid || '';

  if (printOnly) {
    console.log('\n--- 填入 config.yaml 的 platforms.workbuddy ---');
    console.log(`cookie: '${header.replace(/'/g, "''")}'`);
    console.log(`userId: '${userId}'`);
  } else {
    let cfg = fs.readFileSync(CFG, 'utf8');
    const wbRe = /(  workbuddy:\n)(?:[^\n].*\n)*/;
    if (!wbRe.test(cfg)) { console.error('config.yaml 里没有 workbuddy 配置块'); await browser.close(); process.exit(1); }
    const block =
      '  workbuddy:\n' +
      `    enabled: true\n` +
      `    cookie: '${header.replace(/'/g, "''")}'\n` +
      `    userId: '${userId}'\n`;
    cfg = cfg.replace(wbRe, block);
    fs.writeFileSync(CFG, cfg);
    console.log(`\n已更新 ${CFG}（cookie ${header.length} 字符，userId=${userId}）`);
    console.log('重启服务生效：docker compose restart 或 node src/index.js');
  }
  await browser.close();
  process.exit(0);
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
