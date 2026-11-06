// セットアップの引数と、地域の解決（設計書 §6）と、要るディスク・メモリ・ダウンロードの見積もり（設計書 §7 の 1）。
// ネットに出ない（--dry-run でも、確認のテストでも使う）。
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { BBox, LngLat } from '../../src/ops/types';
import type { RegionConfig } from '../../src/region';
import { mapBBox } from './boundary';

interface Source { url: string; poly: string; mib: number }
interface Catalog {
  tokyo: { url: string; md5: string; bytes: number };
  japan: Source & { label: string; name: string };
  subregions: Record<string, Source & { label: string; name: string; prefs: string[] }>;
  prefectures: { jis: string; name: string; key: string; capital: LngLat; subregion: string }[];
}
export const CATALOG: Catalog = JSON.parse(readFileSync(new URL('./regions.json', import.meta.url), 'utf8'));
export const DEFAULT: RegionConfig = JSON.parse(readFileSync(new URL('../../src/region.default.json', import.meta.url), 'utf8'));

/** 手順の名前（--redo と --only に使う） */
export const STEPS = ['boundary', 'index', 'valhalla', 'abr', 'abrg', 'tiles', 'assets', 'region', 'build', 'verify'] as const;
export type StepName = (typeof STEPS)[number];

export interface Args {
  region: string;
  /** 再利用：手元のファイル。消さない・上書きしない */
  pbf?: string; tilesFile?: string; abrCache?: string; abrgBin?: string; valhallaDir?: string;
  keepPbf: boolean; maxzoom: 14 | 15; islands?: 'main' | 'all'; jobs: number; dryRun: boolean; portApp: number;
  osmium: 'auto' | 'host' | 'container'; redo: Set<StepName>; only: Set<StepName> | null;
}

export class SetupError extends Error {}

export function regionList(): string {
  return [
    `日本全国：japan`,
    `地方：${Object.keys(CATALOG.subregions).filter((k) => !CATALOG.prefectures.some((p) => p.key === k)).join('、')}`,
    `都道府県：${CATALOG.prefectures.map((p) => p.key).join('、')}（tokyo は今のデモと同じ設定）`,
  ].join('\n');
}

export function parseSetupArgs(argv: string[]): Args {
  let v;
  try {
    v = parseArgs({
      args: argv, strict: true, allowPositionals: false,
      options: {
        region: { type: 'string' }, pbf: { type: 'string' }, 'tiles-file': { type: 'string' }, 'abr-cache': { type: 'string' },
        'abrg-bin': { type: 'string' }, 'valhalla-dir': { type: 'string' }, 'keep-pbf': { type: 'boolean' }, maxzoom: { type: 'string' },
        islands: { type: 'string' }, jobs: { type: 'string' }, 'dry-run': { type: 'boolean' }, 'port-app': { type: 'string' },
        osmium: { type: 'string' }, redo: { type: 'string' }, only: { type: 'string' },
      },
    }).values;
  } catch (e) {
    throw new SetupError(`引数を読めません：${(e as Error).message}\n使い方：npm run setup -- --region=<地域> [--dry-run]`);
  }
  if (!v.region) throw new SetupError(`--region=<地域> を指定してください。使える地域：\n${regionList()}`);
  const int = (k: string, s: string | undefined, d: number, min: number, max: number) => {
    if (s === undefined) return d;
    const n = Number(s);
    if (!Number.isInteger(n) || n < min || n > max) throw new SetupError(`--${k} は ${min}〜${max} の整数です（${s}）`);
    return n;
  };
  const oneOf = <T extends string>(k: string, s: string | undefined, ok: readonly T[]): T | undefined => {
    if (s !== undefined && !ok.includes(s as T)) throw new SetupError(`--${k} は ${ok.join(' か ')} です（${s}）`);
    return s as T | undefined;
  };
  const steps = (k: string, s: string | undefined) => {
    const xs = (s ?? '').split(',').map((x) => x.trim()).filter(Boolean);
    const badStep = xs.find((x) => !(STEPS as readonly string[]).includes(x));
    if (badStep) throw new SetupError(`--${k} の手順「${badStep}」はありません。手順：${STEPS.join('、')}`);
    return new Set(xs as StepName[]);
  };
  const maxzoom = int('maxzoom', v.maxzoom, 15, 14, 15) as 14 | 15;
  if (maxzoom === 14 && v.region !== 'japan') throw new SetupError('--maxzoom=14 は japan だけで使えます（ほかの地域は拡大の上限15のまま）');
  return {
    region: v.region, pbf: v.pbf, tilesFile: v['tiles-file'], abrCache: v['abr-cache'], abrgBin: v['abrg-bin'], valhallaDir: v['valhalla-dir'],
    keepPbf: !!v['keep-pbf'], maxzoom, islands: oneOf('islands', v.islands, ['main', 'all'] as const), jobs: int('jobs', v.jobs, 2, 1, 64),
    dryRun: !!v['dry-run'], portApp: int('port-app', v['port-app'], 8787, 1, 65535),
    osmium: oneOf('osmium', v.osmium, ['auto', 'host', 'container'] as const) ?? 'auto',
    redo: steps('redo', v.redo), only: v.only === undefined ? null : steps('only', v.only),
  };
}

export interface Region {
  id: string;
  kind: 'tokyo' | 'pref' | 'subregion' | 'japan';
  /** 島を外したときは、境界を作ったあとで「（島しょ部を除く）」を足す（東京は既定のまま） */
  label: string; name: string;
  prefs: { code: number; name: string; jis: string; capital: LngLat }[];
  /** OSM データ（Geofabrik）。key は地方の名前か japan。pinned は東京の固定のファイル */
  data: Source & { key: string; pinned?: Catalog['tokyo'] };
  /** ABR に渡す都道府県（'13' か 'all'） */
  abrPref: string;
  islands: 'main' | 'all';
}

/** 地域の名前から、使う OSM データと都道府県を決める。tokyo は今のデモの設定（境界と bbox は Git の中のもの） */
export function resolveRegion(id: string, islands?: 'main' | 'all'): Region {
  const pref = (jis: string) => {
    const p = CATALOG.prefectures.find((x) => x.jis === jis)!;
    return { code: Number(p.jis), name: p.name, jis: p.jis, capital: p.capital };
  };
  const sub = (key: string) => ({ key, ...CATALOG.subregions[key] });
  if (id === 'tokyo') {
    if (islands) throw new SetupError('tokyo は今のデモと同じ範囲（島しょ部を除く）です。--islands は使えません');
    return { id, kind: 'tokyo', label: DEFAULT.label, name: DEFAULT.name, prefs: [pref('13')], data: { ...sub('kanto'), pinned: CATALOG.tokyo }, abrPref: '13', islands: 'main' };
  }
  const p = CATALOG.prefectures.find((x) => x.key === id);
  if (p) return { id, kind: 'pref', label: p.name, name: p.name, prefs: [pref(p.jis)], data: sub(p.subregion), abrPref: p.jis, islands: islands ?? 'main' };
  const s = CATALOG.subregions[id];
  if (s) return { id, kind: 'subregion', label: s.label, name: s.name, prefs: s.prefs.map(pref), data: sub(id), abrPref: s.prefs.length === 1 ? s.prefs[0] : 'all', islands: islands ?? 'main' };
  if (id === 'japan') {
    return { id, kind: 'japan', label: CATALOG.japan.label, name: CATALOG.japan.name, prefs: CATALOG.prefectures.map((x) => pref(x.jis)), data: { key: 'japan', ...CATALOG.japan }, abrPref: 'all', islands: islands ?? 'all' };
  }
  throw new SetupError(`知らない地域です：${id}。使える地域：\n${regionList()}`);
}

const MiB = 2 ** 20, GiB = 2 ** 30;
/**
 * 手順ごとの大きさの見積もり（バイト）。download：取ってくる量、final：残る量、temp：作るあいだだけ要る量。
 * 数字は 2026-11-06 の関東の測定（pbf 0.5GB → 検索データ 0.3GB、Valhalla の tar 0.9GB・作業のタイル 2.4GB、地図 473MB）からの比。
 * ponytail: 比で伸ばしただけの見積もり。地方と全国は測っていない（README に「試していない」と書く）
 */
export function sizes(r: Region, maxzoom: 14 | 15) {
  const pbf = r.data.pinned?.bytes ?? r.data.mib * MiB;
  const all = r.abrPref === 'all';
  const tiles = r.kind === 'tokyo' ? 190 * MiB : r.kind === 'pref' ? 200 * MiB : r.kind === 'japan' ? (maxzoom === 14 ? 1.3 : 2.6) * GiB : pbf * 0.95;
  return {
    pbf,
    steps: {
      boundary: { download: 0, final: 2 * MiB, temp: 0.2 * pbf },
      index: { download: 0, final: 0.65 * pbf, temp: 0.3 * pbf },
      valhalla: { download: 1 * MiB, final: 1.8 * pbf, temp: 4.6 * pbf },
      abr: { download: (all ? 0.55 * GiB : 45 * MiB) + 0.3 * GiB, final: all ? 0.4 * GiB : 30 * MiB, temp: (all ? 2.5 : 0.5) * GiB + 2 * GiB },
      abrg: { download: 0.3 * GiB, final: 40 * MiB, temp: 2 * GiB },
      tiles: { download: tiles, final: tiles, temp: 0 },
      assets: { download: 7 * MiB, final: 12 * MiB, temp: 7 * MiB },
      region: { download: 0, final: 0, temp: 0 },
      build: { download: 0, final: 20 * MiB, temp: 0 },
      verify: { download: 0, final: 0, temp: 0 },
    } satisfies Record<StepName, { download: number; final: number; temp: number }>,
    /** 作るときの最大メモリ（GiB）：Valhalla は関東を2スレッドで 4.6GB（Docker の cgroup の値）。日本全国は測っていない */
    ramGiB: r.kind === 'japan' ? 12 : 5,
    /** 作業用の PostgreSQL に要る Docker のメモリ（GiB） */
    dockerMemGiB: all ? 4 : 2,
  };
}

export const fmtBytes = (n: number) => (n >= GiB ? `${(n / GiB).toFixed(1)} GiB` : `${Math.max(1, Math.round(n / MiB))} MiB`);

/**
 * data/region.json の中身。東京は既定（src/region.default.json）に、作ったもの（検索データ、データ時点、ルート、住所）を足すだけ。
 * ほかは境界から：名前（島を外したら「（島しょ部を除く）」）、範囲（境界＋2km）、最初の表示（県は県庁所在地、地方と全国は範囲の真ん中）
 */
export function regionConfig(r: Region, x: {
  boundary?: { file: string; bbox: BBox; dropped: boolean };
  index: { out: string; asOf: string }; tiles: string; tilesAsOf: string | null;
  valhalla: string; abrCache: string; abrgBin: string;
}): RegionConfig {
  let base: RegionConfig;
  if (r.kind === 'tokyo') base = { ...DEFAULT };
  else {
    const b = x.boundary!;
    const bbox = mapBBox(b.bbox);
    const r3 = (v: number) => Math.round(v * 1000) / 1000;
    base = {
      id: r.id, label: r.label + (b.dropped ? '（島しょ部を除く）' : ''), name: r.name,
      prefs: r.prefs.map((p) => ({ code: p.code, name: p.name })), bbox,
      view: { center: r.kind === 'pref' ? r.prefs[0].capital : [r3((bbox[0] + bbox[2]) / 2), r3((bbox[1] + bbox[3]) / 2)], zoom: r.kind === 'pref' ? 12 : r.kind === 'subregion' ? 8 : 5 },
      boundary: b.file, tiles: '', osm_index: '', osm_as_of: '', tiles_as_of: '',
    };
  }
  return {
    ...base, tiles: x.tiles, osm_index: x.index.out, osm_as_of: x.index.asOf, tiles_as_of: x.tilesAsOf ?? base.tiles_as_of,
    osm_backend: 'sqlite', valhalla_config: x.valhalla, abr_cache: x.abrCache, abrg_bin: x.abrgBin,
  };
}
