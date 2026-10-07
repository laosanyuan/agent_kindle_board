// 出网层：可选代理 + curl 回退
//
// 为什么需要 curl：
//   Cloudflare 会按 TLS 指纹（JA3）拦机器请求。Node 的 undici 指纹访问 chatgpt.com
//   会被 403 challenge，而 curl 的指纹可以正常通过（实测同一代理出口下 curl 200、undici 403）。
//   因此「配了代理的请求」一律走 curl；没配代理时仍用 undici（保持轻量）。
//
// config.yaml：
//   proxy:
//     url: "http://192.168.1.20:10809"   # v2ray / clash 的 HTTP 入站（不支持 socks5://）
//     applyTo: [chatgpt]                 # 只对这些平台生效；省略或空数组 = 全部
// 环境变量 PROXY_URL 可覆盖 url。
const { execFile, execFileSync } = require('child_process');
const { fetch: undiciFetch, ProxyAgent } = require('undici');

let cfgProxy = null;
const agents = new Map();
let curlOk = null; // null=未检测，true/false=检测结果

function initProxy(cfg) {
  cfgProxy = (cfg && cfg.proxy) || null;
}

function proxyUrl() {
  return (cfgProxy && cfgProxy.url) || process.env.PROXY_URL || '';
}

function dispatcherFor(platformId) {
  const url = proxyUrl();
  if (!url) return undefined;
  const applyTo = cfgProxy && Array.isArray(cfgProxy.applyTo) ? cfgProxy.applyTo : null;
  if (applyTo && applyTo.length && platformId && !applyTo.includes(platformId)) return undefined;
  if (!agents.has(url)) agents.set(url, new ProxyAgent({ uri: url, connectTimeout: 15000 }));
  return agents.get(url);
}

function hasCurl() {
  if (curlOk !== null) return curlOk;
  try {
    execFileSync('curl', ['--version'], { stdio: 'ignore', timeout: 5000 });
    curlOk = true;
  } catch {
    curlOk = false;
  }
  return curlOk;
}

// curl 请求，返回最小 Response 兼容对象（ok/status/text()/json()）
function curlRequest(url, opts, proxy, timeoutMs) {
  return new Promise((resolve, reject) => {
    const args = ['-s', '-S', '--compressed', '--max-time', String(Math.ceil(timeoutMs / 1000)),
      '-w', '\n%{http_code}'];
    if (proxy) args.push('-x', proxy);
    const method = String(opts.method || 'GET').toUpperCase();
    if (method !== 'GET') args.push('-X', method);
    for (const [k, v] of Object.entries(opts.headers || {})) {
      if (v == null) continue;
      args.push('-H', `${k}: ${v}`);
    }
    if (opts.body != null) args.push('--data-binary', String(opts.body));
    args.push(url);

    execFile('curl', args, { maxBuffer: 8 * 1024 * 1024, timeout: timeoutMs + 8000 }, (err, stdout, stderr) => {
      if (err && !stdout) return reject(new Error(`curl 失败: ${err.message || stderr}`));
      const m = /(\d{3})\s*$/.exec(String(stdout));
      const status = m ? Number(m[1]) : 0;
      const body = m ? String(stdout).slice(0, m.index) : String(stdout);
      resolve({
        ok: status >= 200 && status < 300,
        status,
        text: async () => body,
        json: async () => JSON.parse(body),
      });
    });
  });
}

// provider 统一入口：行为与 fetch 一致（res.ok / res.status / res.json()）
async function httpFetch(url, opts = {}, platformId = null) {
  const proxy = proxyUrl();
  const useProxy = !!proxy && (!platformId || !!dispatcherFor(platformId));
  if (useProxy && hasCurl()) {
    const timeoutMs = 20000;
    try {
      return await curlRequest(url, opts, proxy, timeoutMs);
    } catch (e) {
      // curl 不可用时回退 undici
      if (!hasCurl()) return undiciFetch(url, dispatcherFor(platformId) ? { ...opts, dispatcher: dispatcherFor(platformId) } : opts);
      throw e;
    }
  }
  const dispatcher = useProxy ? dispatcherFor(platformId) : undefined;
  return undiciFetch(url, dispatcher ? { ...opts, dispatcher } : opts);
}

module.exports = { initProxy, httpFetch, dispatcherFor };
