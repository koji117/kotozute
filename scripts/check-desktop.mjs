// Mac のアプリの確認：Playwright の Electron でアプリを開き、キーの画面 → 地図のデータの画面 → 作る → 地図 → 郵便局の札 → 窓を閉じる、を確かめる。
// 実行：node scripts/check-desktop.mjs（npm run app と同じ desktop/main.mjs を開く）。
//   地図のデータは本当には作らない。KOTOZUTE_BUILD_FAKE（既定は data/region.json。npm run setup で作ったもの）をアプリに渡し、
//   作る子のプロセスは進み具合だけを出して、その開発用のデータを指す region.json を書く（scripts/setup/app-data-build.ts）。
//   データの画面では、失敗の文と「もう一度」、「止める」、「終了」も確かめる。2回目に開いたときは、メニュー「地図のデータ…」の「最新にする」で切り替わることを確かめる。
//   APP=<kotozute.app/Contents/MacOS/kotozute> なら、作ったアプリ（npm run app:dist）を確かめる。作ったアプリは
//   Node の -r を受け付けず Playwright の Electron がつながらないので、「キーなし」を保存してから直接起こし、
//   アプリの窓に CDP（--remote-debugging-port、CDP_PORT 既定 18798）でつないで確かめ、終わりは窓を閉じて確かめる（キーの画面は開発中の確認で見る。同じファイル）。
//   作ったアプリでは、ルート（組み込みの Valhalla）と住所（アプリの中の abrg）でデモの例1の数字が出ること、アプリのメモリ（全部のプロセスの RSS）、
//   アプリ（と DMG=<.dmg> ならその中身）に .env とキーらしい文字列と地図のデータがないことも確かめる。
//   KOTOZUTE_PORT（既定 18797）は、開発中の確認では userData の port.json に書いて、アプリが覚えたポートとして使わせる（作ったアプリにはそのまま渡す）。
//   ABRG_PORT はアプリに渡す（abrg のポート）。開発中の確認の abrg は、アプリが自分で探すもの（bin/ がないので npm run setup が作ったもの。devAbrg）。
//   それがないとき（別のリポジトリの KOTOZUTE_BUILD_FAKE を使うとき）だけ、その地域の設定の abrg_bin を ABRG_BIN で渡す（ABRG_BIN があればそちら）。
// キーには試しの文字列を使う（本物のキーは使わない）。Claude API は呼ばない。
// キーとデータはふだんの場所（~/Library/Application Support/kotozute）ではなく、一時フォルダ（KOTOZUTE_USER_DATA）に置く。
import { execSync, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { devAbrg, regionLaunch } from '../src/launch.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = process.env.KOTOZUTE_PORT ?? '18797';
const BASE = `http://127.0.0.1:${PORT}`;
const ABRG_PORT = process.env.ABRG_PORT ?? '18033';
const CDP_PORT = process.env.CDP_PORT ?? '18798';
/** 試しのデータの元（開発用の地域の設定）。中の相対パスは、そのリポジトリの根から */
const FAKE = path.resolve(process.env.KOTOZUTE_BUILD_FAKE ?? path.join(ROOT, 'data/region.json'));
if (!fs.existsSync(FAKE)) {
  console.error(`開発用の地域の設定（${FAKE}）がありません。npm run setup -- --region=tokyo で作るか、KOTOZUTE_BUILD_FAKE=<region.json> で渡してください`);
  process.exit(1);
}
const DEV = regionLaunch(path.resolve(path.dirname(FAKE), '..'), process.env, FAKE);
/** abrg が子のプロセスで動くはずか（作ったアプリは必ず。開発中は試しの地域の設定に abrg があるとき） */
const ABRG = !!process.env.APP || !!DEV.abrg;
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
  const env = { ...process.env, KOTOZUTE_USER_DATA: userData, ABRG_PORT, KOTOZUTE_BUILD_FAKE: FAKE };
  if (DEV.abrg && !devAbrg(ROOT)) env.ABRG_BIN = DEV.abrg.bin; // ふだんは渡さず、npm run app と同じくアプリに探させる
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

/** userData の今の地図のデータ（current.json と、それが指す region.json）。なければ null */
function currentData(userData) {
  try {
    const { dir } = JSON.parse(fs.readFileSync(path.join(userData, 'data/current.json'), 'utf8'));
    return { dir, region: JSON.parse(fs.readFileSync(path.join(userData, 'data', dir, 'region.json'), 'utf8')) };
  } catch {
    return null;
  }
}
/** userData の地図のデータのフォルダ（作った日時の名前のもの） */
const dataDirs = (userData) => { try { return fs.readdirSync(path.join(userData, 'data')).filter((d) => /^\d{8}-\d{6}$/.test(d)); } catch { return []; } };
/** pid の子と孫のコマンド（地図のデータを作る子が残っていないかを見る） */
const commands = (pid) => { try { return execSync(`ps -o command= -p ${[pid, ...descendants(pid)].join(',')}`).toString(); } catch { return ''; } };
const msgIs = (w, re) => w.waitForFunction((s) => new RegExp(s).test(document.getElementById('msg').textContent), re.source, { timeout: 20000 });

/** 地図のデータの画面（初めて）で「ダウンロードして作る」を押し、地図の窓を待つ */
async function buildFirst(app, dataWin) {
  await dataWin.waitForSelector('#start:not([hidden])');
  const [page] = await Promise.all([app.waitForEvent('window', { timeout: 30000 }), dataWin.click('#start')]);
  await waitMap(page);
  return page;
}

/** 画面の出典のデータ時点が、今のデータの region.json の値（build で埋め込んだ値ではない。サーバが画面に入れる） */
async function checkDates(page, userData, name) {
  const osm = currentData(userData)?.region.osm_as_of.slice(0, 10);
  const attr = (await page.textContent('#attr'))?.replace(/\s+/g, ' ') ?? '';
  check(`${name}：画面の OSM のデータ時点は今のデータのもの`, !!osm && attr.includes(`OSM ${osm}`), `画面 ${attr.match(/OSM [\d-]+/)?.[0]}、データ ${osm}`);
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
  // 地図のデータは入れない（初めて開いたときに作る）。作る道具は入れる
  const data = execSync(`find "${appDir}" \\( -name '*.pmtiles' -o -name '*.osm.pbf' -o -name 'osm.db' -o -name '*.duckdb' -o -name 'valhalla_tiles*' -o -name region.json \\) -print`).toString().trim();
  check('作ったアプリ：地図のデータが入っていない', data === '', data.split('\n').slice(0, 3).join('、').replaceAll(appDir, '<app>'));
  const res = path.join(appDir, 'Contents/Resources/app');
  const tools = ['bin/abrg', 'bin/pmtiles', 'bin/pmtiles-LICENSE', 'node_modules/@valhallajs/valhallajs/darwin/arm64/valhalla_build_tiles', 'node_modules/pmtiles/package.json', 'scripts/setup/app-data-build.ts'];
  const missing = tools.filter((f) => !fs.existsSync(path.join(res, f)));
  check('作ったアプリ：データを作る道具がある（abrg、pmtiles とライセンスの文、valhalla_build_tiles）', missing.length === 0, missing.join('、'));
  const userData = path.join(tmp, 'app');
  fs.mkdirSync(userData, { recursive: true });
  fs.writeFileSync(path.join(userData, 'key.json'), JSON.stringify({ key: null }));
  const t0 = Date.now();
  const app = spawn(process.env.APP, [`--remote-debugging-port=${CDP_PORT}`], {
    env: { ...process.env, KOTOZUTE_USER_DATA: userData, KOTOZUTE_PORT: PORT, ABRG_PORT, KOTOZUTE_BUILD_FAKE: FAKE }, stdio: 'ignore',
  });
  const exited = new Promise((r) => app.once('exit', (code, signal) => r(signal ?? code)));
  const pages = (b) => b.contexts().flatMap((c) => c.pages());
  let browser, dataPage, page;
  for (; !dataPage && Date.now() - t0 < 30000; await new Promise((r) => setTimeout(r, 100))) {
    browser ??= await chromium.connectOverCDP(`http://127.0.0.1:${CDP_PORT}`).catch(() => undefined);
    dataPage = browser && pages(browser).find((p) => p.url().endsWith('/desktop/data.html'));
  }
  check('作ったアプリ：地図のデータの画面が5秒以内に出る（キーなしで使う。キーの画面は出ない）', !!dataPage && Date.now() - t0 < 5000, `${Date.now() - t0} ms`);
  if (!dataPage) throw new Error('地図のデータの画面が見つかりません');
  await dataPage.waitForSelector('#start:not([hidden])');
  const t1 = Date.now();
  await dataPage.click('#start');
  for (; !page && Date.now() - t1 < 30000; await new Promise((r) => setTimeout(r, 100))) page = pages(browser).find((p) => p.url().startsWith(`${BASE}/`));
  check('作ったアプリ：作り終える（試し）と地図の窓が開く', !!page && !!currentData(userData), `${Date.now() - t1} ms`);
  if (!page) throw new Error('アプリの窓が見つかりません');
  await waitMap(page);
  await new Promise((r) => setTimeout(r, 3000));
  const idle = memMiB(app.pid);
  const kids = descendants(app.pid);
  const abrgCmd = execSync(`ps -o command= -p ${kids.join(',')}`).toString().split('\n').find((c) => /\/abrg serve$/.test(c.trim())) ?? '';
  check('作ったアプリ：abrg はアプリの中のもの', abrgCmd.trim().startsWith(path.join(appDir, 'Contents/Resources/app/')), abrgCmd.trim().replace(appDir, '<app>'));
  await checkMain(page, userData);
  await checkDates(page, userData, '作ったアプリ');
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
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find((w) => w.webContents.getURL().startsWith('http'))?.close()).catch(() => {});
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
    // ===== 0. 地図のデータがない（キーは選んである）→ データの画面 →「終了」で終わる =====
    {
      const userData = path.join(tmp, 'quit');
      fs.mkdirSync(userData, { recursive: true });
      fs.writeFileSync(path.join(userData, 'key.json'), JSON.stringify({ key: null }));
      open = await launch(userData);
      const { app } = open;
      const dataWin = await app.firstWindow();
      await dataWin.waitForSelector('#first:not([hidden])');
      const text = (await dataWin.textContent('#first')) ?? '';
      const want = ['Geofabrik', 'download.geofabrik.de', 'Protomaps', 'build.protomaps.com', 'GitHub', 'github.com', '約 500MB', '約 190MB', '約 22MB', '約 4GB', '約 1.7GB', '数分から十数分', '押したときだけ'];
      check('データの画面（初めて）：取るもの・大きさ・通信先・要る空き・時間', want.every((s) => text.includes(s)), want.filter((s) => !text.includes(s)).join('、'));
      check('データの画面（初めて）：「ダウンロードして作る」と「終了」', (await dataWin.textContent('#start')) === 'ダウンロードして作る' && await dataWin.isVisible('#quit'));
      const pid = app.process().pid;
      const kids = descendants(pid);
      const exited = new Promise((r) => app.process().once('exit', r));
      await dataWin.click('#quit').catch(() => {});
      await Promise.race([exited, new Promise((r) => setTimeout(r, 10000))]);
      await checkGone(pid, kids, '初めてのデータの画面', '「終了」を押す');
      check('「終了」：地図のデータを作っていない', dataDirs(userData).length === 0 && !currentData(userData));
      open = undefined;
    }

    // ===== 1. 初めて開く → キーなしで使う → データの画面（失敗、止める、もう一度）→ 地図と札 =====
    {
      const userData = path.join(tmp, 'nokey');
      open = await launch(userData);
      const { app } = open;
      const keyWin = await app.firstWindow();
      await keyWin.waitForSelector('#key');
      check('キーの画面：見出し', (await keyWin.textContent('h1'))?.includes('Claude API のキー'));
      check('キーの画面：入力は伏せ字', await keyWin.getAttribute('#key', 'type') === 'password');
      check('キーの画面：キーなしで使う', (await keyWin.textContent('#skip')) === 'キーなしで使う');
      // 押すとキーの画面が閉じるので、click の失敗（閉じた画面）は気にしない
      const [dataWin] = await Promise.all([app.waitForEvent('window'), keyWin.click('#skip').catch(() => {})]);
      await dataWin.waitForSelector('#start:not([hidden])');
      check('キーのあと：地図のデータの画面（初めて）が出る', await dataWin.isVisible('#first') && !(await app.windows()).some((w) => w.url().startsWith('http')));
      // 失敗：試しのデータの元がない → 赤い文と「もう一度」
      await app.evaluate(() => { process.env.KOTOZUTE_BUILD_FAKE = '/nonexistent/kotozute-check/region.json'; });
      await dataWin.click('#start');
      await dataWin.waitForSelector('#msg.ng', { timeout: 20000 });
      const err = await dataWin.textContent('#msg');
      check('データの画面：失敗の文と「もう一度」', /ありません/.test(err ?? '') && (await dataWin.textContent('#start')) === 'もう一度' && dataDirs(userData).length === 0, err);
      // 止める：作る子とその作りかけが消え、「もう一度」
      await app.evaluate((_e, f) => { process.env.KOTOZUTE_BUILD_FAKE = f; }, FAKE);
      await dataWin.click('#start');
      await dataWin.waitForSelector('#stop:not([hidden])');
      await dataWin.click('#stop');
      await msgIs(dataWin, /^止めました/);
      check('データの画面：止める → 作る子と作りかけが残らず、「もう一度」', !commands(app.process().pid).includes('app-data-build') && dataDirs(userData).length === 0
        && (await dataWin.textContent('#start')) === 'もう一度');
      const t1 = Date.now();
      const page = await buildFirst(app, dataWin);
      check('作る（試し）：押してから地図が出るまで15秒以内', Date.now() - t1 < 15000, `${Date.now() - t1} ms`);
      check('作る：今のデータが1つだけ（current.json）', !!currentData(userData) && dataDirs(userData).length === 1, dataDirs(userData).join('、'));
      check('地図の窓：前に使ったポート（port.json）で開く', page.url().startsWith(BASE), page.url());
      await checkMain(page, userData);
      await checkDates(page, userData, '初めて');
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
      const [dataWin] = await Promise.all([app.waitForEvent('window'), keyWin.click('button.primary').catch(() => {})]);
      const page = await buildFirst(app, dataWin);
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

    // ===== 3. 2回目に開く → キーの画面とデータの画面を出さずに地図（保存したキーとデータを読めた）→ メニューで「キーなし」に変える → 地図のデータを最新にする =====
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
      // メニューの「地図のデータ…」→ 今のデータ時点 →「最新にする」→ 切り替えて画面を読み直し、前のデータを消す
      const before = currentData(userData);
      const next2 = app.waitForEvent('window');
      await app.evaluate(({ Menu }) => Menu.getApplicationMenu().getMenuItemById('map-data').click());
      const dataWin = await next2;
      await dataWin.waitForSelector('#update:not([hidden])');
      check('地図のデータ…：今のデータ時点と「最新にする」', (await dataWin.textContent('#osm')) === before?.region.osm_as_of.slice(0, 10)
        && (await dataWin.textContent('#tiles')) === before?.region.tiles_as_of.slice(0, 10) && (await dataWin.textContent('#start')) === '最新にする',
        `${await dataWin.textContent('#osm')}、${await dataWin.textContent('#built')}`);
      await Promise.all([page.waitForEvent('load', { timeout: 30000 }), dataWin.click('#start')]);
      await waitMap(page);
      await msgIs(dataWin, /^最新にしました/);
      const after = currentData(userData);
      check('最新にする：新しいデータに切り替え、前のデータを消す', !!after && after.dir !== before?.dir && !fs.existsSync(path.join(userData, 'data', before?.dir ?? 'x'))
        && dataDirs(userData).length === 1, `${before?.dir} → ${after?.dir}、${dataDirs(userData).join('、')}`);
      await checkDates(page, userData, '最新にする');
      const geo = await page.evaluate(async () => (await fetch('/api/op/geocode_address', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'check-desktop-0005', input: { address: '東京都港区芝公園4-2-8' } }) })).json());
      check('最新にする：起こし直した住所（abrg）が新しいデータで答える', geo.ok === true, geo.error?.message);
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
