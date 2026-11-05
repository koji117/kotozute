// 字幕（.captext の各行）を macOS の say で読み上げ、字幕の時間に合わせて動画に重ねる。
// 使い方（docs/storyboard で）：node narrate.js  → demo-storyboard-narrated.mp4
const fs = require('fs');
const { execFileSync } = require('child_process');

const VOICE = 'Kyoko', BASE_RATE = 200, MAX_RATE = 320;
// 読み上げ用の読み（字幕の文字は変えない）
const READ = [
  ['Claude Code', 'クロードコード'], ['Claude', 'クロード'], ['Googleマップ', 'グーグルマップ'], ['Google', 'グーグル'],
  ['Valhalla', 'ヴァルハラ'], ['ABR', 'エービーアール'], ['OSM', 'オーエスエム'], ['GPX', 'ジーピーエックス'],
  ['MCP', 'エムシーピー'], ['1社', 'いっしゃ'], ['SLA', 'エスエルエー'], ['API', 'エーピーアイ'], ['AI', 'エーアイ'], ['hook', 'フック'], ['◯日', '何日'], ['0件', 'ゼロ件'], ['1文', 'いちぶん'], ['札', 'ふだ'],
];

const html = fs.readFileSync('storyboard.html', 'utf8');
const cap = html.slice(html.indexOf('<div class="captext">'), html.indexOf('<div class="mock">'));
// data-silent の行（最後のおことわりなど）は読まない
const lines = [...cap.matchAll(/data-show="([\d.]+)-([\d.]+)"( data-silent)?>([^<]+)</g)]
  .filter(m => !m[3]).map(([, a, b, , text]) => ({ a: +a, b: +b, text }));

fs.mkdirSync('voice', { recursive: true });
const dur = f => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString();
const inputs = [], filters = [];
lines.forEach((l, i) => {
  let spoken = l.text;
  for (const [k, v] of READ) spoken = spoken.split(k).join(v);
  const f = `voice/l${String(i).padStart(2, '0')}.aiff`;
  const slot = l.b - l.a - 0.4; // 字幕の切り替わりの前後に少し間を空ける
  let rate = BASE_RATE;
  execFileSync('say', ['-v', VOICE, '-r', String(rate), '-o', f, spoken]);
  let d = dur(f);
  if (d > slot) {
    rate = Math.min(MAX_RATE, Math.ceil(rate * d / slot * 1.03));
    execFileSync('say', ['-v', VOICE, '-r', String(rate), '-o', f, spoken]);
    d = dur(f);
  }
  console.log(`${d > slot ? 'OVER' : 'ok  '} ${l.a}s ${d.toFixed(1)}/${slot.toFixed(1)}s rate=${rate} ${l.text}`);
  inputs.push('-i', f);
  const ms = Math.round((l.a + 0.2) * 1000);
  filters.push(`[${i + 1}:a]adelay=${ms}|${ms}[v${i}]`);
});
const mix = filters.join(';') + ';' + lines.map((_, i) => `[v${i}]`).join('') +
  `amix=inputs=${lines.length}:normalize=0,aresample=48000[a]`;
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', 'demo-storyboard.mp4', ...inputs, '-filter_complex', mix,
  '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart',
  'demo-storyboard-narrated.mp4'], { stdio: 'inherit' });
console.log('wrote demo-storyboard-narrated.mp4');
