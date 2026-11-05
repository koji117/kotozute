// OSM ノートの下書き（draft_osm_note）と止める語（note_rules、POST /api/note/check）を確かめる。外のサービスは使わない。
// 実行：npx tsx scripts/check-note.ts（失敗したら 0 以外で終わる）
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.OPLOG_FILE = join(tmpdir(), `kotozute-check-note-${process.pid}.jsonl`);
process.env.NOTE_BLOCK_WORDS = 'サンプル物産, ACME'; // 架空の社名（本物は .env にだけ書く）
const { app } = await import('../src/server/main.ts');
const { draftOsmNote } = await import('../src/ops/draft_osm_note.ts');
const { BLOCK_WORDS, blockedWords, envBlockWords } = await import('../src/ops/note_rules.ts');
const { runOp, toolDefs } = await import('../src/ops/registry.ts');
const { addResult, getSession } = await import('../src/server/session.ts');

const session = getSession(`check-note-${Date.now()}`);
const ctx = { session, source: 'direct' as const };
const draft = (input: unknown) => draftOsmNote.run(ctx, draftOsmNote.input.parse(input));
const COORDS = /\d{2,3}\.\d{3,}/;
let n = 0;
const ok = (name: string) => console.log(`ok ${++n} ${name}`);

// 1. クリックした点：OSM の要素ではないので、点を小数5桁で書く
session.clicks.push([139.745434, 35.658581]);
{
  const o = await draft({ target: 'click:1', issue: 'turn_restriction' });
  assert.equal(o.target.ref, 'click:1');
  assert.equal(o.osm_url, null);
  assert.equal(o.issue_label, '右左折の規制');
  assert.equal(o.where, '緯度 35.65858、経度 139.74543');
  assert.deepEqual(o.draft.split('\n'), [`何が：${o.what}`, 'どこで：緯度 35.65858、経度 139.74543', '確認方法：']);
  assert.equal(o.note_url, 'https://www.openstreetmap.org/note/new#map=19/35.65858/139.74543');
  ok('click:1 の下書き（点は小数5桁、確認方法は空欄）');
}

// 2. OSM の要素：要素のページの URL を添える
const park = addResult(session, { name: '芝公園', coord: [139.74937, 35.65476], kind: 'park', osm: 'way/123456' });
{
  const o = await draft({ target: 'osm:way/123456', issue: 'name_wrong' });
  assert.equal(o.target.ref, park.ref);
  assert.equal(o.osm_url, 'https://www.openstreetmap.org/way/123456');
  assert.equal(o.where, '芝公園（https://www.openstreetmap.org/way/123456）');
  assert.match(o.draft, /^何が：OSMの名前が、現地の表示と違う可能性\nどこで：芝公園（https:\/\/www\.openstreetmap\.org\/way\/123456）\n確認方法：$/);
  assert.equal(o.note_url, 'https://www.openstreetmap.org/note/new#map=19/35.65476/139.74937');
  const nameless = addResult(session, { name: null, coord: [139.75, 35.66], kind: 'tunnel', osm: 'way/7' });
  assert.equal((await draft({ target: nameless.ref, issue: 'road_closed' })).where, 'https://www.openstreetmap.org/way/7');
  ok('osm:way/123456 の下書き（要素の URL つき）、名前のない要素は URL だけ');
}

// 3. 確認方法：3つは選べる。Googleマップは見せるが選べない（理由つき）
{
  const o = await draft({ target: 'click:1', issue: 'oneway' });
  assert.deepEqual(o.methods.map((m) => [m.label, m.allowed]), [
    ['現地で見た', true], ['自分で撮った写真がある', true], ['現地を運転して確かめた', true], ['Googleマップで見た', false],
  ]);
  assert.equal(o.methods[3].reason, '他社の地図からの書き写しは OSM のルールでできない');
  assert.ok(o.methods.slice(0, 3).every((m) => m.reason === null));
  ok('確認方法の一覧');
}

// 4. LLM に返すのは名前・要素・種類だけ（座標と下書きの文は渡さない）
{
  const llm = draftOsmNote.llm(await draft({ target: 'osm:way/123456', issue: 'poi_closed' }));
  assert.deepEqual(llm, { target: '芝公園', osm: 'way/123456', issue: '閉店・廃止' });
  assert.ok(!COORDS.test(JSON.stringify(draftOsmNote.llm(await draft({ target: 'click:1', issue: 'other' })))));
  ok('llm(): 座標と下書きを渡さない');
}

// 5. AI は確認方法を選べない：入力にない（ツール定義にもない）。足しても捨てられ、下書きは空欄のまま
{
  const def = toolDefs().find((d) => d.name === 'draft_osm_note')!;
  assert.deepEqual(Object.keys((def.input_schema as any).properties), ['target', 'issue']);
  assert.equal(draftOsmNote.direct, true);
  const r = await runOp('draft_osm_note', { session, source: 'ai' }, { target: 'click:1', issue: 'oneway', method: '現地で見た', confirm: 'saw' });
  assert.ok(r.ok, JSON.stringify(r));
  assert.deepEqual(Object.keys(r.input as object), ['target', 'issue']);
  const out = r.output as Awaited<ReturnType<typeof draft>>;
  assert.match(out.draft, /確認方法：$/);
  assert.ok(!/確認方法：\S/.test(out.draft));
  const keys = (v: unknown): string[] => (v && typeof v === 'object' ? Object.entries(v).flatMap(([k, x]) => [k, ...keys(x)]) : []);
  assert.ok(!keys(out).some((k) => /method|chosen|confirm/i.test(k) && k !== 'methods'), keys(out).join(','));
  ok('AI が確認方法を渡しても出力に入らない');
}

// 6. 場所の参照：画面の範囲・座標・知らない参照・知らない種類は止まる
{
  const fail = async (input: unknown, code: string) => {
    const r = await runOp('draft_osm_note', { session, source: 'ai' }, input);
    assert.ok(!r.ok && r.error.code === code, JSON.stringify(r));
  };
  await fail({ target: 'view:', issue: 'oneway' }, 'bad_ref');
  await fail({ target: '35.6586,139.7454', issue: 'oneway' }, 'bad_input');
  await fail({ target: 'click:9', issue: 'oneway' }, 'bad_ref');
  await fail({ target: 'click:1', issue: 'speed_limit' }, 'bad_input');
  ok('view:・座標・知らない参照・知らない種類は止まる');
}

// 7. 止める語：決まった語、全角・半角と大文字・小文字の違い、.env の語
{
  for (const w of BLOCK_WORDS) assert.ok(blockedWords(`ここは${w}の前`).length === 1, w);
  assert.deepEqual(blockedWords('試走のあと客先へ。顧客の倉庫'), ['試走', '客先', '顧客']);
  assert.deepEqual(blockedWords('㈱ことづて'), ['（株）']);
  assert.deepEqual(blockedWords('右折禁止の標識を現地で見た'), []);
  assert.deepEqual(blockedWords('確認方法：Ｇｏｏｇｌｅマップで見た'), ['google'], '他社の地図を手で書いても止める');
  assert.deepEqual(envBlockWords(), ['サンプル物産', 'ACME']);
  assert.deepEqual(blockedWords('ａｃｍｅの倉庫の前', envBlockWords()), ['ACME']);
  assert.deepEqual(blockedWords('ｻﾝﾌﾟﾙ物産 試走', envBlockWords()), ['試走', 'サンプル物産']);
  assert.deepEqual(blockedWords('サンプル物産'), [], '.env の語を渡さなければ止めない（pure）');
  ok('止める語（.env の語を含む）');
}

// 8. POST /api/note/check：サーバの全部の語で確かめる
{
  const post = (body: string, type = 'application/json') =>
    app.request('/api/note/check', { method: 'POST', headers: { host: 'localhost', 'content-type': type }, body });
  const r = await post(JSON.stringify({ text: '何が：右折禁止\nどこで：サンプル物産の前（試走で見た）' }));
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { blocked: ['試走', 'サンプル物産'] });
  assert.deepEqual(await (await post(JSON.stringify({ text: '現地で見た' }))).json(), { blocked: [] });
  assert.equal((await post(JSON.stringify({ text: 'あ'.repeat(2001) }))).status, 400);
  assert.equal((await post(JSON.stringify({ text: '試走' }), 'text/plain')).status, 415);
  // 画面から AI を通さずに呼べる（direct）
  const op = await app.request('/api/op/draft_osm_note', { method: 'POST', headers: { host: 'localhost', 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: session.id, input: { target: 'click:1', issue: 'road_missing' } }) });
  assert.equal(((await op.json()) as any).output.issue_label, '道がない');
  ok('POST /api/note/check と /api/op/draft_osm_note');
}

console.log(`all ${n} checks passed`);
