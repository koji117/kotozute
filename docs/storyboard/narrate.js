// demo.html の字幕（.captext の各行。{名前} を events.json の結果で埋めたあと）を macOS の say（Kyoko）で読み上げ、
// 字幕の時間に合わせて render.js の動画に重ねる。
// 使い方（docs/storyboard で）：node render.js full && node narrate.js  → ~/kotozute-video/preview.mp4（MP4=… で出力先を変える）
//   EVENTS=… は render.js と同じ。音だけ作って長さを確かめるなら：node narrate.js check
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { launch, open, OUT } = require('./render.js');

const VOICE = 'Kyoko', BASE_RATE = 200, MAX_RATE = 240; // 240 を超えると聞き取りにくい。OVER が出たら字幕を短くするか時間を足す
// 読み上げ用の読み（字幕の文字は変えない）
const READ = [
  ['Claude Code', 'クロードコード'], ['Claude', 'クロード'], ['Googleマップ', 'グーグルマップ'], ['Google', 'グーグル'],
  ['Valhalla', 'ヴァルハラ'], ['OSS', 'オーエスエス'], ['OSM', 'オーエスエム'], ['MCP', 'エムシーピー'], ['AI', 'エーアイ'],
  ['4-2-8', 'よんのにのはち'], ['四丁目2番8号', 'よんちょうめにばんはちごう'], ['hook', 'フック'], ['.dmg', 'ディーエムジー'], ['Mac', 'マック'], ['km', 'キロ'], ['札', 'ふだ'], ['0件', 'ゼロ件'],
];

(async () => {
  const browser = await launch();
  const page = await open(browser);
  const lines = await page.evaluate(() => [...document.querySelectorAll('.captext > div')]
    .filter((d) => !d.hasAttribute('data-silent'))
    .map((d) => { const [a, b] = d.dataset.show.split('-').map(Number); return { a, b, text: d.textContent.trim() }; }));
  await browser.close();

  const dir = path.join(OUT, 'voice');
  fs.mkdirSync(dir, { recursive: true });
  const dur = (f) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString();
  const inputs = [], filters = [];
  let over = 0;
  lines.forEach((l, i) => {
    let spoken = l.text;
    for (const [k, v] of READ) spoken = spoken.split(k).join(v);
    const f = path.join(dir, `l${String(i).padStart(2, '0')}.aiff`);
    const slot = l.b - l.a - 0.4; // 字幕の切り替わりの前後に少し間を空ける
    let rate = BASE_RATE;
    execFileSync('say', ['-v', VOICE, '-r', String(rate), '-o', f, spoken]);
    let d = dur(f);
    for (let k = 0; k < 4 && d > slot && rate < MAX_RATE; k++) { // 速さと長さは比例しないので、数回まで上げ直す
      rate = Math.min(MAX_RATE, Math.ceil(rate * d / slot * 1.02));
      execFileSync('say', ['-v', VOICE, '-r', String(rate), '-o', f, spoken]);
      d = dur(f);
    }
    if (d > slot) over++;
    console.log(`${d > slot ? 'OVER' : 'ok  '} ${l.a}s ${d.toFixed(1)}/${slot.toFixed(1)}s rate=${rate} ${l.text}`);
    inputs.push('-i', f);
    const ms = Math.round((l.a + 0.2) * 1000);
    filters.push(`[${i + 1}:a]adelay=${ms}|${ms}[v${i}]`);
  });
  console.log(`${lines.length}行${over ? `（OVER ${over}行）` : ''}`);
  if (process.argv[2] === 'check') return;

  const video = path.join(OUT, 'demo-silent.mp4'), out = process.env.MP4 ?? path.join(OUT, 'preview.mp4');
  if (!fs.existsSync(video)) throw new Error(`${video} がありません。先に node render.js full を実行してください`);
  const mix = filters.join(';') + ';' + lines.map((_, i) => `[v${i}]`).join('') + `amix=inputs=${lines.length}:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,apad,aresample=48000[a]`;
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', video, ...inputs, '-filter_complex', mix,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out], { stdio: 'inherit' });
  console.log(`wrote ${out}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
