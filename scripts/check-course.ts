// 例2 試走コース（plan_course、check_route）と、トンネルのまとめ方（find_features）を自社の Valhalla・Overpass に対して確かめる。
// 実行：npx tsx scripts/check-course.ts（Valhalla :8002、Overpass :12345 が動いていること）
// Overpass は同じ検索文が1分に4回ほど続くと断るので、続けて何度も流さない。
import assert from 'node:assert/strict';
import { checkRoute } from '../src/ops/check_route';
import { findFeatures, mergeTunnels } from '../src/ops/find_features';
import { planCourse } from '../src/ops/plan_course';
import { searchPlace } from '../src/ops/search_place';
import { OpError, type OpErrorCode } from '../src/ops/types';
import { getSession } from '../src/server/session';
import { distM } from '../src/services/region';

const session = getSession('check-course-0001');
session.view = { bbox: [139.7, 35.61, 139.775, 35.65], zoom: 13.5 }; // 品川のあたり（評価 c07 と同じ）
const ctx = { session, source: 'direct' as const };
const plan = (input: unknown) => planCourse.run(ctx, planCourse.input.parse(input));
const check = (input: unknown) => checkRoute.run(ctx, checkRoute.input.parse(input));
async function fails(f: () => Promise<unknown>, codes: OpErrorCode[]) {
  const e = await f().then(() => null, (e) => e);
  assert.ok(e instanceof OpError, `OpError にならなかった: ${e}`);
  assert.ok(codes.includes(e.code), `code が ${e.code}（期待 ${codes.join('/')}）`);
}
async function step(name: string, f: () => Promise<void>) {
  await f();
  console.log('ok', name);
}

await step('トンネルのまとめ方（点を共有する way は1本、50m 未満は数えない）', async () => {
  const way = (id: number, nodes: number[], line: [number, number][], tags: Record<string, string>) =>
    ({ type: 'way' as const, id, nodes, geometry: line.map(([lon, lat]) => ({ lon, lat })), tags });
  const items = mergeTunnels([
    way(1, [10, 11], [[139.74, 35.62], [139.741, 35.62]], { name: '第一京浜' }), // 約 90m
    way(2, [11, 12], [[139.741, 35.62], [139.743, 35.62]], { name: '第一京浜', 'tunnel:name': '品川トンネル' }), // 約 180m。1 とつながる
    way(3, [20, 21], [[139.75, 35.63], [139.7503, 35.63]], { name: '短い' }), // 約 27m
    way(4, [30, 31], [[139.76, 35.63], [139.761, 35.63]], {}), // 約 90m、名前なし
  ]);
  assert.equal(items.length, 2, JSON.stringify(items));
  assert.equal(items[0].name, '品川トンネル'); // tunnel:name が先
  assert.equal(items[0].osm, 'way/2'); // いちばん長い way
  assert.deepEqual(items[0].bbox, [139.74, 35.62, 139.743, 35.62]);
  assert.equal(items[1].name, null);
});

await step('find_features：トンネルを実データでまとめる（北品川のあたり）', async () => {
  const s = getSession('check-course-0002');
  s.view = { bbox: [139.7312, 35.616, 139.7478, 35.625], zoom: 16 };
  const o = await findFeatures.run({ session: s, source: 'direct' }, findFeatures.input.parse({ words: ['tunnel'], area: 'view:', radius_m: 500 }));
  const g = o.groups[0];
  // 北品川の way/46655151・46655153・430419210（名前なし、点 596206791 でつながる）は1本になる
  const parts = ['way/46655151', 'way/46655153', 'way/430419210'];
  assert.equal(g.items.filter((p) => parts.includes(p.osm!)).length, 1, g.items.map((p) => p.osm).join(','));
  assert.ok(g.count >= 1 && g.items.every((p) => p.kind === 'tunnel' && /^result:\d+$/.test(p.ref)));
  assert.match(g.interpretation, /つながった区間は1本、50m未満は数えない/);
  console.log('  ', g.items.map((p) => `${p.name ?? '名前なし'}(${p.osm})`).join('、'));
});

let startRef = '';
await step('plan_course：品川駅を出て、トンネル2本、高速なし、60分以内', async () => {
  const sp = await searchPlace.run(ctx, { name: '品川駅', area: 'view:' });
  startRef = sp.items[0].ref;
  const o = await plan({ start: startRef, tunnels: 2, max_minutes: 60, avoid_highways: true });
  assert.ok(distM(o.start.coord, [139.739167, 35.628669]) < 300, '品川駅（node/4011643454）から 300m より遠い');
  assert.ok(o.attempts.length >= 1 && o.attempts.length <= 5 && o.routes <= 10, `案 ${o.attempts.length}、ルート計算 ${o.routes}`);
  assert.notEqual(o.chosen, null, `合格がない（${o.stopped_by}）`);
  const a = o.attempts[o.chosen!];
  assert.equal(a.check.verdict, 'pass');
  // 数えたトンネルの本数が表の値と同じで、どれも 50m 以上の別のトンネル
  const counted = a.check.tunnels.filter((t) => !t.skip);
  const row = (k: string) => a.check.rows.find((r) => r.kind === k)!;
  assert.equal(row('tunnels').got, counted.length);
  assert.ok(counted.length >= 2);
  assert.equal(new Set(counted.map((t) => t.name)).size, counted.length, '同じトンネルを2本と数えている');
  assert.ok(counted.every((t) => t.m >= 50 && t.ways.every((w) => /^way\/\d+$/.test(w))));
  assert.ok(a.check.tunnels.filter((t) => t.skip === 'short').every((t) => t.m < 50));
  assert.deepEqual([row('no_highways').result, row('no_highways').got], ['pass', 0]);
  assert.equal(row('minutes').result, 'pass');
  assert.ok(a.minutes <= 60 && a.minutes === row('minutes').got);
  // 不合格の案は、どれかの行が不合格か判定不能
  for (const x of o.attempts.slice(0, o.chosen!)) assert.notEqual(x.check.verdict, 'pass');
  // 車線数は参考：タグのない区間があっても合格のまま
  assert.ok(a.check.lanes.tagged_share > 0 && a.check.lanes.tagged_share <= 1);
  assert.ok(a.check.missing === 0, `生のタグがない way ${a.check.missing}`);
  // 地図・共有リンク用のルート：周回で、経由地はトンネル
  const c = o.course;
  assert.equal(session.route, c);
  assert.equal(c.from, o.start);
  assert.equal(c.to, o.start);
  assert.equal(c.legs.length, a.via.length + 1);
  assert.ok(distM(c.legs[0].shape[0], c.legs.at(-1)!.shape.at(-1)!) < 50, '出発と到着が離れている');
  assert.deepEqual(c.stops.map((s) => s.chosen.ref), a.via.map((v) => v.ref));
  for (const v of a.via) assert.equal(session.places.get(v.ref)?.name, v.name);
  const llm = JSON.stringify(planCourse.llm(o));
  assert.ok(!/1[34]\d\.\d{3}/.test(llm) && !llm.includes('line') && !llm.includes('shape'), 'LLM に座標を渡している');
  console.log('  ', o.attempts.map((x, i) => `${i + 1}回目 ${x.via.map((v) => v.name).join('+')} ${x.minutes}分 ${x.check.tunnels.filter((t) => !t.skip).length}本 ${x.check.verdict}`).join(' / '));
  console.log('  ', `候補 ${o.candidates}本（除外 ${o.excluded}）、ルート計算 ${o.routes}回、車線数のタグ ${Math.round(a.check.lanes.tagged_share * 100)}%・タグなし ${a.check.lanes.untagged_runs}区間`);
});

await step('check_route：地図のコースを同じ条件と別の条件で判定', async () => {
  const same = await check({ tunnels: 2, max_minutes: 60, avoid_highways: true });
  assert.equal(same.verdict, 'pass');
  assert.deepEqual(same.rows.map((r) => r.kind), ['tunnels', 'no_highways', 'minutes']);
  const more = await check({ tunnels: 4, max_minutes: null, avoid_highways: false });
  assert.deepEqual([more.verdict, more.rows.length, more.rows[0].result], ['fail', 1, 'fail']);
  const none = await check({ tunnels: 0, max_minutes: null, avoid_highways: false }); // 0本は「通らない」
  assert.equal(none.verdict, 'fail');
  const short = await check({ tunnels: null, max_minutes: 10, avoid_highways: false });
  assert.deepEqual([short.verdict, short.rows[0].kind, short.rows[0].got], ['fail', 'minutes', session.route!.total.minutes]);
  assert.equal(short.from, short.to); // 周回
  await fails(() => check({ tunnels: null, max_minutes: null, avoid_highways: false }), ['bad_input']);
  await fails(() => checkRoute.run({ session: getSession('check-course-0003'), source: 'direct' }, { tunnels: 2, max_minutes: 60, avoid_highways: true }), ['not_found']);
  assert.ok(!/1[34]\d\.\d{3}/.test(JSON.stringify(checkRoute.llm(same))), 'LLM に座標を渡している');
});

await step('plan_course：誤った入力', async () => {
  await fails(() => plan({ start: 'view:', tunnels: 2, max_minutes: 60, avoid_highways: true }), ['bad_ref']);
  await fails(() => plan({ start: startRef, tunnels: null, max_minutes: 60, avoid_highways: true }), ['bad_input']);
  await fails(() => plan({ start: 'result:999', tunnels: 2, max_minutes: 60, avoid_highways: true }), ['bad_ref']);
  assert.throws(() => planCourse.input.parse({ start: '35.62,139.73', tunnels: 2, max_minutes: 60, avoid_highways: true }));
  assert.throws(() => planCourse.input.parse({ start: startRef, tunnels: 5, max_minutes: 60, avoid_highways: true }));
});

console.log('all ok');
