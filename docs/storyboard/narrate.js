// demo.html の字幕（.captext の各行。{名前} を events.json の結果で埋めたあと）を読み上げ、字幕の時間に合わせて render.js の動画に重ねる。
// 声は2つから選ぶ（TTS）：
//   TTS=say（既定）       … macOS の say（Kyoko）。字幕の時間に収まるまで速さを上げる
//   TTS=elevenlabs        … ElevenLabs の API（11/7 にユーザーが決定）。キーは .env の ELEVENLABS_API_KEY（画面にもログにも出さない）、
//                           声は ELEVENLABS_VOICE_ID、モデルは ELEVENLABS_MODEL（既定 eleven_multilingual_v2）。
//                           前後の行を previous_text / next_text で渡して、行と行の話し方をつなげる。作った音は文と設定の hash でキャッシュする
//                           （~/kotozute-video/voice-el/。同じ文ならもう一度お金がかからない）。字幕の時間を超える行だけ、最大1.2倍まで速める。
// 使い方（docs/storyboard で）：node render.js full && node narrate.js  → ~/kotozute-video/preview.mp4（MP4=… で出力先を変える）
//   EVENTS=… は render.js と同じ。音だけ作って長さを確かめるなら：node narrate.js check
//   声の一覧（ElevenLabs。自分のアカウントの声と、ライブラリの日本語の声）：TTS=elevenlabs node narrate.js voices
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { launch, open, OUT } = require('./render.js');

const TTS = process.env.TTS ?? 'say';
const VOICE = 'Kyoko', BASE_RATE = 200, MAX_RATE = 240; // 240 を超えると聞き取りにくい。OVER が出たら字幕を短くするか時間を足す
const MAX_TEMPO = 1.2; // ElevenLabs の音を速めるのはここまで
// 読み上げ用の読み（字幕の文字は変えない）
const READ = [
  ['Claude Code', 'クロードコード'], ['Claude', 'クロード'], ['Googleマップ', 'グーグルマップ'], ['Google', 'グーグル'],
  ['Valhalla', 'ヴァルハラ'], ['OSS', 'オーエスエス'], ['OSM', 'オーエスエム'], ['MCP', 'エムシーピー'], ['AI', 'エーアイ'],
  ['4-2-8', 'よんのにのはち'], ['四丁目2番8号', 'よんちょうめにばんはちごう'], ['hook', 'フック'], ['.dmg', 'ディーエムジー'], ['Mac', 'マック'], ['km', 'キロ'], ['札', 'ふだ'], ['0件', 'ゼロ件'],
];
const spokenOf = (t) => READ.reduce((s, [k, v]) => s.split(k).join(v), t);
const dur = (f) => +execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f]).toString();

// ===== ElevenLabs =====
const API = 'https://api.elevenlabs.io';
const EL = {
  model: process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2',
  voice: process.env.ELEVENLABS_VOICE_ID,
  settings: { stability: 0.5, similarity_boost: 0.75, style: 0, use_speaker_boost: true, speed: Number(process.env.ELEVENLABS_SPEED ?? 1) },
};
function elKey() {
  try { process.loadEnvFile(path.resolve(__dirname, '../../.env')); } catch {} // .env がなければ環境変数だけ
  const k = process.env.ELEVENLABS_API_KEY;
  if (!k) throw new Error('ELEVENLABS_API_KEY がありません。リポジトリの .env に ELEVENLABS_API_KEY=… を書いてください');
  return k;
}
async function elGet(p) {
  const r = await fetch(API + p, { headers: { 'xi-api-key': elKey() } });
  if (!r.ok) throw new Error(`ElevenLabs ${p.split('?')[0]}：${r.status} ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
/** 1行を音にする（キャッシュがあれば使う）。戻り値は mp3 のパス */
async function eleven(text, prev, next) {
  if (!EL.voice) throw new Error('ELEVENLABS_VOICE_ID がありません（TTS=elevenlabs node narrate.js voices で声を探す）');
  const body = { text, model_id: EL.model, voice_settings: EL.settings, previous_text: prev || undefined, next_text: next || undefined };
  const hash = crypto.createHash('sha256').update(JSON.stringify([EL.voice, body])).digest('hex').slice(0, 20);
  const f = path.join(OUT, 'voice-el', `${hash}.mp3`);
  if (fs.existsSync(f)) return f;
  const r = await fetch(`${API}/v1/text-to-speech/${encodeURIComponent(EL.voice)}?output_format=mp3_44100_128`, {
    method: 'POST', headers: { 'xi-api-key': elKey(), 'content-type': 'application/json', accept: 'audio/mpeg' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`ElevenLabs の音声：${r.status} ${(await r.text()).slice(0, 300)}`);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  return f;
}
/** 字幕の時間（slot）に収まらなければ、最大 MAX_TEMPO 倍まで速める。戻り値は使うファイルと長さ */
function fit(f, slot, out) {
  const d = dur(f);
  if (d <= slot) return { f, d, tempo: 1 };
  const tempo = Math.min(MAX_TEMPO, (d / slot) * 1.01);
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', f, '-filter:a', `atempo=${tempo.toFixed(3)}`, out]);
  return { f: out, d: dur(out), tempo };
}
async function voices() {
  const mine = await elGet('/v2/voices?page_size=100');
  console.log('== 自分のアカウントの声（ELEVENLABS_VOICE_ID に使える）');
  for (const v of mine.voices) console.log(`${v.voice_id}  ${v.name}  [${v.category}] ${Object.values(v.labels ?? {}).join(' ')}`);
  const lib = await elGet('/v1/shared-voices?language=ja&page_size=40');
  console.log('\n== ライブラリの日本語の声（使うには、先に自分のアカウントに足す必要がある）');
  for (const v of lib.voices ?? []) console.log(`${v.voice_id}  ${v.name}  ${[v.gender, v.age, v.accent, v.use_case, v.descriptive].filter(Boolean).join(' ')}  使われた数 ${v.usage_character_count_1y ?? '?'}`);
}

(async () => {
  if (process.argv[2] === 'voices') return voices();
  const browser = await launch();
  const page = await open(browser);
  const lines = await page.evaluate(() => [...document.querySelectorAll('.captext > div')]
    .filter((d) => !d.hasAttribute('data-silent'))
    .map((d) => { const [a, b] = d.dataset.show.split('-').map(Number); return { a, b, text: d.textContent.trim() }; }));
  await browser.close();

  const dir = path.join(OUT, 'voice');
  fs.mkdirSync(dir, { recursive: true });
  const inputs = [], filters = [];
  let over = 0;
  for (const [i, l] of lines.entries()) {
    const spoken = spokenOf(l.text);
    const slot = l.b - l.a - 0.4; // 字幕の切り替わりの前後に少し間を空ける
    let f, d, note;
    if (TTS === 'elevenlabs') {
      const raw = await eleven(spoken, lines[i - 1] && spokenOf(lines[i - 1].text), lines[i + 1] && spokenOf(lines[i + 1].text));
      ({ f, d } = fit(raw, slot, path.join(dir, `l${String(i).padStart(2, '0')}.m4a`)));
      note = `tempo=${(dur(raw) / d).toFixed(2)}`;
    } else {
      f = path.join(dir, `l${String(i).padStart(2, '0')}.aiff`);
      let rate = BASE_RATE;
      execFileSync('say', ['-v', VOICE, '-r', String(rate), '-o', f, spoken]);
      d = dur(f);
      for (let k = 0; k < 4 && d > slot && rate < MAX_RATE; k++) { // 速さと長さは比例しないので、数回まで上げ直す
        rate = Math.min(MAX_RATE, Math.ceil(rate * d / slot * 1.02));
        execFileSync('say', ['-v', VOICE, '-r', String(rate), '-o', f, spoken]);
        d = dur(f);
      }
      note = `rate=${rate}`;
    }
    if (d > slot) over++;
    console.log(`${d > slot ? 'OVER' : 'ok  '} ${l.a}s ${d.toFixed(1)}/${slot.toFixed(1)}s ${note} ${l.text}`);
    inputs.push('-i', f);
    const ms = Math.round((l.a + 0.2) * 1000);
    filters.push(`[${i + 1}:a]adelay=${ms}|${ms}[v${i}]`);
  }
  console.log(`${lines.length}行${over ? `（OVER ${over}行）` : ''}（声：${TTS === 'elevenlabs' ? `ElevenLabs ${EL.model}` : `say ${VOICE}`}）`);
  if (process.argv[2] === 'check') return;

  const video = path.join(OUT, 'demo-silent.mp4'), out = process.env.MP4 ?? path.join(OUT, 'preview.mp4');
  if (!fs.existsSync(video)) throw new Error(`${video} がありません。先に node render.js full を実行してください`);
  const mix = filters.join(';') + ';' + lines.map((_, i) => `[v${i}]`).join('') + `amix=inputs=${lines.length}:normalize=0,loudnorm=I=-14:TP=-1.5:LRA=11,apad,aresample=48000[a]`;
  execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', video, ...inputs, '-filter_complex', mix,
    '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out], { stdio: 'inherit' });
  console.log(`wrote ${out}`);
})().catch((e) => { console.error(e.message); process.exit(1); });
