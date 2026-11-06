// ことづての Mac のアプリ（Electron の main）。
// ポートを決める（前に使ったポートが空いていれば同じもの。port.json）→ 住所（abrg serve）→ アプリのサーバ（Electron の Node で src/server/main.ts を tsx で動かす）
// → / が 200 になるまで待つ → 窓を出す。窓を閉じたら子のプロセスを全部止めて終わる。
// 検索・ルート・住所のデータは、アプリの中の data/region.json から npm start と同じように決める（src/launch.mjs）。
// 環境変数（OSM_BACKEND、OSM_INDEX、VALHALLA_MODE、VALHALLA_CONFIG、ABRG_BIN、ABRG_CACHE_PATH、ABR_URL）があればそちら（開発用）。
// 書き込む場所（共有リンク、レシピ、操作の記録、書き出し、キー、ポート）は ~/Library/Application Support/kotozute/。
// Claude API のキーは safeStorage（キーチェーンの鍵）で暗号化して保存し、サーバには環境変数で渡す。画面とログには出さない。
import { app, BrowserWindow, dialog, ipcMain, Menu, safeStorage, session, shell } from 'electron';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrgServe, regionLaunch, waitHttp } from '../src/launch.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // リポジトリと同じ並び（アプリでは Contents/Resources/app）
const LAUNCH = regionLaunch(ROOT);
app.setPath('userData', process.env.KOTOZUTE_USER_DATA ?? join(app.getPath('appData'), 'kotozute')); // 確認用のスクリプトは別の場所にする
const DATA = app.getPath('userData');
const KEY_FILE = join(DATA, 'key.json');
const PORT_FILE = join(DATA, 'port.json');

let win; // 地図の窓
let keyWin; // キーの画面（出ているときだけ）
let server; // アプリのサーバの子のプロセス
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
      webPreferences: { preload: join(ROOT, 'desktop/preload.cjs') }, // sandbox と contextIsolation は既定（有効）のまま
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
  p.on('error', () => {}); // 起動できないときは exit も来る
  p.on('exit', (code, signal) => {
    children.delete(p);
    if (quitting || p.stopping) return;
    dialog.showErrorBox('ことづて', `${name}が止まりました（${code ?? signal}）。アプリを終了します。`);
    app.quit();
  });
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

/** 住所：地域の設定に abrg とそのデータがあれば 127.0.0.1 の空いたポートで動かす。なければ ABR_URL（既定は :3002）のまま */
async function startAbrg() {
  if (!LAUNCH.abrg) return;
  const p = Number(process.env.ABRG_PORT) || await freePort();
  const a = abrgServe({ ...LAUNCH.abrg, port: p });
  start('住所の検索（abrg）', a.cmd, a.args, a.env);
  abrUrl = `http://127.0.0.1:${p}`;
  await waitHttp(`${abrUrl}/health`, 15_000);
}

async function startServer(key) {
  const env = { ...process.env, ...LAUNCH.env, ELECTRON_RUN_AS_NODE: '1', PORT: String(port), KOTOZUTE_DATA_DIR: DATA };
  // 「キーなしで使う」なら空の文字列にする（起動した環境のキーを渡さない）。消すだけだと、サーバが ROOT の .env を読んでキーが戻る。
  // process.loadEnvFile は、空でも決まっている変数を上書きしない。サーバは空のキーを「キーがない」として Claude を呼ばない
  env.ANTHROPIC_API_KEY = key ?? '';
  if (abrUrl) env.ABR_URL = abrUrl;
  server = start('アプリのサーバ', process.execPath, ['--import', 'tsx', join(ROOT, 'src/server/main.ts')], env);
  await waitHttp(`http://127.0.0.1:${port}/`, 15_000);
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
  const key = await askKey();
  if (key === undefined) return;
  saveKey(key);
  await stop(server); // サーバはキーを起動のときに読むので、同じポートで起こし直す
  await startServer(key);
  win?.reload();
}

Menu.setApplicationMenu(Menu.buildFromTemplate([
  { label: 'ことづて', submenu: [
    { id: 'change-key', label: 'API キーを変える…', click: () => changeKey().catch(fail) },
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

app.on('window-all-closed', () => {}); // 終わるのは地図の窓を閉じたときだけ（キーの画面を閉じても終わらない）
app.on('before-quit', () => {
  quitting = true;
  for (const p of children) p.kill();
});

app.whenReady().then(async () => {
  let key = loadKey();
  if (key === undefined) {
    key = await askKey();
    if (key === undefined) return app.quit(); // 初めての画面を選ばずに閉じた
    saveKey(key);
  }
  port = await appPort();
  await startAbrg();
  await startServer(key);
  openWindow();
}).catch(fail);
