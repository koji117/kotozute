// ことづての Mac のアプリ（Electron の main）。
// キーの画面 → 地図のデータがなければ「地図のデータ」の画面（初めて。取って作り終えるまで待つ）
// → ポートを決める（前に使ったポートが空いていれば同じもの。port.json）→ 住所（abrg serve）→ アプリのサーバ（Electron の Node で src/server/main.ts を tsx で動かす）
// → / が 200 になるまで待つ → 窓を出す。窓を閉じたら子のプロセスを全部止めて終わる。
// 地図のデータ（検索・ルート・地図・住所）はアプリに入れず、アプリが取って作る（設計書 §17。scripts/setup/app-data-build.ts を子のプロセスで動かす）。
//   置き場所は <userData>/data/<作った日時>/、今のものは <userData>/data/current.json。ダウンロードの途中のものは <userData>/data/cache/（次は続きから取る）。
//   サーバには REGION_FILE（今のデータの region.json）を、abrg にはアプリの中の bin/abrg を渡す（src/launch.mjs）。
//   開発中（npm run app）は bin/ がないので、npm run setup が作った abrg（devAbrg）を使う。
//   メニュー「地図のデータ…」の「最新にする」：作るあいだは前のデータで使える。できたら切り替えて、abrg とサーバを起こし直し、画面を読み直し、前のデータを消す。
//   失敗したら前のデータのまま。
// 環境変数（OSM_BACKEND、OSM_INDEX、VALHALLA_MODE、VALHALLA_CONFIG、ABRG_BIN、ABRG_CACHE_PATH、ABR_URL）があればそちら（開発用）。
// 書き込む場所（共有リンク、レシピ、操作の記録、書き出し、キー、ポート、地図のデータ）は ~/Library/Application Support/kotozute/。
// Claude API のキーは safeStorage（キーチェーンの鍵）で暗号化して保存し、サーバには環境変数で渡す。画面とログには出さない。
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { abrgServe, devAbrg, regionLaunch, waitHttp } from '../src/launch.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // リポジトリと同じ並び（アプリでは Contents/Resources/app）
app.setPath('userData', process.env.KOTOZUTE_USER_DATA ?? join(app.getPath('appData'), 'kotozute')); // 確認用のスクリプトは別の場所にする
const DATA = app.getPath('userData');
const KEY_FILE = join(DATA, 'key.json');
const PORT_FILE = join(DATA, 'port.json');
const MAP_DATA = join(DATA, 'data');
const CURRENT_FILE = join(MAP_DATA, 'current.json');
const CACHE = join(MAP_DATA, 'cache');
const STAMP = /^\d{8}-\d{6}$/; // データのフォルダの名前（作った日時、UTC）
// アプリの中の abrg（scripts/app-data.mjs が入れる）。開発中は bin/ がないので、npm run setup が作ったもの
const ABRG_BIN = process.env.ABRG_BIN || (existsSync(join(ROOT, 'bin/abrg')) ? join(ROOT, 'bin/abrg') : devAbrg(ROOT));
const PRELOAD = join(ROOT, 'desktop/preload.cjs'); // sandbox と contextIsolation は既定（有効）のまま

let win; // 地図の窓
let keyWin; // キーの画面（出ているときだけ）
let dataWin; // 地図のデータの画面（出ているときだけ）
let server; // アプリのサーバの子のプロセス
let abrg; // 住所の検索の子のプロセス
let builder; // 地図のデータを作る子のプロセス（作っているときだけ）
let job = null; // 作っている（か、最後に作った）ときの様子。地図のデータの画面に出す
let firstRun; // 初めてのデータを待っているとき：作り終えたら true、やめたら false で呼ぶ
let key; // 保存したキー（null＝キーなしで使う）
let port;
let abrUrl;
let quitting = false;
const children = new Set();

// ===== キー =====

/** 保存したキー。undefined＝まだ選んでいない（か、読めない）、null＝キーなしで使う */
function loadKey() {
  try {
    const { key } = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
    return key === null ? null : safeStorage.decryptString(Buffer.from(key, 'base64'));
  } catch {
    return undefined;
  }
}

function saveKey(key) {
  if (key && !safeStorage.isEncryptionAvailable()) throw new Error('この Mac ではキーを暗号化して保存できません');
  mkdirSync(DATA, { recursive: true });
  writeFileSync(KEY_FILE, JSON.stringify({ key: key ? safeStorage.encryptString(key).toString('base64') : null }), { mode: 0o600 });
}

/** キーの画面を出す。文字列＝保存する、null＝キーなしで使う、undefined＝選ばずに閉じた */
function askKey() {
  return new Promise((resolve) => {
    const w = keyWin = new BrowserWindow({
      width: 620, height: 420, resizable: false, title: 'Claude API のキー', parent: win, modal: !!win,
      webPreferences: { preload: PRELOAD },
    });
    w.setMenuBarVisibility(false);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      keyWin = undefined;
      ipcMain.removeHandler('key');
      resolve(v);
      if (!w.isDestroyed()) w.close();
    };
    // 画面から受けるのは「保存するキー」か null（キーなし）だけ。形が違えば false を返し、画面が直してもらう
    ipcMain.handle('key', (e, v) => {
      if (e.sender !== w.webContents) return false;
      const ok = v === null || (typeof v === 'string' && /^\S{1,500}$/.test(v.trim()));
      if (ok) finish(v && v.trim());
      return ok;
    });
    w.on('closed', () => finish(undefined));
    w.loadFile(join(ROOT, 'desktop/key.html'));
  });
}

// ===== 地図のデータ =====

/** 今のデータ { dir, built_at, file, region }。ない、読めない、ファイルが欠けていれば null */
function currentData() {
  try {
    const { dir, built_at } = JSON.parse(readFileSync(CURRENT_FILE, 'utf8'));
    if (typeof dir !== 'string' || !STAMP.test(dir)) return null;
    const file = join(MAP_DATA, dir, 'region.json');
    const region = JSON.parse(readFileSync(file, 'utf8'));
    const files = [region.tiles, region.osm_index, region.valhalla_config, region.abr_cache];
    if (!files.every((f) => typeof f === 'string' && isAbsolute(f) && existsSync(f))) return null;
    return { dir, built_at: typeof built_at === 'string' ? built_at : null, file, region };
  } catch {
    return null;
  }
}

/** current.json を書く（書きかけを読ませないよう、横に書いてから置き換える） */
function writeCurrent(c) {
  mkdirSync(MAP_DATA, { recursive: true });
  writeFileSync(`${CURRENT_FILE}.tmp`, JSON.stringify(c) + '\n');
  renameSync(`${CURRENT_FILE}.tmp`, CURRENT_FILE);
}

/** 前に止まった回の残り（作りかけ、消しきれなかった前のデータ）を消す。作っている子がいないときだけ呼ぶ */
function cleanStale() {
  const cur = currentData()?.dir;
  try {
    for (const d of readdirSync(MAP_DATA)) if (STAMP.test(d) && d !== cur) rmSync(join(MAP_DATA, d), { recursive: true, force: true });
  } catch {}
}

/** 地図のデータの画面に出す様子。mode：first＝初めて（データがない）、update＝メニューから */
function dataState() {
  const c = currentData();
  return {
    mode: c ? 'update' : 'first',
    current: c && { osm_as_of: c.region.osm_as_of, tiles_as_of: c.region.tiles_as_of, built_at: c.built_at },
    job,
  };
}
const pushState = () => { if (dataWin && !dataWin.webContents.isDestroyed()) dataWin.webContents.send('data:state', dataState()); };

function openDataWindow() {
  if (dataWin) return dataWin.focus(); // 1つだけ
  const w = dataWin = new BrowserWindow({ width: 640, height: 700, resizable: false, title: '地図のデータ', parent: win, webPreferences: { preload: PRELOAD } });
  w.setMenuBarVisibility(false);
  w.webContents.on('will-navigate', (e) => e.preventDefault()); // この画面はリンクを持たない
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  // 初めてのときに閉じたら、アプリを終わる（作っている途中なら止める）。メニューから開いたときは、閉じても作り続ける
  w.on('closed', () => { dataWin = undefined; firstRun?.(false); });
  w.loadFile(join(ROOT, 'desktop/data.html'));
}

/** 初めて：地図のデータの画面を出し、作り終えるのを待つ。true＝できた、false＝やめた */
function waitFirstData() {
  return new Promise((resolve) => {
    firstRun = (ok) => { firstRun = undefined; resolve(ok); };
    openDataWindow();
  });
}

/** 子のプロセスを止める。データを作る子はプロセスのグループごと（中で動く valhalla_build_tiles や pmtiles も止める） */
function kill(p) {
  try { if (p.group) process.kill(-p.pid, 'SIGTERM'); else p.kill(); } catch {}
}

/** 地図のデータを作り始める（作っているときは何もしない） */
function startBuild() {
  if (builder) return false;
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-');
  const out = join(MAP_DATA, stamp);
  const j = job = { status: 'running', steps: [], step: null, got: 0, total: 0, error: null }; // 子の出力はこの j に書く（初めてのあとで job を空にしても困らない）
  // キーらしい名前の環境変数は渡さない（作るのに Claude は使わない）
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/KEY|TOKEN|SECRET|PASSWORD/i.test(k)));
  const args = ['--disable-warning=ExperimentalWarning', '--import', 'tsx', join(ROOT, 'scripts/setup/app-data-build.ts'), '--out', out, '--cache', CACHE];
  const p = builder = spawn(process.execPath, args, {
    cwd: ROOT, env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true, // detached：グループごと止めるため
  });
  p.group = true;
  children.add(p);
  let region;
  let err = '';
  // 子が出す1行1つの JSON。形が違う行は記録に出すだけ
  createInterface({ input: p.stdout }).on('line', (line) => {
    let m;
    try { m = JSON.parse(line); } catch { return console.log(`[データ] ${line}`); }
    if (m?.type === 'step' && typeof m.id === 'string' && Array.isArray(m.steps)) {
      const steps = m.steps.filter((s) => typeof s?.id === 'string' && typeof s?.title === 'string').map(({ id, title }) => ({ id, title }));
      Object.assign(j, { step: m.id, steps, got: 0, total: 0 });
    } else if (m?.type === 'progress' && Number.isFinite(m.got) && Number.isFinite(m.total)) Object.assign(j, { got: m.got, total: m.total });
    else if (m?.type === 'error' && typeof m.msg === 'string') j.error = m.msg;
    else if (m?.type === 'done' && typeof m.region === 'string') region = m.region;
    else return console.log(`[データ] ${typeof m?.msg === 'string' ? m.msg : line}`);
    pushState();
  });
  p.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
  p.on('error', () => {}); // 起動できないときも close が来る
  p.on('close', async (code, signal) => {
    children.delete(p);
    builder = undefined;
    if (quitting) return; // 作りかけは次に開いたときに消す（cleanStale）
    if (code !== 0 || region !== join(out, 'region.json')) {
      rmSync(out, { recursive: true, force: true }); // 作りかけは消す。ダウンロードは cache に残り、次は続きから取る
      if (!p.stopping && !j.error && err) console.error(`[データ] ${err.trim()}`);
      Object.assign(j, p.stopping ? { status: 'stopped', error: null } : { status: 'error', error: j.error ?? `地図のデータを作る途中で止まりました（${code ?? signal}）` });
      return pushState();
    }
    try {
      await useData(stamp);
      j.status = 'done';
    } catch (e) {
      Object.assign(j, { status: 'error', error: e.message });
    }
    pushState();
  });
  pushState();
  return true;
}

/** 作ったデータ（stamp）に切り替える。初めてのときは待っている起動に返すだけ。失敗したら前のデータに戻して、作ったものを消す */
async function useData(stamp) {
  const old = currentData();
  writeCurrent({ dir: stamp, built_at: new Date().toISOString() });
  let restarted = false;
  try {
    if (!currentData()) throw new Error('作ったデータに、そろっていないファイルがあります');
    if (firstRun) return firstRun(true); // サーバは起動の続きで起こす
    restarted = true;
    await stopServices();
    await startServices();
  } catch (e) {
    if (old) writeCurrent({ dir: old.dir, built_at: old.built_at });
    else rmSync(CURRENT_FILE, { force: true });
    if (restarted) await stopServices().then(startServices).catch(fail); // 前のデータで起こし直す
    rmSync(join(MAP_DATA, stamp), { recursive: true, force: true });
    throw new Error(`新しいデータを使えませんでした。前のデータのままです（${e.message}）`);
  }
  win?.reload();
  if (old && old.dir !== stamp) rmSync(join(MAP_DATA, old.dir), { recursive: true, force: true }); // abrg を止めたあとで消す（DuckDB を開いていたため）
}

// 地図のデータの画面からの呼び出し。どれも引数なしで、送り主がその画面のときだけ受ける
const fromData = (e, args) => !!dataWin && e.sender === dataWin.webContents && args.length === 0;
ipcMain.handle('data:state', (e, ...a) => (fromData(e, a) ? dataState() : null));
ipcMain.handle('data:start', (e, ...a) => fromData(e, a) && startBuild());
ipcMain.handle('data:stop', (e, ...a) => {
  if (!fromData(e, a) || !builder) return false;
  builder.stopping = true;
  kill(builder);
  return true;
});
ipcMain.handle('data:quit', (e, ...a) => {
  if (!fromData(e, a)) return false;
  app.quit();
  return true;
});

// ===== 子のプロセス =====

/** 127.0.0.1 で p が空いていれば p を返す（p＝0 なら空いたポートを選ぶ）。使われていれば失敗する */
const freePort = (p = 0) => new Promise((resolve, reject) => {
  const s = createServer();
  s.once('error', reject);
  s.listen(p, '127.0.0.1', () => {
    const { port: p } = s.address();
    s.close(() => resolve(p));
  });
});

function start(name, cmd, args, env) {
  const p = spawn(cmd, args, { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  children.add(p);
  const down = (msg) => {
    children.delete(p);
    if (quitting || p.stopping || p.down) return;
    p.down = true;
    dialog.showErrorBox('ことづて', `${msg}。アプリを終了します。`);
    app.quit();
  };
  // 起動できないとき（ファイルがないなど）は exit が来ず、error だけが来る。待たずにすぐ知らせる
  p.on('error', (e) => down(`${name}を起動できませんでした（${e.message}）`));
  p.on('exit', (code, signal) => down(`${name}が止まりました（${code ?? signal}）`));
  return p;
}

function stop(p) {
  if (!p || p.exitCode !== null || p.signalCode !== null) return Promise.resolve();
  p.stopping = true;
  return new Promise((resolve) => {
    p.once('exit', resolve);
    p.kill();
  });
}

/**
 * アプリのサーバのポート。共有リンク（location.origin で作る）と画面の設定（localStorage）はポートごとなので、
 * 前に使ったポート（port.json）が空いていれば同じものを使う。使われていれば新しく選んで覚え直す。KOTOZUTE_PORT が優先
 */
async function appPort() {
  if (Number(process.env.KOTOZUTE_PORT)) return Number(process.env.KOTOZUTE_PORT);
  let p;
  try { p = await freePort(JSON.parse(readFileSync(PORT_FILE, 'utf8')).port); } catch { p = await freePort(); }
  mkdirSync(DATA, { recursive: true });
  writeFileSync(PORT_FILE, JSON.stringify({ port: p }));
  return p;
}

/** 今のデータで abrg とサーバを起こす（サーバのポートはいつも同じ） */
async function startServices() {
  const c = currentData();
  if (!c) throw new Error('地図のデータがありません');
  const launch = regionLaunch(ROOT, { ...process.env, ABRG_BIN }, c.file);
  // 住所：地域の設定に住所のデータがあれば abrg を 127.0.0.1 の空いたポートで動かす。なければ ABR_URL（既定は :3002）のまま
  abrUrl = undefined;
  if (launch.abrg) {
    const p = Number(process.env.ABRG_PORT) || await freePort();
    const a = abrgServe({ ...launch.abrg, port: p });
    abrg = start('住所の検索（abrg）', a.cmd, a.args, a.env);
    abrUrl = `http://127.0.0.1:${p}`;
    await waitHttp(`${abrUrl}/health`, 15_000);
  }
  const env = { ...process.env, ...launch.env, REGION_FILE: c.file, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), KOTOZUTE_DATA_DIR: DATA };
  // 「キーなしで使う」なら空の文字列にする（起動した環境のキーを渡さない）。消すだけだと、サーバが ROOT の .env を読んでキーが戻る。
  // process.loadEnvFile は、空でも決まっている変数を上書きしない。サーバは空のキーを「キーがない」として Claude を呼ばない
  env.ANTHROPIC_API_KEY = key ?? '';
  if (abrUrl) env.ABR_URL = abrUrl;
  server = start('アプリのサーバ', process.execPath, ['--import', 'tsx', join(ROOT, 'src/server/main.ts')], env);
  await waitHttp(`http://127.0.0.1:${port}/`, 15_000);
}

async function stopServices() {
  await Promise.all([stop(server), stop(abrg)]);
  server = abrg = undefined;
}

// ===== 窓とメニュー =====

function openWindow() {
  const origin = `http://127.0.0.1:${port}`;
  win = new BrowserWindow({ width: 1280, height: 820, title: 'ことづて' });
  // 画面が求める権限は、アプリの画面からの現在地（here:）と共有リンクのコピーだけ許す。カメラ、マイク、通知などは断る
  session.defaultSession.setPermissionRequestHandler((wc, permission, done, { requestingUrl }) => {
    done(['geolocation', 'clipboard-sanitized-write'].includes(permission) && !!requestingUrl?.startsWith(`${origin}/`));
  });
  // 出典やノートのリンクは既定のブラウザで開く（http と https だけ）。アプリの窓はアプリの画面だけを出す
  const external = (url) => { if (/^https?:\/\//.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (new URL(url).origin !== origin) { e.preventDefault(); external(url); } });
  win.on('closed', () => { win = undefined; app.quit(); });
  win.loadURL(`${origin}/`);
}

async function changeKey() {
  if (keyWin) return keyWin.focus(); // キーの画面は1つだけ
  const k = await askKey();
  if (k === undefined) return;
  saveKey(k);
  key = k;
  if (!server) return; // 初めてのデータを作っているあいだ：サーバはこのあと起こすときにキーを読む
  await stopServices(); // サーバはキーを起動のときに読むので、同じポートで起こし直す
  await startServices();
  win?.reload();
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'ことづて', submenu: [
    { id: 'change-key', label: 'API キーを変える…', click: () => changeKey().catch(fail) },
    { id: 'map-data', label: '地図のデータ…', click: () => openDataWindow() },
    { type: 'separator' },
    { label: '終了', accelerator: 'Command+Q', click: () => app.quit() },
  ] },
  { role: 'editMenu' }, // 検索の欄でコピーと貼り付けを使うため
]));

function fail(e) {
  if (quitting) return; // 終わる途中（起動中に Command+Q など）で子が止まっただけなら、エラーを出さない
  dialog.showErrorBox('ことづて', `起動できませんでした。${e.message}`);
  app.quit();
}

app.on('window-all-closed', () => {}); // 終わるのは地図の窓を閉じたとき（初めてのデータの画面を閉じたときも）だけ
app.on('before-quit', () => {
  quitting = true;
  for (const p of children) kill(p);
});

app.whenReady().then(async () => {
  cleanStale();
  key = loadKey();
  if (key === undefined) {
    key = await askKey();
    if (key === undefined) return app.quit(); // 初めての画面を選ばずに閉じた
    saveKey(key);
  }
  if (!currentData() && !(await waitFirstData())) return app.quit(); // 地図のデータの画面を閉じたか「終了」を押した
  dataWin?.close();
  job = null; // 次にメニューから開いたときは、初めての様子を出さない
  port = await appPort();
  await startServices();
  openWindow();
}).catch(fail);
