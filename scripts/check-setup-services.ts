// 作り直したルートと住所が、今の Docker の Valhalla（3.9.1）と ABR と同じ答えを返すかを確かめる（Task 4b）。
// 実行：
//   ルート：VALHALLA_CONFIG=<valhalla.json> npx tsx scripts/check-setup-services.ts
//     組み込み（valhallajs）で 26本を引き、scripts/fixtures/valhalla-cmp-tokyo.txt（今の Docker の答え）と比べる。
//     違えば VALHALLA_URL（既定 http://localhost:8002）にも同じ問いを投げ、時間・距離・通る道（way）の違いを出す。
//     ほかに、左側通行（drive_on_right が false）と、高速のハード除外が効くか。
//     VALHALLA_CONFIG に http://… を渡すと、組み込みの代わりにその HTTP の Valhalla を確かめる。
//   住所：ABRG_URL=http://127.0.0.1:<port> npx tsx scripts/check-setup-services.ts
//     18の住所を ABRG_URL と ABR_URL（既定 http://localhost:3002）に投げ、座標・一致した文字・残り・精度が同じか。
// 26本の作り方と1行の形は、調査で使った compare.sh（~/kotozute-setup-lab/valhalla/scripts/）と同じ。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const bad: string[] = [];
const md5 = (s: string) => createHash('md5').update(s + '\n').digest('hex').slice(0, 8);

// ===== ルート =====
type Q = (path: '/route' | '/trace_attributes', body: object) => Promise<any>;
const http = (url: string): Q => async (path, body) => (await fetch(url + path, { method: 'POST', body: JSON.stringify(body) })).json();
async function embedded(file: string): Promise<Q> {
  const { Actor } = await import('@valhallajs/valhallajs');
  const cfg = JSON.parse(readFileSync(file, 'utf8'));
  for (const k of ['tile_extract', 'tile_dir']) if (cfg.mjolnir[k]) cfg.mjolnir[k] = resolve(dirname(file), cfg.mjolnir[k]);
  const a = new Actor(cfg);
  // エラーも HTTP と同じく JSON で返す（compare.sh は失敗も1行にする）
  return (path, body) => (path === '/route' ? a.route(body) : a.traceAttributes(body)).catch((e: any) => ({ error_code: e.code, error: e.message }));
}

// 品川駅、芝公園、新宿、渋谷、池袋、上野、東京駅、立川、八王子、青梅、奥多摩の手前、町田、羽田、葛西、練馬、府中、足立、錦糸町、吉祥寺、大井
const P = [[35.6290, 139.7385], [35.6586, 139.7454], [35.6896, 139.7006], [35.6580, 139.7016], [35.7295, 139.7109], [35.7138, 139.7773], [35.6812, 139.7671],
  [35.6980, 139.4137], [35.6557, 139.3389], [35.7880, 139.2580], [35.8094, 139.0966], [35.5422, 139.4466], [35.5494, 139.7798], [35.6413, 139.8617],
  [35.7377, 139.6542], [35.6720, 139.4800], [35.7497, 139.8049], [35.6969, 139.8136], [35.7031, 139.5797], [35.6074, 139.7344]];
const AVOID = { costing_options: { auto: { exclude_highways: true, exclude_tolls: true } } };
const ROUTES: [string, object][] = Array.from({ length: 24 }, (_, i) => {
  const a = P[i % P.length];
  let b = P[(i * 7 + 3) % P.length];
  if (a === b) b = P[(i + 1) % P.length];
  return [`r${i}`, { locations: [{ lat: a[0], lon: a[1] }, { lat: b[0], lon: b[1] }], costing: 'auto', ...(i % 2 ? AVOID : {}), units: 'kilometers', shape_format: 'polyline6' }];
});
ROUTES.push(
  ['demo-via', { locations: [{ lat: 35.6290, lon: 139.7385 }, { lat: 35.6400, lon: 139.7330, type: 'break_through', heading: 0, heading_tolerance: 45 }, { lat: 35.6586, lon: 139.7454 }], costing: 'auto', ...AVOID, units: 'kilometers', shape_format: 'polyline6' }],
  ['demo-loop', { locations: [{ lat: 35.6290, lon: 139.7385 }, { lat: 35.6253, lon: 139.7420, type: 'break_through', preferred_layer: -1 }, { lat: 35.6290, lon: 139.7385 }], costing: 'auto', ...AVOID, units: 'kilometers', shape_format: 'polyline6' }],
);

/** 1本を引いて、compare.sh と同じ1行（名前、時間・距離・曲がり方の md5、[時間,距離]、通った way の並びの md5）と中身を返す */
async function one(q: Q, name: string, body: object) {
  const r = await q('/route', body);
  const t = r.trip?.summary;
  const types = (r.trip?.legs ?? []).flatMap((l: any) => l.maneuvers.map((m: any) => m.type)).join(',');
  const tr = await q('/trace_attributes', { encoded_polyline: r.trip?.legs[0].shape, shape_format: 'polyline6', costing: 'auto', shape_match: 'edge_walk', filters: { action: 'include', attributes: ['edge.way_id'] } });
  const ways: number[] = (tr.edges ?? []).map((e: any) => e.way_id);
  const line = `${name} ${md5(JSON.stringify([t?.time, t?.length, types].map((x) => x == null ? 'null' : String(x))))} ${JSON.stringify([t?.time ?? null, t?.length ?? null])} ${md5(JSON.stringify(ways))}`;
  return { line, sec: t?.time as number, km: t?.length as number, types, ways };
}

/** 2つの way の並びの違い：最初に分かれる位置と、片方にしかない way */
function wayDiff(a: number[], b: number[]) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  const sa = new Set(a), sb = new Set(b);
  return `最初に分かれる位置 ${i}／今だけ ${[...new Set(a.filter((w) => !sb.has(w)))].join(',') || 'なし'}／新だけ ${[...new Set(b.filter((w) => !sa.has(w)))].join(',') || 'なし'}`;
}

const CONFIG = process.env.VALHALLA_CONFIG;
if (CONFIG) {
  const q = CONFIG.startsWith('http') ? http(CONFIG) : await embedded(CONFIG); // http://… なら、その HTTP の Valhalla を確かめる
  const base = http(process.env.VALHALLA_URL ?? 'http://localhost:8002');
  const want = readFileSync('scripts/fixtures/valhalla-cmp-tokyo.txt', 'utf8').trim().split('\n');
  let same = 0;
  for (const [i, [name, body]] of ROUTES.entries()) {
    const got = await one(q, name, body);
    if (got.line === want[i]) { same++; continue; }
    bad.push(`ルート ${name}：今 ${want[i]} ／ 新 ${got.line}`);
    const old = await one(base, name, body).catch(() => null);
    if (!old) continue;
    const m = (s: number) => (s / 60).toFixed(2);
    console.log(`  ${name}：時間 ${m(old.sec)}→${m(got.sec)}分、距離 ${old.km}→${got.km}km、曲がり方 ${old.types === got.types ? '同じ' : '違う'}、way ${old.ways.length}→${got.ways.length}本（${wayDiff(old.ways, got.ways)}）`);
  }
  console.log(`ルート：${ROUTES.length}本のうち ${same}本が今と同じ`);

  // 左側通行：東京の道で drive_on_right がすべて false
  const r = await q('/route', ROUTES[0][1]);
  const dor = await q('/trace_attributes', { encoded_polyline: r.trip.legs[0].shape, shape_format: 'polyline6', costing: 'auto', shape_match: 'edge_walk', filters: { action: 'include', attributes: ['edge.drive_on_right'] } });
  const vals = [...new Set(dor.edges.map((e: any) => e.drive_on_right))];
  if (vals.length !== 1 || vals[0] !== false) bad.push(`drive_on_right が ${JSON.stringify(vals)}（期待 [false]）`);
  else console.log('左側通行：drive_on_right はすべて false');

  // 高速のハード除外：品川駅 → 八王子。除外なしは高速を通り、除外ありは高速も有料道路も通らない
  const roads = async (opt: object) => {
    const x = await q('/route', { locations: [{ lat: P[0][0], lon: P[0][1] }, { lat: P[8][0], lon: P[8][1] }], costing: 'auto', ...opt, units: 'kilometers', shape_format: 'polyline6' });
    const e = await q('/trace_attributes', { encoded_polyline: x.trip.legs[0].shape, shape_format: 'polyline6', costing: 'auto', shape_match: 'edge_walk', filters: { action: 'include', attributes: ['edge.road_class', 'edge.toll'] } });
    return { motorway: e.edges.some((x: any) => x.road_class === 'motorway'), toll: e.edges.some((x: any) => x.toll), min: (x.trip.summary.time / 60).toFixed(1) };
  };
  const [plain, avoid] = [await roads({}), await roads(AVOID)];
  if (!plain.motorway || avoid.motorway || avoid.toll) bad.push(`ハード除外：除外なし ${JSON.stringify(plain)}、除外あり ${JSON.stringify(avoid)}`);
  else console.log(`ハード除外：除外なし ${plain.min}分（高速あり）、除外あり ${avoid.min}分（高速・有料なし）`);
}

// ===== 住所 =====
const ADDRS = ['東京都港区芝公園4-2-8', '港区芝公園4-2-8', '東京都港区芝公園１丁目５番２５号', '東京都世田谷区世田谷4丁目21-27', '世田谷区世田谷４－２１－２７',
  '東京都北区王子本町1-15-22', '東京都台東区東上野4丁目5-6', '台東区東上野四丁目5番6号', '東京都品川区北品川５丁目２番１号', '東京都大島町元町1丁目1-14',
  '東京都新宿区西新宿4-33-7', '東京都足立区中央本町一丁目17', '足立区中央本町1丁目17-1', '中央区大手前2丁目1-22', '大阪府大阪市中央区大手前２丁目１－２２',
  '東京都千代田区紀尾井町1-3', '東京都八王子市元本郷町3-24-1', '東京都町田市森野2-2-22'];
/** cmp.sh と同じ5つ：座標、一致した文字、残り、一致の深さ、座標の単位 */
async function geocode(url: string, a: string) {
  const j = await (await fetch(`${url}/geocode?address=${encodeURIComponent(a)}`)).json();
  const f = j.features?.[0] ?? {};
  const p = f.properties ?? {};
  return JSON.stringify([f.geometry?.coordinates ?? null, p.matched_address ?? null, p.unmatched_address ?? null, p.match_level ?? null, p.coordinates_level ?? null]);
}

const ABRG = process.env.ABRG_URL;
if (ABRG) {
  const base = process.env.ABR_URL ?? 'http://localhost:3002';
  let same = 0;
  for (const a of ADDRS) {
    const [x, y] = [await geocode(base, a), await geocode(ABRG, a)];
    if (x === y) same++;
    else bad.push(`住所 ${a}：今 ${x} ／ 新 ${y}`);
  }
  console.log(`住所：${ADDRS.length}件のうち ${same}件が今と同じ`);
  const lv = JSON.parse(await geocode(ABRG, ADDRS[0]))[4];
  if (lv !== 'rsdtdsp_blk') bad.push(`港区芝公園4-2-8 の精度が ${lv}（期待 rsdtdsp_blk）`);
}

if (!CONFIG && !ABRG) bad.push('VALHALLA_CONFIG も ABRG_URL もありません。確かめるものを指定してください');
if (bad.length) {
  console.log(bad.join('\n'));
  process.exit(1);
}
console.log('check-setup-services: ok');
