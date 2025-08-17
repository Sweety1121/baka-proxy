bakadir=/root/baka-proxy && \
cp -a "$bakadir/server.cjs" "$bakadir/server.cjs.bak.$(date +%F-%H%M%S)" 2>/dev/null || true && \
cat > "$bakadir/server.cjs" <<'JS'
/* server.cjs —— 8080 端口；优先轻量拉取(自动解压)；遇到CF/异常再Puppeteer兜底；带内存缓存；图片支持 /img 与 /img-auto */
const express = require('express');
const zlib = require('zlib');
const fetch = require('node-fetch');            // 建议 node-fetch@2
const puppeteer = require('puppeteer-extra');
try { puppeteer.use(require('puppeteer-extra-plugin-stealth')()); } catch (_) {}

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const SOCKS_PROXY = process.env.SOCKS_PROXY || 'socks5://127.0.0.1:7890';
const PORT        = Number(process.env.PORT || 8080);

const DEFAULT_UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const BASE_REFERER = 'https://bakamh.com/';
const ACCEPT_HTML  = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const ACCEPT_IMG   = 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8';

// —— 简易内存缓存（HTML 45s；图片 5min）
const cache = new Map();
function setCache(k, v, ttl){ cache.set(k, {v, exp: Date.now()+ttl}); }
function getCache(k){
  const it = cache.get(k); if(!it) return null;
  if(Date.now()>it.exp){ cache.delete(k); return null; }
  return it.v;
}

// —— 轻量拉取 + 自动解压（返回 {status, headers, body(字符串或Buffer)}）
async function fetchDecompress(url, headers = {}) {
  const h = {
    'User-Agent': headers['User-Agent'] || DEFAULT_UA,
    'Accept': headers['Accept'] || ACCEPT_HTML,
    'Accept-Language': headers['Accept-Language'] || 'zh-CN,zh;q=0.9',
    'Referer': headers['Referer'] || BASE_REFERER,
    'Cache-Control': 'no-cache',
    'Pragma': 'no-cache',
    'Accept-Encoding': 'gzip, deflate, br',
    ...headers,
  };
  const res = await fetch(url, { redirect: 'follow', headers: h });
  const buf = Buffer.from(await res.arrayBuffer());
  const enc = (res.headers.get('content-encoding') || '').toLowerCase();
  const ctype = (res.headers.get('content-type') || '').toLowerCase();
  let body;

  // 如果是图片/二进制，直接按 Buffer 返回（不转字符串，防止损坏）
  const wantBinary = h.Accept && h.Accept.startsWith('image/');
  const isBinaryCT = ctype && !ctype.includes('text') && !ctype.includes('json') && !ctype.includes('xml');

  if (wantBinary || isBinaryCT) {
    // 对图片等，按编码解压后保留Buffer
    if (enc.includes('br')) body = zlib.brotliDecompressSync(buf);
    else if (enc.includes('gzip')) body = zlib.gunzipSync(buf);
    else if (enc.includes('deflate')) body = zlib.inflateSync(buf);
    else body = buf;
  } else {
    // 文本
    let tmp = buf;
    if (enc.includes('br')) tmp = zlib.brotliDecompressSync(buf);
    else if (enc.includes('gzip')) tmp = zlib.gunzipSync(buf);
    else if (enc.includes('deflate')) tmp = zlib.inflateSync(buf);
    body = tmp.toString('utf8');
  }
  return { status: res.status, headers: res.headers, body };
}

function looksLikeChallenge(status, text) {
  if (status >= 400) return true;
  if (Buffer.isBuffer(text)) return false;
  if (!text || typeof text !== 'string') return false;
  return /cloudflare|attention required|checking your browser/i.test(text)
      || /<title>\s*Just a moment\s*<\/title>/i.test(text);
}

// —— Puppeteer 兜底（走 SOCKS）
async function withBrowser(fn) {
  const browser = await puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: ['--no-sandbox','--disable-setuid-sandbox', `--proxy-server=${SOCKS_PROXY}`],
  });
  try { return await fn(browser); } finally { try { await browser.close(); } catch {} }
}

// —— Express 基础
const app = express();
app.use((_, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  next();
});
app.get('/ping', (_,res)=>res.send('pong'));

// 1) HTML：先轻抓；有挑战/异常再渲染
app.get('/html', async (req, res) => {
  const target = String(req.query.url || '');
  if (!target) return res.status(400).send('url is required');

  const key = 'HTML:'+target;
  const c = getCache(key);
  if (c) { res.type('html').send(c); return; }

  try {
    const { status, body, headers } = await fetchDecompress(target, {
      Accept: ACCEPT_HTML,
      Referer: req.query.referer || BASE_REFERER,
      'User-Agent': req.query.ua || DEFAULT_UA,
    });
    let html = Buffer.isBuffer(body) ? body.toString('utf8') : String(body||'');

    if (looksLikeChallenge(status, html) || (headers.get('content-type')||'').includes('text/html') === false) {
      const rendered = await withBrowser(async (browser) => {
        const page = await browser.newPage();
        await page.setUserAgent(req.query.ua || DEFAULT_UA);
        await page.setExtraHTTPHeaders({ 'Referer': req.query.referer || BASE_REFERER, 'Accept-Language': 'zh-CN,zh;q=0.9' });
        await page.setViewport({ width: 1366, height: 824 });
        await page.goto(target, { waitUntil: 'networkidle2', timeout: 60000 });
        await new Promise(r=>setTimeout(r,1500));   // 兼容旧版 API
        return await page.content();
      });
      html = rendered;
    }

    setCache(key, html, 45*1000);
    res.set('Content-Type','text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send('fetch error: ' + (e?.message || String(e)));
  }
});

// 2) 图片直链代理：/img?url=  （支持Referer/UA，可缓存）
app.get('/img', async (req, res) => {
  const target = String(req.query.url || '');
  const referer = String(req.query.referer || BASE_REFERER);
  if (!target) return res.status(400).send('url required');

  const key = 'IMG:'+target+'|R:'+referer;
  const c = getCache(key);
  if (c) {
    res.set('Content-Type', c.type || 'image/jpeg');
    res.set('Cache-Control','public, max-age=300');
    return res.send(c.buf);
  }

  try {
    // 轻抓（带Referer/UA）
    const r1 = await fetchDecompress(target, { Accept: ACCEPT_IMG, Referer: referer, 'User-Agent': DEFAULT_UA });
    let type = (r1.headers.get('content-type') || '').toLowerCase();
    let ok = r1.status>=200 && r1.status<300 && /^image\//.test(type);
    let buf = Buffer.isBuffer(r1.body) ? r1.body : Buffer.from(r1.body||'', 'utf8');

    if (!ok) {
      // 兜底：无头浏览器拿图片
      const out = await withBrowser(async (browser) => {
        const page = await browser.newPage();
        await page.setUserAgent(DEFAULT_UA);
        await page.setExtraHTTPHeaders({ Referer: referer, 'Accept-Language': 'zh-CN,zh;q=0.9' });
        const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 60000 });
        if (!resp) throw new Error('no response');
        const h = resp.headers();
        const b = await resp.buffer();
        return { type: h['content-type'] || 'image/jpeg', buf: b };
      });
      type = out.type; buf = out.buf;
    }

    setCache(key, { type, buf }, 5*60*1000);
    res.set('Content-Type', type || 'image/jpeg');
    res.set('Cache-Control','public, max-age=300');
    res.send(buf);
  } catch (e) {
    res.status(500).send('img error: ' + (e?.message || String(e)));
  }
});

// 3) /img-auto?url=&referer=  —— 语义清晰的转发到 /img
app.get('/img-auto', async (req, res) => {
  const q = require('url').parse(req.url).query || '';
  req.url = '/img?'+q;
  app._router.handle(req, res);
});

// 启动
app.listen(PORT, () => {
  console.log(new Date().toISOString()+`: Server listening on http://0.0.0.0:${PORT}`);
  console.log(`Using CHROME_PATH=${CHROME_PATH}  SOCKS_PROXY=${SOCKS_PROXY}`);
});
JS
pm2 restart baka-8080 --update-env --time
