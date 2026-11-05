// 住所とルートの操作（geocode_address、route）を自社の ABR・Valhalla・Overpass に対して確かめる。
// 実行：npx tsx scripts/check-route.ts（ABR :3001、Valhalla :8002、Overpass :12345 が動いていること）
import assert from 'node:assert/strict';
import { geocodeAddress } from '../src/ops/geocode_address';
import { route } from '../src/ops/route';
import { stepText } from '../src/ops/steps';
import { OpError, type OpErrorCode } from '../src/ops/types';
import { getSession } from '../src/server/session';

const session = getSession('check-route-0001');
// 架空の現在地（品川駅 高輪口付近。絵コンテと同じ）
session.here = { coord: [139.737985, 35.628809], accuracy_m: 30 };
const ctx = { session, source: 'direct' as const };
const ja = /[ぁ-んァ-ヶ一-龠]/;

const geo = (address: string) => geocodeAddress.run(ctx, geocodeAddress.input.parse({ address }));
const go = (input: unknown) => route.run(ctx, route.input.parse(input));
async function fails(f: () => Promise<unknown>, codes: OpErrorCode[]) {
  const e = await f().then(() => null, (e) => e);
  assert.ok(e instanceof OpError, `OpError にならなかった: ${e}`);
  assert.ok(codes.includes(e.code), `code が ${e.code}（期待 ${codes.join('/')}）`);
  assert.ok(ja.test(e.message));
}
async function check(name: string, f: () => Promise<void>) {
  await f();
  console.log('ok', name);
}

await check('道路名のテンプレート', async () => {
  assert.equal(stepText({ type: 12, street_names: ['15', '第一京浜'], length: 0.87, time: 0 }), 'Uターンして第一京浜へ');
  assert.equal(stepText({ type: 16, street_names: ['白山祝田田町線', '301'], length: 0.43, time: 0 }), 'やや左へ　白山祝田田町線');
  assert.equal(stepText({ type: 3, street_names: ['1', '桜田通り'], length: 0.66, time: 0 }, true), '桜田通りを進む');
  assert.equal(stepText({ type: 10, length: 0.06, time: 0 }), '右折');
  assert.equal(stepText({ type: 5, length: 0, time: 0 }), '到着・右側');
  assert.equal(stepText({ type: 99, street_names: ['C1'], length: 0, time: 0 }), '道なりに進む');
});

await check('住所（芝公園4-2-8）', async () => {
  const g = await geo('東京都港区芝公園4-2-8');
  assert.equal(g.place.ref, 'abr:1');
  assert.equal(g.place.kind, 'address');
  assert.ok(g.matched.startsWith('東京都港区芝公園'), g.matched);
  assert.ok(['machiaza', 'machiaza_detail'].includes(g.level), g.level); // 手元の ABR は住居番号の座標（--pos）なし
  assert.ok(ja.test(g.precision) && g.precision.endsWith('代表点'), g.precision);
  assert.equal(g.unmatched, '2-8');
  assert.equal(session.places.get('abr:1'), g.place);
  const llm = geocodeAddress.llm(g);
  assert.ok(!JSON.stringify(llm).includes('139.'), 'LLM に座標を渡している');
});

await check('住所：東京都の外と、読めない住所', async () => {
  await fails(() => geo('大阪府大阪市北区梅田1-1'), ['out_of_area', 'not_found']);
  await fails(() => geo('あいうえお'), ['not_found']);
});

let normalMin = 0;
await check('ルート：現在地 → 郵便局 → 手土産 → 芝公園4-2-8', async () => {
  const r = await go({ from: 'here:', to: 'abr:1', stops: [{ ref: null, word: 'post_office' }, { ref: null, word: 'souvenir' }], keep_order: true, avoid_highways: false });
  assert.equal(r.stops.length, 2);
  assert.equal(r.legs.length, 3);
  assert.equal(r.stops[0].chosen.kind, 'post_office'); // 指定の順を守る
  assert.equal(r.stops[1].chosen.kind, 'souvenir');
  assert.ok(r.total.minutes >= 7 && r.total.minutes <= 12, `合計 ${r.total.minutes} 分`);
  assert.ok(r.total.minutes >= r.direct.minutes - 0.2, '寄り道ありが寄り道なしより速い');
  assert.ok(r.tried > 1 && r.tried <= 29, `tried ${r.tried}`);
  assert.equal(r.legs[0].from, '現在地');
  assert.equal(r.legs[2].to, '東京都港区芝公園4丁目');
  for (const s of r.stops) {
    assert.match(s.chosen.ref, /^result:\d+$/);
    assert.equal(session.places.get(s.chosen.ref), s.chosen);
    assert.ok(s.alternatives.every((a) => a.extra_min >= 0 && /^result:\d+$/.test(a.place.ref)), '候補の追加時間が負');
    assert.ok(s.alternatives.length <= 3);
  }
  for (const l of r.legs) {
    assert.ok(l.steps.length > 0 && l.steps.every((s) => ja.test(s.text)), '曲がり方の日本語がない');
    assert.ok(l.shape.length > 1);
    assert.ok(/^到着/.test(l.steps[l.steps.length - 1].text));
  }
  assert.equal(session.route, r);
  const llm = JSON.stringify(route.llm(r));
  assert.ok(!llm.includes('139.') && !llm.includes('shape'), 'LLM に座標を渡している');
  console.log('  ', r.legs.map((l) => `${l.from}→${l.to} ${l.minutes}分`).join(' / '), `計 ${r.total.minutes}分（寄り道なし ${r.direct.minutes}分）`);
  console.log('  ', r.legs[0].steps.map((s) => s.text).join('、'));
});

await check('ルート：同じ言葉を2つ（コンビニ2か所）は別の店を選ぶ', async () => {
  const r = await go({ from: 'here:', to: 'abr:1', stops: [{ ref: null, word: 'convenience' }, { ref: null, word: 'convenience' }], keep_order: true, avoid_highways: false });
  assert.equal(r.stops.length, 2);
  assert.notEqual(r.stops[0].chosen.osm, r.stops[1].chosen.osm, '同じ店に2回寄っている');
  assert.ok(r.tried <= 12, `tried ${r.tried}（4×4 から同じ店の4通りを除く）`);
  console.log('  ', r.stops.map((s) => s.chosen.name).join(' → '), `試した ${r.tried}通り`);
});

await check('ルート：高速を使わない（品川 → 立川）', async () => {
  const g = await geo('東京都立川市曙町2丁目');
  const base = { from: 'here:', to: g.place.ref, stops: [], keep_order: true };
  const normal = await go({ ...base, avoid_highways: false });
  const avoid = await go({ ...base, avoid_highways: true });
  normalMin = normal.total.minutes;
  assert.equal(avoid.avoid_highways, true);
  assert.equal(avoid.tried, 1);
  assert.equal(avoid.extra_min, 0);
  assert.ok(avoid.total.minutes > normalMin, `高速なし ${avoid.total.minutes} 分、あり ${normalMin} 分`);
  console.log('  ', `高速あり ${normalMin}分、高速なし ${avoid.total.minutes}分`);
});

await check('ルート：誤った参照と入力', async () => {
  await fails(() => go({ from: 'result:999', to: 'abr:1', stops: [], keep_order: true, avoid_highways: false }), ['bad_ref']);
  await fails(() => go({ from: 'here:', to: 'abr:1', stops: [{ ref: 'abr:1', word: 'cafe' }], keep_order: true, avoid_highways: false }), ['bad_input']);
  await fails(() => go({ from: 'here:', to: 'view:', stops: [], keep_order: true, avoid_highways: false }), ['bad_ref']); // 範囲は地点にしない
  assert.throws(() => route.input.parse({ from: '35.6,139.7', to: 'abr:1', stops: [], keep_order: true, avoid_highways: false }));
});

console.log('all ok');
