// Mac のアプリの確認：Playwright の Electron でアプリを開き、キーの画面 → 地図 → 郵便局の札 → 窓を閉じる、を確かめる。
// 実行：node scripts/check-desktop.mjs（npm run app と同じ desktop/main.mjs を開く。data/region.json のデータを使う。なければ Overpass・Valhalla・ABR が動いていること）
//   APP=<kotozute.app/Contents/MacOS/kotozute> なら、作ったアプリ（npm run app:dist）を確かめる。作ったアプリは
//   Node の -r を受け付けず Playwright の Electron がつながらないので、「キーなし」を保存してから直接起こし、
//   アプリの窓に CDP（--remote-debugging-port、CDP_PORT 既定 18798）でつないで確かめ、終わりは窓を閉じて確かめる（キーの画面は開発中の確認で見る。同じファイル）。
//   作ったアプリでは、ルート（組み込みの Valhalla）と住所（アプリの中の abrg）でデモの例1の数字が出ること、アプリのメモリ（全部のプロセスの RSS）、
//   アプリ（と DMG=<.dmg> ならその中身）に .env とキーらしい文字列がないことも確かめる。
//   KOTOZUTE_PORT（既定 18797）は、開発中の確認では userData の port.json に書いて、アプリが覚えたポートとして使わせる（作ったアプリにはそのまま渡す）。
//   ABRG_PORT はアプリに渡す（abrg のポート）。開発中の確認の abrg は地域の設定（data/region.json）から決まる（ABRG_BIN・ABRG_CACHE_PATH があればそちら）。
// キーには試しの文字列を使う（本物のキーは使わない）。Claude API は呼ばない。
// キーとデータはふだんの場所（~/Library/Application Support/kotozute）ではなく、一時フォルダ（KOTOZUTE_USER_DATA）に置く。
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { regionLaunch } from '../src/launch.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = process.env.KOTOZUTE_PORT ?? '18797';
const BASE = `http://127.0.0.1:${PORT}`;
const ABRG_PORT = process.env.ABRG_PORT ?? '18033';
const CDP_PORT = process.env.CDP_PORT ?? '18798';
/** abrg が子のプロセスで動くはずか（作ったアプリは必ず。開発中は地域の設定か ABRG_BIN があるとき） */
const ABRG = !!process.env.APP || !!regionLaunch(ROOT).abrg;
const require = createRequire(import.meta.url);
// Playwright は check-web.mjs と同じく、require('playwright') か、グローバルの @playwright/cli の中のものを使う
function playwrightPath() {
  try { return require.resolve('playwright'); } catch {}
  return require.resolve(`${execSync('npm root -g').toString().trim()}/@playwright/cli/node_modules/playwright`);
}
const PW = playwrightPath();
const { _electron, chromium } = require(PW);
// executablePath を渡すと Playwright は自分の loader を足さない（窓につながらず止まる）ので、ここで足す
const LOADER = path.join(path.dirname(createRequire(PW).resolve('playwright-core/package.json')), 'lib/server/electron/loader.js');

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok' : 'NG'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!ok) failed++;
};

/** アプリを開く。出力（stdout と stderr）は logs に集める。ポートは KOTOZUTE_PORT ではなく、アプリが覚えたポート（port.json）で決める */
async function launch(userData) {
  const env = { ...process.env, KOTOZUTE_USER_DATA: userData, ABRG_PORT };
  delete env.KOTOZUTE_PORT;
  fs.mkdirSync(userData, { recursive: true });
  if (!fs.existsSync(path.join(userData, 'port.json'))) fs.writeFileSync(path.join(userData, 'port.json'), JSON.stringify({ port: Number(PORT) }));
  // グローバルの Playwright は electron を探せないので、Electron のパスを渡す
  const app = await _electron.launch({ executablePath: require('electron'), args: ['-r', LOADER, path.join(ROOT, 'desktop/main.mjs')], cwd: ROOT, env });
  const logs = [];
  app.process().stdout.on('data', (d) => logs.push(String(d)));
  app.process().stderr.on('data', (d) => logs.push(String(d)));
  return { app, logs };
}

/** pid の子と孫（Electron の窓の描画、サーバ、abrg） */
function descendants(pid) {
  const rows = execSync('ps -A -o pid=,ppid=').toString().trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number));
  const out = [];
  for (let q = [pid]; q.length;) {
    const p = q.shift();
    for (const [c, pp] of rows) if (pp === p) { out.push(c); q.push(c); }
  }
  return out;
}
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

async function waitMap(page) {
  await page.waitForFunction(() => window.map?.getSource('marks') && window.map.loaded() && window.map.areTilesLoaded(), null, { timeout: 30000 });
}

/** 地図の画面と API：地図 → 郵便局の札 → キーがない → 書き込む場所 → 住所 */
async function checkMain(page, userData) {
  await waitMap(page);
  check('地図が出る', true);
  const assets = await Promise.all(['/tiles/tokyo.pmtiles', '/assets/sprites/v4/light.json', '/assets/fonts/Noto%20Sans%20Regular/0-255.pbf']
    .map((u) => fetch(BASE + u, { headers: { range: 'bytes=0-15' } }).then((r) => `${u.split('/').at(-1)} ${r.status}`)));
  check('地図ファイル・アイコン・フォントをアプリの中から出す', assets.every((a) => / 20[06]$/.test(a)), assets.join('、'));
  await page.click('#chips .chip');
  await page.waitForFunction(() => !document.querySelector('#chips .chip[aria-busy]'), null, { timeout: 30000 });
  const panel = (await page.textContent('#panel'))?.replace(/\s+/g, ' ') ?? '';
  const drawn = await page.evaluate(async () => (await window.map.getSource('feat').getData()).features.length);
  check('郵便局の札：印が出る', /郵便局 \d+件/.test(panel) && drawn > 0, `${panel.match(/郵便局 \d+件/)?.[0]}、印 ${drawn}`);
  const saved = JSON.parse(fs.readFileSync(path.join(userData, 'key.json'), 'utf8'));
  check('キーなし：key.json は null', saved.key === null);
  // キーなしなら、起動した環境にキーがあってもサーバには渡らない（Claude を呼ぶ前に止まる。外へは出ない）
  const chat = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'check-desktop-0001', text: '郵便局' }) }).then((r) => r.json());
  check('キーなし：サーバにキーがない（ROOT に .env があっても）', /キー.*サーバにありません/.test(chat.error ?? ''), chat.error);
  check('書き込む場所：操作の記録は userData の logs/', fs.existsSync(path.join(userData, 'logs/ops.jsonl')));
  const op = (name, input) => page.evaluate(async ([n, i]) => (await fetch(`/api/op/${n}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'check-desktop-0002', input: i }) })).json(), [name, input]);
  const share = await op('make_share_link', {});
  check('書き込む場所：共有リンクは userData の shares/', !!share.ok && fs.existsSync(path.join(userData, 'shares', `${share.output?.id}.json`)), share.output?.id);
  if (ABRG) check('住所（abrg）が子のプロセスで動く', await fetch(`http://127.0.0.1:${ABRG_PORT}/health`).then((r) => r.ok, () => false));
  const geo = await op('geocode_address', { address: '東京都港区芝公園4-2-8' });
  check('住所：港区芝公園4-2-8 は街区の代表点', geo.ok && geo.output?.level === 'rsdtdsp_blk', geo.error?.message ?? geo.output?.level);
  const recipe = await page.evaluate(async () => (await fetch('/api/recipe', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'check-desktop-0002' }) })).json());
  check('書き込む場所：レシピは userData の recipes/', fs.existsSync(path.join(userData, 'recipes', `${recipe.id}.json`)), recipe.id ?? recipe.error);
}

/** プロセスが終わったあと：子と孫が残らない、ポートが閉じる */
async function checkGone(pid, kids, name, how) {
  await new Promise((r) => setTimeout(r, 500));
  const left = [pid, ...kids].filter(alive);
  check(`${name}：${how}とアプリと子のプロセス（${kids.length}）が残らない`, left.length === 0, left.join(','));
  check(`${name}：サーバのポートが閉じる`, await fetch(`${BASE}/`).then(() => false, () => true));
  if (ABRG) check(`${name}：abrg のポートが閉じる`, await fetch(`http://127.0.0.1:${ABRG_PORT}/health`).then(() => false, () => true));
}

/** pid とその子と孫の RSS（MiB）：合計と、プロセスの種類ごと */
function memMiB(pid) {
  const kind = (c) => c.includes('--type=gpu-process') ? 'GPU' : c.includes('--type=renderer') ? '画面' : c.includes('--type=utility') ? 'utility'
    : c.includes('src/server/main.ts') ? 'サーバ' : /\/abrg serve$/.test(c) ? 'abrg' : c.includes('--type=') ? 'その他' : 'main';
  const parts = {};
  for (const l of execSync(`ps -o rss=,command= -p ${[pid, ...descendants(pid)].join(',')}`).toString().trim().split('\n')) {
    const [, kb, cmd] = l.trim().match(/^(\d+)\s+(.*)$/);
    parts[kind(cmd)] = (parts[kind(cmd)] ?? 0) + Number(kb) / 1024;
  }
  const total = Object.values(parts).reduce((a, x) => a + x, 0);
  return `${Math.round(total)} MiB（${Object.entries(parts).map(([k, v]) => `${k} ${Math.round(v)}`).join('、')}）`;
}

/** 例1（docs/plan.md §7）：現在地（品川駅 高輪口）→ 郵便局 → 手土産の店 → 港区芝公園4-2-8。AI を通さずに /api/op で回す（scripts/golden.ts の demo:ex1 と同じ入力） */
async function checkExample1(page) {
  const api = (p, body) => page.evaluate(async ([u, b]) => (await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })).json(), [p, body]);
  const sessionId = 'check-desktop-0004';
  await api('/api/context', { sessionId, here: { coord: [139.7379847, 35.6288086], accuracy_m: 30 } });
  const geo = await api('/api/op/geocode_address', { sessionId, input: { address: '東京都港区芝公園4-2-8' } });
  check('例1：住所はアプリの中の abrg（127.0.0.1）が答える', geo.ok && geo.output?.place?.ref === 'abr:1' && geo.net?.hosts?.['127.0.0.1'] === 1 && geo.net.other === 0 && geo.net.anthropic === 0,
    `${geo.output?.place?.name ?? geo.error?.message}、${JSON.stringify(geo.net?.hosts)}`);
  const r = await api('/api/op/route', { sessionId, input: { from: 'here:', to: 'abr:1', stops: [{ ref: null, word: 'post_office' }, { ref: null, word: 'souvenir' }], keep_order: true, avoid_highways: false } });
  const o = r.output;
  const got = r.ok ? `${o.total.minutes}分・${o.total.km}km、${o.stops.map((x) => x.chosen.name).join(' → ')} → ${o.to.name}` : r.error?.message;
  check('例1：ルートは 7.3分・3.65km（泉岳寺駅前郵便局 → 文銭堂 → 東京都港区芝公園4丁目2）', got === '7.3分・3.65km、泉岳寺駅前郵便局 → 文銭堂 → 東京都港区芝公園4丁目2', got);
  // 組み込みの Valhalla と SQLite の検索データなら、ルートの間にサーバは HTTP の要求を1つも出さない（Docker の Valhalla や Overpass なら localhost に出る）
  check('例1：ルートと寄り先の検索で HTTP の要求がない（組み込みの Valhalla、SQLite）', r.ok && Object.keys(r.net?.hosts ?? { x: 1 }).length === 0, JSON.stringify(r.net?.hosts));
}

/** 作ったアプリの中（と dmg の中）に .env とキーらしい文字列がない */
function scanSecrets(dir, name) {
  const envs = execSync(`find "${dir}" \\( -name .env -o -name '.env.*' \\) -print`).toString().trim();
  check(`${name}：.env がない`, envs === '', envs.split('\n').slice(0, 3).join('、'));
  // Anthropic の API キーは全部のファイルで探す。秘密鍵（PEM の見出しだけの行）、AWS・GitHub・Slack のトークンはテキストのファイルだけで探す
  // （Electron と abrg のバイナリには、偶然の AKIA… の並びと、TLS の PEM の見出しの文字列がある。11/6 に確かめた）。grep は見つからないと 1 で終わる
  const grep = (opts, pat) => { try { return execSync(`grep ${opts} '${pat}' "${dir}"`, { maxBuffer: 1 << 24 }).toString().trim(); } catch (e) { if (e.status !== 1) throw e; return ''; } };
  const hits = [grep('-rlaE', 'sk-ant-[A-Za-z0-9_-]{10,}'), grep('-rlIE', '^-----BEGIN [A-Z ]*PRIVATE KEY-----$|AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9]{36}|xox[abprs]-[A-Za-z0-9-]{10,}')].filter(Boolean).join('\n');
  check(`${name}：キーらしい文字列がない`, hits === '', hits.split('\n').slice(0, 5).join('、'));
}

/** 作ったアプリ（APP）：キーなしを保存 → 直接起こす → アプリの窓に CDP でつなぐ → 窓を閉じる */
async function checkPackaged() {
  const appDir = fs.realpathSync(path.resolve(process.env.APP, '../../..')); // <名前>.app（ps は /tmp を /private/tmp で出す）
  scanSecrets(appDir, '作ったアプリ');
  if (process.env.DMG) {
    const mnt = path.join(tmp, 'dmg');
    fs.mkdirSync(mnt);
    execSync(`hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "${mnt}" "${process.env.DMG}"`, { stdio: 'ignore' });
    try { scanSecrets(mnt, 'dmg の中'); } finally { execSync(`hdiutil detach "${mnt}"`, { stdio: 'ignore' }); }
  }
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'key.json'), JSON.stringify({ key: null }));
  const t0 = Date.now();
  const app = spawn(process.env.APP, [`--remote-debugging-port=${CDP_PORT}`], { env: { ...process.env, KOTOZUTE_USER_DATA: userData, KOTOZUTE_PORT: PORT, ABRG_PORT }, stdio: 'ignore' });
  const exited = new Promise((r) => app.once('exit', (code, signal) => r(signal ?? code)));
  for (; Date.now() - t0 < 30000; await new Promise((r) => setTimeout(r, 50))) {
    if (await fetch(`${BASE}/`).then((r) => r.ok, () => false)) break;
  }
  check('作ったアプリ：起こしてからサーバが答えるまで5秒以内', Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`);
  let page;
  for (const t = Date.now(); !page && Date.now() - t < 15000; await new Promise((r) => setTimeout(r, 100))) {
    page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith(`${BASE}/`));
  }
  check('作ったアプリ：窓が開く（キーなしで使う。キーの画面は出ない）', !!page && browser.contexts().flatMap((c) => c.pages()).length === 1, page?.url());
  if (!page) throw new Error('アプリの窓が見つかりません');
  await waitMap(page);
  await new Promise((r) => setTimeout(r, 3000));
  const idle = memMiB(app.pid);
  const kids = descendants(app.pid);
  const abrgCmd = execSync(`ps -o command= -p ${kids.join(',')}`).toString().split('\n').find((c) => /\/abrg serve$/.test(c.trim())) ?? '';
  check('作ったアプリ：abrg はアプリの中のもの', abrgCmd.trim().startsWith(path.join(appDir, 'Contents/Resources/app/')), abrgCmd.trim().replace(appDir, '<app>'));
  await checkMain(page, userData);
  await checkExample1(page);
  console.log(`メモリ（アプリの全部のプロセスの RSS）：地図を出して3秒待つ ${idle}／確かめたあと ${memMiB(app.pid)}`);
  // 地図の窓を閉じる（画面の window.close()）→ アプリが終わり、子のプロセスも止まる
  const left = descendants(app.pid);
  await page.evaluate(() => window.close()).catch(() => {});
  const how = await Promise.race([exited, new Promise((r) => setTimeout(() => r('10秒で終わらない'), 10000))]);
  await browser.close().catch(() => {});
  if (how === '10秒で終わらない') app.kill('SIGTERM');
  await checkGone(app.pid, left, '作ったアプリ', `窓を閉じる（${how}）`);
}

/** 地図の窓を閉じる → アプリと子のプロセスが全部終わる */
async function closeAndCheck(app, name) {
  const pid = app.process().pid;
  const kids = descendants(pid);
  const exited = new Promise((r) => app.process().once('exit', r));
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.getTitle() !== 'Claude API のキー')?.close()).catch(() => {});
  await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
  await checkGone(pid, kids, name, '窓を閉じる');
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kotozute-desktop-'));
const DUMMY = `kz-check-dummy-${randomBytes(6).toString('hex')}`; // 試しの文字列（本物のキーではない）
let open;
try {
  if (process.env.APP) {
    await checkPackaged();
  } else {
    // ===== 1. 初めて開く → キーなしで使う → 地図と札 =====
    {
      const userData = path.join(tmp, 'nokey');
      const t0 = Date.now();
      open = await launch(userData);
      const { app } = open;
      const keyWin = await app.firstWindow();
      await keyWin.waitForSelector('#key');
      check('キーの画面：見出し', (await keyWin.textContent('h1'))?.includes('Claude API のキー'));
      check('キーの画面：入力は伏せ字', await keyWin.getAttribute('#key', 'type') === 'password');
      check('キーの画面：キーなしで使う', (await keyWin.textContent('#skip')) === 'キーなしで使う');
      const t1 = Date.now();
      // 押すとキーの画面が閉じるので、click の失敗（閉じた画面）は気にしない
      const [page] = await Promise.all([app.waitForEvent('window'), keyWin.click('#skip').catch(() => {})]);
      await page.waitForLoadState('load');
      const startMs = Date.now() - t1;
      check('起動：キーを選んでから窓まで5秒以内', startMs < 5000, `${startMs} ms、開いてから ${Date.now() - t0} ms`);
      check('地図の窓：前に使ったポート（port.json）で開く', page.url().startsWith(BASE), page.url());
      await checkMain(page, userData);
      await closeAndCheck(app, 'キーなし');
      open = undefined;
    }

    // ===== 2. キーを入れる → 画面にも記録にも出ない → メニューで変える =====
    const userData = path.join(tmp, 'withkey');
    {
      open = await launch(userData);
      const { app, logs } = open;
      const keyWin = await app.firstWindow();
      await keyWin.click('button.primary');
      check('キーの画面：空なら止める', (await keyWin.textContent('#msg')) === 'キーを入れてください');
      await keyWin.fill('#key', DUMMY);
      check('キーの画面：入れたキーが文字として出ない', !(await keyWin.evaluate(() => document.body.innerText)).includes(DUMMY));
      const [page] = await Promise.all([app.waitForEvent('window'), keyWin.click('button.primary').catch(() => {})]);
      await waitMap(page);
      const file = fs.readFileSync(path.join(userData, 'key.json'), 'utf8');
      check('キー：保存したファイルは暗号化（平文がない）', !!JSON.parse(file).key && !file.includes(DUMMY));
      check('キー：ファイルは本人だけ読める（600）', (fs.statSync(path.join(userData, 'key.json')).mode & 0o777) === 0o600);
      check('キー：地図の画面に出ない', !(await page.content()).includes(DUMMY));
      // メニューの「API キーを変える」→ 前のキーは入っていない。閉じれば今のキーのまま
      const next = app.waitForEvent('window');
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('change-key').click());
      const keyWin2 = await next;
      await keyWin2.waitForSelector('#key');
      check('キーを変える：前のキーは入っていない', (await keyWin2.inputValue('#key')) === '' && !(await keyWin2.content()).includes(DUMMY));
      await keyWin2.close();
      check('キーを変える：閉じてもキーはそのまま', fs.readFileSync(path.join(userData, 'key.json'), 'utf8') === file);
      await closeAndCheck(app, 'キーあり');
      check('キー：アプリの出力（記録）に出ない', !logs.join('').includes(DUMMY), `${logs.join('').length} 文字`);
      open = undefined;
    }

    // ===== 3. 2回目に開く → キーの画面を出さずに地図（保存したキーを読めた）→ メニューで「キーなし」に変える =====
    {
      open = await launch(userData);
      const { app, logs } = open;
      const page = await app.firstWindow();
      await waitMap(page);
      check('2回目：キーの画面を出さない', page.url().startsWith(BASE) && (await app.windows()).length === 1, page.url());
      const next = app.waitForEvent('window');
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('change-key').click());
      const keyWin = await next;
      await keyWin.waitForSelector('#skip');
      await Promise.all([page.waitForEvent('load', { timeout: 20000 }), keyWin.click('#skip').catch(() => {})]); // サーバを起こし直して、地図を読み直す
      await waitMap(page);
      check('キーを変える：キーなしにすると key.json は null', JSON.parse(fs.readFileSync(path.join(userData, 'key.json'), 'utf8')).key === null);
      const chat = await fetch(`${BASE}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'check-desktop-0003', text: '郵便局' }) }).then((r) => r.json());
      check('キーを変える：起こし直したサーバにキーがない', /キー.*サーバにありません/.test(chat.error ?? ''), chat.error);
      await closeAndCheck(app, '2回目');
      check('2回目：出力にキーが出ない', !logs.join('').includes(DUMMY));
      open = undefined;
    }
  }
} catch (e) {
  check('最後まで回る', false, e.message.split('\n')[0]);
} finally {
  if (open) await open.app.close().catch(() => {});
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `check-desktop: NG ${failed}` : 'check-desktop: ok');
process.exit(failed ? 1 : 0);
