// 検索データ（SQLite の osm.db）が、自社の Overpass と同じ答え（要素・順・座標・形・残すタグ）を返すかを確かめる。
// 実行：node --disable-warning=ExperimentalWarning --import tsx scripts/check-osm.ts [答えのフォルダ]
//   答えのフォルダ（既定 ~/kotozute-parity/osm-kanto）：osm.db（関東の pbf から作ったもの。OSM_INDEX で別のものも指定できる）、
//   op-<名前>.json（Overpass の答え）、demo-route-thin.json（例1の回廊の点）、random-hw-ids.json（道の way の番号 200本）。
//   op-<名前>.json がないものだけ、Overpass（:12345）に1回たずねて保存する（2回目からは Overpass に通信しない）。
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { OpError, type BBox, type LngLat } from '../src/ops/types';
import { courseTunnels, elementTags, features, names, wayTags } from '../src/services/osm';
import type { OsmElement } from '../src/services/overpass';
import { FEAT_KEYS, HW_KEYS } from './setup/osm-index';

const DIR = process.argv[2] ?? join(homedir(), 'kotozute-parity/osm-kanto');
const INDEX = process.env.OSM_INDEX ?? join(DIR, 'osm.db');
const read = (f: string) => JSON.parse(readFileSync(join(DIR, f), 'utf8'));

const HERE: LngLat = [139.7379847, 35.6288086]; // 品川駅 高輪口（node/265050703、デモの出発地）
const SHIBA: LngLat = [139.7494, 35.6548];
const TOKYO: BBox = [138.9, 35.48, 139.95, 35.92];
const VIEW: BBox = [139.735, 35.645, 139.755, 35.665]; // check-places の画面の範囲
const ROADS = 'trunk|primary|secondary|tertiary|unclassified|residential'; // plan_course と同じ
const box = ([x, y]: LngLat, m: number): BBox => {
  const dx = m / (111320 * Math.cos((y * Math.PI) / 180)), dy = m / 110570;
  return [x - dx, y - dy, x + dx, y + dy];
};

/** 中身を切り替えて呼ぶ（osm.ts は呼ぶたびに OSM_BACKEND と OSM_INDEX を読む） */
async function on<T>(backend: 'overpass' | 'sqlite', f: () => Promise<T>): Promise<T> {
  process.env.OSM_BACKEND = backend;
  process.env.OSM_INDEX = INDEX;
  return f();
}
/** Overpass の答え：保存したものがあればそれ、なければ Overpass にたずねて保存する。混んでいたら60秒待って1回だけやり直す */
async function overpassAnswer(name: string, f: () => Promise<OsmElement[]>): Promise<OsmElement[]> {
  const file = `op-${name}.json`;
  if (existsSync(join(DIR, file))) return read(file).elements;
  let elements: OsmElement[];
  try {
    elements = await on('overpass', f);
  } catch (e) {
    if (!(e instanceof OpError && e.code === 'limit')) throw e;
    console.log(`  Overpass が混んでいます（${e.message}）。60秒待ってやり直します`);
    await new Promise((r) => setTimeout(r, 60_000));
    elements = await on('overpass', f);
  }
  writeFileSync(join(DIR, file), JSON.stringify({ elements }));
  return elements;
}

const pick = (t: Record<string, string> = {}, keys: string[]) => Object.fromEntries(keys.filter((k) => k in t).map((k) => [k, t[k]]));
/** 検索データが残すキー：地物は名前・railway・地点の詳細、道の way はそれに道のキー */
const kept = (e: { type: string; tags?: Record<string, string> }) => pick(e.tags, e.type === 'way' && e.tags?.highway ? [...FEAT_KEYS, ...HW_KEYS] : FEAT_KEYS);
const key = (e: OsmElement) => `${e.type}/${e.id}`;
const byTypeId = (a: OsmElement, b: OsmElement) => ['node', 'way', 'relation'].indexOf(a.type) - ['node', 'way', 'relation'].indexOf(b.type) || a.id - b.id;

/** 要素・順・座標・形・点の番号・残すタグが全部同じ */
function same(name: string, op: OsmElement[], me: OsmElement[], keep = kept) {
  assert.deepEqual(me.map(key), op.map(key), `${name}：要素か順が違う`);
  op.forEach((a, i) => {
    const b = me[i], at = `${name} ${key(a)}`;
    assert.deepEqual([b.lat, b.lon, b.bounds], [a.lat, a.lon, a.bounds], `${at}：座標`);
    assert.deepEqual(b.geometry, a.geometry, `${at}：形`);
    assert.deepEqual(b.nodes, a.nodes, `${at}：点の番号`);
    assert.deepEqual(b.tags, keep(a), `${at}：タグ`);
  });
}

let n = 0;
async function check(name: string, f: () => Promise<string | void>) {
  const note = await f();
  n++;
  console.log('ok', name, note ?? '');
}

// ===== 検索データがないとき =====
await check('検索データがないときは、最初に使ったときに日本語で止まる（読み込みでは開かない）', async () => {
  process.env.OSM_BACKEND = 'sqlite';
  process.env.OSM_INDEX = join(DIR, 'ない.db');
  await assert.rejects(features('post_office', { around: { points: [HERE], radius_m: 500 } }), (e) =>
    e instanceof OpError && e.code === 'service' && e.message === '検索データがありません。npm run setup を回してください');
  await assert.rejects(names('品川駅', TOKYO, true), (e) => e instanceof OpError && e.code === 'service');
});

// ===== 範囲の上限は Overpass と同じ =====
await check('範囲の上限（400km²、半径 3000m）', async () => {
  await on('sqlite', () => assert.rejects(features('cafe', { bbox: [139.0, 35.5, 139.9, 35.9] }), (e) => e instanceof OpError && e.code === 'limit'));
  await on('sqlite', () => assert.rejects(features('cafe', { around: { points: [HERE], radius_m: 3001 } }), (e) => e instanceof OpError && e.code === 'limit'));
});

// ===== Overpass と比べる =====
const sq = <T>(f: () => Promise<T>) => on('sqlite', f);
const els = (f: () => Promise<{ elements: OsmElement[] }>) => async () => (await f()).elements;
const cases: [string, () => Promise<OsmElement[]>][] = [
  ['po500', els(() => features('post_office', { around: { points: [HERE], radius_m: 500 } }))], // 品川駅の周り 500m の郵便局
  ['souvenir-shiba', els(() => features('souvenir', { bbox: box(SHIBA, 1000) }))], // 芝公園の 2km 四方の手土産
  ['name', els(() => names('品川駅', TOKYO, true))], // 東京都の範囲の「品川駅」（完全一致）
  ['name-20km2', els(() => names('品川駅', box(HERE, Math.sqrt(20e6) / 2), true))], // 20km² の中の「品川駅」
  ['tunnel6k', els(() => courseTunnels(HERE, 6000, ROADS))], // 品川駅の 6km のトンネル（形つき）
  ['tunnel-view', els(() => features('tunnel', { bbox: [139.7312, 35.616, 139.7478, 35.625] }, true))], // 札のトンネル（点の番号と形つき）
  ['substr-shibakoen', els(() => names('芝公園', VIEW, false))], // 3文字以上の部分一致（trigram の索引）
  ['substr-1', els(() => names('品', TOKYO, false))], // 1文字
  ['substr-2', els(() => names('品川', TOKYO, false))], // 2文字
];
// 名前の記号（QL・正規表現・FTS の記号）：完全一致と部分一致の両方
const SYMBOLS: [string, string][] = [['dotstar', '.*'], ['backslash', 'a\\'], ['quote', '"'], ['star', '*'], ['near', 'NEAR'], ['inject', 'a"];out;(']];
for (const [id, s] of SYMBOLS) {
  cases.push([`sym-${id}-exact`, els(() => names(s, TOKYO, true))], [`sym-${id}-substr`, els(() => names(s, TOKYO, false))]);
}
for (const [name, f] of cases) {
  await check(`Overpass と同じ：${name}`, async () => {
    const op = await overpassAnswer(name, f);
    same(name, op, await sq(f));
    return `（${op.length}件）`;
  });
}

await check('Overpass と同じ：例1の回廊 300m（郵便局と手土産）', async () => {
  const route: LngLat[] = read('demo-route-thin.json');
  const area = { around: { points: route, radius_m: 300 } };
  // アプリは言葉ごとに1回ずつたずねる。保存した答えは2つの言葉の和なので、同じ順に並べて比べる
  const me = await sq(async () => [...(await features('post_office', area)).elements, ...(await features('souvenir', area)).elements].sort(byTypeId));
  const op = await overpassAnswer('corridor', async () => { throw new Error('op-corridor.json がありません'); });
  same('corridor', op, me);
  return `（${op.length}件）`;
});

await check('Overpass と同じ：ランダムな道 200本のタグ', async () => {
  const ids: number[] = read('random-hw-ids.json');
  const asEls = (m: Map<number, Record<string, string>>): OsmElement[] => [...m].map(([id, tags]): OsmElement => ({ type: 'way', id, tags })).sort(byTypeId);
  const op = await overpassAnswer('waytags-200', async () => asEls(await wayTags(ids)));
  same('waytags-200', op, asEls(await sq(() => wayTags(ids))), (e) => pick(e.tags, HW_KEYS)); // 道の表は道のキーだけ
  return `（${op.length}本）`;
});

await check('Overpass と同じ：地点の詳細のタグ', async () => {
  // 郵便局（node）、東京スカイツリー（way）、東京タワー（relation）、関東のデータにない点
  for (const osm of ['node/1420771303', 'way/288269147', 'relation/4247312', 'node/1']) {
    const [type, id] = osm.split('/') as [OsmElement['type'], string];
    const asEls = (t: Record<string, string> | null): OsmElement[] => (t ? [{ type, id: Number(id), tags: t }] : []);
    const op = await overpassAnswer(`tags-${type}-${id}`, async () => asEls(await elementTags(osm)));
    same(osm, op, asEls(await sq(() => elementTags(osm))));
  }
  await sq(() => assert.rejects(elementTags('node/1;out'), (e) => e instanceof OpError && e.code === 'bad_input'));
});

console.log(`all ok（${n}）`);
