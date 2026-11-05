// レシピ（Claude を使わない再実行）と外部通信の記録を、自社の Overpass・ABR に対して確かめる。
// 実行：npx tsx scripts/check-recipe-netlog.ts（Overpass :12345、ABR :3002 が動いていること。API キーは要らない）
// Overpass は同じ問い合わせが1分に4回を超えると断るので、続けて何度も回さない。
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPLOG_FILE = join(tmpdir(), `kotozute-check-recipe-${process.pid}.jsonl`);
// 手元の外へは実際に出さない：localhost と 127.0.0.1 以外の宛先には偽の応答を返す（記録はその手前で数える）
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) =>
  /^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(String(input)) ? realFetch(input, init) : Promise.resolve(new Response('{}'));
const { app } = await import('../src/server/main.ts');
const { withNetlog } = await import('../src/server/netlog.ts');
const { getSession } = await import('../src/server/session.ts');

const req = async (path: string, body?: unknown) => {
  const res = await app.request(path, body === undefined ? { headers: { host: 'localhost' } }
    : { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
const op = (sessionId: string, name: string, input: unknown) => req(`/api/op/${name}`, { sessionId, input });
let n = 0;
const ok = (name: string) => console.log(`ok ${++n} ${name}`);

const t = Date.now();
const A = `check-recipe-a-${t}`, B = `check-recipe-b-${t}`;
const VIEW = { bbox: [139.742, 35.652, 139.752, 35.66], zoom: 16 }; // 芝公園・東京タワーのあたり
const HERE = { coord: [139.737985, 35.628809], accuracy_m: 30 }; // 架空の現在地（品川駅 高輪口付近）
const CLICK = [139.74543, 35.65858];

// 1. A で画面から操作する（札やボタンと同じ入口）。失敗した操作はレシピに入れない
const STEPS: [string, unknown][] = [
  ['search_place', { name: '東京タワー', area: 'view:' }],
  ['geocode_address', { address: '東京都港区芝公園4-2-8' }],
  ['find_features', { words: ['post_office'], area: 'abr:1', radius_m: 500 }],
  ['find_features', { words: ['convenience'], area: 'here:', radius_m: 300 }],
  ['set_view', { target: 'result:1', show: ['post_office'], hide: ['convenience'] }],
  ['find_features', { words: ['cafe'], area: 'view:', radius_m: 500 }], // set_view で動いた後の画面
];
const orig: any[] = [];
{
  assert.equal((await req('/api/context', { sessionId: A, view: VIEW, here: HERE, click: CLICK })).status, 200);
  for (const [name, input] of STEPS) {
    const r = await op(A, name, input);
    assert.equal(r.json.ok, true, `${name}: ${JSON.stringify(r.json.error)}`);
    orig.push(r.json);
    if (name === 'search_place') assert.equal((await op(A, 'set_view', { target: 'result:9999', show: [], hide: [] })).json.ok, false);
  }
  assert.ok(orig[0].output.items.length > 0, '東京タワーが見つからない');
  const geo = orig[1].net;
  assert.ok(geo.self >= 1 && geo.anthropic === 0 && geo.other === 0, JSON.stringify(geo));
  assert.equal(geo.hosts.localhost ?? geo.hosts['127.0.0.1'], geo.self);
  assert.deepEqual(orig[4].net, { hosts: {}, self: 0, anthropic: 0, other: 0 }, '表示の切り替えは外に出ない');
  ok(`A で ${STEPS.length} 操作、住所の検索で自社のサービスへ ${geo.self}件`);
}

// 2. レシピを保存して読み直す
let id = '';
{
  const r = await req('/api/recipe', { sessionId: A });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  id = r.json.id;
  assert.match(id, /^[0-9A-Za-z]{10}$/);
  assert.equal(r.json.url, `/?r=${id}`);
  assert.deepEqual(r.json.steps.map((s: any) => s.op), STEPS.map(([o]) => o), '失敗した操作が入っている');
  assert.equal(r.json.includes_here, true);
  assert.ok(existsSync(`data/recipes/${id}.json`));
  const got = await req(`/api/recipe/${id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(got.json.context, { here: HERE, clicks: [CLICK] });
  assert.ok(got.json.steps.every((s: any) => s.source === 'direct'));
  assert.deepEqual(got.json.steps[0].view, VIEW);
  assert.deepEqual(got.json.steps[5].view.bbox, orig[4].output.bbox, '操作の前の画面の範囲を覚えていない');
  assert.equal((await req('/api/recipe/AAAAAAAAAA')).status, 404);
  assert.equal((await req('/api/recipe/..%2F..%2Fpackage')).status, 404);
  assert.equal((await req('/api/recipe/AAAAAAAAAA/run', { sessionId: B })).status, 404);
  assert.equal((await req('/api/recipe', { sessionId: `check-recipe-empty-${t}` })).status, 400, '操作のないレシピを保存した');
  // here: を使っていなければ、現在地はレシピに入れない
  const C = `check-recipe-c-${t}`;
  await req('/api/context', { sessionId: C, here: HERE });
  assert.equal((await op(C, 'set_view', { target: 'view:', show: [], hide: [] })).json.ok, true);
  const c = await req('/api/recipe', { sessionId: C });
  assert.equal(c.json.includes_here, false);
  assert.equal((await req(`/api/recipe/${c.json.id}`)).json.context.here, null);
  ok(`保存 /?r=${id}、ID の検査、現在地は here: を使ったときだけ`);
}

// 3. 状態のある別のセッション B で再実行：作り直して同じ順に呼ぶので、出力も参照（result:N、abr:N）も同じ
{
  assert.equal((await op(B, 'geocode_address', { address: '東京都千代田区丸の内1丁目' })).json.ok, true); // B の abr:1 を先に使う
  const r = await req(`/api/recipe/${id}/run`, { sessionId: B });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.recipe.id, id);
  assert.equal(r.json.steps.length, STEPS.length);
  r.json.steps.forEach((s: any, i: number) => {
    assert.equal(s.ok, true, `${s.op}: ${JSON.stringify(s.error)}`);
    assert.equal(s.source, 'recipe');
    assert.equal(s.op, orig[i].op);
    assert.deepEqual(s.input, orig[i].input);
    // here: は B の現在地ではないので、「現在地」ではなく保存した人の現在地と書く（4番目は here: のまわり）
    const want = i === 3 ? { ...orig[i].output, area: { ...orig[i].output.area, label: 'レシピを保存した人の現在地' } } : orig[i].output;
    assert.deepEqual(s.output, want, `${i + 1}番目（${s.op}）の出力が違う`);
  });
  const net = r.json.net;
  assert.ok(net.self >= 1 && net.anthropic === 0 && net.other === 0, JSON.stringify(net));
  const sB = getSession(B);
  assert.deepEqual(sB.places.get('result:1'), orig[0].output.items[0]);
  assert.deepEqual(sB.places.get('abr:1'), orig[1].output.place);
  assert.equal(sB.history.length, STEPS.length);
  assert.ok(sB.history.every((h) => h.source === 'recipe'));
  assert.deepEqual(sB.layers.post_office?.visible, true);
  assert.deepEqual(sB.layers.convenience?.visible, false);
  // 再実行が終わったら、保存した人の現在地は B の here: に残さない
  assert.equal(sB.here, undefined);
  assert.equal((await op(B, 'add_pin', { target: 'here:' })).json.error?.code, 'bad_ref');
  ok(`再実行：${STEPS.length} 操作の出力と参照が同じ、Claude 0件・自社 ${net.self}件`);
}

// 4. コマンドで再実行（別のプロセス、API キーなし）
{
  const { ANTHROPIC_API_KEY: _, ...env } = process.env;
  const run = () => spawnSync('npx', ['tsx', 'scripts/run-recipe.ts', id], { env, encoding: 'utf8', timeout: 120_000 });
  let p = run();
  // 別のプロセスなので A の結果の覚えがなく、同じ問い合わせを Overpass に送り直す。自社の Overpass は
  // 同じ問い合わせが続くと30秒ほど断る（duplicate_query）ので、断られたら待ってもう一度だけ試す
  if (p.status !== 0 && p.stdout.includes('混んでいます')) {
    await new Promise((r) => setTimeout(r, 40_000));
    p = run();
  }
  assert.equal(p.status, 0, p.stdout + p.stderr);
  const lines = p.stdout.trim().split('\n');
  assert.ok(lines.some((l) => l.startsWith('1. 場所の検索（search_place）')), p.stdout);
  assert.ok(lines.at(-1)!.includes('api.anthropic.com 0件') && lines.at(-1)!.includes('その他の外部 0件'), p.stdout);
  assert.ok(!p.stdout.includes('139.7'), 'コマンドの出力に座標がある');
  assert.equal(spawnSync('npx', ['tsx', 'scripts/run-recipe.ts', '../x'], { env, encoding: 'utf8' }).status, 1);
  ok(`コマンド：${lines.at(-1)}`);
}

// 5. 外部通信の記録：ホスト名で分け、同時に動く2つの要求を混ぜない
{
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const [[, a], [, b]] = await Promise.all([
    withNetlog(async () => {
      await fetch(`http://127.0.0.1:3002/geocode?address=${encodeURIComponent('東京都港区')}`);
      await sleep(30);
      await fetch('https://api.anthropic.com/v1/messages');
    }),
    withNetlog(async () => {
      await sleep(10);
      await fetch('https://example.invalid/x');
      await fetch(new Request('http://localhost:8002/status'));
    }),
  ]);
  assert.deepEqual(a, { hosts: { '127.0.0.1': 1, 'api.anthropic.com': 1 }, self: 1, anthropic: 1, other: 0 });
  assert.deepEqual(b, { hosts: { 'example.invalid': 1, localhost: 1 }, self: 1, anthropic: 0, other: 1 });
  // 画面からの2つの要求を同時に送る：住所の検索だけが自社のサービスを使う
  const [g, v] = await Promise.all([
    op(`check-recipe-d-${t}`, 'geocode_address', { address: '東京都港区芝公園4-2-8' }),
    op(`check-recipe-e-${t}`, 'set_view', { target: 'view:', show: [], hide: [] }),
  ]);
  assert.equal(g.json.net.self, 1, JSON.stringify(g.json.net));
  assert.equal(v.json.net.self, 0, JSON.stringify(v.json.net));
  ok('外部通信の記録：自社・api.anthropic.com・その他に分け、同時の要求を混ぜない');
}

console.log(`all ${n} checks passed`);
