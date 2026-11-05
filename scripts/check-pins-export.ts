// ピンと書き出し（add_pin、make_share_link のピン、export_route、export_png）を確かめる。
// 実行：npx tsx scripts/check-pins-export.ts（Valhalla :8002 が動いていること）
//   export_png の MCP の形（サーバで画像を作る）は、Playwright があり、KOTOZUTE_BASE（既定 http://127.0.0.1:8787）の画面のサーバが動いているときだけ確かめる。
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addPin } from '../src/ops/add_pin';
import { exportPng } from '../src/ops/export_png';
import { exportRoute } from '../src/ops/export_route';
import { route } from '../src/ops/route';
import { loadShare, makeShareLink } from '../src/ops/share';
import { OpError, type OpErrorCode } from '../src/ops/types';
import { addAbr, addResult, getSession } from '../src/server/session';

process.env.EXPORT_DIR ??= join(tmpdir(), 'kotozute-check-exports');
const session = getSession('check-pins-0001');
session.view = { bbox: [139.735, 35.645, 139.765, 35.675], zoom: 14 };
// 浜松町一丁目と西新橋一丁目の信号（eval の d06 と同じ）
session.clicks = [[139.755056, 35.660042], [139.751533, 35.669721]];
const ctx = { session, source: 'direct' as const };

const pin = (target: string) => addPin.run(ctx, addPin.input.parse({ target }));
const out = (format: string) => exportRoute.run(ctx, exportRoute.input.parse({ format }));
async function fails(f: () => Promise<unknown>, code: OpErrorCode) {
  const e = await f().then(() => null, (e) => e);
  assert.ok(e instanceof OpError, `OpError にならなかった: ${e}`);
  assert.equal(e.code, code, e.message);
}
async function check(name: string, f: () => Promise<void>) {
  await f();
  console.log('ok', name);
}

const tower = addResult(session, { name: '東京タワー', coord: [139.74544, 35.658564], kind: 'place', osm: 'relation/4247312' });
const addr = addAbr(session, { name: '東京都港区芝公園4丁目2', coord: [139.7461, 35.6583], kind: 'address' });

await check('add_pin：同じ参照に2回立てても1本', async () => {
  const a = await pin(tower.ref);
  const b = await pin(tower.ref);
  assert.equal(b.count, 1);
  assert.equal(b.pin, a.pin);
  assert.equal(b.pin.name, '東京タワー'); // ピンの名前は結果の名前
  // 同じ OSM の要素：osm: の参照でも、別の検索の result:N でも1本
  assert.equal((await pin('osm:relation/4247312')).count, 1);
  const again = addResult(session, { name: '東京タワー', coord: [139.74544, 35.658564], kind: 'place', osm: 'relation/4247312' });
  assert.equal((await pin(again.ref)).count, 1);
  assert.equal((await pin('click:1')).count, 2);
  assert.deepEqual(addPin.llm(await pin(addr.ref)), { pin: { ref: addr.ref, name: addr.name }, count: 3 });
  assert.ok(!JSON.stringify(addPin.llm(await pin(tower.ref))).includes('139.'), 'LLM に座標を渡している');
});

await check('add_pin：view: と知らない参照と座標は止める、100本まで', async () => {
  await fails(() => pin('view:'), 'bad_ref');
  await fails(() => pin('result:9999'), 'bad_ref');
  assert.throws(() => addPin.input.parse({ target: '35.6586,139.7454' }));
  const s = getSession('check-pins-full');
  s.pins = Array.from({ length: 100 }, (_, i) => ({ ref: `abr:${i + 1}`, name: null, coord: [139.7, 35.6] as [number, number], kind: 'address' as const }));
  s.clicks = [[139.75, 35.66]];
  const e = await addPin.run({ session: s, source: 'direct' }, { target: 'click:1' }).then(() => null, (e) => e);
  assert.ok(e instanceof OpError && e.code === 'limit', String(e));
  s.places.set('abr:1', s.pins[0]);
  assert.equal((await addPin.run({ session: s, source: 'direct' }, { target: 'abr:1' })).count, 100); // 立っているピンは上限でも止めない
});

await check('共有リンク：住所とピン（同じ参照は1つ）、現在地のピンは名前を変える', async () => {
  session.here = { coord: [139.737985, 35.628809], accuracy_m: 30 };
  await pin('here:');
  const sh = await makeShareLink.run(ctx, {});
  assert.equal(sh.includes_here, true);
  const st = loadShare(sh.id)!;
  const refs = st.pins.map((p) => p.ref);
  assert.deepEqual(refs, [addr.ref, tower.ref, 'click:1', 'here:']);
  const here = st.pins.find((p) => p.ref === 'here:')!;
  assert.equal(here.name, '共有した人の現在地');
  assert.notEqual(here.kind, 'here');
  // 読み直しても同じ（ファイルから）
  assert.deepEqual(JSON.parse(readFileSync(`data/shares/${sh.id}.json`, 'utf8')).pins.map((p: { ref: string }) => p.ref), refs);
  session.pins = session.pins.filter((p) => p.ref !== 'here:');
  delete session.here;
});

await check('export_route：ルートがなければ not_found', async () => {
  await fails(() => out('gpx'), 'not_found');
  assert.throws(() => exportRoute.input.parse({ format: 'kml' }));
});

const r = await route.run(ctx, route.input.parse({ from: 'click:1', to: 'click:2', stops: [], keep_order: false, avoid_highways: false }));
// 名前の差し込みを確かめる（OSM の名前に記号が入っていても壊れない）
r.legs[0].to = 'A&B <"テスト"> \'x\'';

await check('export_route：GPX 1.1（区間ごとの trkseg、出発と目的地の wpt、出典と ODbL とデータ時点）', async () => {
  const g = await out('gpx');
  assert.match(g.filename, /^kotozute-route-\d{12}\.gpx$/);
  assert.equal(g.mime, 'application/gpx+xml');
  assert.equal(g.warning, '社内確認用。社外に渡すときは ODbL の条件（出典の表示、改変したデータベースの共有）に注意してください');
  execSync('xmllint --noout -', { input: g.content }); // 整形式の XML（壊れていれば例外）
  const c = g.content;
  assert.match(c, /<gpx version="1\.1" creator="kotozute" xmlns="http:\/\/www\.topografix\.com\/GPX\/1\/1">/);
  assert.equal(c.match(/<trk>/g)?.length, 1);
  assert.equal(c.match(/<trkseg>/g)?.length, r.legs.length);
  assert.equal(c.match(/<trkpt /g)?.length, r.legs.reduce((n, l) => n + l.shape.length, 0));
  assert.equal(c.match(/<wpt /g)?.length, 2 + r.stops.length);
  assert.ok(c.includes('© OpenStreetMap contributors') && c.includes('https://www.openstreetmap.org/copyright'), '出典がない');
  assert.ok(c.includes('<license>https://opendatacommons.org/licenses/odbl/1-0/</license>') && c.includes('ODbL'), 'ライセンスがない');
  assert.ok(c.includes('OSMデータ時点：2026-'), 'データ時点がない');
  assert.ok(c.includes('Valhalla'), '経路の出典がない');
  assert.ok(c.includes('A&#38;B &#60;&#34;テスト&#34;&#62; &#39;x&#39;') && !c.includes('<"テスト">'), '名前がエスケープされていない');
  const llm = exportRoute.llm(g) as { size: number };
  assert.deepEqual(Object.keys(llm), ['filename', 'size']);
  assert.equal(llm.size, Buffer.byteLength(c));
});

await check('export_route：GeoJSON（区間の LineString と地点の Point、出典・ODbL-1.0・データ時点）', async () => {
  const j = JSON.parse((await out('geojson')).content);
  assert.equal(j.type, 'FeatureCollection');
  assert.equal(j.license, 'ODbL-1.0');
  assert.ok(j.attribution.includes('© OpenStreetMap contributors') && j.attribution_url === 'https://www.openstreetmap.org/copyright');
  assert.match(j.osm_data_as_of, /^2026-/);
  const lines = j.features.filter((f: any) => f.geometry.type === 'LineString');
  const pts = j.features.filter((f: any) => f.geometry.type === 'Point');
  assert.equal(lines.length, r.legs.length);
  assert.equal(pts.length, 2 + r.stops.length);
  assert.deepEqual(pts.map((f: any) => f.properties.kind), ['出発', '目的地']);
  assert.equal(pts[1].properties.name, 'A&B <"テスト"> \'x\'');
  assert.deepEqual(lines[0].geometry.coordinates, r.legs[0].shape);
});

await check('export_png：画面（ai・direct）は client', async () => {
  assert.deepEqual(await exportPng.run({ session, source: 'ai' }, {}), { mode: 'client' });
  assert.deepEqual(await exportPng.run(ctx, {}), { mode: 'client' });
});

// MCP：サーバで共有リンクの画面を開いて作る。Playwright と画面のサーバがなければ飛ばす
const base = process.env.KOTOZUTE_BASE ?? 'http://127.0.0.1:8787';
const serverUp = await fetch(`${base}/`).then((x) => x.ok, () => false);
let hasPw = true;
try { execSync('node -e "require(\'playwright\')"', { stdio: 'ignore' }); } catch {
  try { execSync('test -d "$(npm root -g)/@playwright/cli/node_modules/playwright"'); } catch { hasPw = false; }
}
if (!serverUp || !hasPw) {
  console.log(`skipped export_png（mcp）：${!hasPw ? 'Playwright がない' : `画面のサーバ（${base}）が動いていない`}`);
  if (!serverUp) await fails(() => exportPng.run({ session, source: 'mcp' }, {}), 'service');
} else {
  await check('export_png（mcp）：出典を焼き込んだ PNG を EXPORT_DIR に保存', async () => {
    const o = await exportPng.run({ session, source: 'mcp' }, {});
    assert.equal(o.mode, 'file');
    if (o.mode !== 'file') return;
    assert.ok(o.path.startsWith(process.env.EXPORT_DIR!), o.path);
    assert.match(o.share_url, new RegExp(`^${base}/\\?s=[0-9A-Za-z]{10}$`));
    const png = readFileSync(o.path);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
    assert.equal(w, 2560); // 1280 × 2
    assert.ok(h > 1600, `下に出典の帯がない（${w}x${h}）`);
    console.log('  ', o.path, `${w}x${h}`);
  });
}

console.log('all ok');
