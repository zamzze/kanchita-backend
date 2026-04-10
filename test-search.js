const { connect } = require('puppeteer-real-browser');
(async () => {
  const { browser, page } = await connect({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-web-security','--disable-dev-shm-usage'],
    turnstile: true, disableXvfb: false,
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  await page.setRequestInterception(true);
  page.on('request', async (req) => {
    if (['image','stylesheet','font'].includes(req.resourceType())) {
      await req.abort();
    } else {
      await req.continue();
    }
  });

  const url = 'https://cinecalidadhd.world/5791-invencible-2021-online-en-hd-cinecalidad/temporada-1-episodio-1';
  console.log('Loading episode page...');
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => {});

  const result = await page.evaluate(() => {
    const embeds = [];
    document.querySelectorAll('[data-src]').forEach(el => {
      embeds.push({ tag: el.tagName, dataSrc: el.getAttribute('data-src') });
    });
    document.querySelectorAll('a[href]').forEach(a => {
      if (a.href.includes('gscdn') || a.href.includes('supervideo')) {
        embeds.push({ tag: 'A', href: a.href, text: a.textContent.trim() });
      }
    });
    const iframes = [];
    document.querySelectorAll('iframe').forEach(f => {
      iframes.push(f.src || f.getAttribute('data-src'));
    });
    return { embeds, iframes };
  });

  console.log('Embeds:', JSON.stringify(result.embeds, null, 2));
  console.log('Iframes:', result.iframes);

  await browser.close();
})().catch(console.error);