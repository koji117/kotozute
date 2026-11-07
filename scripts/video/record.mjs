// 動画の録画：本物のアプリ（BASE、既定 http://127.0.0.1:8787）を Playwright で動かし、本物の Claude で場面（clip）ごとに録る。撮影はしない（2026-11-06 にユーザーが決定）。
// 実行：node scripts/video/record.mjs [chips|coord|ex1|ex2|app ...]   （省くと全部。指定した組だけ録り直し、events.json の同じ場面を置き換える）
//   kotozute のサーバが BASE で動いていること。Claude のキーはサーバの環境にだけある（このスクリプトは読まない）。
// 出力（~/kotozute-video。Git に入れない）：
//   events.json … { base, recorded_at, viewport, clips: [{ id, file, duration_s, marks: [{ name, t }] }], results: { <場面>: 応答 } }
//     場面に足す項目：url（s3b-share で開いた共有リンク）、view（そのときの地図の範囲 [西, 南, 東, 北]）、downloads（画面が保存したファイル）
//   clips/<場面>.mp4（1920x1080、30fps）、clips/<場面>.png（画面が保存した画像。s4b-png は資料用の画像そのもの）
//   s6-app（Mac のアプリ）は ../kotozute-setup の dist（npx vite build）と開発用のデータ（data/region.json）が要る。窓の中身だけを録る（Mac の窓の枠は写らない）。
//     アプリの地図のデータは、そのデータを指す形で userData に置く（appData）。データの画面は出ず、キーの画面のあとに地図が出る
// 録り方：CDP の screencast の JPEG を時刻つきで保存し、場面ごとに ffmpeg で mp4 にする（Playwright の recordVideo は VP8 1Mbps で文字がぼやける）。
//   画面は 1280x720・倍率 1.5。Playwright の viewport の上書きでは screencast のコマが 1280x720 のままなので、窓の大きさと --force-device-scale-factor で合わせる。
//   ヘッドレスの Chrome for Testing（GPU で地図が動く。SwiftShader の倍のコマ数）を使う。
// 印（marks、場面の始まりからの秒）：start、typing（打ち始め）、typed（打ち終わり）、sent（送った）、answered（応答が届いた）、done（結果が出そろった）。
//   2回目からは sent2・answered2。sent〜answered はサーバへの要求すべて（札、日本語の依頼、レシピの再実行）。Claude を待つのは
//   results[場面] が /api/chat の応答（steps があり recipe がない）の場面だけ。ボタンだけの操作は click・saved・zoom・located・share・net・loaded。
// results：場面ごとに最初に受け取った応答を results[場面]、2つ目からは results[`${場面}:2`] …（/api/chat、/api/op/*、/api/share/*、/api/recipe/*/run）。
// Overpass は同じ問い合わせを別のプロセスから約30秒以内に送ると断る（limit）。limit のときは60秒待って1回だけやり直す。
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { devAbrg } from '../../src/launch.mjs';

const BASE = process.env.BASE ?? 'http://127.0.0.1:8787';
const OUT = path.join(os.homedir(), 'kotozute-video');
const CLIPS = path.join(OUT, 'clips');
const RAW = path.join(OUT, 'raw');
const SETUP = process.env.SETUP_DIR ?? path.join(os.homedir(), 'IdeaProjects/kotozute-setup'); // Mac のアプリ（Electron）
const W = 1280, H = 720, DPR = 1.5;
/** 現在地：品川駅 高輪口（OSM node/265050703）。字幕「現在地は撮影用に設定（品川駅 高輪口）」 */
const HERE = { latitude: 35.6288086, longitude: 139.7379847, accuracy: 30 };
const TEXT = {
  view: '芝公園のあたりを大きく。郵便局だけ残して', // CLAUDE.md「デモの例」
  ex1: '今いる場所から、郵便局で書類を出して、手土産を買ってから、港区芝公園4-2-8へ。ルートを共有リンクで', // docs/plan.md §7 例1
  ex2: '来週の客先試走。品川駅を出て、トンネルを2本通り、高速は使わず60分以内。資料用の画像も', // 文書で決まっていないので絵コンテ（docs/storyboard/storyboard.html）の文
  coord: '9系 X=-35363.24 Y=-5992.92', // 平面直角座標（9系）で東京駅。国土地理院の計算と同じ値（scripts/check-quick.ts の 8）。検索の欄に貼る（AI を通さない）
};
/** 例2 (b) の北品川の範囲（scripts/check-course.ts と同じ）。地図の横幅をこの経度の幅に合わせる（緯度は範囲の内側になる） */
const KITASHINAGAWA = [139.7312, 35.616, 139.7478, 35.625];
const ORDER = ['s1-chips', 's2-view', 's2b-coord', 's3-ex1', 's3b-share', 's4-feat', 's4-ex2', 's4b-png', 's5-adv', 's5-recipe', 's6-app'];
const GROUPS = { chips: ['s1-chips', 's2-view'], coord: ['s2b-coord'], ex1: ['s3-ex1', 's3b-share', 's5-adv'], ex2: ['s4-feat', 's4-ex2', 's4b-png', 's5-recipe'], app: ['s6-app'] };
const want = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(GROUPS);
for (const g of want) if (!GROUPS[g]) throw new Error(`組の名前が違います：${g}（${Object.keys(GROUPS).join('、')}）`);

const require = createRequire(import.meta.url);
function playwright() {
  try { return require('playwright'); } catch {}
  return require(`${execSync('npm root -g').toString().trim()}/@playwright/cli/node_modules/playwright`);
}
const { chromium } = playwright();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => Date.now() / 1000;
fs.mkdirSync(CLIPS, { recursive: true });

// ===== 場面（clip）と印 =====
const clips = [];
const results = {};
const notes = []; // 録っている間に起きたこと（報告用）
let cur = null; // 録っている場面
const begin = (id, rec) => { cur = { id, segs: [{ rec, from: now() }], marks: [{ name: 'start', t: now() }], n: 0, downloads: [] }; };
const mark = (name) => cur.marks.push({ name, t: now() });
/** 別のページの録画に切り替える（共有リンクやレシピを開いた新しいページ） */
const switchTo = (rec) => { const t = now(); cur.segs.at(-1).to = t; cur.segs.push({ rec, from: t }); };
/** limit でやり直すとき：場面を今から始め直す */
function restart() {
  for (const k of Object.keys(results)) if (k === cur.id || k.startsWith(`${cur.id}:`)) delete results[k];
  Object.assign(cur, { segs: [{ rec: cur.segs.at(-1).rec, from: now() }], marks: [{ name: 'start', t: now() }], n: 0 });
}
/** 画面に「分からない」「判定不能」が見えているか（動画では見せない。ユーザーが決定）。閉じた「詳細」の中とパネルの外にスクロールしたものは数えない */
function unknownShown() {
  const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let n; (n = w.nextNode());) {
    const e = n.parentElement;
    if (!/分からない|判定不能/.test(n.textContent) || !e.checkVisibility()) continue;
    const a = e.getBoundingClientRect(), p = e.closest('#panel')?.getBoundingClientRect() ?? { top: 0, bottom: innerHeight };
    if (a.bottom > p.top && a.top < p.bottom) return true;
  }
  return false;
}
async function end(hold = 1800) {
  mark('done');
  const page = cur.segs.at(-1).rec.page;
  if (await page.evaluate(unknownShown).catch(() => false)) notes.push(`${cur.id}：画面に「分からない」が見えている`);
  await sleep(hold);
  cur.segs.at(-1).to = now();
  clips.push(cur);
  cur = null;
}

// ===== 録画（CDP の screencast） =====
async function record(page, name) {
  const dir = path.join(RAW, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const cdp = await page.context().newCDPSession(page);
  const rec = { name, page, frames: [], stop:() => cdp.send('Page.stopScreencast').catch(() => {}) };
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = path.join(dir, `${String(rec.frames.length).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    rec.frames.push({ t: metadata.timestamp ?? now(), file });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: W * DPR, maxHeight: H * DPR });
  recs.push(rec);
  return rec;
}
const recs = [];

/** 場面を mp4 にする。コマは届いた時刻のまま並べ、30fps に直す。大きさの違うコマ（Mac のアプリ）は縮めて真ん中に置く */
function encode(c) {
  const list = [];
  for (const s of c.segs) {
    const fr = s.rec.frames;
    if (!fr.length) throw new Error(`${c.id}：${s.rec.name} のコマがありません`);
    const i = Math.max(0, fr.findLastIndex((f) => f.t <= s.from));
    const seq = [fr[i], ...fr.slice(i + 1).filter((f) => f.t < s.to)];
    seq.forEach((f, k) => {
      const d = (k + 1 < seq.length ? seq[k + 1].t : s.to) - (k ? f.t : s.from);
      if (d > 0) list.push(`file '${f.file}'\nduration ${d.toFixed(4)}`);
    });
  }
  const txt = path.join(RAW, `${c.id}.ffconcat`);
  fs.writeFileSync(txt, `ffconcat version 1.0\n${list.join('\n')}\n${list.at(-1).split('\n')[0]}\n`);
  const vf = `scale='min(${W * DPR},iw)':'min(${H * DPR},ih)':force_original_aspect_ratio=decrease,pad=${W * DPR}:${H * DPR}:-1:-1:color=0xF2F1EE,setsar=1,format=yuv420p`;
  execSync(`ffmpeg -y -loglevel error -f concat -safe 0 -i '${txt}' -vf "${vf}" -fps_mode cfr -r 30 -c:v libx264 -preset medium -crf 16 -movflags +faststart '${path.join(CLIPS, `${c.id}.mp4`)}'`);
}

// ===== ブラウザ =====
/** いちばん新しい Chrome for Testing（Playwright の版に合うものがなくても動かす。ヘッドレスでも GPU を使う） */
function chromePath() {
  const dir = path.join(process.env.HOME, 'Library/Caches/ms-playwright');
  const v = fs.readdirSync(dir).filter((d) => /^chromium-\d+$/.test(d)).sort((a, b) => Number(a.slice(9)) - Number(b.slice(9))).at(-1);
  if (!v) throw new Error('Chrome for Testing がありません（~/Library/Caches/ms-playwright/chromium-*）');
  return path.join(dir, v, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
}

/** 録画用のカーソル（ヘッドレスの録画にはカーソルが写らないので、点を描く。押すと縮む） */
function cursorScript() {
  if (window.__recCursor) return;
  window.__recCursor = true;
  const add = () => {
    const d = document.createElement('div');
    d.style.cssText = 'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:rgba(18,52,59,.85);'
      + 'border:2.5px solid #fff;box-shadow:0 1px 6px rgba(0,0,0,.4);pointer-events:none;z-index:2147483647;transition:transform .06s linear;transform:translate(-99px,-99px)';
    document.body.append(d);
    let x = -99, y = -99, s = 1;
    const put = () => { d.style.transform = `translate(${x}px,${y}px) scale(${s})`; };
    addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; put(); }, true);
    addEventListener('mousedown', () => { s = 0.68; put(); }, true);
    addEventListener('mouseup', () => { s = 1; put(); }, true);
  };
  if (document.body) add(); else addEventListener('DOMContentLoaded', add);
}

/** /api の応答を、そのとき録っている場面に入れる。画面が保存したファイルも場面の名前で残す */
function watch(page) {
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (!cur || !/^\/api\/(chat$|op\/|share\/|recipe\/[^/]+\/run$)/.test(u.pathname)) return;
    const c = cur, key = c.n++ ? `${c.id}:${c.n}` : c.id;
    r.json().then((j) => { if (cur === c || clips.includes(c)) results[key] = j; }, () => {});
  });
  page.on('download', (d) => {
    if (!cur) return;
    const name = `${cur.id}${cur.downloads.length ? `-${cur.downloads.length + 1}` : ''}${path.extname(d.suggestedFilename())}`;
    cur.downloads.push(`clips/${name}`);
    pending.push(d.saveAs(path.join(CLIPS, name)));
  });
}
const pending = [];

/** 窓の中を 1280x720 にする（新しいヘッドレスは窓の大きさに上の枠が入るので、差の分だけ窓を広げる） */
async function fitWindow(page) {
  const [w, h] = await page.evaluate(() => [innerWidth, innerHeight]);
  if (w === W && h === H) return;
  const cdp = await page.context().newCDPSession(page);
  const { windowId, bounds } = await cdp.send('Browser.getWindowForTarget');
  await cdp.send('Browser.setWindowBounds', { windowId, bounds: { width: bounds.width + W - w, height: bounds.height + H - h } });
  await sleep(300);
}

async function openPage(ctx, url = '/') {
  const page = await ctx.newPage();
  watch(page);
  await fitWindow(page);
  await page.goto(BASE + url);
  const [w, h, dpr] = await page.evaluate(() => [innerWidth, innerHeight, devicePixelRatio]);
  if (w !== W || h !== H || dpr !== DPR) throw new Error(`画面の大きさが ${w}x${h}@${dpr} です（${W}x${H}@${DPR} にしたい）`);
  await ready(page);
  await page.mouse.move(900, 430);
  mouse.set(page, [900, 430]);
  return page;
}
const ready = async (page) => {
  await page.waitForFunction(() => window.map?.getSource('marks') && window.map.loaded() && window.map.areTilesLoaded(), null, { timeout: 60000 });
  await page.evaluate(() => document.fonts.ready);
};
/** page.evaluate(fn) が真になるまで待つ（waitForFunction は Promise を待たないので getData() を使う条件はここで） */
async function until(page, fn, ms = 20000) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(200)) if (await page.evaluate(fn)) return true;
  return false;
}
const hasHere = async () => (await window.map.getSource('here').getData()).features.length === 1;
/** 地図の動きとタイルの読み込みが落ち着くまで待つ */
async function settle(page, ms = 20000) {
  for (const t = Date.now(); Date.now() - t < ms; await sleep(150)) {
    if (await page.evaluate(() => !window.map.isMoving() && window.map.loaded() && window.map.areTilesLoaded())) break;
  }
  await page.evaluate(() => new Promise((r) => { window.map.once('idle', r); window.map.triggerRepaint(); }));
}

/** 動画（demo.html）は録画の右に約束の欄と ③ の札（Claudeが読んだ／地図のデータが答えた）を重ねる。札は録画の右から約 435px。
 *  ルートや印が札の下に入らないよう、地図の右に余白を足す（画面の fitBounds はこの余白も避ける）。見えている範囲は変えない */
const OVERLAY_RIGHT = 380;
async function padForOverlays(page) {
  const moved = await page.evaluate((R) => {
    const m = window.map, c = m.getContainer(), p = m.unproject([200, 200]);
    m.jumpTo({ padding: { top: 0, bottom: 0, left: 0, right: R }, center: m.unproject([c.clientWidth / 2 - R / 2, c.clientHeight / 2]) });
    const q = m.project(p);
    return Math.hypot(q.x - 200, q.y - 200);
  }, OVERLAY_RIGHT);
  if (moved > 1) throw new Error(`地図の余白を足したら表示が ${moved.toFixed(1)}px 動いた`);
  await settle(page);
}

// ===== 人の手の動き =====
const mouse = new WeakMap();
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);
/** カーソルを見える速さで動かす（Playwright の steps は待たずに動くので、自分で刻む） */
async function glide(page, x, y) {
  const [x0, y0] = mouse.get(page) ?? [W / 2, H / 2];
  const n = Math.max(10, Math.min(36, Math.round(Math.hypot(x - x0, y - y0) / 22)));
  for (let i = 1; i <= n; i++) {
    const k = ease(i / n);
    await page.mouse.move(x0 + (x - x0) * k, y0 + (y - y0) * k);
    await sleep(16);
  }
  mouse.set(page, [x, y]);
}
async function clickOn(page, sel) {
  const loc = page.locator(sel).last();
  await loc.waitFor({ state: 'visible', timeout: 30000 });
  const b = await loc.boundingBox();
  await glide(page, b.x + b.width / 2, b.y + b.height / 2);
  await sleep(180);
  await page.mouse.down();
  await sleep(90);
  await page.mouse.up();
}
/** 結果パネルをホイールで動かし、sel（最後のもの）をパネルの中に見せる */
async function wheelTo(page, sel) {
  const p = await page.locator('#panel').boundingBox();
  await glide(page, p.x + p.width * 0.62, p.y + Math.min(p.height * 0.55, 380));
  for (let i = 0; i < 80; i++) {
    const v = await page.evaluate((s) => {
      const e = [...document.querySelectorAll(s)].at(-1), a = e?.getBoundingClientRect(), b = document.querySelector('#panel').getBoundingClientRect();
      return !a ? 0 : a.top < b.top + 8 ? -1 : a.bottom > b.bottom - 8 ? 1 : 0;
    }, sel);
    if (!v) return;
    await page.mouse.wheel(0, v * 80);
    await sleep(60);
  }
}

/** limit（Overpass が混んでいる）なら 60秒待って1回だけやり直す */
const hasLimit = (j) => [j, ...(j?.steps ?? [])].some((s) => s && s.ok === false && s.error?.code === 'limit');
async function retryOnLimit(act) {
  const j = await act();
  if (!hasLimit(j)) return j;
  notes.push(`${cur.id}：Overpass の limit。60秒待ってやり直した`);
  console.log(`  ${cur.id}：limit。60秒待ってやり直します`);
  await sleep(60000);
  restart();
  await sleep(600);
  return act();
}

/** 札（AI を通さない）を押す。marks：sent・answered（2つ目からは sent2…） */
async function chip(page, word, k = '') {
  return retryOnLimit(async () => {
    const res = page.waitForResponse((r) => r.url().includes('/api/op/find_features'), { timeout: 60000 });
    await clickOn(page, `#chips .chip[data-word="${word}"]`);
    mark(`sent${k}`);
    const r = await res;
    const j = await r.json();
    mark(`answered${k}`);
    await page.waitForFunction(() => !document.querySelector('#chips .chip[aria-busy]') && !document.querySelector('#panel').hidden);
    await settle(page);
    return j;
  });
}

/** 検索の欄に日本語の依頼を打って送る。marks：typed・sent・answered */
async function ask(page, text) {
  return retryOnLimit(async () => {
    await clickOn(page, '#q');
    await sleep(350);
    mark('typing');
    await page.keyboard.type(text, { delay: 105 });
    mark('typed');
    await sleep(600);
    const res = page.waitForResponse((r) => r.url().endsWith('/api/chat'), { timeout: 240000 });
    await page.keyboard.press('Enter');
    mark('sent');
    const j = await (await res).json();
    mark('answered');
    await page.waitForFunction((t) => document.querySelector('#panel .req')?.textContent.includes(t), text.slice(0, 12), { timeout: 30000 });
    await settle(page);
    return j;
  });
}

const ctxOpts = (geo) => ({
  viewport: null, locale: 'ja-JP', timezoneId: 'Asia/Tokyo', acceptDownloads: true,
  ...(geo ? { permissions: ['geolocation'], geolocation: HERE } : {}),
});

// ===== 場面 =====
async function chipsScenes(browser) {
  const ctx = await browser.newContext(ctxOpts(true));
  await ctx.addInitScript(cursorScript);
  const page = await openPage(ctx);
  const rec = await record(page, 'chips');
  await sleep(800);

  // 札を押すと AI を通さずに地図に出る（郵便局。続けて手土産。次の「郵便局だけ残して」で手土産が消える）
  begin('s1-chips', rec);
  await sleep(900);
  await chip(page, 'post_office');
  await sleep(1400);
  await chip(page, 'souvenir', '2');
  await end(2200);

  // 表示の操作 (e)
  begin('s2-view', rec);
  await sleep(700);
  await ask(page, TEXT.view);
  await end(2500);
  await ctx.close();
}

// 座標を貼る（③ 日本ファースト）。画面の中で読んで、その場所へ動き、地点の札に平面直角座標と地域メッシュが出る。
// AI を通さないので、この場面では /api/chat を1回も呼ばないことを確かめる
async function coordScene(browser) {
  const ctx = await browser.newContext(ctxOpts(false));
  await ctx.addInitScript(cursorScript);
  const page = await openPage(ctx);
  await padForOverlays(page);
  let chats = 0;
  page.on('request', (r) => { if (new URL(r.url()).pathname === '/api/chat') chats++; });
  const rec = await record(page, 'coord');
  await sleep(800);
  begin('s2b-coord', rec);
  await sleep(600);
  await clickOn(page, '#q');
  await sleep(300);
  mark('typing');
  await page.keyboard.insertText(TEXT.coord); // 貼りつけ（1度に入る）
  mark('typed');
  await sleep(700);
  await page.keyboard.press('Enter');
  mark('sent');
  const pop = page.locator('.poi-pop').last();
  await pop.waitFor({ state: 'visible', timeout: 20000 });
  await settle(page);
  const card = await pop.innerText();
  if (!/平面直角/.test(card) || !/地域メッシュ/.test(card)) throw new Error(`地点の札に座標が出ていない：${card.slice(0, 80)}`);
  if (chats) throw new Error(`座標を貼ったのに /api/chat を ${chats}回呼んだ`);
  results['s2b-coord'] = { card, chats };
  await end(2600);
  await ctx.close();
}

let shareUrl;
async function ex1Scenes(browser) {
  const ctx = await browser.newContext(ctxOpts(true));
  await ctx.addInitScript(cursorScript);
  const page = await openPage(ctx);
  await padForOverlays(page);
  const rec = await record(page, 'ex1');
  await sleep(800);

  begin('s3-ex1', rec);
  await sleep(800);
  await clickOn(page, '#locate'); // 現在地（撮影用に品川駅 高輪口）
  mark('click');
  if (!await until(page, hasHere)) notes.push('例1：現在地のボタンで現在地が出なかった');
  await settle(page);
  mark('located');
  await sleep(1200);
  await ask(page, TEXT.ex1);
  await sleep(1500);
  if (!await page.locator('#panel .share input').count()) { // Claude が共有リンクを作らなかったときだけ、ボタンで作る
    notes.push('例1：Claude が共有リンクを作らなかったので、共有リンクのボタンを押した');
    await wheelTo(page, '#panel [data-act=share]');
    await clickOn(page, '#panel [data-act=share]');
    mark('click2');
    await page.locator('#panel .share input').waitFor({ timeout: 30000 });
  }
  await wheelTo(page, '#panel .share');
  mark('share');
  shareUrl = await page.locator('#panel .share input').last().inputValue();
  await end(3000);

  // 共有リンクを、まっさらな別のブラウザで開く
  const ctx2 = await browser.newContext(ctxOpts(false));
  await ctx2.addInitScript(cursorScript);
  const p2 = await ctx2.newPage();
  watch(p2);
  await fitWindow(p2);
  const rec2 = await record(p2, 'share');
  begin('s3b-share', rec2);
  cur.url = shareUrl;
  await p2.goto(shareUrl);
  await ready(p2);
  await p2.mouse.move(900, 430);
  mouse.set(p2, [900, 430]);
  await p2.locator('#banner').waitFor({ state: 'visible' });
  await settle(p2);
  mark('loaded');
  await sleep(1500);
  await glide(p2, 760, 360);
  await end(2500);
  await ctx2.close();

  // 例1の結果の「詳細」を開いて外部通信の記録。例2の「詳細」は車線数（参考）の「分からない（データなし）」が出るので使わない（動画では見せない。ユーザーが決定）
  begin('s5-adv', rec);
  await sleep(600);
  await wheelTo(page, '#panel details.adv > summary');
  await clickOn(page, '#panel details.adv > summary');
  mark('click');
  await sleep(500);
  await wheelTo(page, '#panel .net');
  mark('net');
  await end(3500);
  await ctx.close();
}

async function ex2Scenes(browser) {
  const ctx = await browser.newContext(ctxOpts(true));
  await ctx.addInitScript(cursorScript);
  const page = await openPage(ctx);
  // 録る前に：現在地（here:）を入れ、北品川の範囲を出す
  await page.click('#locate');
  if (!await until(page, hasHere)) throw new Error('例2：現在地が出ません');
  await page.mouse.move(900, 430);
  await settle(page);
  await page.evaluate(([w, s, e, n, width]) => window.map.jumpTo({ center: [(w + e) / 2, (s + n) / 2], zoom: Math.log2((width * 360) / (512 * (e - w))) }), [...KITASHINAGAWA, W]);
  await settle(page);
  const view = await page.evaluate(() => window.map.getBounds().toArray().flat().map((x) => Math.round(x * 1e6) / 1e6));
  const rec = await record(page, 'ex2');
  await sleep(800);

  // (b) 踏切とトンネル（AI を通さない札。まとめた数）
  begin('s4-feat', rec);
  cur.view = view;
  await sleep(900);
  await chip(page, 'level_crossing');
  await sleep(1400);
  await chip(page, 'tunnel', '2');
  await end(2500);

  // (c) 条件つきの試走コース → 条件の確認
  // 先に地図を2段引いて、品川駅を画面に入れる（北品川の範囲に駅は入っていない。11/6 の1回目の録画では、Claude が品川駅を
  // 画面の範囲（view:）で探し、駅ではなくバスの路線だけが見つかって、コースを作らずに止まった）。eval の c07 も品川のあたりの画面で測っている
  await padForOverlays(page); // 札の場面（s4-feat）の範囲は変えないので、ここで足す
  begin('s4-ex2', rec);
  await sleep(700);
  for (const k of ['', '2']) {
    await clickOn(page, '#zout');
    mark(`zoom${k}`);
    await settle(page);
    await sleep(350);
  }
  cur.view = await page.evaluate(() => window.map.getBounds().toArray().flat().map((x) => Math.round(x * 1e6) / 1e6));
  await sleep(500);
  await ask(page, TEXT.ex2);
  await sleep(1500); // 依頼に「資料用の画像」があれば、画面が画像を作って保存する
  await end(3000);

  // (d) 資料用の画像（出典とデータ時点が入る）
  begin('s4b-png', rec);
  await sleep(600);
  await wheelTo(page, '#panel [data-act=png]');
  const dl = page.waitForEvent('download', { timeout: 30000 });
  await clickOn(page, '#panel [data-act=png]');
  mark('click');
  await dl;
  await Promise.all(pending);
  mark('saved');
  await end(2000);

  // レシピ → 「Claude を使わずに再実行」。「詳細」は閉じたまま（このブラウザでは開いていない。開くと車線数の「分からない（データなし）」が出る）
  begin('s5-recipe', rec);
  await sleep(600);
  await wheelTo(page, '#panel [data-act=recipe]');
  await clickOn(page, '#panel [data-act=recipe]');
  mark('click');
  await page.locator('#panel .recipe a').waitFor({ timeout: 30000 });
  await wheelTo(page, '#panel .recipe');
  mark('saved');
  await sleep(1400);
  const popup = ctx.waitForEvent('page');
  await clickOn(page, '#panel .recipe a');
  const rp = await popup;
  watch(rp);
  const run = rp.waitForResponse((r) => /\/api\/recipe\/[^/]+\/run$/.test(new URL(r.url()).pathname), { timeout: 180000 });
  const rec2 = await record(rp, 'recipe');
  switchTo(rec2);
  mark('sent');
  await rp.mouse.move(900, 430);
  mouse.set(rp, [900, 430]);
  await run;
  mark('answered');
  await ready(rp);
  await rp.locator('#panel .net').waitFor({ state: 'attached', timeout: 60000 });
  await settle(rp);
  if (await rp.locator('#panel details.adv[open]').count()) throw new Error('レシピの画面で「詳細」が開いています');
  await end(3500);
  await Promise.all(pending);
  await ctx.close();
}

/**
 * アプリの地図のデータ（desktop/main.mjs の <userData>/data/<日時>/region.json と current.json）を、kotozute-setup の開発用のデータを指す形で置く。
 * データ時点は本物の値のまま（KOTOZUTE_BUILD_FAKE は OSM のデータ時点を今の日時にするので、動画の出典に作った日付が出る。使わない）。
 * 住所の DuckDB だけは写す（scripts/setup/app-data-build.ts の試しと同じ。abrg が開くため。APFS の複製でディスクを使わない）
 */
function appData(userData) {
  const r = JSON.parse(fs.readFileSync(path.join(SETUP, 'data/region.json'), 'utf8'));
  const abs = (p) => (p ? path.resolve(SETUP, p) : p);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-'); // desktop/main.mjs と同じ名前の形
  const dir = path.join(userData, 'data', stamp);
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(abs(r.abr_cache), path.join(dir, 'abrg.duckdb'), fs.constants.COPYFILE_FICLONE);
  const { abrg_bin: _, ...region } = {
    ...r, tiles: abs(r.tiles), osm_index: abs(r.osm_index), boundary: abs(r.boundary), valhalla_config: abs(r.valhalla_config),
    abr_cache: path.join(dir, 'abrg.duckdb'), osm_backend: 'sqlite',
  };
  fs.writeFileSync(path.join(dir, 'region.json'), JSON.stringify(region, null, 2) + '\n');
  fs.writeFileSync(path.join(userData, 'data/current.json'), JSON.stringify({ dir: stamp, built_at: new Date().toISOString() }) + '\n');
}

/** Mac のアプリ：kotozute-setup の Electron を起動し、「キーなしで使う」→ 地図 → 札。本物の窓の中身（CDP の screencast）を録る */
async function appScene() {
  // 画面（vite build の dist）がないと、アプリはエラーの窓を出して止まる（その窓は SIGTERM で閉じない）
  if (!fs.existsSync(path.join(SETUP, 'dist/index.html'))) throw new Error(`${SETUP}/dist がありません（先に npx vite build）`);
  const port = 9333;
  const userData = path.join(OUT, 'electron-userdata'); // 本物のアプリの設定（~/Library/Application Support/kotozute）に触らない
  fs.rmSync(userData, { recursive: true, force: true });
  appData(userData);
  const abrgBin = devAbrg(SETUP);
  if (!abrgBin) throw new Error(`${SETUP} に住所の道具（abrg）がありません`);
  const child = spawn('npx', ['electron', `--remote-debugging-port=${port}`, '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', 'desktop/main.mjs'],
    { cwd: SETUP, env: { ...process.env, KOTOZUTE_USER_DATA: userData, ABRG_BIN: abrgBin }, stdio: 'ignore', detached: true });
  const kill = (sig = 'SIGTERM') => { try { process.kill(-child.pid, sig); } catch {} }; // 子のサーバも同じプロセスグループ
  process.on('exit', () => kill('SIGKILL'));
  try {
    for (const t = Date.now(); ; await sleep(500)) {
      try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) break; } catch {}
      if (Date.now() - t > 180000) throw new Error('Electron が起動しません（デバッグのポートが開かない）');
    }
    const app = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const ctx = app.contexts()[0];
    const find = async (re, ms = 60000) => {
      for (const t = Date.now(); Date.now() - t < ms; await sleep(300)) {
        const p = ctx.pages().find((x) => re.test(x.url()));
        if (p) return p;
      }
      throw new Error(`窓が出ません：${re}`);
    };
    const key = await find(/key\.html$/);
    await key.waitForLoadState();
    await key.evaluate(cursorScript);
    await key.mouse.move(300, 330);
    mouse.set(key, [300, 330]);
    const rec = await record(key, 'app-key');
    await sleep(800);
    begin('s6-app', rec);
    await sleep(1200);
    await clickOn(key, '#skip');
    mark('click');
    const page = await find(/^http:\/\/127\.0\.0\.1:\d+\//, 90000);
    watch(page);
    const rec2 = await record(page, 'app-map');
    switchTo(rec2);
    await ready(page);
    await page.evaluate(cursorScript);
    await page.mouse.move(900, 430);
    mouse.set(page, [900, 430]);
    await settle(page);
    mark('loaded');
    await sleep(1500);
    await chip(page, 'post_office');
    await end(2500);
    await app.close().catch(() => {});
  } finally {
    kill();
    await sleep(3000);
    kill('SIGKILL');
  }
}

// ===== 実行 =====
const browser = await chromium.launch({
  headless: true, executablePath: chromePath(),
  args: [`--force-device-scale-factor=${DPR}`, `--window-size=${W},${H + 87}`, '--lang=ja-JP'],
});
const t0 = Date.now();
// 1つの組が失敗しても、録れた場面は書き出す（Claude を呼んだ分を捨てない）
for (const [g, fn] of [['chips', chipsScenes], ['coord', coordScene], ['ex1', ex1Scenes], ['ex2', ex2Scenes]]) {
  if (!want.includes(g)) continue;
  try { await fn(browser); } catch (e) {
    notes.push(`${g}：途中で止まった（${cur?.id ?? '場面の外'}：${e.message.split('\n')[0]}）。その場面は外した`);
    console.error(e);
    cur = null;
  }
}
await browser.close();
if (want.includes('app')) {
  try { await appScene(); } catch (e) {
    notes.push(`s6-app：録れなかった（${e.message}）。場面を外した`);
    if (cur?.id === 's6-app') cur = null;
  }
}
await Promise.all(pending);
for (const r of recs) await r.stop();

for (const c of clips) encode(c);
const evPath = path.join(OUT, 'events.json');
let ev = {};
try { ev = JSON.parse(fs.readFileSync(evPath, 'utf8')); } catch {}
const redo = new Set(want.flatMap((g) => GROUPS[g]));
const out = {
  base: BASE,
  recorded_at: new Date().toISOString(),
  viewport: { width: W, height: H, deviceScaleFactor: DPR },
  clips: [
    ...(ev.clips ?? []).filter((c) => !redo.has(c.id)),
    ...clips.map((c) => {
      const t0 = c.segs[0].from;
      return {
        id: c.id, file: `clips/${c.id}.mp4`, duration_s: +(c.segs.at(-1).to - t0).toFixed(3),
        marks: c.marks.map((m) => ({ name: m.name, t: +(m.t - t0).toFixed(3) })),
        ...(c.url ? { url: c.url } : {}), ...(c.view ? { view: c.view } : {}), ...(c.downloads.length ? { downloads: c.downloads } : {}),
      };
    }),
  ].sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id)),
  results: {
    ...Object.fromEntries(Object.entries(ev.results ?? {}).filter(([k]) => !redo.has(k.split(':')[0]))),
    ...results,
  },
};
fs.writeFileSync(evPath, `${JSON.stringify(out, null, 1)}\n`);
if (!process.env.KEEP_RAW) fs.rmSync(RAW, { recursive: true, force: true });

// ===== 報告：画面に出た数と時間 =====
const R = out.results;
const ok = (s) => (s?.ok ? s.output : null);
const ops = (j) => (j?.steps ?? []).map((s) => `${s.op}${s.ok ? '' : `（失敗：${s.error?.code}）`} ${JSON.stringify(s.input)}`);
const groupsOf = (...ks) => ks.flatMap((k) => ok(R[k])?.groups ?? []).map((g) => `${g.label} ${g.count}${g.points ? `（点 ${g.points}）` : ''}：${g.items.map((p) => p.name ?? '名前なし').join('、')}`);
const report = { elapsed_s: Math.round((Date.now() - t0) / 1000), notes };
if (R['s1-chips']) report.s1 = groupsOf('s1-chips', 's1-chips:2');
if (R['s2-view']) report.s2 = ops(R['s2-view']);
if (R['s2b-coord']) report.s2b = R['s2b-coord'].card.split('\n');
if (R['s3-ex1']) {
  const rt = R['s3-ex1'].steps?.find((s) => s.op === 'route' && s.ok)?.output;
  report.s3 = { ops: ops(R['s3-ex1']), route: rt && { minutes: rt.total.minutes, km: rt.total.km, extra_min: rt.extra_min, tried: rt.tried, from: rt.from.name, stops: rt.stops.map((s) => s.chosen.name), to: rt.to.name }, share: shareUrl, net: R['s3-ex1'].net };
}
if (R['s4-feat']) report.s4feat = groupsOf('s4-feat', 's4-feat:2');
if (R['s4-ex2']) {
  const co = R['s4-ex2'].steps?.find((s) => s.op === 'plan_course' && s.ok)?.output;
  report.s4ex2 = { ops: ops(R['s4-ex2']), attempts: co?.attempts.map((a) => ({ minutes: a.minutes, km: a.km, verdict: a.check.verdict, via: a.via.map((v) => v.name ?? '名前なし'), rows: a.check.rows.map((r) => `${r.kind}:${r.got}/${r.want ?? ''}:${r.result}`) })), chosen: co?.chosen, net: R['s4-ex2'].net };
}
if (R['s5-recipe']) report.s5recipe = { ops: ops(R['s5-recipe']), net: R['s5-recipe'].net };
if (R['s6-app']) report.s6 = groupsOf('s6-app');
const chats = Object.entries(R).filter(([, j]) => j?.steps && j.recipe === undefined);
report.claude = { chat_requests: chats.length, api_calls: chats.reduce((n, [, j]) => n + (j.net?.anthropic ?? 0), 0) };
report.clips = Object.fromEntries(out.clips.map((c) => {
  const m = Object.fromEntries(c.marks.map((x) => [x.name, x.t]));
  return [c.id, { duration_s: c.duration_s, ...(m.sent != null && m.answered != null ? { wait_s: +(m.answered - m.sent).toFixed(1) } : {}) }];
}));
console.log(JSON.stringify(report, null, 1));
console.log(`events.json：${evPath}`);
