// 場所の操作（find_features、search_place）を自社の Overpass に対して確かめる。
// 実行：npx tsx scripts/check-places.ts（Overpass が localhost:12345 で動いていること）
import assert from 'node:assert/strict';
import { findFeatures } from '../src/ops/find_features';
import { searchPlace } from '../src/ops/search_place';
import { OpError } from '../src/ops/types';
import { getSession } from '../src/server/session';
import { bboxKm2 } from '../src/services/region';

const session = getSession('check-places-0001');
session.view = { bbox: [139.735, 35.645, 139.755, 35.665], zoom: 15 };
const ctx = { session, source: 'direct' as const };
const isRef = (r: string) => /^result:\d+$/.test(r);

async function check(name: string, f: () => Promise<void>) {
  try {
    await f();
  } catch (e) {
    // Overpass が同じ検索を続けて拒否すると、JSON でなく HTML の誤りが 200 で返る（OVERPASS_ALLOW_DUPLICATE_QUERIES=no）
    if (e instanceof SyntaxError) throw new Error(`${name}：Overpass が JSON でない応答を返しました。同じ検索の拒否なら1分ほど待って再実行`, { cause: e });
    throw e;
  }
  console.log('ok', name);
}

// 同じ検索文を1回の実行で繰り返さない（Overpass が同じ検索の繰り返しを拒否するため）
let firstPo = '';
await check('郵便局と手土産（画面の範囲）', async () => {
  const out = await findFeatures.run(ctx, { words: ['post_office', 'souvenir'], area: 'view:', radius_m: 500 });
  firstPo = out.groups[0].items[0].ref;
  const [po, sv] = out.groups;
  assert.equal(out.area.label, '画面の範囲');
  assert.ok(po.count > 0, '郵便局が0件');
  assert.ok(po.items.every((p) => isRef(p.ref) && p.kind === 'post_office'));
  assert.equal(po.interpretation, '郵便局＝amenity=post_office');
  assert.equal(sv.word, 'souvenir');
  assert.deepEqual(session.layers.post_office?.refs, po.items.map((p) => p.ref));
  assert.equal(session.places.get(po.items[0].ref), po.items[0]);
  const llm = findFeatures.llm(out) as { groups: { items: object[] }[] };
  assert.ok(!JSON.stringify(llm).includes('coord'), 'LLM に座標を渡している');
  assert.ok(llm.groups[0].items.length <= 20);
});

await check('結果の周り（半径）と層の置き換え', async () => {
  const out = await findFeatures.run(ctx, { words: ['convenience'], area: firstPo, radius_m: 300 });
  assert.ok(out.groups[0].count > 0, 'コンビニが0件');
  const again = await findFeatures.run(ctx, { words: ['convenience'], area: firstPo, radius_m: 500 });
  assert.ok(again.groups[0].count >= out.groups[0].count);
  assert.deepEqual(session.layers.convenience?.refs, again.groups[0].items.map((p) => p.ref));
});

await check('公園のように広い場所はその範囲で探す（代々木公園）', async () => {
  session.view = { bbox: [139.69, 35.66, 139.705, 35.68], zoom: 15 };
  const parks = (await findFeatures.run(ctx, { words: ['park'], area: 'view:', radius_m: 300 })).groups[0].items;
  const big = parks.filter((p) => p.bbox).sort((a, b) => bboxKm2(b.bbox!) - bboxKm2(a.bbox!))[0];
  // 半径300mの円を囲む四角は約0.36km²。これより広い公園
  assert.ok(big && bboxKm2(big.bbox!) > 0.5, '広い公園がない');
  const out = await findFeatures.run(ctx, { words: ['toilets'], area: big.ref, radius_m: 300 });
  assert.deepEqual(out.area.bbox, big.bbox);
  session.view = { bbox: [139.735, 35.645, 139.755, 35.665], zoom: 15 };
});

await check('入力の検証（緯度経度と決まっていない半径は通さない）', async () => {
  assert.equal(findFeatures.input.safeParse({ words: ['cafe'], area: '35.65,139.74', radius_m: 500 }).success, false);
  assert.equal(findFeatures.input.safeParse({ words: ['cafe'], area: 'view:', radius_m: 400 }).success, false);
  assert.equal(findFeatures.input.safeParse({ words: ['cafe; out;'], area: 'view:', radius_m: 500 }).success, false);
  assert.equal(searchPlace.input.safeParse({ name: '東京タワー', area: 'click:0' }).success, false);
});

await check('小さな範囲で0件（エラーにしない）', async () => {
  session.view = { bbox: [139.7450, 35.6550, 139.7452, 35.6552], zoom: 20 };
  const out = await findFeatures.run(ctx, { words: ['hospital'], area: 'view:', radius_m: 300 });
  assert.equal(out.groups[0].count, 0);
  assert.equal(out.groups[0].truncated, false);
});

await check('広すぎる範囲は limit', async () => {
  session.view = { bbox: [139.0, 35.5, 139.9, 35.9], zoom: 9 };
  await assert.rejects(findFeatures.run(ctx, { words: ['cafe'], area: 'view:', radius_m: 300 }), (e) => e instanceof OpError && e.code === 'limit');
});

session.view = { bbox: [139.735, 35.645, 139.755, 35.665], zoom: 15 };

let tower = '';
await check('東京タワーを名前で探す', async () => {
  const out = await searchPlace.run(ctx, { name: '東京タワー', area: 'view:' });
  assert.ok(out.total > 0 && out.items.length > 0);
  assert.ok(out.items.every((p) => isRef(p.ref) && p.name === '東京タワー'));
  assert.ok(out.items.length <= 10);
  tower = out.items[0].ref;
  // 東京タワーの範囲（約90m四方）は半径500mより狭いので、範囲の中ではなく周りを探す
  const rel = out.items.find((p) => p.bbox);
  assert.ok(rel, '範囲のある東京タワーがない');
  const cafe = await findFeatures.run(ctx, { words: ['cafe'], area: rel.ref, radius_m: 500 });
  assert.notDeepEqual(cafe.area.bbox, rel.bbox);
  assert.ok(cafe.groups[0].count > 0, '東京タワーの周り500mでカフェが0件');
});

await check('「品川駅」は駅として見つかる（東京都全体）', async () => {
  const out = await searchPlace.run(ctx, { name: '品川駅', area: tower });
  assert.ok(out.items.some((p) => p.name === '品川'), '駅の「品川」がない');
});

await check('部分一致', async () => {
  const out = await searchPlace.run(ctx, { name: '芝公園', area: 'view:' });
  assert.ok(out.total > 0);
});

await check('注入できない（QL と正規表現の記号）', async () => {
  for (const name of ['a"];out;(', 'a\\"];out;(', "x'];node(1);out;", '.*', 'a\\', '[(']) {
    const out = await searchPlace.run(ctx, { name, area: 'view:' });
    assert.equal(out.total, 0, `「${name}」で ${out.total} 件`);
  }
});

await check('空の名前と知らない参照', async () => {
  await assert.rejects(searchPlace.run(ctx, { name: '\n\t', area: 'view:' }), (e) => e instanceof OpError && e.code === 'bad_input');
  await assert.rejects(searchPlace.run(ctx, { name: '東京', area: 'result:99999' }), (e) => e instanceof OpError && e.code === 'bad_ref');
});

await check('画面が東京都の外なら out_of_area', async () => {
  session.view = { bbox: [135.4, 34.6, 135.6, 34.8], zoom: 12 };
  await assert.rejects(searchPlace.run(ctx, { name: '大阪駅', area: 'view:' }), (e) => e instanceof OpError && e.code === 'out_of_area');
  session.view = { bbox: [139.735, 35.645, 139.755, 35.665], zoom: 15 };
});

console.log('all ok');
