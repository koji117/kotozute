// 画面の確認：vite（:5199。/api・/tiles・/assets は :8787 へ）を起動し、Playwright で開いて配置と動きを確かめる。
// 実行：node scripts/check-web.mjs（kotozute のサーバが :8787 で動いていること）
//   WEB_BASE=http://localhost:8790 node scripts/check-web.mjs なら vite を使わず、そのサーバ（vite build の dist と /api）を確かめる。
// Playwright は require('playwright') で探し、なければグローバルの @playwright/cli の中のものを使う。
// /api がまだない（404）ときは、API を使う確認を「失敗の表示」の確認に切り替える。
import { execSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const OUT = '/private/tmp/claude-501/kotozute-web-shots';
const PORT = 5199;
const BASE = process.env.WEB_BASE ?? `http://localhost:${PORT}`;
const NO_GEO = '位置情報が使えません。地図をクリックして場所を指定できます';
fs.mkdirSync(OUT, { recursive: true });

const require = createRequire(import.meta.url);
function playwright() {
  try { return require('playwright'); } catch {}
  return require(`${execSync('npm root -g').toString().trim()}/@playwright/cli/node_modules/playwright`);
}

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'ok' : 'NG'}  ${name}${extra ? `  (${extra})` : ''}`);
  if (!ok) failed++;
};

const vite = process.env.WEB_BASE ? null
  : spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'ignore', detached: true });
const stopVite = () => { try { if (vite) process.kill(-vite.pid, 'SIGTERM'); } catch {} };
process.on('exit', stopVite);

async function waitHttp(url, ms = 30000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`${url} が起動しません`);
}

const { chromium } = playwright();
let browser;
let courseRes; // 試走コースの応答（デスクトップで作り、スマホでも使う）
try {
  await waitHttp(`${BASE}/`);
  const api = await fetch(`${BASE}/api/context`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId: 'check-web-00000001', view: { bbox: [139.74, 35.65, 139.76, 35.67], zoom: 15 } }) });
  const apiUp = api.ok;
  console.log(`${BASE} の API: ${apiUp ? 'あり' : `なし（${api.status}）`}`);

  const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  browser = await chromium.launch({ args }).catch(() => {
    // Playwright の版に合うブラウザがないときは、入っている中でいちばん新しい headless shell を使う
    const dir = `${process.env.HOME}/Library/Caches/ms-playwright`;
    const shell = fs.readdirSync(dir).filter((d) => d.startsWith('chromium_headless_shell-')).sort().at(-1);
    if (!shell) throw new Error('Chromium がありません。npx playwright install chromium を実行してください');
    return chromium.launch({ args, executablePath: `${dir}/${shell}/chrome-headless-shell-mac-arm64/chrome-headless-shell` });
  });
  const hosts = new Set();
  const open = async (opts, path = '/') => {
    const ctx = await browser.newContext({ acceptDownloads: true, ...opts });
    const page = await ctx.newPage();
    page.on('request', (r) => { const u = new URL(r.url()); if (u.protocol.startsWith('http')) hosts.add(u.hostname); });
    page.on('pageerror', (e) => check('ページの JS エラーなし', false, e.message));
    await page.goto(BASE + path);
    // 地図の読み込みと、自前のタイルが実際に描かれたこと
    await page.waitForFunction(() => window.map?.getSource('marks') && window.map.loaded() && window.map.areTilesLoaded(), null, { timeout: 30000 });
    await page.evaluate(() => document.fonts.ready);
    return page;
  };
  const box = (page, sel) => page.locator(sel).first().boundingBox();
  const text = async (page, sel) => (await page.locator(sel).first().textContent())?.replace(/\s+/g, ' ').trim() ?? '';
  // waitForFunction は Promise を待たないので、getData() を使う条件はここで繰り返し調べる
  const until = async (page, fn, ms = 15000) => {
    for (const t = Date.now(); Date.now() - t < ms; await page.waitForTimeout(200)) if (await page.evaluate(fn)) return true;
    return false;
  };
  const overlap = (a, b) => a && b && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

  // ===== デスクトップ 1280x720 =====
  const page = await open({ viewport: { width: 1280, height: 720 } });
  check('地図のタイルが描かれる', await page.evaluate(() => window.map.queryRenderedFeatures().length > 50));
  check('landcover を使わない', await page.evaluate(() => !window.map.getStyle().layers.some((l) => l['source-layer'] === 'landcover')));
  check('M PLUS 1 を自前で読む', await page.evaluate(() => document.fonts.check('500 16px "M PLUS 1"', 'ことづて')));
  await page.screenshot({ path: `${OUT}/desktop-start.png` });

  const search = await box(page, '#search');
  check('検索：左上、幅 440px', search && Math.abs(search.x - 16) < 2 && Math.abs(search.width - 440) < 2, JSON.stringify(search));
  check('検索：送るボタン', await page.locator('#search button[type=submit][aria-label]').count() === 1);
  const chips = await page.locator('#chips .chip').allTextContents();
  check('札：5つ（郵便局から）', chips.length === 5 && chips[0] === '郵便局', chips.join(','));
  const chip0 = await box(page, '#chips .chip');
  check('札：検索の右', chip0 && chip0.x > search.x + search.width && chip0.y < search.y + search.height);
  for (const id of ['#locate', '#zin', '#zout']) {
    const b = await box(page, id);
    check(`地図のボタン ${id}：右下`, b && b.x > 1280 - 80 && b.y > 360);
  }
  const status = await text(page, '.status');
  check('状態の札：地域だけ（外部通信は「詳細」へ）', status.includes('東京都（島しょ部を除く）') && !status.includes('外部通信'), status);
  const attr = await text(page, '#attr');
  check('出典：OSM・Protomaps・データ時点', attr.includes('© OpenStreetMap contributors') && attr.includes('Protomaps') && attr.includes('データ時点：OSM'), attr);
  check('出典のリンク先', await page.locator('#attr a[href="https://www.openstreetmap.org/copyright"]').count() === 1);
  const br = await box(page, '.br');
  check('右下の札が検索・札と重ならない', !overlap(br, search) && !overlap(br, await box(page, '#chips')));
  check('横スクロールなし', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check('結果パネルは最初は閉じている', await page.locator('#panel').isHidden());

  // 拡大ボタン
  const z0 = await page.evaluate(() => window.map.getZoom());
  await page.click('#zin');
  await page.waitForFunction((z) => Math.abs(window.map.getZoom() - z - 1) < 0.01 && !window.map.isMoving(), z0);
  check('拡大ボタンで1段拡大', true);

  // 現在地：許可がないとき
  await page.click('#locate');
  await page.locator('#toast').waitFor({ state: 'visible' });
  check('位置情報が使えないときの案内', (await text(page, '#toast')) === NO_GEO, await text(page, '#toast'));

  // 札（AI を通さない）
  await page.click('#chips .chip');
  await page.locator('#panel').waitFor({ state: 'visible' });
  await page.waitForFunction(() => !document.querySelector('#chips .chip[aria-busy]'));
  const panelText = await text(page, '#panel');
  if (apiUp) {
    check('札：パネルに「郵便局 N件」', /郵便局 \d+件/.test(panelText), panelText.slice(0, 80));
    check('札：押した札が点灯', await page.locator('#chips .chip').first().getAttribute('aria-pressed') === 'true');
    const n = Number(panelText.match(/郵便局 (\d+)件/)?.[1]);
    const drawn = await page.evaluate(async () => (await window.map.getSource('feat').getData()).features.length);
    check('札：件数と地図の印の数が同じ', n === drawn, `${n} / ${drawn}`);
    const net = await text(page, '#panel details.adv .net');
    check('外部通信の記録：札の結果の「詳細」の中にある', net.includes('外部通信の記録（この操作の間）') && /api\.anthropic\.com\s?0件/.test(net) && /その他の外部\s?0件/.test(net), net);
    check('詳細：はじめは閉じている', await page.locator('#panel details.adv').evaluate((d) => !d.open));
    const mainText = await page.evaluate(() => { const p = document.querySelector('#panel').cloneNode(true); p.querySelector('details.adv')?.remove(); return p.textContent; });
    check('詳細：OSM のタグは本体に出さず「詳細」に出す', !mainText.includes('amenity=') && (await text(page, '#panel details.adv')).includes('amenity=post_office'), mainText.match(/amenity=.{0,30}/)?.[0]);
  } else {
    check('札：API がないときはエラーを出す', panelText.includes('サーバに接続できません'), panelText.slice(0, 80));
  }
  const pbox = await box(page, '#panel');
  check('結果パネル：検索の下、幅 440px', pbox && pbox.y > search.y + search.height && Math.abs(pbox.width - 440) < 2, JSON.stringify(pbox));
  check('結果パネル：画面の中に収まる', pbox && pbox.y + pbox.height <= 720 - 16 + 1);
  check('ルートがないときは「GPX（社内用）」を出さない', await page.locator('#panel [data-act=gpx]').isHidden());
  await page.screenshot({ path: `${OUT}/desktop-panel.png` });

  // 資料用の画像：地図の下に白い帯と出典が入る
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('#panel [data-act=png]')]);
  const png = fs.readFileSync(await dl.path());
  fs.writeFileSync(`${OUT}/export.png`, png);
  const cv = await page.evaluate(() => ({ w: window.map.getCanvas().width, h: window.map.getCanvas().height }));
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  check('画像：地図と同じ幅で、下に帯がある', w === cv.w && h > cv.h, `${w}x${h} / 地図 ${cv.w}x${cv.h}`);
  const ink = await page.evaluate(async ({ b64, mapH }) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const d = g.getImageData(img.width / 2, mapH, img.width / 2, img.height - mapH).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] < 160) dark++;
    return dark;
  }, { b64: png.toString('base64'), mapH: cv.h });
  check('画像：帯の右側に出典の文字が描かれている', ink > 200, `暗い画素 ${ink}`);

  if (apiUp) {
    // 共有リンク → 別の画面で読み取りのみで開く
    await page.click('#panel [data-act=share]');
    await page.locator('#panel .share input').waitFor();
    const url = await page.locator('#panel .share input').inputValue();
    check('共有リンク：?s=<id> の URL', /\/\?s=\w+$/.test(url), url);
    const shared = await open({ viewport: { width: 1280, height: 720 } }, new URL(url).pathname + new URL(url).search);
    check('共有リンク：帯「共有された地図（読み取りのみ）」', await until(shared, () => document.querySelector('#banner')?.textContent === '共有された地図（読み取りのみ）'));
    const n = Number(panelText.match(/郵便局 (\d+)件/)?.[1]);
    check('共有リンク：同じ印が出る', await until(shared, async () => (await window.map.getSource('feat').getData()).features.length > 0) || n === 0);
    await shared.screenshot({ path: `${OUT}/desktop-shared.png` });

    await page.click('#chips .chip');
    check('札：もう一度押すと隠す', await page.locator('#chips .chip').first().getAttribute('aria-pressed') === 'false'
      && await page.evaluate(async () => (await window.map.getSource('feat').getData()).features.length === 0));
  }

  // 地図のクリック → クリック1
  await page.mouse.click(900, 400);
  if (apiUp) {
    check('クリックした点に「クリック1」', await until(page, async () => (await window.map.getSource('marks').getData()).features.some((f) => f.properties.label === 'クリック1')));
  } else {
    const ok = await page.waitForFunction(() => document.querySelector('#toast')?.textContent?.includes('サーバに接続できません'), null, { timeout: 5000 }).then(() => true, () => false);
    check('クリック：API がないときは案内を出す', ok, await text(page, '#toast'));
  }

  // 「今いる場所から」の依頼で現在地が使えないとき：Claude に送らず、理由と次の手を出す（送ると住所だけ調べて黙って止まる）
  let chatCalls = 0;
  await page.route('**/api/chat', (r) => { chatCalls++; return r.fulfill({ json: { steps: [], stop: 'done' } }); });
  await page.fill('#q', '今いる場所から郵便局に寄って港区芝公園4-2-8へ');
  await page.press('#q', 'Enter');
  const noHere = await page.waitForFunction(() => document.querySelector('#panel')?.textContent.includes('依頼を送りませんでした'), null, { timeout: 20000 }).then(() => true, () => false);
  check('現在地なし：依頼を送らずに理由を出す', noHere && chatCalls === 0 && (await page.inputValue('#q')).startsWith('今いる場所から'), await text(page, '#panel'));
  await page.unroute('**/api/chat');

  // 「今いる場所から」の依頼で現在地がまだないとき：送る前に位置情報を取る
  if (apiUp) {
    const page3 = await open({ viewport: { width: 1280, height: 720 }, permissions: ['geolocation'], geolocation: { latitude: 35.6458, longitude: 139.7479, accuracy: 30 } });
    let sent = 0;
    await page3.route('**/api/chat', (r) => { sent++; return r.fulfill({ json: { steps: [], stop: 'done' } }); });
    await page3.fill('#q', '今いる場所から郵便局に寄って港区芝公園4-2-8へ');
    await page3.press('#q', 'Enter');
    const got = await page3.locator('#panel .req').waitFor({ timeout: 20000 }).then(() => true, () => false);
    check('現在地なし→許可あり：位置情報を取ってから送る', got && sent === 1 && await until(page3, async () => (await window.map.getSource('here').getData()).features.length === 1), `sent=${sent}`);
    await page3.context().close();
  }

  // 現在地：許可したとき
  const page2 = await open({ viewport: { width: 1280, height: 720 }, permissions: ['geolocation'], geolocation: { latitude: 35.6458, longitude: 139.7479, accuracy: 30 } });
  await page2.click('#locate');
  if (apiUp) {
    check('現在地：点と「現在地 半径30m」', await until(page2, async () => (await window.map.getSource('here').getData()).features[0]?.properties.label === '現在地 半径30m'));
    check('現在地：その場所へ寄る', await until(page2, () => window.map.getZoom() >= 15 && !window.map.isMoving() && window.map.areTilesLoaded()));
    const acc = await page2.evaluate(async () => JSON.stringify(await window.map.getSource('acc').getData()).slice(0, 120));
    check('現在地：精度の円', acc.includes('Polygon'), acc);
    await page2.screenshot({ path: `${OUT}/desktop-here.png` });
  } else {
    // サーバが現在地を受けなければ、here: は使えないので地図にも出さない
    check('現在地：サーバが受けないときは案内だけ', await until(page2, () => document.querySelector('#toast')?.textContent?.includes('サーバに接続できません'))
      && await page2.evaluate(async () => (await window.map.getSource('here').getData()).features.length === 0));
  }

  let noteStep = null; // OSM ノートの下書きの結果（スマホでも使う）
  // 日本語の依頼の結果パネル：Claude の代わりに、自社の ABR・Overpass・Valhalla で実際に操作した結果を /api/chat の応答として返す
  if (apiUp) {
    const steps = await page2.evaluate(async () => {
      const sessionId = window.sessionId;
      const op = async (name, input) => (await fetch(`/api/op/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, input }) })).json();
      const geo = await op('geocode_address', { address: '東京都港区芝公園4-2-8' });
      const sp = await op('search_place', { name: '東京タワー', area: 'here:' });
      const r = await op('route', { from: 'here:', to: geo.output?.place.ref ?? 'abr:1', stops: [{ ref: null, word: 'post_office' }], keep_order: true, avoid_highways: false });
      return [geo, sp, r];
    });
    check('依頼：住所・場所・ルートの操作が成功', steps.every((s) => s.ok), steps.map((s) => s.ok ? s.op : s.error.message).join(','));
    let chatRes = { steps, stop: 'done' };
    await page2.route('**/api/chat', (r) => r.fulfill({ json: chatRes }));
    await page2.fill('#q', '今いる場所から郵便局に寄って港区芝公園4-2-8へ');
    await page2.press('#q', 'Enter');
    await page2.locator('#panel .steps').waitFor();
    const t = await text(page2, '#panel');
    check('依頼：解釈に操作と入力', t.includes('解釈') && t.includes('住所：東京都港区芝公園4-2-8') && t.includes('名前：東京タワー') && t.includes('出発：現在地'), t.slice(0, 200));
    check('依頼：住所の精度', t.includes('座標の精度：'));
    check('依頼：ルートの時間と寄り道', /車\s?[\d.]+分\s?[\d.]+km/.test(t) && /寄り道で \+[\d.]+分/.test(t), t.match(/車.{0,40}/)?.[0]);
    check('依頼：入力欄を空にする', (await page2.inputValue('#q')) === '');
    const at = await text(page2, '#attr');
    check('依頼：出典に経路と住所', at.includes('Valhalla') && at.includes('アドレス・ベース・レジストリ'), at);
    check('依頼：地図に経由地と目的地', await until(page2, async () => {
      const ns = (await window.map.getSource('marks').getData()).features.map((f) => f.properties.n);
      return ns.includes('1') && ns.includes('終') && (await window.map.getSource('route').getData()).features.length > 0;
    }));
    await until(page2, () => !window.map.isMoving() && window.map.areTilesLoaded());
    await page2.screenshot({ path: `${OUT}/desktop-route.png` });

    // 2回目の依頼：検証に落ちた入力（LLM が座標を書いた）と、view: のままの表示の切り替え（地図は動かさない）
    chatRes = { stop: 'done', steps: await page2.evaluate(async () => {
      const sessionId = window.sessionId;
      const op = async (name, input) => (await fetch(`/api/op/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, input }) })).json();
      return [await op('route', { from: '35.6586,139.7454', to: 'abr:1', stops: [], keep_order: true, avoid_highways: false }), await op('set_view', { target: 'view:', show: [], hide: [] })];
    }) };
    check('2回目：座標の入力は検証で落ちる', chatRes.steps[0].ok === false && chatRes.steps[0].error.code === 'bad_input', JSON.stringify(chatRes.steps[0].error));
    const cam0 = await page2.evaluate(() => [window.map.getCenter().toArray(), window.map.getZoom()]);
    await page2.fill('#q', '品川駅のあたり。表示はこのまま');
    await page2.press('#q', 'Enter');
    await page2.waitForFunction(() => document.querySelector('#panel .req')?.textContent.includes('表示はこのまま'));
    const t2 = await text(page2, '#panel');
    check('2回目：LLM が書いた座標を画面に出さない', !t2.includes('35.6586') && t2.includes('入力が正しくありません'), t2.slice(0, 200));
    await page2.waitForTimeout(800);
    const cam1 = await page2.evaluate(() => [window.map.getCenter().toArray(), window.map.getZoom()]);
    check('2回目：set_view の view: で地図が動かない', JSON.stringify(cam0) === JSON.stringify(cam1), `${JSON.stringify(cam0)} → ${JSON.stringify(cam1)}`);
    check('2回目：住所のピンとルートは残る', await page2.evaluate(async () => (await window.map.getSource('marks').getData()).features.some((f) => f.properties.n === '終')));

    // レシピ：保存して /?r=<id> を開くと、新しいセッションで Claude を使わずに同じ操作をやり直す
    await page2.click('#panel [data-act=recipe]');
    await page2.locator('#panel .recipe a').waitFor();
    const href = await page2.locator('#panel .recipe a').getAttribute('href');
    const rc = await text(page2, '#panel .recipe');
    check('レシピ：/?r=<id> の再実行リンク', /^\/\?r=[0-9A-Za-z]{10}$/.test(href ?? ''), href);
    check('レシピ：現在地が入っている注意', rc.includes('現在地が入っています'), rc);
    for (const [name, vp] of [['desktop', { width: 1280, height: 720 }], ['mobile', { width: 390, height: 844 }]]) {
      const rp = await open({ viewport: vp, ...(name === 'mobile' ? { deviceScaleFactor: 2, isMobile: true, hasTouch: true } : {}) }, href);
      await rp.locator('#panel .net').waitFor({ state: 'attached', timeout: 60000 });
      const rt = await text(rp, '#panel');
      check(`レシピ（${name}）：Claude を使わずに再実行`, rt.includes('Claude を使わずに再実行') && rt.includes('手順') && !rt.includes('エラー'), rt.slice(0, 160));
      check(`レシピ（${name}）：保存した人の現在地を「現在地」と呼ばない`, rt.includes('レシピを保存した人の現在地') && !/現在地 半径|出発：現在地/.test(rt), rt.slice(0, 300));
      check(`レシピ（${name}）：同じルートが出る`, await until(rp, async () => (await window.map.getSource('marks').getData()).features.some((f) => f.properties.n === '終')));
      check(`レシピ（${name}）：外部通信は Claude 0件・その他 0件`, /api\.anthropic\.com\s?0件/.test(rt) && /その他の外部\s?0件/.test(rt), rt.match(/外部通信の記録.*/)?.[0]);
      check(`レシピ（${name}）：パネルに横スクロールなし`, await rp.evaluate(() => { const p = document.querySelector('#panel'); return p.scrollWidth <= p.clientWidth; }));
      await until(rp, () => !window.map.isMoving() && window.map.areTilesLoaded());
      await rp.screenshot({ path: `${OUT}/${name}-recipe.png` });
    }

    // 3回目：ピン（1回目の東京タワーの検索結果。ルートの上の場所は経路の印で出す）、GPX、画像。書き出しは画面が Blob と canvas で行う
    chatRes = { stop: 'done', steps: await page2.evaluate(async () => {
      const sessionId = window.sessionId;
      const op = async (name, input) => (await fetch(`/api/op/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, input }) })).json();
      return [await op('add_pin', { target: 'result:1' }), await op('export_route', { format: 'gpx' }), await op('export_png', {})];
    }) };
    check('3回目：ピン・GPX・画像の操作が成功', chatRes.steps.every((s) => s.ok) && chatRes.steps[2].output.mode === 'client', chatRes.steps.map((s) => s.ok ? s.op : s.error.message).join(','));
    const files = [];
    page2.on('download', (d) => files.push(d.suggestedFilename()));
    await page2.fill('#q', '東京タワーにピン。GPXと画像もください');
    await page2.press('#q', 'Enter');
    await page2.waitForFunction(() => document.querySelector('#panel .req')?.textContent.includes('GPXと画像も'));
    const t3 = await text(page2, '#panel');
    check('3回目：ピン・GPX（ODbL の注意）・画像のカード', t3.includes('ピンを立てました（全部で1本）') && t3.includes('GPX（社内用）を書き出しました') && t3.includes('ODbL の条件') && t3.includes('出典（© OpenStreetMap contributors ほか）'), t3.slice(-300));
    check('3回目：ピンは赤い印', await until(page2, async () => (await window.map.getSource('marks').getData()).features.some((f) => f.properties.color === '#B3261E')));
    for (const t = Date.now(); files.length < 2 && Date.now() - t < 20000;) await page2.waitForTimeout(200);
    check('3回目：GPX と画像をダウンロード', files.some((f) => /^kotozute-route-\d{12}\.gpx$/.test(f)) && files.some((f) => /^kotozute-\d{12}\.png$/.test(f)), files.join(','));
    check('ルートがあると「GPX（社内用）」が出る', await page2.locator('#panel [data-act=gpx]').isVisible());
    const [gpx] = await Promise.all([page2.waitForEvent('download'), page2.click('#panel [data-act=gpx]')]);
    const g = fs.readFileSync(await gpx.path(), 'utf8');
    check('GPX のボタン：ファイルに出典と ODbL', g.startsWith('<?xml') && g.includes('© OpenStreetMap contributors') && g.includes('odbl'), gpx.suggestedFilename());
    await page2.screenshot({ path: `${OUT}/desktop-pins-export.png` });

    // 4回目：OSM ノートの下書き。確認方法を選ぶまでと、止める語があるあいだはコピーできない
    noteStep = await page2.evaluate(async () => (await fetch('/api/op/draft_osm_note', { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: window.sessionId, input: { target: 'result:1', issue: 'turn_restriction' } }) })).json());
    check('ノート：下書きの操作が成功', noteStep.ok, JSON.stringify(noteStep.error));
    chatRes = { stop: 'done', steps: [noteStep] };
    await page2.fill('#q', 'ここ右折禁止なのに地図にない。ノートを書きたい');
    await page2.press('#q', 'Enter');
    await page2.locator('#panel .ncard').waitFor();
    const nt = await text(page2, '#panel .ncard');
    check('ノート：通信しない旨、何が・どこで', nt.includes('アプリはOSMと通信しない。投稿は現地を見た本人') && nt.includes('何が右左折の規制：') && nt.includes('どこで'), nt.slice(0, 160));
    const ta = page2.locator('#panel .ncard textarea');
    const copyBtn = page2.locator('#panel [data-act=note-copy]');
    check('ノート：下書きに OSM の要素の URL', /どこで：.*https:\/\/www\.openstreetmap\.org\/(node|way|relation)\/\d+/.test(await ta.inputValue()), await ta.inputValue());
    check('ノート：Googleマップは選べない（理由つき）', await page2.locator('#panel .meth label.off input').isDisabled() && (await text(page2, '#panel .meth label.off')).includes('他社の地図からの書き写しは OSM のルールでできない'));
    check('ノート：方法を選ぶまでコピーできない', await copyBtn.isDisabled());
    const link = page2.locator('#panel .ncard a.btn');
    check('ノート：OSMのノート画面へ（新しいタブ）', /^https:\/\/www\.openstreetmap\.org\/note\/new#map=19\/[\d.]+\/[\d.]+$/.test(await link.getAttribute('href'))
      && await link.getAttribute('target') === '_blank' && await link.getAttribute('rel') === 'noopener', await link.getAttribute('href'));
    await page2.locator('#panel .meth input').first().check();
    check('ノート：選んだ方法が下書きに入る', (await ta.inputValue()).endsWith('確認方法：現地で見た'), await ta.inputValue());
    check('ノート：選ぶとコピーできる', await until(page2, () => !document.querySelector('#panel [data-act=note-copy]').disabled));
    const clean = await ta.inputValue();
    await ta.fill(`${clean}（試走のとき）`);
    check('ノート：止める語で警告し、コピーできない', await until(page2, () => document.querySelector('#panel .nwarn:not([hidden])')?.textContent.includes('試走')) && await copyBtn.isDisabled());
    await page2.screenshot({ path: `${OUT}/desktop-note-blocked.png` });
    await ta.fill(clean);
    check('ノート：語を消すとコピーできる', await until(page2, () => document.querySelector('#panel .nwarn').hidden && !document.querySelector('#panel [data-act=note-copy]').disabled));
    await copyBtn.click();
    check('ノート：コピーした', await until(page2, () => document.querySelector('#toast')?.textContent === '下書きをコピーしました'), await text(page2, '#toast'));

    // 5回目 例2 試走コース：plan_course と check_route を直接呼んだ結果を /api/chat の応答にして、合否表と地図を確かめる
    courseRes = { stop: 'done', steps: await page2.evaluate(async () => {
      const sessionId = window.sessionId;
      const op = async (name, input) => (await fetch(`/api/op/${name}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, input }) })).json();
      const sp = await op('search_place', { name: '品川駅', area: 'here:' });
      const pc = await op('plan_course', { start: sp.output?.items[0]?.ref ?? 'here:', tunnels: 2, max_minutes: 60, avoid_highways: true });
      return [sp, pc, await op('check_route', { tunnels: 2, max_minutes: 60, avoid_highways: true })];
    }) };
    check('試走：場所・コース・判定の操作が成功', courseRes.steps.every((s) => s.ok), courseRes.steps.map((s) => s.ok ? s.op : s.error.message).join(','));
    chatRes = courseRes;
    await page2.fill('#q', '来週の客先試走。品川駅を出て、トンネルを2本通り、高速は使わず60分以内。');
    await page2.press('#q', 'Enter');
    await page2.locator('#panel .vt').first().waitFor();
    const t4 = await text(page2, '#panel');
    const vt = await text(page2, '#panel .vt');
    check('試走：合否表に合格と3つの行、車線数（参考）は「詳細」', /合否表\s?合格/.test(t4) && ['トンネル 2本', '高速を使わない', '60分以内'].every((s) => vt.includes(s)) && !vt.includes('車線数')
      && (await text(page2, '#panel details.adv')).includes('車線数（参考）'), vt.slice(0, 300));
    check('試走：案ごとの札（1回目・2回目）', await page2.locator('#panel .chipline span').count() === courseRes.steps[1].output?.attempts.length);
    check('試走：トンネルの数え方を出す', t4.includes('連続する tunnel=yes を1本、50m未満は数えない'));
    check('試走：解釈に出発・トンネル・時間', t4.includes('出発・到着：') && t4.includes('トンネル（本）：2') && t4.includes('時間の上限（分）：60'), t4.match(/試走コース.{0,80}/)?.[0]);
    check('試走：地図にコース、トンネルの名前、発着の印', await until(page2, async () => {
      const tun = (await window.map.getSource('tun').getData()).features.filter((f) => f.geometry.type === 'Point').map((f) => f.properties.name);
      const ns = (await window.map.getSource('marks').getData()).features.map((f) => f.properties.n);
      return tun.length >= 2 && ns.includes('発') && !ns.includes('終') && (await window.map.getSource('route').getData()).features.length >= 2;
    }));
    check('試走：出典に経路', (await text(page2, '#attr')).includes('Valhalla'));
    await until(page2, () => !window.map.isMoving() && window.map.areTilesLoaded());
    await page2.screenshot({ path: `${OUT}/desktop-course.png` });
  }

  // 共有リンクの画面（読み取りのみ）
  const page3 = await open({ viewport: { width: 1280, height: 720 } }, '/?s=check-web-none');
  await page3.waitForFunction(() => document.querySelector('#banner')?.textContent !== '');
  check('共有の画面：帯がある', await page3.locator('#banner').isVisible(), await text(page3, '#banner'));
  check('共有の画面：検索と札がない', await page3.locator('#search').isHidden() && await page3.locator('#chips').isHidden());
  check('共有の画面：出典がある', (await text(page3, '#attr')).includes('© OpenStreetMap contributors'));

  // ===== スマホ 390x844 =====
  const m = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await m.screenshot({ path: `${OUT}/mobile-start.png` });
  const ms = await box(m, '#search');
  check('スマホ：検索は全幅', ms && Math.abs(ms.x - 12) < 2 && Math.abs(ms.width - 366) < 2, JSON.stringify(ms));
  const mc = await box(m, '#chips .chip');
  check('スマホ：札は検索の下', mc && mc.y >= ms.y + ms.height);
  check('スマホ：横スクロールなし', await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const mbr = await box(m, '.br');
  check('スマホ：右下の札が画面の中', mbr && mbr.x >= 0 && mbr.y + mbr.height <= 844);
  await m.locator('#chips .chip').first().tap();
  await m.locator('#panel').waitFor({ state: 'visible' });
  await m.waitForTimeout(300);
  const sheet = await box(m, '#panel');
  check('スマホ：結果は全幅の下部シート', sheet && sheet.x === 0 && Math.abs(sheet.width - 390) < 1 && Math.abs(sheet.y + sheet.height - 844) < 1, JSON.stringify(sheet));
  const mattr = await box(m, '#attr');
  check('スマホ：出典はシートの上に見える', mattr && mattr.y + mattr.height <= sheet.y + 1, JSON.stringify(mattr));
  await m.screenshot({ path: `${OUT}/mobile-sheet.png` });
  if (noteStep?.ok) {
    await m.route('**/api/chat', (r) => r.fulfill({ json: { stop: 'done', steps: [noteStep] } }));
    await m.fill('#q', 'ノートを書きたい');
    await m.press('#q', 'Enter');
    await m.locator('#panel .ncard').waitFor();
    const tb = await box(m, '#panel .ncard textarea');
    check('スマホ：ノートの下書きが幅に収まる', tb && tb.x >= 0 && tb.x + tb.width <= 390 && await m.evaluate(() => document.documentElement.scrollWidth <= innerWidth), JSON.stringify(tb));
    check('スマホ：下書きの文字は 16px（入力で拡大しない）', await m.evaluate(() => getComputedStyle(document.querySelector('#panel .ncard textarea')).fontSize === '16px'));
    await m.screenshot({ path: `${OUT}/mobile-note.png` });
  }

  // スマホ：合否表が下部シートの幅に収まる
  if (courseRes) {
    const mc = await open({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await mc.route('**/api/chat', (r) => r.fulfill({ json: courseRes }));
    await mc.fill('#q', '品川駅を出て、トンネルを2本通り、高速は使わず60分以内');
    await mc.locator('#search button[type=submit]').tap();
    await mc.locator('#panel .vt').first().waitFor();
    const fits = await mc.evaluate(() => {
      const p = document.querySelector('#panel'), vt = document.querySelector('#panel .vt');
      return p.scrollWidth <= p.clientWidth && vt.scrollWidth <= vt.clientWidth && vt.getBoundingClientRect().right <= innerWidth;
    });
    check('スマホ：合否表がシートの幅に収まる', fits);
    await mc.screenshot({ path: `${OUT}/mobile-course.png` });
  }

  // 実行時に外へ出ていないこと（localhost だけ）
  check('通信先は localhost だけ', [...hosts].every((h) => h === 'localhost'), [...hosts].join(','));
  console.log(`画像：${OUT}`);
} catch (e) {
  check('実行', false, e.stack ?? String(e));
} finally {
  await browser?.close();
  stopVite();
}
process.exit(failed ? 1 : 0);
