// セットアップの部品の確認（ネットなし、Docker なし、数秒）。
//   1. 引数の解釈（知らない地域・知らないオプションは日本語のエラーと地域の一覧）
//   2. 地域の解決（tokyo・osaka・kanto・japan・hokkaido）と、data/region.json の中身（東京は既定と同じ＋作ったもの）
//   3. 手順の印（入力が同じなら飛ばし、違えばやり直す）、記録で値を伏せる、.env を作るのは無いときだけ、同じファイルの判定
//   4. ダウンロード：途中で切れたら .part から続ける、md5 か sha256 が違えば捨てる、取り終えた .part は取り直さずに確かめる、進み具合（手元の HTTP サーバ）
//   5. 確認の手順：Docker なし、docker.sock の権限なし、Docker が止まっている、Docker の置き場の空き、osmium なし、Go と C のコンパイラ、ポートが使用中、ディスク不足（偽の docker を PATH に置く）
//   6. Geofabrik の .poly、地図の範囲（境界＋2km）
//   SETUP_PBF=<関東の pbf> があれば、東京の境界を作り直して、今の tokyo-boundary.json と 2000点で比べる（手元の osmium が要る。数秒）
// 実行：npx tsx scripts/check-setup.ts
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { createServer as tcpServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapBBox, buildBoundary, inRings } from './setup/boundary';
import { download } from './setup/download';
import { DEFAULT, parseSetupArgs, regionConfig, resolveRegion, SetupError } from './setup/plan';
import { prereq, type Needs } from './setup/prereq';
import { ensureEnv, Marks, mask, sameFile } from './setup/steps';
import { poly2geojson } from './setup/tiles';
import { osmiumFor } from './setup/tools';

const tmp = mkdtempSync(join(tmpdir(), 'check-setup-'));
const bad: string[] = [];
let n = 0;
async function t(name: string, f: () => unknown) {
  n++;
  try { await f(); } catch (e) { bad.push(`${name}：${(e as Error).message.split('\n')[0]}`); }
}
const throwsJa = (f: () => unknown, re: RegExp) => assert.throws(f, (e: Error) => e instanceof SetupError && re.test(e.message));

// ===== 1. 引数 =====
await t('知らない地域', () => {
  for (const re of [/知らない地域です：atlantis。使える地域：/, /日本全国：japan/, /地方：tohoku、kanto/, /都道府県：hokkaido、.*kagawa/]) throwsJa(() => resolveRegion(parseSetupArgs(['--region=atlantis']).region), re);
});
await t('知らないオプション', () => throwsJa(() => parseSetupArgs(['--region=tokyo', '--foo']), /引数を読めません/));
await t('地域なし', () => throwsJa(() => parseSetupArgs([]), /--region=<地域> を指定してください/));
await t('maxzoom 14 は japan だけ', () => throwsJa(() => parseSetupArgs(['--region=kanto', '--maxzoom=14']), /japan だけ/));
await t('知らない手順', () => throwsJa(() => parseSetupArgs(['--region=tokyo', '--redo=foo']), /手順「foo」はありません/));
await t('既定の値', () => {
  const a = parseSetupArgs(['--region=tokyo', '--pbf=x.pbf', '--only=index,tiles', '--keep-pbf']);
  assert.deepEqual([a.jobs, a.maxzoom, a.portApp, a.osmium, a.pbf, a.keepPbf, [...a.only!]], [2, 15, 8787, 'auto', 'x.pbf', true, ['index', 'tiles']]);
});

// ===== 2. 地域 =====
await t('tokyo', () => {
  const r = resolveRegion('tokyo');
  assert.equal(r.data.key, 'kanto');
  assert.equal(r.data.pinned?.url.split('/').pop(), 'kanto-261103.osm.pbf');
  assert.deepEqual([r.abrPref, r.label, r.prefs.map((p) => p.code)], ['13', DEFAULT.label, [13]]);
  throwsJa(() => resolveRegion('tokyo', 'all'), /--islands は使えません/);
});
await t('osaka', () => {
  const r = resolveRegion('osaka');
  assert.deepEqual([r.kind, r.data.key, r.abrPref, r.islands, r.label], ['pref', 'kansai', '27', 'main', '大阪府']);
});
await t('kanto', () => {
  const r = resolveRegion('kanto');
  assert.deepEqual([r.kind, r.abrPref, r.prefs.length, r.prefs.map((p) => p.code)], ['subregion', 'all', 7, [8, 9, 10, 11, 12, 13, 14]]);
});
await t('japan', () => {
  const r = resolveRegion('japan');
  assert.deepEqual([r.kind, r.abrPref, r.islands, r.prefs.length, r.data.key], ['japan', 'all', 'all', 47, 'japan']);
});
await t('hokkaido は都道府県（住所はその県だけ）', () => assert.equal(resolveRegion('hokkaido').abrPref, '01'));
const made = { index: { out: DEFAULT.osm_index, asOf: DEFAULT.osm_as_of }, tiles: 'tokyo.pmtiles', tilesAsOf: DEFAULT.tiles_as_of, valhalla: 'data/setup/valhalla/valhalla.json', abrCache: 'data/setup/abr/abrg.duckdb', abrgBin: 'data/setup/abr/abrg' };
await t('東京の data/region.json は既定と同じ＋作ったもの', () => {
  const c = regionConfig(resolveRegion('tokyo'), made);
  assert.deepEqual(c, { ...DEFAULT, osm_backend: 'sqlite', valhalla_config: made.valhalla, abr_cache: made.abrCache, abrg_bin: made.abrgBin });
});
await t('香川県の data/region.json', () => {
  const c = regionConfig(resolveRegion('kagawa'), { ...made, tiles: 'kagawa.pmtiles', boundary: { file: 'data/setup/boundary.json', bbox: [133.4, 34.0, 134.5, 34.6], dropped: true } });
  assert.deepEqual([c.id, c.label, c.name, c.prefs, c.view.zoom, c.boundary], ['kagawa', '香川県（島しょ部を除く）', '香川県', [{ code: 37, name: '香川県' }], 12, 'data/setup/boundary.json']);
  assert.ok(c.bbox[0] < 133.4 && c.bbox[2] > 134.5 && c.bbox.every((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-9), `範囲 ${c.bbox}`);
});

// ===== 3. 印・記録・.env・同じファイル =====
await t('手順の印', () => {
  const m = new Marks(join(tmp, 'state'));
  const out = join(tmp, 'out.txt');
  writeFileSync(out, 'x');
  assert.equal(m.done('index', { pbf: 'a' }, [out]), false);
  m.set('index', { pbf: 'a' }, { out: 'out.txt' });
  assert.equal(m.done('index', { pbf: 'a' }, [out]), true, '入力が同じなら済み');
  assert.equal(m.done('index', { pbf: 'b' }, [out]), false, '入力が違えばやり直す');
  assert.equal(m.done('index', null, [out]), false, '入力が分からなければ回す');
  rmSync(out);
  assert.equal(m.done('index', { pbf: 'a' }, [out]), false, 'できたものがなければやり直す');
  assert.deepEqual(m.get('index')?.result, { out: 'out.txt' });
});
await t('記録で値を伏せる', () => {
  assert.equal(mask('ANTHROPIC_API_KEY=sk-ant-abc123 と DB_PASSWORD: hunter2'), 'ANTHROPIC_API_KEY=*** と DB_PASSWORD: ***');
  assert.equal(mask('{"github_token": "ghp_x"}'), '{"github_token": "***"}');
  assert.equal(mask('osmium tags-filter kanto.osm.pbf'), 'osmium tags-filter kanto.osm.pbf');
});
await t('.env は無いときだけ作る', () => {
  const d = join(tmp, 'env');
  mkdirSync(d);
  writeFileSync(join(d, '.env.example'), 'ANTHROPIC_API_KEY=\n');
  assert.equal(ensureEnv(d), true);
  assert.equal(readFileSync(join(d, '.env'), 'utf8'), 'ANTHROPIC_API_KEY=\n');
  writeFileSync(join(d, '.env'), 'ANTHROPIC_API_KEY=x\n');
  assert.equal(ensureEnv(d), false);
  assert.equal(readFileSync(join(d, '.env'), 'utf8'), 'ANTHROPIC_API_KEY=x\n', '上書きしない');
  assert.ok(existsSync(join(process.cwd(), '.env.example')), 'リポジトリに .env.example がある');
  assert.match(readFileSync(join(process.cwd(), '.env.example'), 'utf8'), /^ANTHROPIC_API_KEY=$/m);
});
await t('同じファイル（シンボリックリンク）', () => {
  const a = join(tmp, 'a.pmtiles'), b = join(tmp, 'b.pmtiles');
  writeFileSync(a, 'x');
  symlinkSync(a, b);
  assert.deepEqual([sameFile(a, b), sameFile(a, join(tmp, 'none')), sameFile(a, join(tmp, 'out.txt'))], [true, false, false]);
});

// ===== 4. ダウンロード =====
const body = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
const md5 = createHash('md5').update(body).digest('hex');
let cut = true, ranges: string[] = [], gets = 0, md5Fail = 0;
const srv = httpServer((req, res) => {
  if (req.url === '/missing') { res.writeHead(404).end(); return; }
  if (req.url!.endsWith('.md5')) { if (md5Fail-- > 0) res.writeHead(404).end(); else res.end(`${md5}  x.osm.pbf\n`); return; }
  const range = /bytes=(\d+)-/.exec(req.headers.range ?? '');
  const from = range ? Number(range[1]) : 0;
  const head = { 'content-length': String(body.length - from), etag: '"v1"', 'accept-ranges': 'bytes' };
  // /nosize：HEAD が大きさを返さない（続きがなければ 416 で分かる）
  if (req.method === 'HEAD') { res.writeHead(200, req.url === '/nosize' ? { etag: '"v1"' } : { ...head, 'content-length': String(body.length) }).end(); return; }
  gets++;
  if (from >= body.length) { res.writeHead(416, { 'content-range': `bytes */${body.length}` }).end(); return; }
  if (range) ranges.push(req.headers.range!);
  res.writeHead(range ? 206 : 200, head);
  if (cut) { cut = false; res.write(body.subarray(from, from + 100_000), () => res.destroy()); return; } // 途中で切る
  res.end(body.subarray(from));
});
await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
const log = () => {};
await t('ダウンロード：途中から続ける、md5、取ってあれば飛ばす', async () => {
  const dest = join(tmp, 'dl', 'a.osm.pbf');
  await assert.rejects(download({ url: `${base}/a`, dest, md5, log }), /途中で切れました/);
  assert.equal(existsSync(dest), false, '切れたら本当の名前にしない');
  assert.ok(statSync(`${dest}.part`).size >= 100_000);
  await download({ url: `${base}/a`, dest, md5, log });
  assert.deepEqual(readFileSync(dest), body);
  assert.ok(ranges.length === 1 && /^bytes=\d+-$/.test(ranges[0]) && ranges[0] !== 'bytes=0-', `続きから取る（${ranges}）`);
  assert.equal(existsSync(`${dest}.part`), false);
  await download({ url: `${base}/nothing-to-fetch`, dest, md5: 'x', log }); // 取ってあれば何もしない
  const d2 = join(tmp, 'dl', 'b.osm.pbf');
  await assert.rejects(download({ url: `${base}/b`, dest: d2, md5: '0'.repeat(32), log }), /md5 が合いません/);
  assert.deepEqual([existsSync(d2), existsSync(`${d2}.part`)], [false, false], 'md5 が違えば捨てる');
  await assert.rejects(download({ url: `${base}/missing`, dest: join(tmp, 'dl', 'c'), log }), (e: Error & { status?: number }) => e.status === 404);
});
await t('ダウンロード：取り終えた .part は取り直さずに確かめる', async () => {
  for (const name of ['full', 'nosize']) {
    const dest = join(tmp, 'dl', `${name}.osm.pbf`);
    writeFileSync(`${dest}.part`, body);
    const g = gets;
    await download({ url: `${base}/${name}`, dest, md5, log });
    assert.deepEqual(readFileSync(dest), body, name);
    assert.equal(existsSync(`${dest}.part`), false, name);
    assert.equal(gets - g, name === 'full' ? 0 : 1, `${name}：GET の回数（大きさが分からなければ 416 で分かる）`);
  }
});
await t('ダウンロード：md5 のファイルが取れなかった回のあと、もう一度回すと通る', async () => {
  const dest = join(tmp, 'dl', 'd.osm.pbf');
  md5Fail = 1;
  await assert.rejects(download({ url: `${base}/d`, dest, md5Url: true, log }), /md5 のファイルを取れません（HTTP 404）/);
  assert.equal(statSync(`${dest}.part`).size, body.length);
  const g = gets;
  await download({ url: `${base}/d`, dest, md5Url: true, log });
  assert.deepEqual([readFileSync(dest).equals(body), existsSync(`${dest}.part`), gets - g], [true, false, 0]);
});
await t('ダウンロード：sha256 が違えば捨てる、合えば通る。進み具合を呼ぶ（アプリの住所のデータ）', async () => {
  const dest = join(tmp, 'dl', 'e.duckdb');
  await assert.rejects(download({ url: `${base}/e`, dest, sha256: '0'.repeat(64), log }), /sha256 が固定した値と違います/);
  assert.deepEqual([existsSync(dest), existsSync(`${dest}.part`)], [false, false]);
  const seen: [number, number][] = [];
  await download({ url: `${base}/e`, dest, sha256: createHash('sha256').update(body).digest('hex'), log, progress: (got, total) => seen.push([got, total]) });
  assert.deepEqual([readFileSync(dest).equals(body), seen.at(-1)], [true, [body.length, body.length]]);
});
srv.close();

// ===== 5. 確認の手順（偽の docker と osmium を PATH に置く） =====
const bin = join(tmp, 'bin');
mkdirSync(bin);
const stub = (name: string, script: string) => { writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`); chmodSync(join(bin, name), 0o755); };
const none: Needs = { docker: false, dockerMemGiB: 2, dockerDiskGiB: 1, go: false, goAvoid: [], python: false, osmium: null, pmtiles: false, port: null, diskBytes: 0, dir: tmp };
const env = { PATH: bin };
const problems = async (n: Partial<Needs>) => (await prereq({ ...none, ...n }, env)).problems.join('\n');
await t('確認：何も要らなければ問題なし', async () => assert.equal(await problems({}), ''));
await t('確認：Docker なし', async () => assert.match(await problems({ docker: true }), /docker コマンドがありません。Docker Desktop（Mac）か Docker Engine（Linux）を入れてください。.*--abr-cache/));
await t('確認：docker.sock の権限なし', async () => {
  stub('docker', 'echo "permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock" >&2; exit 1');
  assert.match(await problems({ docker: true }), /Docker を使う権限がありません（docker\.sock）。.*usermod -aG docker/);
});
await t('確認：Docker が止まっている', async () => {
  stub('docker', 'echo "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?" >&2; exit 1');
  assert.match(await problems({ docker: true }), /Docker は入っていますが、動いていません。Docker を起動してから/);
});
await t('確認：Docker のメモリ', async () => {
  stub('docker', 'case "$1" in version) echo 29.0.0;; info) echo 1073741824;; esac');
  assert.match(await problems({ docker: true, dockerMemGiB: 4 }), /Docker が使えるメモリが 1\.0 GiB です。4 GiB 以上に/);
  assert.equal(await problems({ docker: true, dockerMemGiB: 1 }), '');
});
await t('確認：Docker の置き場の空き（Linux のように手元にあるときだけ）', async () => {
  stub('docker', `case "$3" in *Server.Version*) echo 29.0.0;; *MemTotal*) echo 8589934592;; *DockerRootDir*) echo "$ROOT_DIR";; esac`);
  const p = async (root: string, gib: number) => (await prereq({ ...none, docker: true, dockerDiskGiB: gib }, { ...env, ROOT_DIR: root })).problems.join('\n');
  assert.match(await p(tmp, 2 ** 30), /Docker の置き場（.*）の空きは .* GiB で、住所のデータを作るのに約 1073741824 GiB 要ります.*--abr-cache/);
  assert.equal(await p(tmp, 1), '');
  assert.equal(await p('/var/lib/docker-in-the-vm', 2 ** 30), '', '手元にない置き場（Mac の Docker Desktop）は見ない');
});
await t('確認：osmium がなければコンテナの osmium', async () => {
  const r = await prereq({ ...none, osmium: 'auto' }, env); // 偽の docker は動いている
  assert.deepEqual([r.found.osmium, r.problems], ['container', []]);
  rmSync(join(bin, 'docker'));
  assert.match(await problems({ osmium: 'auto' }), /docker コマンドがありません.*brew install osmium-tool/);
  assert.match(await problems({ osmium: 'host' }), /osmium がありません（--osmium=host）/);
  stub('osmium', 'echo osmium version 1.19.1');
  assert.deepEqual((await prereq({ ...none, osmium: 'auto' }, env)).found.osmium, 'host');
});
await t('確認：Go と C のコンパイラと python3 がない', async () => {
  const p = await problems({ go: true, goAvoid: ['--abrg-bin=<abrg>'], python: true });
  assert.match(p, /Go がありません。.*go\.dev\/dl.*--abrg-bin=<abrg> で Go なしで進めます/);
  assert.match(p, /C のコンパイラがありません。.*xcode-select --install.*--abrg-bin=<abrg> で進めます/);
  assert.match(p, /python3 がありません。.*--valhalla-dir/);
  stub('go', 'echo go version go1.25.0');
  stub(process.platform === 'darwin' ? 'xcode-select' : 'cc', 'echo ok');
  assert.equal(await problems({ go: true }), '');
});
await t('確認：ポートが使用中', async () => {
  const s = tcpServer().listen(0, '127.0.0.1');
  await new Promise((r) => s.once('listening', r));
  const port = (s.address() as AddressInfo).port;
  try { assert.match(await problems({ port }), new RegExp(`ポート ${port} はほかのプログラムが使っています。止めるか、--port-app=<番号> で別の番号に`)); }
  finally { s.close(); }
});
await t('確認：ディスク不足', async () => assert.match(await problems({ diskBytes: 2 ** 60, dir: join(tmp, 'まだない', 'フォルダ') }), /空きディスクが足りません。.*ファイルを消して空きを作って/));

// ===== 6. そのほか =====
await t('Geofabrik の .poly', () => {
  const g = poly2geojson('kanto\n1\n  139.0 35.0\n  140.0 35.0\n  140.0 36.0\nEND\n!1h\n  139.4 35.4\n  139.6 35.4\n  139.6 35.6\nEND\n2\n  141 37\n  141.1 37\n  141 37.1\nEND\nEND\n');
  assert.equal(g.geometry.coordinates.length, 2, '外側の輪2つ');
  assert.equal(g.geometry.coordinates[0].length, 2, '1つ目に穴');
  assert.deepEqual(g.geometry.coordinates[0][0].at(-1), [139.0, 35.0], '輪を閉じる');
});
await t('地図の範囲（境界＋2km、0.01度で外へ）', () => {
  assert.deepEqual(mapBBox([133.5, 34.1, 134.4, 34.5]), [133.47, 34.08, 134.43, 34.52]);
});

// 関東の pbf があれば：東京の境界を作り直して、今の tokyo-boundary.json と比べる（2000点）
if (process.env.SETUP_PBF) {
  await t('東京の境界を作り直すと今のものと同じ', async () => {
    const b = await buildBoundary({ pbf: process.env.SETUP_PBF!, prefs: ['13'], islands: 'main', work: join(tmp, 'bwork'), osmium: osmiumFor('host', tmp), log: () => {} });
    const old = JSON.parse(readFileSync('src/services/tokyo-boundary.json', 'utf8')).rings;
    let seed = 42;
    const rnd = () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
    const [w, s, e, nn] = DEFAULT.bbox;
    let diff = 0;
    for (let i = 0; i < 2000; i++) { const p: [number, number] = [w + rnd() * (e - w), s + rnd() * (nn - s)]; if (inRings(b.groups[0], p) !== inRings(old, p)) diff++; }
    assert.equal(diff, 0, `2000点中 ${diff} 点が違う`);
    assert.equal(b.dropped, true, '島を外した');
  });
}

rmSync(tmp, { recursive: true, force: true });
if (bad.length) {
  console.error(`check-setup: ${bad.length}/${n} 件の問題\n${bad.map((b) => `  ✗ ${b}`).join('\n')}`);
  process.exit(1);
}
console.log(`check-setup: ok（${n}）`);
