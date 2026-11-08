// demo.html を Playwright で1コマずつ撮る（1920×1080、30コマ/秒）。録画と結果は ~/kotozute-video/events.json から入れる。
// 使い方（docs/storyboard で）：
//   node render.js preview [秒,秒,…]   → ~/kotozute-video/preview/t*.png（確かめ用の数枚）
//   node render.js full                → ~/kotozute-video/frames/ と ~/kotozute-video/demo-silent.mp4（音なし）
//   EVENTS=~/kotozute-video/dummy/events.json node render.js preview   ダミーで確かめる（dummy-events.js）
//   FRAMES=1550-1800 node render.js full  一部のコマだけ撮り直す（動画は作り直す）
// narrate.js は open() を使って、同じ状態のページから字幕を読む。
const path = require('path');
const fs = require('fs');
const { execFileSync, execSync } = require('child_process');
const { pathToFileURL } = require('url');

const HOME = process.env.HOME;
const OUT = path.join(HOME, 'kotozute-video');
const EVENTS = process.env.EVENTS ?? path.join(OUT, 'events.json');
const FPS = 30;

// Playwright は require('playwright') で探し、なければグローバルの @playwright/cli の中のもの（scripts/check-web.mjs と同じ）
function playwright() {
  try { return require('playwright'); } catch {}
  return require(`${execSync('npm root -g').toString().trim()}/@playwright/cli/node_modules/playwright`);
}
async function launch() {
  const { chromium } = playwright();
  return chromium.launch().catch(() => {
    // Playwright の版に合うブラウザがないときは、入っている中でいちばん新しい headless shell を使う
    const dir = `${HOME}/Library/Caches/ms-playwright`;
    const shell = fs.readdirSync(dir).filter((d) => d.startsWith('chromium_headless_shell-')).sort().at(-1);
    return chromium.launch({ executablePath: `${dir}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell` });
  });
}

// demo.html を開き、録画・結果・リポジトリの記録を入れて、読み込みとフォントを待つ
async function open(browser) {
  const events = fs.existsSync(EVENTS) ? JSON.parse(fs.readFileSync(EVENTS, 'utf8')) : null;
  const root = path.resolve(__dirname, '../..');
  // コミット済みの記録だけを使う（作業中に hook が足した行は、コミットするまで動画に出さない）
  const committed = (f) => execFileSync('git', ['-C', root, 'show', `HEAD:${f}`]).toString();
  const repo = {
    hooks: committed('logs/hook-blocks.jsonl').split('\n').filter(Boolean).map((l) => JSON.parse(l)),
    audit: JSON.parse(committed('logs/tag-audit.json')),
    // Claude Code の場面の題：マージを除くコミットの数と、そのうち Co-Authored-By: Claude がある数（作り直すときの HEAD で数える）
    commits: Number(execFileSync('git', ['-C', root, 'rev-list', '--count', '--no-merges', 'HEAD']).toString()),
    claudeCommits: execFileSync('git', ['-C', root, 'log', '--no-merges', '--format=%h', '--grep=Co-Authored-By: Claude', 'HEAD']).toString().split('\n').filter(Boolean).length,
  };
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1.5 });
  page.on('pageerror', (e) => console.error('page error:', e.message));
  await page.addInitScript(({ events, repo, dir }) => { window.EVENTS = events; window.REPO = repo; window.VIDEO_DIR = dir; },
    { events, repo, dir: pathToFileURL(path.dirname(EVENTS)).href + '/' });
  await page.goto(pathToFileURL(path.join(__dirname, 'demo.html')).href);
  await page.evaluate(() => window.ready);
  // フォントは使う文字の分だけ読まれるので、ページの全部の文字で先に読ませる
  const fonts = await page.evaluate(async () => {
    const text = document.body.textContent;
    const specs = ['400 16px "M PLUS 1"', '500 16px "M PLUS 1"', '700 16px "M PLUS 1"', '800 16px "M PLUS 1"', '400 16px "Noto Sans Mono"', '500 16px "Noto Sans Mono"'];
    for (const s of specs) await document.fonts.load(s, text);
    await document.fonts.ready;
    return specs.map((s) => document.fonts.check(s, '地図 ABC'));
  });
  console.log(events ? `events: ${EVENTS}${events.dummy ? '（ダミー）' : ''}` : `events なし: ${EVENTS}`);
  console.log('fonts', fonts);
  const missing = await page.evaluate(() => window.MISSING);
  if (missing.length) console.log('足りないもの:', [...new Set(missing)].join(' '));
  return page;
}

async function main() {
  const mode = process.argv[2] ?? 'preview';
  const browser = await launch();
  const page = await open(browser);
  const dur = await page.evaluate(() => window.DURATION);
  // 本番（full）は、字幕に「？」が出るなら止める。Mac のアプリの録画がないときは入れ方の絵だけになる決まりなので止めない
  const lack = (await page.evaluate(() => window.MISSING)).filter((m) => m !== '録画:s6-app');
  if (mode === 'full' && lack.length && !process.env.ALLOW_MISSING) throw new Error(`足りないものがあるので止めます（ALLOW_MISSING=1 で続ける）：${[...new Set(lack)].join(' ')}`);
  if (mode === 'preview') {
    const dir = path.join(OUT, 'preview');
    fs.mkdirSync(dir, { recursive: true });
    const times = process.argv[3] ? process.argv[3].split(',').map(Number)
      : [3, 9, 14, 17, 22, 27, 32, 38, 45, 52, 58, 64, 72, 77, 83, 88, 94, 99, 104, 108, 112, 118, 123, 128, 134, 141, 146, 150, 158, 166, 172, 177];
    for (const t of times) {
      await page.evaluate((t) => window.render(t), t);
      await page.screenshot({ path: path.join(dir, `t${String(t).padStart(3, '0')}.png`) });
    }
    console.log(`preview ${times.length}枚: ${dir}`);
  } else {
    const dir = path.join(OUT, 'frames');
    fs.mkdirSync(dir, { recursive: true });
    const total = Math.round(dur * FPS);
    const [f0, f1] = (process.env.FRAMES ?? '0-1e9').split('-').map(Number);
    const t0 = Date.now();
    for (let i = Math.max(0, f0); i < Math.min(total, f1 + 1); i++) {
      await page.evaluate((t) => window.render(t), i / FPS);
      await page.screenshot({ path: path.join(dir, `f${String(i).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 92 });
      if (i % 300 === 0) console.log(`frame ${i}/${total}（${Math.round((Date.now() - t0) / 1000)}秒）`);
    }
    const frame = (i) => path.join(dir, `f${String(i).padStart(5, '0')}.jpg`);
    const lack = Array.from({ length: total }, (_, i) => i).filter((i) => !fs.existsSync(frame(i)));
    if (lack.length) { console.log(`コマが ${lack.length}枚足りないので、動画は作りません（最初の欠け：${lack[0]}）`); return browser.close(); }
    const mp4 = path.join(OUT, 'demo-silent.mp4');
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%05d.jpg'), '-frames:v', String(total),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-movflags', '+faststart', mp4], { stdio: 'inherit' });
    console.log(`frames ${total} → ${mp4}`);
  }
  await browser.close();
}

module.exports = { launch, open, OUT };
if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
