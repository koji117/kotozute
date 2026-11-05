// 自社の Valhalla（Docker、関東の OSM データ）への問い合わせ。公開のルート検索は使わない。
import { OpError, type LngLat } from '../ops/types';

const URL_ = process.env.VALHALLA_URL ?? 'http://localhost:8002';

export interface Maneuver { type: number; street_names?: string[]; length: number; time: number; roundabout_exit_count?: number }
export interface VLeg { sec: number; km: number; shape: LngLat[]; maneuvers: Maneuver[] }
export interface VRoute { sec: number; km: number; legs: VLeg[] }

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

/** 自動車のルート。points は出発地、経由地、目的地の順。高速を使わないときはハード除外（exclude_highways） */
export async function valhallaRoute(points: LngLat[], opt: { avoid_highways: boolean }): Promise<VRoute> {
  const body = {
    locations: points.map(([lon, lat]) => ({ lat, lon })),
    costing: 'auto',
    ...(opt.avoid_highways ? { costing_options: { auto: { exclude_highways: true } } } : {}),
    units: 'kilometers',
    shape_format: 'polyline6',
  };
  let res: Response;
  try {
    res = await fetch(`${URL_}/route`, { method: 'POST', body: JSON.stringify(body), signal: AbortSignal.timeout(20_000) });
  } catch (e) {
    if (e instanceof Error && e.name === 'TimeoutError') throw new OpError('limit', 'ルートの検索に時間がかかりすぎました');
    throw new OpError('service', 'ルートの検索（自社の Valhalla）に接続できません');
  }
  // 400 は道路が近くにない、つながる道がない、など（error_code 1xx・4xx）
  if (res.status === 400) throw new OpError('not_found', 'ルートが見つかりませんでした（近くに車の通れる道がないか、道がつながっていません）');
  if (!res.ok) throw new OpError('service', `ルートの検索（自社の Valhalla）がエラーを返しました（${res.status}）`);
  const j = (await res.json().catch(() => null)) as {
    trip?: { summary: { time: number; length: number }; legs: { summary: { time: number; length: number }; shape: string; maneuvers: Maneuver[] }[] };
  } | null;
  if (!j?.trip) throw new OpError('service', 'ルートの検索（自社の Valhalla）の応答が読めません');
  return {
    sec: j.trip.summary.time,
    km: j.trip.summary.length,
    legs: j.trip.legs.map((l) => ({ sec: l.summary.time, km: l.summary.length, shape: decode6(l.shape), maneuvers: l.maneuvers })),
  };
}
