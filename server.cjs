const express = require('express');
const puppeteer = require('puppeteer-extra');
try { puppeteer.use(require('puppeteer-extra-plugin-stealth')()); } catch (_) {}

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const SOCKS_PROXY = process.env.SOCKS_PROXY || 'socks5://127.0.0.1:7890';
const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36';

const app = express();

// CORS
app.use((_, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  next();
});

app.get('/ping', (_, res) => res.send('pong'));

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

app.get('/html', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('url is required');

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox',
        `--proxy-server=${SOCKS_PROXY}`,
      ],
    });

    const page = await browser.newPage();

    // UA
    await page.setUserAgent(req.query.ua || DEFAULT_UA);

    // Extra headers
    const extra = { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' };
    if (req.query.referer) extra['Referer'] = String(req.query.referer);
    if (req.query.cookie) extra['Cookie'] = String(req.query.cookie);
    await page.setExtraHTTPHeaders(extra);

    await page.setViewport({ width: 1366, height: 824 });
    await page.goto(target, { waitUntil: 'networkidle0', timeout: 60000 });

    // 给 CF 一点时间
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

const PORT = 8080;
app.listen(PORT, () => console.log('Server listening on http://127.0.0.1:' + PORT));
