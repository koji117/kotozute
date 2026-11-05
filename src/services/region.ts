// 対応する地域：東京都（島しょ部を除く）。tokyo.pmtiles の切り出し範囲と同じ。
import type { BBox, LngLat } from '../ops/types';

// ponytail: 矩形で判定する。埼玉・神奈川・千葉の端も入る。都の境界で切るなら行政界のポリゴンに替える
export const TOKYO_BBOX: BBox = [138.9, 35.48, 139.95, 35.92];
export const REGION_LABEL = '東京都（島しょ部を除く）';

export const inTokyo = ([lng, lat]: LngLat) =>
  lng >= TOKYO_BBOX[0] && lng <= TOKYO_BBOX[2] && lat >= TOKYO_BBOX[1] && lat <= TOKYO_BBOX[3];

/** bbox の面積（km²、平面近似） */
export const bboxKm2 = ([w, s, e, n]: BBox) => {
  const kx = 111.32 * Math.cos((((s + n) / 2) * Math.PI) / 180);
  return Math.abs(e - w) * kx * Math.abs(n - s) * 110.57;
};

/** 2点の距離（m、平面近似。狭い範囲用） */
export const distM = ([x1, y1]: LngLat, [x2, y2]: LngLat) => {
  const kx = 111320 * Math.cos((((y1 + y2) / 2) * Math.PI) / 180);
  return Math.hypot((x2 - x1) * kx, (y2 - y1) * 110570);
};
