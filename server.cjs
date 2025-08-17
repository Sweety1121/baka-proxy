// server.cjs —— 8080 端口；优先轻量抓取 + 自动解压，遇到 CF/异常再用 Puppeteer（走 SOCKS）兜底；带内存缓存；图片支持 /img 和 /img-auto
const express = require('express');
const zlib = require('zlib');
const fetch = require('node-fetch');            // 建议 node-fetch@2
const puppeteer = require('puppeteer-extra');
try { puppeteer.use(require('puppeteer-extra-plugin-stealth')()); } catch (_) {}

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const SOCKS_PROXY = process.env.SOCKS_PROXY || 'socks5://127.0.0.1:7890';
const PORT        = Number(process.env.PORT || 8080);

const DEFAULT_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const BASE_REFERER = 'https://bakamh.com/';
const ACCEPT_HTML  = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const ACCEPT_IMG   = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';

// —— 简单内存缓存（HTML: 45秒；图片: 5分钟）
const cache = new Map();
function setCache(key, value, ttlMs) { cache.set(key, { value, exp: Date.now()+ttlMs }); }
function getCache(key) {
  const it = cache.get(key);
  if (!it) return null;
  if (Date.now() > it.exp) { cache.delete(key); return null; }
  return it.value;
}

// —— 轻量抓取 + 自动解压
async function fetchDecompress(url, headers = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'User-Agent': DEFAULT_UA,
      'Accept': headers.Accept || ACCEPT_HTML,
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Referer': headers.Referer || BASE_REFERER,
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Accept-Encoding': 'gzip, deflate, br',
      ...(headers || {}),
    },
  });
  const buf = Buffer.from(await res.arrayBuffer());
  const enc = (res.headers.get('content-encoding') || '').toLowerCase();
  let body;
  try {
    if (enc.includes('br')) body = zlib.brotliDecompressSync(buf).toString('utf8');
    else if (enc.includes('gzip')) body = zlib.gunzipSync(buf).toString('utf8');
    else if (enc.includes('deflate')) body = zlib.inflateSync(buf).toString('utf8');
    else body = buf.toString('utf8');
  } catch {
    // 解压失败就按原样给 Buffer
    body = buf;
  }
  return { status: res.status, headers: res.headers, body };
}

function looksLikeChallenge(status, text) {
  if (status >= 400) return true;
  if (!text || typeof text !== 'string') return false;
  return /cloudflare|attention required|checking your browser/i.test(text)
      || /<title>\s*Just a moment\s*<\/title>/i.test(text);
}

// —— Puppeteer（走 SOCKS）兜底
async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox', `--proxy-server=${SOCKS_PROXY}`],
  });
  try { return await fn(browser); } finally { try { await browser.close(); } catch {} }
}

// —— Express
const app = express();
app.use((_, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  next();
});
app.get('/ping', (_,res)=>res.send('pong'));

// 1) HTML：先轻抓 + 解压；遇到挑战/异常再用 headless 渲染
app.get('/html', async (req, res) => {
  const raw = req.query.url;
  if (!raw) return res.status(400).send('url is required');
  const target = String(raw);

  const key = 'HTML:' + target;
  const cached = getCache(key);
  if (cached) { res.type('html').send(cached); return; }

  try {
    // 轻抓
    const { status, body, headers } = await fetchDecompress(target, { Accept: ACCEPT_HTML, Referer: req.query.referer || BASE_REFERER, 'User-Agent': req.query.ua || DEFAULT_UA });
    let html = typeof body === 'string' ? body : body.toString('utf8');

    // 可疑就兜底渲染
    if (looksLikeChallenge(status, html) || (headers.get('content-type')||'').includes('text/html') === false) {
      const rendered = await withBrowser(async (browser) => {
        const page = await browser.newPage();
        await page.setUserAgent(req.query.ua || DEFAULT_UA);
        await page.setExtraHTTPHeaders({ 'Referer': req.query.referer || BASE_REFERER, 'Accept-Language': 'zh-CN,zh;q=0.9' });
        await page.setViewport({ width: 1366, height: 824 });
        await page.goto(target, { waitUntil: 'networkidle2', timeout: 60000 });
        // 搜索页/详情页等，给点时间
        await page.waitForTimeout(1500);
        return await page.content();
      });
      html = rendered;
    }

    setCache(key, html, 45 * 1000); // 45 秒
    res.set('Content-Type','text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send('fetch error: ' + (e?.message || String(e)));
  }
});

// 2) 图片直链代理（旧接口，保持兼容）/img?url=
app.get('/img', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('url required');

  const key = 'IMG:' + target;
  const cached = getCache(key);
  if (cached) {
    res.set('Content-Type', cached.type || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=300');
    return res.send(cached.buf);
  }

  try {
    // 先轻抓（带 Referer/UA）
    const { status, headers, body } = await fetchDecompress(target, { Accept: ACCEPT_IMG, Referer: BASE_REFERER });
    let ok = status >= 200 && status < 300;
    let type = headers.get('content-type') || '';
    let buf  = Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8');

    // 如果不是图片或失败，再兜底 headless
    if (!ok || !/^image\//i.test(type)) {
      const out = await withBrowser(async (browser) => {
        const page = await browser.newPage();
        await page.setUserAgent(DEFAULT_UA);
        await page.setExtraHTTPHeaders({ Referer: BASE_REFERER, 'Accept-Language': 'zh-CN,zh;q=0.9' });
        const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (!resp) throw new Error('no response');
        const h = resp.headers();
        const b = await resp.buffer();
        return { type: h['content-type'] || 'image/jpeg', buf: b };
      });
      type = out.type;
      buf  = out.buf;
    }

    setCache(key, { type, buf }, 5 * 60 * 1000); // 5 分钟
    res.set('Content-Type', type || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=300');
    res.send(buf);
  } catch (e) {
    res.status(500).send('img error: ' + (e?.message || String(e)));
  }
});

// 3) 新的图片接口（推荐）：/img-auto?url=（和上面一致，只是路径名更清晰）
app.get('/img-auto', async (req, res) => {
  req.url = '/img?' + require('url').parse(req.url).query; // 复用 /img 逻辑
  app._router.handle(req, res);
});

// 启动
app.listen(PORT, () => {
  console.log(`Server listening on http://127.0.0.1:${PORT}`);
  console.log('Using CHROME_PATH=' + CHROME_PATH + '  SOCKS_PROXY=' + SOCKS_PROXY);
});
