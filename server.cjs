const express = require('express');
const puppeteer = require('puppeteer-extra');
try { puppeteer.use(require('puppeteer-extra-plugin-stealth')()); } catch (e) {}

const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/chromium';
const PROXY       = process.env.PROXY       || 'socks5://127.0.0.1:7890';
const DEFAULT_UA  = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0 Safari/537.36';
const PORT        = process.env.PORT        || 8080;

const app = express();

app.get('/ping', (_, res) => res.send('pong'));

function sleep(ms){ return new Promise(r=>setTimeout(r,ms)); }

app.get('/html', async (req, res) => {
  const target = req.query.url;
  if (!target) return res.status(400).send('url is required');

  let browser;
  try {
    browser = await puppeteer.launch({
      executablePath: CHROME_PATH,
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        `--proxy-server=${PROXY}`
      ],
    });
    const page = await browser.newPage();

    await page.setUserAgent(req.query.ua || DEFAULT_UA);
    const extra = { 'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8' };
    if (req.query.referer) extra['Referer'] = String(req.query.referer);
    if (req.query.cookie)  extra['Cookie']  = String(req.query.cookie);
    await page.setExtraHTTPHeaders(extra);

    await page.setViewport({ width: 1366, height: 824, deviceScaleFactor: 1 });

    await page.goto(target, { waitUntil: 'networkidle0', timeout: 60000 });
    await sleep(1500);

    const html = await page.content();
    res.set('content-type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).send('ERR: ' + (e?.message || String(e)));
  } finally {
    if (browser) { try { await browser.close(); } catch {} }
  }
});

app.listen(PORT, () => {
  console.log(`server listening on http://0.0.0.0:${PORT}  proxy=${PROXY}`);
});
