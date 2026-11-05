// 自社の abr-geocoder（デジタル庁のアドレス・ベース・レジストリ）への問い合わせ。公開のジオコーダは使わない。
import { OpError, type LngLat } from '../ops/types';

const URL_ = `${process.env.ABR_URL ?? 'http://localhost:3002'}/geocode`;

export interface AbrMatch {
  coord: LngLat;
  matched: string;
  unmatched: string | null;
  /** 文字列がどこまで一致したか（match_level） */
  match_level: string;
  /** 座標がどの単位の点か（coordinates_level） */
  level: string;
  score: number;
}

// coordinates_level → 精度の日本語。abr-geocoder の openapi.yml（MatchLevelEnum）の説明のまま。言い換えない
const PRECISION: Record<string, string> = {
  pref: '都道府県の代表点',
  city: '市区町村の代表点',
  machiaza: '大字・町の代表点',
  machiaza_detail: '丁目・小字の代表点',
  rsdtdsp_blk: '街区の代表点',
  rsdtdsp_rsdt: '住居番号の位置',
  parcel: '地番の代表点',
};
export const precisionOf = (level: string) => PRECISION[level] ?? '精度は不明';

/** いちばん良い1件。結果がなければ null */
export async function geocode(address: string): Promise<AbrMatch | null> {
  let res: Response;
  try {
    res = await fetch(`${URL_}?address=${encodeURIComponent(address)}`, { signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new OpError('service', '住所の検索（自社の abr-geocoder）に接続できません');
  }
  if (!res.ok) throw new OpError('service', `住所の検索（自社の abr-geocoder）がエラーを返しました（${res.status}）`);
  const j = (await res.json().catch(() => null)) as {
    features?: { geometry: { coordinates: LngLat }; properties: {
      matched_address: string; unmatched_address: string[] | null; match_level: string; coordinates_level: string; score: number;
    } }[];
  } | null;
  if (!j) throw new OpError('service', '住所の検索（自社の abr-geocoder）の応答が読めません');
  const f = j.features?.[0];
  if (!f) return null;
  const p = f.properties;
  return {
    coord: f.geometry.coordinates,
    matched: p.matched_address,
    unmatched: p.unmatched_address?.length ? p.unmatched_address.join('') : null,
    match_level: p.match_level,
    level: p.coordinates_level,
    score: p.score,
  };
}
