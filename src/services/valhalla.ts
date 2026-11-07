// 自社の Valhalla（Docker、関東の OSM データ）への問い合わせ。公開のルート検索は使わない。
// 既定は HTTP（VALHALLA_URL）。VALHALLA_MODE=embedded では同じプロセスの中で動かす（下の embedded）。
import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { OpError, type LngLat } from '../ops/types';

const URL_ = process.env.VALHALLA_URL ?? 'http://localhost:8002';

export interface Maneuver { type: number; street_names?: string[]; length: number; time: number; roundabout_exit_count?: number }
export interface VLeg { sec: number; km: number; shape: LngLat[]; maneuvers: Maneuver[] }
export interface VRoute { sec: number; km: number; legs: VLeg[] }
/** 経由地の指定。break_through は区間を分けるが、そこで U ターンしない。heading（度）は通る向き、layer は寄せたい層（トンネルは -1） */
export interface VLoc { coord: LngLat; type: 'break' | 'break_through'; heading?: number; layer?: number }

const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

/** polyline6 を [lng, lat] の配列に戻す */
function decode6(str: string): LngLat[] {
  const out: LngLat[] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (const k of [0, 1]) {
      let shift = 0, res = 0, b;
      do { b = str.charCodeAt(i++) - 63; res |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
      const d = res & 1 ? ~(res >> 1) : res >> 1;
      if (k === 0) lat += d; else lng += d;
    }
    out.push([r6(lng / 1e6), r6(lat / 1e6)]);
  }
  return out;
}

// 組み込み（VALHALLA_MODE=embedded）：HTTP の代わりに @valhallajs/valhallajs の Actor を同じプロセスで使う（設計書 §16）。
// VALHALLA_CONFIG は valhalla.json のパス。中の相対パス（tile_extract、tile_dir）は設定ファイルのフォルダから解く。最初に使うときに作る。
// タイルは tile_extract（tar。前のセットアップ）があればそれ、空ならタイルのフォルダ（tile_dir）から読む
let actor: Promise<{ route(q: string): Promise<any>; traceAttributes(q: string): Promise<any> }> | undefined;
function embedded() {
  return (actor ??= (async () => {
    const { Actor } = await import('@valhallajs/valhallajs'); // HTTP のときは読み込まない（ネイティブのモジュール）
    const file = process.env.VALHALLA_CONFIG ?? '';
    const cfg = JSON.parse(await readFile(file, 'utf8'));
    for (const k of ['tile_extract', 'tile_dir'] as const) if (cfg.mjolnir[k]) cfg.mjolnir[k] = resolve(dirname(file), cfg.mjolnir[k]);
    // タイルのキャッシュはスレッドごとなので 128MiB までにする（前に作ったデータの設定は 1e9。結果は変わらない。11/7 に14本のルートで確かめた）
    cfg.mjolnir.max_cache_size = Math.min(cfg.mjolnir.max_cache_size ?? Infinity, 134217728);
    // タイルがないと Actor は作れても、どのルートも「道がつながっていません」になる。ここで止める
    if (cfg.mjolnir.tile_extract) await stat(cfg.mjolnir.tile_extract);
    else if (!(await readdir(cfg.mjolnir.tile_dir, { recursive: true })).some((f) => f.endsWith('.gph'))) throw new Error(`タイルのフォルダにタイル（.gph）がありません：${cfg.mjolnir.tile_dir}`);
    return new Actor(cfg);
  })().catch((e) => { actor = undefined; throw e; }));
}

/** 組み込みで1回問い合わせる。エラーは HTTP のときと同じ OpError にそろえる（Valhalla の 400 → not_found） */
async function postEmbedded(path: string, body: unknown, notFound: string): Promise<any> {
  const a = await embedded().catch((e) => {
    console.error('[valhalla] 組み込みの Valhalla を起こせません（VALHALLA_CONFIG とその tile_extract か tile_dir を確かめてください）:', String(e)); // 本当の理由はサーバの記録に1行だけ出す
    throw new OpError('service', 'ルートの検索（自社の Valhalla）に接続できません');
  });
  const q = JSON.stringify(body);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new OpError('limit', 'ルートの検索に時間がかかりすぎました')), 20_000); });
  try {
    return await Promise.race([path === '/route' ? a.route(q) : a.traceAttributes(q), timeout]);
  } catch (e) {
    if (e instanceof OpError) throw e;
    const status = (e as { httpCode?: number }).httpCode;
    if (status === 400) throw new OpError('not_found', notFound);
    throw new OpError('service', `ルートの検索（自社の Valhalla）がエラーを返しました（${status ?? 500}）`);
  } finally {
    clearTimeout(timer);
  }
}

/** 400（道路が近くにない、つながる道がない、形が道に合わない など。error_code 1xx・4xx）は notFound の文で not_found にする */
async function post(path: string, body: unknown, notFound: string): Promise<any> {
  if (process.env.VALHALLA_MODE === 'embedded') return postEmbedded(path, body, notFound);
  let res: Response;
  try {
    res = await fetch(`${URL_}${path}`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') throw new OpError('limit', 'ルートの検索に時間がかかりすぎました');
    throw new OpError('service', 'ルートの検索（自社の Valhalla）に接続できません');
  }
  if (res.status === 400) throw new OpError('not_found', notFound);
  if (!res.ok) throw new OpError('service', `ルートの検索（自社の Valhalla）がエラーを返しました（${res.status}）`);
  const j = await res.json().catch(() => null);
  if (!j) throw new OpError('service', 'ルートの検索（自社の Valhalla）の応答が読めません');
  return j;
}

/**
 * 自動車のルート。points は出発地、経由地、目的地の順。
 * 高速を使わないときは高速道路と有料道路をハード除外する（exclude_highways・exclude_tolls。allow_hard_exclusions は有効にしてある）
 */
export async function valhallaRoute(points: (LngLat | VLoc)[], opt: { avoid_highways: boolean }): Promise<VRoute> {
  const body = {
    locations: points.map((p) => {
      if (!('coord' in p)) return { lat: p[1], lon: p[0] };
      const { coord: [lon, lat], type, heading, layer } = p;
      return { lat, lon, type, ...(heading != null ? { heading, heading_tolerance: 45 } : {}), ...(layer != null ? { preferred_layer: layer } : {}) };
    }),
    costing: 'auto',
    ...(opt.avoid_highways ? { costing_options: { auto: { exclude_highways: true, exclude_tolls: true } } } : {}),
    units: 'kilometers',
    shape_format: 'polyline6',
  };
  const j = await post('/route', body, 'ルートが見つかりませんでした（近くに車の通れる道がないか、道がつながっていません）') as {
    trip?: { summary: { time: number; length: number }; legs: { summary: { time: number; length: number }; shape: string; maneuvers: Maneuver[] }[] };
  };
  if (!j.trip) throw new OpError('service', 'ルートの検索（自社の Valhalla）の応答が読めません');
  return {
    sec: j.trip.summary.time,
    km: j.trip.summary.length,
    legs: j.trip.legs.map((l) => ({ sec: l.summary.time, km: l.summary.length, shape: decode6(l.shape), maneuvers: l.maneuvers })),
  };
}

/** 通った道の1区間（Valhalla の辺）。from・to は shape の番号 */
export interface VEdge { way_id: number; m: number; from: number; to: number }
/** snapped：形が道にそのまま合わず、近くの道に寄せて取り直した */
export interface VTrace { shape: LngLat[]; edges: VEdge[]; snapped: boolean }

/** ルートの形を道路網に重ねて、通った辺（OSM の way）を順に返す。そのまま合わなければ（edge_walk）近くの道に寄せて取り直す（walk_or_snap） */
export async function valhallaTrace(shape: LngLat[]): Promise<VTrace> {
  const body = (shape_match: string) => ({
    shape: shape.map(([lon, lat]) => ({ lat, lon })), costing: 'auto', shape_match,
    filters: { action: 'include', attributes: ['shape', 'edge.way_id', 'edge.length', 'edge.begin_shape_index', 'edge.end_shape_index'] },
  });
  const notFound = 'ルートの道を地図のデータと照らし合わせられませんでした';
  let snapped = false;
  const j = await post('/trace_attributes', body('edge_walk'), notFound).catch((e) => {
    if (!(e instanceof OpError && e.code === 'not_found')) throw e;
    snapped = true;
    return post('/trace_attributes', body('walk_or_snap'), notFound);
  }) as { shape: string; edges: { way_id: number; length: number; begin_shape_index: number; end_shape_index: number }[] };
  return {
    shape: decode6(j.shape),
    edges: j.edges.map((e) => ({ way_id: e.way_id, m: e.length * 1000, from: e.begin_shape_index, to: e.end_shape_index })),
    snapped,
  };
}
