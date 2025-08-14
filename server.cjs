// server.cjs  —— 8080 端口，HTML 与图片都经由 puppeteer + SOCKS 代理
const express = require('express');
const puppeteer = require('puppeteer-extra');
try { puppeteer.use(require('puppeteer-extra-plugin-stealth')()); } catch (_) {}

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const SOCKS_PROXY = process.env.SOCKS_PROXY || 'socks5://127.0.0.1:7890';
const DEFAULT_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36';

const app = express();

// CORS（方便 App 直接请求）
app.use((_, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  next();
});

// 健康检查
app.get('/ping', (_, res) => res.send('pong'));

// 小工具
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
async function launchBrowser() {
  return puppeteer.launch({
    executablePath: CHROME_PATH,
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      `--proxy-server=${SOCKS_PROXY}`,
    ],
  });
}

// 1) 拉取整页 HTML：/html?url=<目标页>&ua=&referer=&cookie=
app.get('/html', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('url is required');

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // UA
    await page.setUserAgent(req.query.ua || DEFAULT_UA);

    // 额外头
    const extra = { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' };
    if (req.query.referer) extra['Referer'] = String(req.query.referer);
    if (req.query.cookie)  extra['Cookie']  = String(req.query.cookie);
    await page.setExtraHTTPHeaders(extra);

    await page.setViewport({ width: 1366, height: 824 });

    await page.goto(target, { waitUntil: 'networkidle0', timeout: 60000 });

    // 稍等 2 秒，给 CF/前端脚本一点时间
    await sleep(2000);

    const html = await page.content();
    res.set('content-type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (err) {
    res.status(500).send('fetch error: ' + (err?.message || String(err)));
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
});

// 2) 图片直链代理：/img?url=<图片URL>
app.get('/img', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('url required');

  let browser;
  try {
    browser = await launchBrowser();
    const page = await browser.newPage();

    // 直接打开图片 URL
    const resp = await page.goto(target, { timeout: 60000, waitUntil: 'domcontentloaded' });
    if (!resp) throw new Error('no response');

    const headers = resp.headers();
    const contentType = headers['content-type'] || 'application/octet-stream';
    const buf = await resp.buffer();

    res.set('content-type', contentType);
    if (headers['cache-control']) res.set('cache-control', headers['cache-control']);
    res.send(buf);
  } catch (e) {
    res.status(500).send('img error: ' + (e?.message || String(e)));
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
});

// 启动
const PORT = 8080;
app.listen(PORT, () => {
  console.log('Server listening on http://127.0.0.1:' + PORT);
  console.log('Using CHROME_PATH=' + CHROME_PATH + '  SOCKS_PROXY=' + SOCKS_PROXY);
});
