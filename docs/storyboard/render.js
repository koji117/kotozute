const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const mode = process.argv[2];           // 'preview' or 'full'
const out = process.argv[3];
const fps = 12, dur = 180;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve('storyboard.html'), { waitUntil: 'networkidle' });
  await page.evaluate(async () => {
    const txt = 'ことづて 合否表 トンネル 0123456789 ABC';
    const specs = ['400 16px "BIZ UDPGothic"','700 16px "BIZ UDPGothic"','500 16px "IBM Plex Sans JP"','700 16px "IBM Plex Sans JP"','400 16px "IBM Plex Mono"','500 16px "IBM Plex Mono"'];
    for (const s of specs) await document.fonts.load(s, txt);
    for (let t = 0; t <= 180; t += 0.5) window.render(t);
    await document.fonts.ready;
  });
  const ok = await page.evaluate(() => ['400 16px "BIZ UDPGothic"','700 16px "BIZ UDPGothic"','500 16px "IBM Plex Sans JP"','700 16px "IBM Plex Sans JP"','400 16px "IBM Plex Mono"'].map(s => document.fonts.check(s, '地図')));
  console.log('fonts', ok);
  fs.mkdirSync(out, { recursive: true });
  const times = mode === 'preview'
    ? [2, 12, 18, 26, 34, 50, 70, 82, 95, 112, 125, 134, 140, 148, 156, 165, 172, 178]
    : Array.from({ length: dur * fps }, (_, i) => i / fps);
  let i = 0;
  for (const t of times) {
    await page.evaluate(t => window.render(t), t);
    const name = mode === 'preview' ? `t${String(t).padStart(3, '0')}.png` : `f${String(i).padStart(5, '0')}.jpg`;
    await page.screenshot({ path: path.join(out, name), type: mode === 'preview' ? 'png' : 'jpeg', quality: mode === 'preview' ? undefined : 92 });
    i++;
  }
  await browser.close();
  console.log('frames', i);
})();
