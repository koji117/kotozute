// デザイン案の HTML を PNG にする。
// 使い方：node design/shot.js design/option-a.html design/option-a.png [幅] [高さ]（既定 1280×720）
const { chromium } = require('playwright');
const path = require('path');
(async () => {
  const [src, out, w = '1280', h = '720'] = process.argv.slice(2);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve(src), { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: out });
  await browser.close();
  console.log('wrote', out);
})();
