// Mac のアプリが地図のデータ（東京）を取って作る（設計書 §17）。アプリが Electron の Node で動かす（ELECTRON_RUN_AS_NODE=1、--import tsx。サーバと同じ）。
//   引数：--out <新しいデータのフォルダ> --cache <ダウンロードの置き場> [--jobs N]
//   手順：空きの確認 → 住所（GitHub Releases、sha256）→ OSM（関東の pbf。続きから、md5）→ 地図（最新のビルドから切り出す）
//         → 検索データ → ルートのデータ → 地域の設定（<out>/region.json）。
//   ネットを使う手順を先に回す。住所（約 22MB）を最初にするのは、取れないとき（公開の前は 404）に約 700MB を取ったあとで止まらないため。
//   進み具合は stdout に1行1つの JSON で出す：{type:'step', id, steps}、{type:'progress', got, total}、{type:'log', msg}、{type:'error', msg}、{type:'done', region}。
//   ダウンロードは --cache に置き、止めても次は続きから取る。作り終えたら pbf は消す。
//   取り終えた pbf が残っていても（前の回が途中で止まった）、Geofabrik の今のファイルと同じとき（ETag）だけ使う。「最新にする」で古いものを使わないため。
//   ネットにつながらないときは、取る先の名前を入れた日本語の文にする（download.ts の netError）。
// 通信する先は download.geofabrik.de、build.protomaps.com、github.com（と raw.githubusercontent.com。ルートの速度表）だけ。
// 試すための差し替え（環境変数）：KOTOZUTE_PBF_URL（手元のパスか URL）、KOTOZUTE_TILES_FILE（手元の .pmtiles）、KOTOZUTE_ABR_URL（手元のパスか URL）。
// KOTOZUTE_BUILD_FAKE=1（か、地域の設定のパス）：本当には作らず、進み具合だけを出して、開発用のデータ（data/region.json）を指す region.json を書く（画面の確認用）。
import { spawnSync } from 'node:child_process';
import { constants, copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import type { RegionConfig } from '../../src/region';
import { download, netError } from './download';
import { buildOsmIndex } from './osm-index';
import { CATALOG, DEFAULT, fmtBytes, regionConfig, resolveRegion } from './plan';
import { extract, latestBuild, pmtilesBin, tilesInfo } from './tiles';
import type { Log } from './tools';
import { buildValhalla } from './valhalla';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const GiB = 2 ** 30;
/** 住所のデータ（東京の住居表示を abrg で取り込んだ DuckDB）。同じリポジトリの GitHub Releases に置く（公開するときにユーザーがアップロードする） */
export const ABR_TOKYO = {
  url: 'https://github.com/koji117/kotozute/releases/download/abr-tokyo-20261106/abrg-tokyo.duckdb',
  sha256: '58e2c515a63e00f21d4fa793fffada7e201edd8870769535e32bfe6e4c69ece9',
  bytes: 22294528,
};
/** 作るあいだに要る空きと、作ったあとに残る量（測った値に余裕を足したもの） */
const NEED = { build: 5 * GiB, after: 1.6 * GiB }; // 11/7 にこの Mac で測った値：作るあいだの最大 4.16GiB（ルートの手順）、作ったあと 1.51GiB
export const STEPS = [
  { id: 'disk', title: '空きディスクの確認' },
  { id: 'abr', title: '住所のデータを取る' },
  { id: 'osm', title: 'OSM のデータ（関東）を取る' },
  { id: 'tiles', title: '地図を取って東京の範囲を切り出す' },
  { id: 'index', title: '検索データを作る' },
  { id: 'valhalla', title: 'ルートのデータを作る' },
  { id: 'region', title: '仕上げ' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

const emit = (m: Record<string, unknown>) => process.stdout.write(JSON.stringify(m) + '\n');
const log: Log = (msg) => emit({ type: 'log', msg });
const step = (id: StepId) => emit({ type: 'step', id, steps: STEPS });
let last = 0;
/** ダウンロードの量。0.2 秒に1回まで */
const progress = (got: number, total: number) => {
  const t = Date.now();
  if (t - last < 200 && got !== total) return;
  last = t;
  emit({ type: 'progress', got, total });
};
const isUrl = (s: string) => /^https?:\/\//.test(s);
const sha256Of = async (file: string) => {
  const h = createHash('sha256');
  for await (const c of createReadStream(file)) h.update(c);
  return h.digest('hex');
};

async function build(out: string, cache: string, jobs: number): Promise<string> {
  mkdirSync(out, { recursive: true });
  mkdirSync(cache, { recursive: true });

  step('disk');
  const s = statfsSync(out), free = s.bavail * s.bsize;
  if (free < NEED.build) {
    throw new Error(`空きディスクが足りません。地図のデータを作るあいだ約 ${fmtBytes(NEED.build)} の空きが要ります（作ったあとに残るのは約 ${fmtBytes(NEED.after)}）。今の空きは ${fmtBytes(free)} です。ファイルを消して空きを作ってから、もう一度押してください`);
  }
  log(`空きディスク ${fmtBytes(free)}（要るのは約 ${fmtBytes(NEED.build)}）`);

  step('abr');
  const abrSrc = process.env.KOTOZUTE_ABR_URL ?? ABR_TOKYO.url;
  const abr = join(out, 'abrg.duckdb');
  if (isUrl(abrSrc)) {
    const part = join(cache, 'abrg-tokyo.duckdb');
    await download({ url: abrSrc, dest: part, sha256: ABR_TOKYO.sha256, log, progress }).catch((e: Error) => {
      throw new Error(`住所のデータをダウンロードできませんでした。住所のデータがまだ公開されていないか、ネットにつながっていません（${e.message}）`);
    });
    renameSync(part, abr);
  } else {
    if (!existsSync(abrSrc)) throw new Error(`住所のデータをダウンロードできませんでした。KOTOZUTE_ABR_URL のファイルがありません：${abrSrc}`);
    if ((await sha256Of(abrSrc)) !== ABR_TOKYO.sha256) throw new Error(`住所のデータの sha256 が固定した値と違います：${abrSrc}`);
    copyFileSync(abrSrc, abr, constants.COPYFILE_FICLONE);
  }

  step('osm');
  const pbfSrc = process.env.KOTOZUTE_PBF_URL ?? CATALOG.subregions.kanto.url;
  let pbf: string, downloaded = false;
  if (isUrl(pbfSrc)) {
    pbf = join(cache, basename(new URL(pbfSrc).pathname));
    // Geofabrik のものは .md5 で確かめる（差し替えの URL には .md5 がないことがある）。revalidate：前の回の残りは、今の latest と同じときだけ使う
    await download({ url: pbfSrc, dest: pbf, md5Url: process.env.KOTOZUTE_PBF_URL ? undefined : true, revalidate: true, log, progress });
    downloaded = true;
  } else {
    if (!existsSync(pbfSrc)) throw new Error(`KOTOZUTE_PBF_URL のファイルがありません：${pbfSrc}`);
    pbf = resolve(pbfSrc); // 手元のファイルはその場で使い、消さない
    log(`OSM のデータは手元のファイルを使います：${pbf}`);
  }

  step('tiles');
  // pmtiles：アプリには入っている（bin/pmtiles）。開発中は手元のもの、なければ固定した版を GitHub から取る
  const bin = existsSync(join(ROOT, 'bin/pmtiles')) ? join(ROOT, 'bin/pmtiles')
    : await pmtilesBin(spawnSync('pmtiles', ['version']).status === 0 ? 'host' : 'download', join(cache, 'bin'), log);
  const src = process.env.KOTOZUTE_TILES_FILE ?? await latestBuild(log);
  const tiles = join(out, 'tokyo.pmtiles');
  // pmtiles は取る量を「fetching chunks 45% |…| (81/181 MB, …)」の形で出す。それを進み具合にする
  const tilesLog: Log = (m) => {
    const p = /\((\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?) MB/.exec(m);
    if (p) progress(Number(p[1]) * 2 ** 20, Number(p[2]) * 2 ** 20); else log(m);
  };
  await extract({ bin, src, out: tiles, bbox: DEFAULT.bbox, maxzoom: 15, log: tilesLog });
  const tilesAsOf = (await tilesInfo(tiles)).asOf;

  step('index');
  const db = join(out, 'osm.db');
  await buildOsmIndex({ pbf, out: db, log });
  const { DatabaseSync } = await import('node:sqlite');
  const sq = new DatabaseSync(db, { readOnly: true });
  const osmAsOf = (sq.prepare("SELECT v FROM meta WHERE k = 'osm_as_of'").get() as { v: string } | undefined)?.v;
  sq.close();
  if (!osmAsOf) throw new Error('検索データにデータ時点（osm_as_of）がありません');

  step('valhalla');
  log(`ルートのデータを ${jobs} スレッドで作ります`);
  // 速度表（raw.githubusercontent.com）を取る。そこでネットが切れたときも日本語の文にする
  await buildValhalla({ pbf, dir: join(out, 'valhalla'), jobs, log }).catch((e: Error) => {
    throw e.message === 'fetch failed' || e.name === 'TimeoutError' ? netError('https://raw.githubusercontent.com/', e) : e;
  });

  step('region');
  // npm run setup の東京と同じ形。abrg の場所は入れない（アプリの中にあり、アプリを動かすと場所が変わる。アプリが ABRG_BIN で渡す）
  const { abrg_bin: _, ...region } = regionConfig(resolveRegion('tokyo'), {
    index: { out: db, asOf: osmAsOf }, tiles, tilesAsOf, valhalla: join(out, 'valhalla', 'valhalla.json'), abrCache: abr, abrgBin: '',
  });
  const file = join(out, 'region.json');
  writeFileSync(file, JSON.stringify(region satisfies RegionConfig, null, 2) + '\n');
  if (downloaded) {
    for (const f of [pbf, `${pbf}.etag`]) rmSync(f, { force: true });
    log('OSM のデータ（pbf）を消しました');
  }
  return file;
}

/** 試し（KOTOZUTE_BUILD_FAKE）：手順と進み具合だけを出し、開発用のデータを指す region.json を書く。住所の DuckDB だけは写す（abrg が開くため） */
async function fake(out: string): Promise<string> {
  const v = process.env.KOTOZUTE_BUILD_FAKE!;
  const src = v === '1' ? join(ROOT, 'data/region.json') : resolve(v);
  if (!existsSync(src)) throw new Error(`試しのデータの元（${src}）がありません`);
  const base = resolve(dirname(src), '..'); // region.json の中の相対パスは、そのリポジトリの根から
  const r: RegionConfig = JSON.parse(readFileSync(src, 'utf8'));
  const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));
  mkdirSync(out, { recursive: true });
  for (const { id } of STEPS) {
    step(id);
    if (id === 'osm') for (let i = 1; i <= 8; i++) { await sleep(100); emit({ type: 'progress', got: i * 64 * 2 ** 20, total: 512 * 2 ** 20 }); }
    else await sleep(250);
  }
  const abs = (p?: string) => (p ? resolve(base, p) : p);
  if (!r.abr_cache) throw new Error(`試しのデータの元に住所のデータ（abr_cache）がありません：${src}`);
  copyFileSync(abs(r.abr_cache)!, join(out, 'abrg.duckdb'), constants.COPYFILE_FICLONE);
  const { abrg_bin: _, ...region } = {
    ...r, tiles: abs(r.tiles)!, osm_index: abs(r.osm_index)!, boundary: abs(r.boundary)!, valhalla_config: abs(r.valhalla_config),
    abr_cache: join(out, 'abrg.duckdb'), osm_backend: 'sqlite' as const,
    osm_as_of: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), // 試しだけ：作り直すとデータ時点が変わることを画面で確かめるため
  };
  const file = join(out, 'region.json');
  writeFileSync(file, JSON.stringify(region, null, 2) + '\n');
  return file;
}

try {
  const { values: v } = parseArgs({ options: { out: { type: 'string' }, cache: { type: 'string' }, jobs: { type: 'string' } }, strict: true });
  if (!v.out || !v.cache) throw new Error('使い方：app-data-build.ts --out <フォルダ> --cache <フォルダ> [--jobs N]');
  const jobs = v.jobs ? Number(v.jobs) : totalmem() < 12 * GiB ? 1 : 2; // 関東を2スレッドで最大約 4.6GB（設計書 §17）
  if (!Number.isInteger(jobs) || jobs < 1 || jobs > 64) throw new Error(`--jobs は 1〜64 の整数です（${v.jobs}）`);
  const region = process.env.KOTOZUTE_BUILD_FAKE ? await fake(resolve(v.out)) : await build(resolve(v.out), resolve(v.cache), jobs);
  emit({ type: 'done', region });
} catch (e) {
  emit({ type: 'error', msg: (e as Error).message });
  process.exitCode = 1;
}
