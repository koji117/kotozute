// MCP サーバ（src/mcp/server.ts）を、SDK のクライアントから stdio で起動して確かめる。
// Claude API のキーを環境から外し、リポジトリの外のフォルダから起動する。23区の区役所の住所（docs/demo/ward-offices.csv）を MCP 経由で一括で住所にする。
// 実行：npx tsx scripts/check-mcp.ts（自社の Overpass :12345、ABR :3002 が動いていること）
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { OPS } from '../src/ops/registry';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER = join(ROOT, 'src/mcp/server.ts');
let n = 0;
const ok = (name: string) => console.log(`ok ${++n} ${name}`);

// 1. MCP サーバが読み込むファイルに src/server/claude.ts と Anthropic の SDK がない（キーを読まない、AI を呼ばない）
{
  const seen = new Set<string>();
  const walk = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    assert.ok(!src.includes('@anthropic-ai/sdk') && !src.includes('ANTHROPIC_API_KEY'), `${file} が Claude API を使う`);
    for (const [, rel] of src.matchAll(/^import [^;]*?from '(\.[^']+)'/gm)) walk(resolve(dirname(file), rel.endsWith('.ts') ? rel : `${rel}.ts`));
  };
  walk(SERVER);
  assert.ok(!seen.has(join(ROOT, 'src/server/claude.ts')));
  assert.ok(seen.has(join(ROOT, 'src/ops/registry.ts')));
  ok(`MCP サーバは ${seen.size} 個のファイルを読み込み、claude.ts を含まない`);
}

// 2. キーを外した環境で、リポジトリの外から起動する
const { ANTHROPIC_API_KEY: _key, ...env } = process.env;
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(ROOT, 'node_modules/tsx/dist/cli.mjs'), SERVER],
  cwd: tmpdir(),
  env: { ...(env as Record<string, string>), OPLOG_FILE: join(tmpdir(), `kotozute-check-mcp-${process.pid}.jsonl`) },
});
const client = new Client({ name: 'check-mcp', version: '0.0.0' });
const errors: Error[] = [];
client.onerror = (e) => errors.push(e); // stdout に JSON でない行が出るとここに来る
await client.connect(transport);

type Res = { isError?: boolean; content: { type: string; text?: string }[] };
const call = async (name: string, args: Record<string, unknown>) => {
  const r = (await client.callTool({ name, arguments: args })) as Res;
  const text = r.content[0]?.text ?? '';
  return { isError: !!r.isError, text, json: r.isError ? null : JSON.parse(text) };
};
const noCoord = (text: string) => assert.ok(!/1[34]\d\.\d{3}|35\.\d{3}/.test(text), `座標が返っている：${text}`);

try {
  // 3. ツールの一覧：OPS と同じ名前・説明。入力は JSON Schema
  {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name), OPS.map((o) => o.name));
    for (const t of tools) {
      const op = OPS.find((o) => o.name === t.name)!;
      assert.equal(t.description, op.description);
      assert.equal(t.title, op.title);
      assert.equal(t.inputSchema.type, 'object');
    }
    ok(`tools/list：${tools.length}個（${tools.map((t) => t.name).join('、')}）`);
  }

  // 4. 住所：参照・一致・精度を返し、座標は返さない
  {
    const r = await call('geocode_address', { address: '東京都港区芝公園4-2-8' });
    assert.equal(r.isError, false, r.text);
    assert.equal(r.json.ref, 'abr:1');
    assert.ok(r.json.matched.startsWith('東京都港区芝公園'), r.json.matched);
    assert.equal(r.json.level, 'rsdtdsp_blk');
    assert.equal(r.json.precision, '街区の代表点');
    noCoord(r.text);
    ok(`geocode_address：${r.json.matched}（残り ${r.json.unmatched}、${r.json.precision}）`);
  }

  // 5. 場所の検索：住所の結果（abr:1）の近い順
  {
    const r = await call('search_place', { name: '東京タワー', area: 'abr:1' });
    assert.equal(r.isError, false, r.text);
    assert.ok(r.json.total > 0 && r.json.items[0].name === '東京タワー', r.text);
    assert.match(r.json.items[0].ref, /^result:\d+$/);
    noCoord(r.text);
    ok(`search_place：東京タワー ${r.json.total}件（先頭 ${r.json.items[0].ref}）`);
  }

  // 6. 入力の検証は runOp と同じ（緯度経度・空・知らない操作・知らない参照）。日本語の文で isError
  {
    const raw = await call('search_place', { name: '東京タワー', area: '35.65,139.74' });
    assert.ok(raw.isError && raw.text.includes('入力が正しくありません'), raw.text);
    const empty = await call('geocode_address', { address: '' });
    assert.ok(empty.isError && empty.text.includes('address'), empty.text);
    const nope = await call('nope', {});
    assert.ok(nope.isError && nope.text === '知らない操作です', nope.text);
    const ref = await call('set_view', { target: 'result:9999', show: [], hide: [] });
    assert.ok(ref.isError && /[ぁ-ん]/.test(ref.text), ref.text);
    const out = await call('geocode_address', { address: '大阪府大阪市北区梅田1-1' });
    assert.ok(out.isError && out.text.includes('東京都'), out.text);
    ok('緯度経度・空の住所・知らない操作・知らない参照・東京都の外は isError（日本語）');
  }

  // 7. 一括：23区の区役所の住所を MCP で住所にし、精度を数える
  {
    const rows = readFileSync(join(ROOT, 'docs/demo/ward-offices.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));
    assert.equal(rows.length, 23);
    const results = await Promise.all(rows.map(([, , address]) => call('geocode_address', { address })));
    const levels: Record<string, number> = {};
    results.forEach((r, i) => {
      assert.equal(r.isError, false, `${rows[i][1]}：${r.text}`);
      assert.ok(['rsdtdsp_blk', 'rsdtdsp_rsdt'].includes(r.json.level), `${rows[i][1]}：${r.json.precision}`);
      assert.ok(r.json.matched.startsWith(`東京都${rows[i][0]}`), `${rows[i][1]}：${r.json.matched}`);
      noCoord(r.text);
      levels[r.json.precision] = (levels[r.json.precision] ?? 0) + 1;
      console.log(`   ${r.json.ref} ${rows[i][1]}：${r.json.matched}${r.json.unmatched ? `（残り ${r.json.unmatched}）` : ''} ${r.json.precision}`);
    });
    assert.equal(new Set(results.map((r) => r.json.ref)).size, 23);
    ok(`23区の区役所：${Object.entries(levels).map(([k, v]) => `${k} ${v}件`).join('、')}`);
  }

  // 8. 共有リンク：MCP で作った住所のピンを画面で開ける URL
  {
    const r = await call('make_share_link', {});
    assert.equal(r.isError, false, r.text);
    assert.match(r.json.id, /^[0-9A-Za-z]{10}$/);
    assert.equal(r.json.open, `http://localhost:8787/?s=${r.json.id}`);
    const state = JSON.parse(readFileSync(join(ROOT, `data/shares/${r.json.id}.json`), 'utf8'));
    assert.equal(state.pins.length, 24); // 芝公園4-2-8 と23区の区役所
    ok(`make_share_link：${r.json.open}（ピン ${state.pins.length}個）`);
  }

  assert.deepEqual(errors, [], `stdout に JSON-RPC 以外が出た：${errors.join(' / ')}`);
  ok('stdout は JSON-RPC だけ');
} finally {
  await client.close();
}
console.log(`all ${n} checks passed`);
