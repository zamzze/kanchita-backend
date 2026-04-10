docker exec streaming_api sh -c "cat > /tmp/search.js << 'ENDOFSCRIPT'
const { connect } = require('puppeteer-real-browser');
(async () => {
  const { browser, page } = await connect({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-web-security','--disable-dev-shm-usage'],
    turnstile: true, disableXvfb: false,
  });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
  console.log('Navigating to search...');
  await page.goto('https://cinecalidadhd.world/?do=search&subaction=search&story=titanic', {
    waitUntil: 'domcontentloaded', timeout: 15000
  }).catch(()=>{});
  const content = await page.content();
  console.log('Page length:', content.length);
  const movieUrls = [...new Set((content.match(/href=\"[^\"]+\/\d+-[^\"]+\"/g) || []))];
  console.log('Movie URLs found:', movieUrls.length);
  movieUrls.slice(0, 10).forEach(u => console.log(u));
  const gscdn = [...new Set((content.match(/gscdn\.cam\/video\/embed\/[a-z0-9]+/g) || []))];
  console.log('Gscdn embeds:', gscdn);
  await browser.close();
})().catch(console.error);
ENDOFSCRIPT"