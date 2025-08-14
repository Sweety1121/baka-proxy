cat > server.js <<'EOF'
const express = require('express');
const puppeteer = require('puppeteer-extra');
try { puppeteer.use(require('puppeteer-extra-plugin-stealth')()); } catch (_) {}

const PORT         = 8080;                             // 对外端口
const CHROME_PATH  = '/usr/bin/chromium';              // VPS 已装好 chromium
const SOCKS_PROXY  = 'socks5://127.0.0.1:7890';        // Clash 本地端口
const DEFAULT_UA   = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36';

const app = express();
app.use((_, res, next) => {            // CORS
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  next();
});
app.get('/ping', (_, res) => res.send('pong'));

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
        `--proxy-server=${SOCKS_PROXY}`
      ],
    });
    const page = await browser.newPage();
    await page.setUserAgent(DEFAULT_UA);
    await page.setViewport({width:1366,height:824});
    await page.goto(target, {waitUntil:'networkidle0', timeout:60000});
    const html = await page.content();
    res.set('content-type', 'text/html; charset=utf-8').send(html);
  } catch (e) {
    res.status(500).send('ERR: '+(e?.message||e));
  } finally { if (browser) await browser.close().catch(()=>{}); }
});

app.listen(PORT, () =>
  console.log(`Server running -> http://127.0.0.1:${PORT}/ping`)
);
EOF
