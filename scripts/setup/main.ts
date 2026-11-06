// npm run setup -- --region=<地域>（入口は scripts/setup.mjs）。設計書 §6・§7・§16。
// 手順を1つずつ順に回す。手順ごとに印（data/setup/state/）を残し、止まっても同じコマンドで続きから回る。
// 再利用のオプション（--pbf、--tiles-file、--abr-cache、--abrg-bin、--valhalla-dir）で渡したファイルは、その場で使い、消さない・上書きしない。
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { freemem, totalmem } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BBox } from '../../src/ops/types';
import type { RegionConfig } from '../../src/region';
import { dictSignature } from '../../src/services/osm-sqlite';
import { buildBoundary, mapBBox } from './boundary';
import { buildAbrData, buildAbrg } from './abr';
import { download, head } from './download';
import { buildOsmIndex } from './osm-index';
import { DEFAULT, fmtBytes, parseSetupArgs, regionConfig, resolveRegion, SetupError, sizes, type Args, type Region, type StepName } from './plan';
import { prereq } from './prereq';
import { ensureEnv, lock, Marks, mask, openLog, sameFile, writeAtomic } from './steps';
import { extract, latestBuild, pmtilesBin, poly2geojson, tilesInfo } from './tiles';
import { OSMIUM_IMAGE, osmiumFor, type Log } from './tools';
import { buildValhalla } from './valhalla';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DATA = join(ROOT, 'data/setup');
/** フォントとアイコン（basemaps-assets）の固定の版。サーバはこのフォルダから配信する（src/server/main.ts の ASSETS） */
const ASSETS_COMMIT = '028c18f713baecad011301ff7a69acc39bcc2ae7';
const ASSETS_DIR = join(ROOT, 'data/basemaps-assets-src/basemaps-assets-main');
const TOKYO_POINTS = { a: [139.7379847, 35.6288086], b: [139.7494, 35.6548] } as const; // 品川駅 高輪口 → 芝公園（デモの場所）

/** リポジトリの中なら根からの相対（data/region.json の書き方）、外なら絶対パス */
const rel = (p: string) => { const r = relative(ROOT, resolve(p)); return r.startsWith('..') || isAbsolute(r) ? resolve(p) : r.split(sep).join('/'); };
const abs = (p: string) => resolve(ROOT, p);
const fileKey = (f: string) => { const s = statSync(f); return `file:${realpathSync(f)}:${s.size}:${Math.round(s.mtimeMs)}`; };

interface Step {
  name: StepName; title: string;
  /** 再利用・既にあるものを使うときの説明（手順を回さない） */
  reuse?: () => { note: string; result: Record<string, unknown> } | null;
  /** 入力（同じなら済み）。null は「まだ分からない＝回す」。undefined の手順は毎回回す */
  inputs?: () => unknown;
  outputs?: () => string[];
  run: () => Promise<Record<string, unknown>>;
}

async function main(argv: string[]): Promise<void> {
  const args = parseSetupArgs(argv);
  const region = resolveRegion(args.region, args.islands);
  for (const [k, f] of [['pbf', args.pbf], ['tiles-file', args.tilesFile], ['abr-cache', args.abrCache], ['abrg-bin', args.abrgBin]] as const) {
    if (f && !existsSync(f)) throw new SetupError(`--${k} のファイルがありません：${f}`);
  }
  if (args.valhallaDir && !['valhalla_tiles.tar', 'valhalla.json'].every((f) => existsSync(join(args.valhallaDir!, f)))) {
    throw new SetupError(`--valhalla-dir のフォルダに valhalla_tiles.tar と valhalla.json がありません：${args.valhallaDir}`);
  }

  const marks = new Marks(join(DATA, 'state'));
  const L = args.dryRun ? null : openLog(join(DATA, 'logs'));
  const log: Log = L?.log ?? ((m) => console.log(m));
  if (!args.dryRun) lock(join(DATA, 'setup.lock'));
  const warn = (m: string) => log(`注意：${m}`);
  const size = sizes(region, args.maxzoom);

  // ===== OSM データ（pbf）：使う手順が最初に呼んだときに取る =====
  const want = region.data.pinned?.url ?? region.data.url;
  const pbfMark = () => (marks.done('pbf', { want }) ? (marks.get('pbf')!.result as { file: string; name: string; fallback?: boolean }) : null);
  const pbfKey = () => (args.pbf ? fileKey(args.pbf) : pbfMark() ? `geofabrik:${pbfMark()!.name}` : null);
  const pbfHere = () => (args.pbf ? resolve(args.pbf) : pbfMark() && existsSync(abs(pbfMark()!.file)) ? abs(pbfMark()!.file) : null);
  async function ensurePbf(): Promise<string> {
    const have = pbfHere();
    if (have) return have;
    let url = want, md5: string | undefined = region.data.pinned?.md5, fallback = false;
    if (region.data.pinned && !(await head(url)).ok) {
      warn(`固定した OSM データ（${basename(url)}）が Geofabrik から消えていたので、最新を使います。動画と件数や時間が違うことがあります`);
      [url, md5, fallback] = [region.data.url, undefined, true];
    }
    const dest = join(DATA, 'pbf', basename(url));
    const got = await download({ url, dest, md5, md5Url: md5 ? undefined : true, log });
    marks.set('pbf', { want }, { file: rel(dest), name: basename(got.url), fallback });
    return dest;
  }

  // ===== 手順（設計書 §7）。東京の境界は Git の中のもの =====
  let osmium: ReturnType<typeof osmiumFor> | undefined;
  let found = { osmium: null as 'host' | 'container' | null, pmtiles: null as 'host' | 'download' | null };
  const result = (s: StepName) => marks.get(s)?.result as Record<string, any> | undefined;
  /** 前の手順の結果。今の入力で済んでいるものだけ（別の地域で作った古い結果は使わない） */
  const need = (s: StepName) => {
    const st = steps.find((x) => x.name === s)!;
    const r = reused.get(s) ?? (st.inputs && marks.done(s, st.inputs(), st.outputs?.() ?? []) ? result(s) : undefined);
    if (!r) throw new Error(`先に手順「${s}」を回してください（--only を外すと全部回ります）`);
    return r as Record<string, any>;
  };
  const reused = new Map<StepName, Record<string, unknown>>();
  const tilesDest = join(ROOT, `${region.id}.pmtiles`);
  const boundaryFile = join(DATA, 'boundary.json');
  const steps: Step[] = [
    ...(region.kind === 'tokyo' ? [] : [{
      name: 'boundary', title: '受け付ける範囲（都道府県の境界）',
      inputs: () => (pbfKey() ? { pbf: pbfKey(), prefs: region.prefs.map((p) => p.jis), islands: region.islands } : null),
      outputs: () => [boundaryFile],
      run: async () => {
        const b = await buildBoundary({ pbf: await ensurePbf(), prefs: region.prefs.map((p) => p.jis), islands: region.islands, work: join(DATA, 'boundary-work'), osmium: osmium!, log });
        writeAtomic(boundaryFile, JSON.stringify({ source: `© OpenStreetMap contributors（ODbL）。都道府県の relation の輪を osmium で組み、島の規則（${region.islands === 'all' ? '島も全部' : '県庁所在地の輪と 5 km 以内でつながる輪'}）で残して間引いたもの`, bbox: b.bbox, groups: b.groups }) + '\n');
        return { file: rel(boundaryFile), bbox: b.bbox, dropped: b.dropped };
      },
    } satisfies Step]),
    {
      name: 'index', title: '検索データ（SQLite）',
      inputs: () => (pbfKey() ? { pbf: pbfKey(), dict: createHash('sha256').update(dictSignature()).digest('hex').slice(0, 16) } : null),
      outputs: () => (result('index') ? [abs(result('index')!.out)] : []),
      run: async () => {
        const pbf = await ensurePbf();
        const ts = await osmiumOut(['fileinfo', '-g', 'header.option.osmosis_replication_timestamp', pbf]);
        const day = /^\d\d(\d\d)-(\d\d)-(\d\d)/.exec(ts);
        const out = join(DATA, 'osm', `${region.data.key}-${day ? day.slice(1).join('') : 'local'}`, 'osm.db');
        const r = await buildOsmIndex({ pbf, out, osmium: osmium!, log });
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(out, { readOnly: true });
        const asOf = (db.prepare("SELECT v FROM meta WHERE k = 'osm_as_of'").get() as { v: string }).v;
        db.close();
        const prev = result('index')?.out;
        if (prev && prev !== rel(out) && existsSync(abs(prev))) log(`前の検索データ（${prev}）は使わなくなりました。要らなければ消してください`);
        return { out: rel(out), asOf, bytes: r.bytes };
      },
    },
    {
      name: 'valhalla', title: 'ルートのデータ（Valhalla）',
      reuse: () => (args.valhallaDir ? { note: `--valhalla-dir（${args.valhallaDir}）を使います`, result: { config: rel(join(args.valhallaDir, 'valhalla.json')) } } : null),
      inputs: () => (pbfKey() ? { pbf: pbfKey() } : null),
      outputs: () => ['valhalla_tiles.tar', 'valhalla.json'].map((f) => join(DATA, 'valhalla', f)),
      run: async () => {
        await buildValhalla({ pbf: await ensurePbf(), dir: join(DATA, 'valhalla'), jobs: args.jobs, log });
        return { config: rel(join(DATA, 'valhalla', 'valhalla.json')) };
      },
    },
    {
      name: 'abr', title: '住所のデータ（ABR、DuckDB）',
      reuse: () => (args.abrCache ? { note: `--abr-cache（${args.abrCache}）を使います。Docker は使いません`, result: { cache: rel(args.abrCache) } } : null),
      inputs: () => ({ pref: region.abrPref }),
      outputs: () => [join(DATA, 'abr', 'abrg.duckdb')],
      run: async () => {
        await buildAbrData({ pref: region.abrPref, dir: join(DATA, 'abr'), log });
        return { cache: rel(join(DATA, 'abr', 'abrg.duckdb')) };
      },
    },
    {
      name: 'abrg', title: '住所の道具（abrg）',
      reuse: () => (args.abrgBin ? { note: `--abrg-bin（${args.abrgBin}）を使います`, result: { bin: rel(args.abrgBin) } } : null),
      inputs: () => ({ platform: `${process.platform}-${process.arch}` }),
      outputs: () => [join(DATA, 'abr', 'abrg')],
      run: async () => ({ bin: rel(await buildAbrg({ dir: join(DATA, 'abr'), log })) }),
    },
    {
      name: 'tiles', title: '地図タイル（Protomaps）',
      reuse: () => {
        // 渡されたファイルか、セットアップの前からあるファイル（今のデモの tokyo.pmtiles など）は、作り直さずに使う
        const ours = result('tiles')?.file === rel(tilesDest);
        const f = args.tilesFile ?? (!ours && !args.redo.has('tiles') && existsSync(tilesDest) ? tilesDest : null);
        if (!f) return null;
        return { note: `${args.tilesFile ? '--tiles-file' : 'すでにある'}（${rel(f)}）を使います${args.tilesFile ? '' : '。作り直すなら --redo=tiles'}`, result: { file: sameFile(f, tilesDest) ? rel(tilesDest) : rel(f) } };
      },
      // 県の切り出しの範囲は境界から決まる（境界の手順のあと）。入力は地域で見る
      inputs: () => ({ region: region.id, islands: region.islands, maxzoom: args.maxzoom }),
      outputs: () => [tilesDest],
      run: async () => {
        const bin = await pmtilesBin(found.pmtiles!, join(DATA, 'bin'), log);
        const src = await latestBuild(log);
        let shape: { bbox?: [number, number, number, number]; region?: string };
        if (region.kind === 'tokyo') shape = { bbox: DEFAULT.bbox };
        else if (region.kind === 'pref') shape = { bbox: mapBBox(need('boundary').bbox) };
        else {
          const poly = join(DATA, 'tiles', basename(region.data.poly));
          await download({ url: region.data.poly, dest: poly, log });
          const geo = poly.replace(/\.poly$/, '.geojson');
          writeFileSync(geo, JSON.stringify(poly2geojson(readFileSync(poly, 'utf8'))));
          shape = { region: geo };
        }
        await extract({ bin, src, out: tilesDest, ...shape, maxzoom: args.maxzoom, log });
        if (found.pmtiles === 'download') rmSync(join(DATA, 'bin'), { recursive: true, force: true }); // 取ってきた道具は消す
        return { file: rel(tilesDest) };
      },
    },
    {
      name: 'assets', title: 'フォントとアイコン（basemaps-assets）',
      // 既にあるフォルダは消さない・上書きしない（シンボリックリンクで別のフォルダを指していることがある）
      reuse: () => (existsSync(join(ASSETS_DIR, 'fonts')) ? { note: `すでにある ${rel(ASSETS_DIR)} を使います`, result: {} } : null),
      run: async () => {
        const tgz = join(DATA, `basemaps-assets-${ASSETS_COMMIT.slice(0, 7)}.tar.gz`);
        await download({ url: `https://codeload.github.com/protomaps/basemaps-assets/tar.gz/${ASSETS_COMMIT}`, dest: tgz, log });
        const part = `${ASSETS_DIR}.part`;
        rmSync(part, { recursive: true, force: true });
        mkdirSync(part, { recursive: true });
        await exec('tar', ['-xzf', tgz, '--strip-components=1', '-C', part], log);
        renameSync(part, ASSETS_DIR);
        rmSync(tgz);
        return {};
      },
    },
    {
      name: 'region', title: '地域の設定（data/region.json）',
      run: async () => {
        const tiles = need('tiles'), index = need('index');
        const cfg = regionConfig(region, {
          boundary: region.kind === 'tokyo' ? undefined : (need('boundary') as { file: string; bbox: BBox; dropped: boolean }),
          index: { out: index.out, asOf: index.asOf }, tiles: tiles.file, tilesAsOf: (await tilesInfo(abs(tiles.file))).asOf,
          valhalla: need('valhalla').config, abrCache: need('abr').cache, abrgBin: need('abrg').bin,
        });
        writeAtomic(join(ROOT, 'data/region.json'), JSON.stringify(cfg, null, 2) + '\n');
        if (ensureEnv(ROOT)) log('.env を .env.example から作りました。日本語の依頼を使うときは、.env の ANTHROPIC_API_KEY にキーを書いてください（札とボタンはキーがなくても動きます）');
        return {};
      },
    },
    {
      name: 'build', title: '画面（vite build）',
      // 画面は地域の設定を build の中に持つ。設定を変えたら必ず作り直す（毎回作る。数秒）
      run: async () => { await exec(process.execPath, [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build'], log, ROOT); return {}; },
    },
    { name: 'verify', title: '動作確認', run: async () => { await verify(region, args, need, log); return {}; } },
  ];

  // ===== 計画（設計書 §7 の 1）：どの手順を回すか、何を取ってくるか、どれだけ要るか =====
  const plan = steps.map((s) => {
    // 再利用は --only で飛ばす手順でも効かせる（あとの手順がその結果を使うため。何も書かない）
    const r = s.reuse?.();
    if (r) { reused.set(s.name, r.result); return { s, state: 'reuse' as const, note: r.note }; }
    if (args.only && !args.only.has(s.name)) return { s, state: 'skip' as const, note: '飛ばす（--only）' };
    const inputs = s.inputs?.();
    const done = s.inputs !== undefined && inputs !== null && !args.redo.has(s.name) && marks.done(s.name, inputs, s.outputs?.() ?? []);
    return { s, state: done ? ('done' as const) : ('run' as const), note: done ? '済み' : '回す' };
  });
  const todo = new Set(plan.filter((p) => p.state === 'run').map((p) => p.s.name));
  const pbfUse = (['boundary', 'index', 'valhalla'] as StepName[]).some((s) => todo.has(s));
  const pbfDownload = pbfUse && !pbfHere();
  const todoSizes = [...todo].map((s) => size.steps[s]);
  const downloads = (pbfDownload ? size.pbf : 0) + todoSizes.reduce((a, x) => a + x.download, 0);
  const disk = (pbfDownload ? size.pbf : 0) + todoSizes.reduce((a, x) => a + x.final, 0) + Math.max(0, ...todoSizes.map((x) => x.temp)) + 2 ** 29;
  log(`地域：${region.id}（${region.label}${region.kind === 'tokyo' ? '。今のデモと同じ設定' : ''}）。住所：${region.abrPref === 'all' ? '全国の住居表示' : `${region.prefs[0].name}の住居表示`}`);
  for (const p of plan) log(`  [${p.s.name}] ${p.s.title}：${p.note}`);
  log(`OSM データ：${args.pbf ? `--pbf（${args.pbf}）を使います` : !pbfUse ? '使いません' : pbfDownload ? `${basename(want)} を取ってきます（約 ${fmtBytes(size.pbf)}）` : '取ってあります'}${!args.pbf && pbfUse && !args.keepPbf ? '。使い終わったら消します（残すなら --keep-pbf）' : ''}`);
  log(`ダウンロード：${downloads ? `約 ${fmtBytes(downloads)}` : 'なし'}。ディスク：約 ${fmtBytes(disk)}。作るときのメモリ：約 ${todo.has('valhalla') ? size.ramGiB : 1} GiB（この機械 ${fmtBytes(totalmem())}、空き ${fmtBytes(freemem())}）。どれも見積もり`);
  if (todo.has('valhalla') && totalmem() < size.ramGiB * 2 ** 30) warn(`この機械のメモリ（${fmtBytes(totalmem())}）は、ルートのデータを作るのに足りないかもしれません（約 ${size.ramGiB} GiB）。--jobs=1 にするとメモリは減り、時間は延びます`);

  // ===== 確認（設計書 §7 の 0） =====
  const pbfOutside = args.pbf && relative(DATA, resolve(args.pbf)).startsWith('..');
  const pre = await prereq({
    docker: todo.has('abr'), dockerMemGiB: size.dockerMemGiB, dockerDiskGiB: size.dockerDiskGiB,
    go: todo.has('abr') || todo.has('abrg'),
    goAvoid: [...(todo.has('abr') ? ['--abr-cache=<abrg.duckdb>'] : []), ...(todo.has('abrg') ? ['--abrg-bin=<abrg>'] : [])],
    python: todo.has('valhalla'), osmium: todo.has('index') || todo.has('boundary') ? args.osmium : null,
    pmtiles: todo.has('tiles'), port: todo.has('verify') ? args.portApp : null, diskBytes: disk, dir: DATA,
  });
  if (pre.found.osmium === 'container' && pbfOutside) pre.problems.push(`コンテナの osmium は data/setup の中のファイルしか読めません。--pbf のファイルを ${rel(join(DATA, 'pbf'))}/ に置くか、osmium を入れてください`);
  for (const m of pre.ok) log(`  ✓ ${m}`);
  for (const m of pre.problems) log(`  ✗ ${m}`);
  if (pre.problems.length) throw new SetupError('足りないものがあります。上の ✗ を直してから、もう一度回してください');
  if (args.dryRun) { log('--dry-run なので、ここで止めます'); return; }
  found = pre.found;
  if (found.osmium) osmium = osmiumFor(found.osmium, DATA);
  // コンテナの osmium のイメージは、セットアップが取ってきたときだけ最後に消す（前からあるものは消さない）。
  // 取ってくる前に印を残す（途中で止まった回のあとも、次に最後まで回ったときに消すため）
  if (found.osmium === 'container' && spawnSync('docker', ['image', 'inspect', OSMIUM_IMAGE], { stdio: 'ignore' }).status !== 0) marks.set('osmium-image', { image: OSMIUM_IMAGE });
  const osmiumOut = (a: string[]) => new Promise<string>((res, rej) => {
    const p = osmium!(a);
    let out = '';
    p.stdout!.on('data', (d) => (out += d));
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res(out.trim()) : rej(new Error(`osmium ${a[0]} が失敗しました（終了コード ${c}）`))));
  });

  // ===== 回す（重い手順は1つずつ） =====
  const t0 = Date.now();
  for (const p of plan) {
    if (p.state !== 'run') continue;
    log(`== ${p.s.title}`);
    const t = Date.now();
    let r: Record<string, unknown>;
    try {
      r = await p.s.run();
    } catch (e) {
      log(`手順「${p.s.name}」で止まりました：${(e as Error).message}`);
      if (L) console.error(`\n記録の最後の20行（全部は ${rel(L.file)}）：\n${L.tail(20).join('\n')}`);
      throw e;
    }
    // 入力は回したあとで取り直す（OSM データを取ってくるまでは pbf の名前が分からないため）
    if (p.s.inputs) marks.set(p.s.name, p.s.inputs(), r); else reused.set(p.s.name, r);
    log(`   済み（${((Date.now() - t) / 1000).toFixed(0)} 秒）`);
    // OSM データを使う手順が全部済んだら、取ってきた pbf を消す（--pbf で渡したものと --keep-pbf は残す）
    if (['boundary', 'index', 'valhalla'].includes(p.s.name)) dropPbf();
  }
  if (marks.get('osmium-image') && spawnSync('docker', ['rmi', OSMIUM_IMAGE], { stdio: 'ignore' }).status === 0) {
    marks.clear('osmium-image');
    log('取ってきた osmium のイメージを消しました');
  }
  function dropPbf() {
    const m = pbfMark();
    if (args.pbf || args.keepPbf || !m || !existsSync(abs(m.file))) return;
    const users = steps.filter((s) => ['boundary', 'index', 'valhalla'].includes(s.name) && !s.reuse?.());
    if (!users.every((s) => marks.done(s.name, s.inputs!(), s.outputs?.() ?? []))) return;
    rmSync(abs(m.file));
    log(`OSM データ（${m.file}）を消しました（残すなら --keep-pbf）`);
  }

  // ===== まとめ（設計書 §7 の 14） =====
  if (!args.only || args.only.has('region')) {
    const cfg = JSON.parse(readFileSync(join(ROOT, 'data/region.json'), 'utf8')) as RegionConfig;
    const files = [cfg.osm_index, cfg.tiles, cfg.valhalla_config && join(cfg.valhalla_config, '../valhalla_tiles.tar'), cfg.abr_cache, cfg.abrg_bin].filter((f): f is string => !!f);
    log(`できたもの（${((Date.now() - t0) / 60000).toFixed(1)} 分）：`);
    for (const f of files) log(`  ${f}：${existsSync(abs(f)) ? fmtBytes(statSync(abs(f)).size) : 'ありません'}`);
    log(`起動：${args.portApp === 8787 ? '' : `PORT=${args.portApp} `}npm start → http://localhost:${args.portApp}/`);
  }
  if (pbfMark()?.fallback) warn('OSM データは固定のものではなく最新です。動画と件数や時間が違うことがあります');
  if (L) log(`記録：${rel(L.file)}`);
}

/** コマンドを回す。出力は失敗したときだけ記録に出す（最後の30行） */
function exec(cmd: string, args: string[], log: Log, cwd = ROOT): Promise<void> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out: string[] = [];
    const keep = (d: Buffer) => { out = [...out, ...String(d).split('\n').filter((l) => l.trim())].slice(-30); };
    p.stdout.on('data', keep);
    p.stderr.on('data', keep);
    p.on('error', (e) => rej(new Error(`${basename(cmd)} を起動できません：${e.message}`)));
    p.on('close', (c) => {
      if (c === 0) return res();
      for (const l of out) log(`   ${l.trimEnd()}`);
      rej(new Error(`${basename(cmd)} ${args.at(-1)} が失敗しました（終了コード ${c}）`));
    });
  });
}

/**
 * 動作確認（設計書 §7 の 13）：npm start と同じ起こし方でアプリを起こし、画面・地図・フォント・検索データ・住所・ルートと、
 * そのルートの道のタグが検索データに全部あることを確かめる。Claude は呼ばない
 */
async function verify(region: Region, args: Args, need: (s: StepName) => Record<string, any>, log: Log): Promise<void> {
  const base = `http://127.0.0.1:${args.portApp}`;
  const app = spawn(process.execPath, [join(ROOT, 'scripts/start.mjs')], {
    cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PORT: String(args.portApp), OPLOG_FILE: join(DATA, 'logs', 'verify-ops.jsonl') },
  });
  const out: string[] = [];
  const keep = (d: Buffer) => out.push(...String(d).split('\n').filter(Boolean));
  app.stdout.on('data', keep);
  app.stderr.on('data', keep);
  const exited = new Promise<number | null>((r) => app.on('close', r));
  const bad: string[] = [];
  try {
    for (let i = 0; ; i++) {
      if (app.exitCode !== null) throw new Error(`アプリが起動しませんでした：\n${out.slice(-20).join('\n')}`);
      if (await fetch(`${base}/`).then((r) => r.ok, () => false)) break;
      if (i > 120) throw new Error(`アプリが60秒たっても応えません：\n${out.slice(-20).join('\n')}`);
      await new Promise((r) => setTimeout(r, 500));
    }
    const sessionId = `setup-check-${Date.now()}`;
    const api = async (path: string, body: unknown) => {
      const r = await fetch(`${base}/api/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sessionId, ...body as object }) });
      return { status: r.status, json: (await r.json()) as any };
    };
    const ok = (what: string, cond: boolean, detail = '') => { if (cond) log(`  ✓ ${what}${detail ? `：${detail}` : ''}`); else bad.push(`${what}${detail ? `：${detail}` : ''}`); };

    const tilesName = basename(need('tiles').file);
    const t = await fetch(`${base}/tiles/${tilesName}`, { headers: { range: 'bytes=0-6' } });
    ok('地図ファイル', t.status === 206 && (await t.text()) === 'PMTiles', `/tiles/${tilesName}`);
    ok('フォント', (await fetch(`${base}/assets/fonts/Noto%20Sans%20Regular/0-255.pbf`)).ok);

    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(abs(need('index').out), { readOnly: true });
    const n = (q: string) => Number((db.prepare(q).get() as { n: number }).n);
    const [feat, hw] = [n('SELECT count(*) AS n FROM feat'), n('SELECT count(*) AS n FROM hw')];
    db.close();
    ok('検索データ', feat > 0 && hw > 0, `地物 ${feat}、道 ${hw}`);

    const address = region.kind === 'tokyo' ? '東京都港区芝公園4-2-8' : region.prefs[0].name;
    const g = await api('op/geocode_address', { input: { address } });
    ok('住所', g.json.ok === true, g.json.ok ? `${address} → ${g.json.output?.place?.name ?? '一致'}` : `${address}（${g.json.error?.message ?? g.json.error}）`);

    // ルート：東京はデモの場所。ほかは県庁所在地と、そこから約1km（地域の外なら向きを変える）
    const [a, ...bs] = region.kind === 'tokyo'
      ? [TOKYO_POINTS.a, TOKYO_POINTS.b]
      : [region.prefs[0].capital, ...[[0.01, 0], [0, 0.01], [-0.01, 0], [0, -0.01]].map(([dx, dy]) => [region.prefs[0].capital[0] + dx, region.prefs[0].capital[1] + dy])];
    const c1 = await api('context', { click: a });
    let c2: { status: number; json: any } | undefined;
    for (const b of bs) if ((c2 = await api('context', { click: b })).status === 200) break;
    if (c1.status !== 200 || c2?.status !== 200) bad.push(`ルートの点が地域の中にありません（${JSON.stringify(c1.json)}）`);
    else {
      const r = await api('op/route', { input: { from: c1.json.clickRef, to: c2.json.clickRef, stops: [], keep_order: false, avoid_highways: false } });
      ok('ルート', r.json.ok === true, r.json.ok ? `${r.json.output.total.minutes} 分、${r.json.output.total.km} km` : r.json.error?.message);
      if (r.json.ok) {
        const c = await api('op/check_route', { input: { tunnels: null, max_minutes: 180, avoid_highways: false } });
        ok('ルートの道のタグ', c.json.ok === true && c.json.output.missing === 0, c.json.ok ? `道 ${c.json.output.ways} 本、見つからない ${c.json.output.missing} 本` : c.json.error?.message);
      }
    }
  } finally {
    app.kill('SIGTERM');
    await exited;
  }
  if (bad.length) throw new Error(`動作確認で問題がありました：\n${bad.map((b) => `  ✗ ${b}`).join('\n')}`);
}

main(process.argv.slice(2)).catch((e: Error) => {
  console.error(mask(e instanceof SetupError ? e.message : `\nセットアップが止まりました：${e.message}`));
  if (!(e instanceof SetupError)) console.error(`\n同じコマンドをもう一度回すと、続きから回ります：\n  npm run setup -- ${process.argv.slice(2).join(' ')}`);
  process.exit(1);
});
