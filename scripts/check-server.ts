// サーバの確認：API、操作の入口、ツール定義、Claude のループを、自社の Overpass・ABR に対して実際に動かして確かめる。
// 実行：npx tsx scripts/check-server.ts（失敗したら 0 以外で終わる）
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

// 確認の記録は本番の操作ログ（logs/ops.jsonl）に混ぜない
process.env.OPLOG_FILE = join(tmpdir(), `kotozute-check-ops-${process.pid}.jsonl`);
const { app } = await import('../src/server/main.ts');
const { OPS, toolDefs } = await import('../src/ops/registry.ts');
const { addResult, getSession } = await import('../src/server/session.ts');

const sid = `check-${Date.now()}`;
const post = async (path: string, body: unknown) => {
  const res = await app.request(path, { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as any };
};
let n = 0;
const ok = (name: string) => console.log(`ok ${++n} ${name}`);

// 1. クリックを伝えると click:1 が返る。東京の外は 400
const CLICK: [number, number] = [139.74543, 35.65858]; // 東京タワーのあたり
{
  const r = await post('/api/context', { sessionId: sid, click: CLICK });
  assert.equal(r.status, 200);
  assert.equal(r.json.clickRef, 'click:1');
  const out = await post('/api/context', { sessionId: sid, click: [140.5, 35.6] });
  assert.equal(out.status, 400);
  const nan = await app.request('/api/context', { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' }, body: `{"sessionId":"${sid}","here":{"coord":[1e999,35.6],"accuracy_m":10}}` });
  assert.equal(nan.status, 400);
  ok('context: click:1、東京の外と無限大は 400');
}

// 2. 芝のあたりの画面で地物を探す（自社の Overpass）
const VIEW = { bbox: [139.742, 35.652, 139.752, 35.66], zoom: 16 };
{
  const r = await post('/api/op/find_features', { sessionId: sid, view: VIEW, input: { words: ['post_office', 'convenience'], area: 'view:', radius_m: 500 } });
  assert.equal(r.status, 200);
  assert.equal(r.json.ok, true, JSON.stringify(r.json.error));
  assert.equal(r.json.source, 'direct');
  assert.deepEqual(r.json.output.groups.map((g: any) => g.word), ['post_office', 'convenience']);
  assert.ok(r.json.output.groups[1].count > 0, '芝のあたりのコンビニが0件');
  ok(`find_features: 郵便局 ${r.json.output.groups[0].count}件、コンビニ ${r.json.output.groups[1].count}件`);
}

// 3. AI 専用の操作（direct: false）と知らない操作は画面から呼べない
{
  assert.equal((await post('/api/op/unknown_words', { sessionId: sid, input: { words: ['本屋'] } })).status, 404);
  assert.equal((await post('/api/op/nope', { sessionId: sid, input: {} })).status, 404);
  ok('unknown_words と知らない操作は 404');
}

// 4. 入力の検証（strict でも API が強制しない上限をサーバで止める）
{
  const raw = await post('/api/op/set_view', { sessionId: sid, input: { target: 'lat:35.6,lng:139.7', show: [], hide: [] } });
  assert.equal(raw.json.ok, false);
  assert.equal(raw.json.error.code, 'bad_input');
  const many = await post('/api/op/set_view', { sessionId: sid, input: { target: 'view:', show: Array(13).fill('cafe'), hide: [] } });
  assert.equal(many.json.error.code, 'bad_input');
  const ref = await post('/api/op/set_view', { sessionId: sid, input: { target: 'result:9999', show: [], hide: [] } });
  assert.equal(ref.json.error.code, 'bad_ref');
  assert.equal((await post('/api/op/set_view', { sessionId: 'x', input: {} })).status, 400);
  ok('緯度経度・13個・知らない参照・不正なセッションは止まる');
}

// 5. 表示の切り替え：郵便局だけ残す。地図に出ていない言葉（カフェ）は結果に入れない
{
  const r = await post('/api/op/set_view', { sessionId: sid, input: { target: 'click:1', show: ['post_office'], hide: ['convenience', 'cafe'] } });
  assert.equal(r.json.ok, true, JSON.stringify(r.json.error));
  assert.deepEqual(r.json.output.shown, ['post_office']);
  assert.deepEqual(r.json.output.hidden, ['convenience']);
  const [w, s, e, nn] = r.json.output.bbox;
  assert.ok(w < CLICK[0] && CLICK[0] < e && s < CLICK[1] && CLICK[1] < nn && e - w < 0.01, '点の周りの範囲になっていない');
  // 幅0の範囲を持つ地物（南北にまっすぐな道など）でも、点の周りに寄って zoom が有限になる
  const line = addResult(getSession(sid), { name: null, coord: CLICK, kind: 'place', osm: 'way/1', bbox: [CLICK[0], 35.65, CLICK[0], 35.66] });
  const thin = await post('/api/op/set_view', { sessionId: sid, input: { target: line.ref, show: [], hide: [] } });
  assert.equal(thin.json.ok, true, JSON.stringify(thin.json.error));
  assert.ok(thin.json.output.bbox[2] - thin.json.output.bbox[0] > 0.001, '幅0の範囲のまま');
  assert.ok(Number.isFinite(getSession(sid).view!.zoom));
  ok('set_view: 郵便局だけ残す、クリックした点の周りに寄る、幅0の範囲は点の周り');
}

// 6. 共有リンクを作って読み直す
{
  const r = await post('/api/op/make_share_link', { sessionId: sid, input: {} });
  assert.equal(r.json.ok, true, JSON.stringify(r.json.error));
  assert.match(r.json.output.id, /^[0-9A-Za-z]{10}$/);
  assert.equal(r.json.output.url, `/?s=${r.json.output.id}`);
  assert.ok(existsSync(`data/shares/${r.json.output.id}.json`));
  const got = await app.request(`/api/share/${r.json.output.id}`, { headers: { host: 'localhost' } });
  assert.equal(got.status, 200);
  const state = (await got.json()) as any;
  assert.deepEqual(state.layers.map((l: any) => l.word), ['post_office'], '隠したコンビニが共有に入っている');
  assert.equal(state.bbox.length, 4);
  assert.equal((await app.request('/api/share/AAAAAAAAAA', { headers: { host: 'localhost' } })).status, 404);
  // 手元でも ALLOWED_HOSTS でもない名前（DNS rebinding）は断る
  assert.equal((await app.request('/api/share/AAAAAAAAAA', { headers: { host: 'evil.example' } })).status, 403);
  assert.equal((await app.request('/api/share/..%2F..%2Fpackage', { headers: { host: 'localhost' } })).status, 404);
  ok(`make_share_link → GET /api/share/${r.json.output.id}`);
}

// 7. ツール定義：13個、strict、すべての object が additionalProperties:false で全キー required、API が受けない制約は残さない
{
  const defs = toolDefs();
  assert.equal(defs.length, 13);
  assert.equal(new Set(defs.map((d) => d.name)).size, 13);
  const walk = (s: any, where: string): void => {
    for (const k of ['$schema', 'pattern', 'maxItems', 'minimum', 'maximum', 'minLength', 'maxLength', 'default']) assert.ok(!(k in s), `${where} に ${k} が残っている`);
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false, where);
      assert.deepEqual(s.required, Object.keys(s.properties), where);
    }
    for (const [k, v] of Object.entries(s.properties ?? {})) walk(v, `${where}.${k}`);
    if (s.items) walk(s.items, `${where}[]`);
    for (const v of s.anyOf ?? []) walk(v, `${where}|`);
  };
  for (const d of defs) {
    assert.equal(d.strict, true);
    walk(d.input_schema, d.name);
  }
  // 省略可能なキーがあると required に入れたとき Claude が値を作ってしまう。操作の定義に optional を使わない
  for (const op of OPS) {
    const js: any = z.toJSONSchema(op.input, { io: 'input' });
    assert.deepEqual(js.required ?? [], Object.keys(js.properties), `${op.name} に省略可能なキーがある（.nullable() で書く）`);
  }
  ok('toolDefs: 13個の strict なツール');
}

// 8. Claude：入力の長さはサーバで止める。キーがなければ error、あれば住所の依頼で geocode_address を呼ぶ
{
  assert.equal((await post('/api/chat', { sessionId: sid, text: '' })).status, 400);
  const long = await post('/api/chat', { sessionId: sid, text: 'あ'.repeat(301) });
  assert.equal(long.status, 400);
  assert.match(long.json.error, /300文字/);
  const big = await post('/api/chat', { sessionId: sid, text: 'あ'.repeat(20_000) });
  assert.equal(big.status, 413);
  // ほかのサイトのフォーム（text/plain）からは送れない
  const form = await app.request('/api/chat', { method: 'POST', headers: { host: 'localhost', 'content-type': 'text/plain' }, body: JSON.stringify({ sessionId: sid, text: '共有して' }) });
  assert.equal(form.status, 415);
  const r = await post('/api/chat', { sessionId: sid, text: '港区芝公園4-2-8の住所を出して' });
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.steps));
  assert.ok(['done', 'max_steps', 'no_tool', 'refusal', 'error'].includes(r.json.stop));
  if (!process.env.ANTHROPIC_API_KEY) {
    assert.equal(r.json.stop, 'error');
    assert.match(r.json.error, /ANTHROPIC_API_KEY/);
    ok('chat: キーがないので error を返す（本物の Claude との確認は飛ばした）');
  } else {
    assert.equal(r.json.stop, 'done', JSON.stringify(r.json));
    const geo = r.json.steps.find((s: any) => s.op === 'geocode_address');
    assert.ok(geo?.ok, `geocode_address の成功がない：${JSON.stringify(r.json.steps)}`);
    assert.match(geo.output.place.ref, /^abr:\d+$/);
    for (const s of r.json.steps) assert.equal(s.source, 'ai');
    ok(`chat: ${r.json.steps.map((s: any) => s.op).join(' → ')}（${geo.output.matched}）`);
  }
}

// 9. 操作ログ：呼び出しごとに1行。クリックの座標は書かない
{
  const lines = readFileSync(process.env.OPLOG_FILE!, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.length >= 6);
  assert.ok(lines.every((l) => l.session === sid.slice(0, 8) && l.at && l.op));
  assert.ok(!readFileSync(process.env.OPLOG_FILE!, 'utf8').includes(String(CLICK[0])), '操作ログにクリックの座標がある');
  assert.ok(lines.some((l) => l.op === 'find_features' && l.ok && l.counts.groups === 2));
  ok(`操作ログ ${lines.length}行`);
}

console.log(`all ${n} checks passed`);
