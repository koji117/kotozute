const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const mode = process.argv[2];           // 'preview' or 'full'
const out = process.argv[3];
const fps = 30, dur = 257.5;
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  await page.goto('file://' + path.resolve('storyboard.html'), { waitUntil: 'networkidle' });
  await page.evaluate(async (dur) => {
    const txt = 'ことづて 合否表 地図 トンネル 0123456789 ABC';
    const specs = ['400 16px "M PLUS 1"','500 16px "M PLUS 1"','700 16px "M PLUS 1"','800 16px "M PLUS 1"','400 16px "Noto Sans Mono"','500 16px "Noto Sans Mono"'];
    for (const s of specs) await document.fonts.load(s, txt);
    for (let t = 0; t <= dur; t += 0.5) window.render(t);
    await document.fonts.ready;
  }, dur);
  const ok = await page.evaluate(() => ['400 16px "M PLUS 1"','700 16px "M PLUS 1"','800 16px "M PLUS 1"','400 16px "Noto Sans Mono"'].map(s => document.fonts.check(s, '地図 ABC')));
  console.log('fonts', ok);
  fs.mkdirSync(out, { recursive: true });
  const times = process.argv[4] ? process.argv[4].split(',').map(Number) // 例：node render.js preview out 51,58
    : mode === 'preview'
    ? [3, 15, 27, 37, 48, 53, 61, 66, 71, 75.5, 85, 94, 105, 111, 118, 125, 131, 140, 145, 149.5, 154, 163, 173, 179, 193, 203, 218, 233, 241, 253]
    : Array.from({ length: Math.round(dur * fps) }, (_, i) => i / fps);
  let i = 0;
  const [f0, f1] = (process.env.FRAMES ?? '0-1e9').split('-').map(Number); // 例：FRAMES=1550-1800 で一部だけ撮り直す
  for (const t of times) {
    if (mode !== 'preview' && (i < f0 || i > f1)) { i++; continue; }
    await page.evaluate(t => window.render(t), t);
    const name = mode === 'preview' ? `t${String(t).padStart(3, '0')}.png` : `f${String(i).padStart(5, '0')}.jpg`;
    await page.screenshot({ path: path.join(out, name), type: mode === 'preview' ? 'png' : 'jpeg', quality: mode === 'preview' ? undefined : 92 });
    i++;
  }
  await browser.close();
  console.log('frames', i);
})();
