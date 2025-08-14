const puppeteer = require('puppeteer-extra');
try { puppeteer.use(require('puppeteer-extra-plugin-stealth')()); } catch {}

(async () => {
  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/chromium',
    headless: 'new',
    args: [
      '--no-sandbox', '--disable-setuid-sandbox',
      '--proxy-server=socks5://127.0.0.1:7890',
    ],
  });

  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115 Safari/537.36');

  console.log('[GO] open');
  try {
    await page.goto('https://bakamh.com/', { waitUntil: 'networkidle0', timeout: 60000 });
    const title = await page.title();
    console.log('[TITLE]', title);
    console.log('OK — page length:', (await page.content()).length);
  } catch (e) {
    console.error('ERR', e.message);
  } finally {
    await browser.close();
  }
})();
