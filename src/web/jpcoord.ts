// 日本の座標：平面直角座標系（JGD2011、1〜19系）と地域メッシュ（JIS X 0410、3次）。計算は画面の中だけ（AI も外のサービスも使わない）。
// 平面直角は国土地理院の式（河瀬 2011、GRS80、縮尺係数 0.9999）。緯度経度は OSM の値をそのまま JGD2011 として計算する。
import type { LngLat } from '../ops/types';

/** 系の原点 [緯度, 経度]（度） */
const ORIGIN: Record<number, [number, number]> = {
  1: [33, 129.5], 2: [33, 131], 3: [36, 132 + 10 / 60], 4: [33, 133.5], 5: [36, 134 + 20 / 60],
  6: [36, 136], 7: [36, 137 + 10 / 60], 8: [36, 138.5], 9: [36, 139 + 50 / 60], 10: [40, 140 + 50 / 60],
  11: [44, 140.25], 12: [44, 142.25], 13: [44, 144.25], 14: [26, 142], 15: [26, 127.5],
  16: [26, 124], 17: [26, 131], 18: [20, 136], 19: [26, 154],
};
/** 地域の id → 系。地域を増やすときは足す（ない地域では平面直角を出さず、貼るときは「9系」のように系を書いてもらう） */
export const ZONE_OF_REGION: Record<string, number> = { tokyo: 9 }; // 東京都（島しょ部を除く）は9系

const a = 6378137, F = 298.257222101, m0 = 0.9999, n = 1 / (2 * F - 1);
const rad = Math.PI / 180;
const A = [1 + n ** 2 / 4 + n ** 4 / 64, -1.5 * (n - n ** 3 / 8 - n ** 5 / 64), (15 / 16) * (n ** 2 - n ** 4 / 4), (-35 / 48) * (n ** 3 - (5 / 16) * n ** 5), (315 / 512) * n ** 4, (-693 / 1280) * n ** 5];
const al = [0, n / 2 - (2 / 3) * n ** 2 + (5 / 16) * n ** 3 + (41 / 180) * n ** 4 - (127 / 288) * n ** 5, (13 / 48) * n ** 2 - (3 / 5) * n ** 3 + (557 / 1440) * n ** 4 + (281 / 630) * n ** 5, (61 / 240) * n ** 3 - (103 / 140) * n ** 4 + (15061 / 26880) * n ** 5, (49561 / 161280) * n ** 4 - (179 / 168) * n ** 5, (34729 / 80640) * n ** 5];
const be = [0, n / 2 - (2 / 3) * n ** 2 + (37 / 96) * n ** 3 - (1 / 360) * n ** 4 - (81 / 512) * n ** 5, (1 / 48) * n ** 2 + (1 / 15) * n ** 3 - (437 / 1440) * n ** 4 + (46 / 105) * n ** 5, (17 / 480) * n ** 3 - (37 / 840) * n ** 4 - (209 / 4480) * n ** 5, (4397 / 161280) * n ** 4 - (11 / 504) * n ** 5, (4583 / 161280) * n ** 5];
const de = [0, 2 * n - (2 / 3) * n ** 2 - 2 * n ** 3 + (116 / 45) * n ** 4 + (26 / 45) * n ** 5 - (2854 / 675) * n ** 6, (7 / 3) * n ** 2 - (8 / 5) * n ** 3 - (227 / 45) * n ** 4 + (2704 / 315) * n ** 5 + (2323 / 945) * n ** 6, (56 / 15) * n ** 3 - (136 / 35) * n ** 4 - (1262 / 105) * n ** 5 + (73814 / 2835) * n ** 6, (4279 / 630) * n ** 4 - (332 / 35) * n ** 5 - (399572 / 14175) * n ** 6, (4174 / 315) * n ** 5 - (144838 / 6237) * n ** 6, (601676 / 22275) * n ** 6];
const Abar = ((m0 * a) / (1 + n)) * A[0];
/** 赤道から緯度 phi までの子午線の長さ（縮尺係数をかけたもの） */
const S = (phi: number) => ((m0 * a) / (1 + n)) * (A[0] * phi + [1, 2, 3, 4, 5].reduce((s, j) => s + A[j] * Math.sin(2 * j * phi), 0));
const zoneOf = (zone: number) => {
  const o = ORIGIN[zone];
  if (!o) throw new Error(`平面直角座標の系は1〜19です（${zone}）`);
  return { phi0: o[0] * rad, lam0: o[1] * rad };
};

/** 緯度経度 → 平面直角座標（X は北向き、Y は東向き、m） */
export function toPlane([lng, lat]: LngLat, zone: number): { x: number; y: number } {
  const { phi0, lam0 } = zoneOf(zone);
  const phi = lat * rad, dl = lng * rad - lam0, k = (2 * Math.sqrt(n)) / (1 + n);
  const t = Math.sinh(Math.atanh(Math.sin(phi)) - k * Math.atanh(k * Math.sin(phi)));
  const xi = Math.atan(t / Math.cos(dl)), eta = Math.atanh(Math.sin(dl) / Math.sqrt(1 + t * t));
  let x = xi, y = eta;
  for (let j = 1; j <= 5; j++) {
    x += al[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    y += al[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  return { x: Abar * x - S(phi0), y: Abar * y };
}

/** 平面直角座標 → 緯度経度 */
export function fromPlane(x: number, y: number, zone: number): LngLat {
  const { phi0, lam0 } = zoneOf(zone);
  const xi = (x + S(phi0)) / Abar, eta = y / Abar;
  let xi2 = xi, eta2 = eta;
  for (let j = 1; j <= 5; j++) {
    xi2 -= be[j] * Math.sin(2 * j * xi) * Math.cosh(2 * j * eta);
    eta2 -= be[j] * Math.cos(2 * j * xi) * Math.sinh(2 * j * eta);
  }
  const chi = Math.asin(Math.sin(xi2) / Math.cosh(eta2));
  let phi = chi;
  for (let j = 1; j <= 6; j++) phi += de[j] * Math.sin(2 * j * chi);
  return [(lam0 + Math.atan(Math.sinh(eta2) / Math.cos(xi2))) / rad, phi / rad];
}

/** 3次メッシュ（基準地域メッシュ、約1km、8桁） */
export function mesh3([lng, lat]: LngLat): string {
  const s = Math.floor(lat * 3600 + 1e-6), e = Math.floor((lng - 100) * 3600 + 1e-6); // 秒。境目の丸めの誤差で下に落ちないよう少し足す
  const p = Math.floor(s / 2400), q = Math.floor((s % 2400) / 300), r = Math.floor((s % 300) / 30);
  const u = Math.floor(e / 3600), v = Math.floor((e % 3600) / 450), w = Math.floor((e % 450) / 45);
  return `${p}${u}${q}${v}${r}${w}`;
}

/** 1次（4桁）・2次（6桁）・3次（8桁）のメッシュの中心。形が違えば null */
export function meshCenter(code: string): LngLat | null {
  const m = /^(\d{2})(\d{2})(?:([0-7])([0-7])(?:(\d)(\d))?)?$/.exec(code);
  if (!m) return null;
  const [p, u, q, v, r, w] = m.slice(1).map((d) => (d === undefined ? -1 : Number(d)));
  let lat = p * 2400, lng = u * 3600, h = 2400, wd = 3600; // 秒
  if (q >= 0) { lat += q * 300; lng += v * 450; h = 300; wd = 450; }
  if (r >= 0) { lat += r * 30; lng += w * 45; h = 30; wd = 45; }
  return [100 + (lng + wd / 2) / 3600, (lat + h / 2) / 3600];
}

/** 度 → 度分秒（例：35°40′52.5″） */
export function dms(v: number): string {
  const t = Math.round(Math.abs(v) * 36000); // 0.1秒
  const d = Math.floor(t / 36000), m = Math.floor((t % 36000) / 600), s = (t % 600) / 10;
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″`;
}

/** 日本の範囲（ざっくり。地域の中かどうかはサーバが境界で確かめる） */
const inJapan = ([lng, lat]: LngLat) => lat >= 20 && lat <= 46 && lng >= 122 && lng <= 154;

export type Parsed = { at: LngLat; how: string } | { error: string };
const NUM = String.raw`(-?\d+(?:\.\d+)?)`;
const SEP = String.raw`\s*[,、/\s]\s*`;
const DMS_ONE = String.raw`(北緯|南緯|東経|西経|[NSEW])?\s*(\d{1,3}(?:\.\d+)?)\s*(?:°|度)\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:′|'|分))?\s*(?:(\d{1,2}(?:\.\d+)?)\s*(?:″|′′|"|''|秒))?\s*([NSEW])?`;

/**
 * 検索の欄に貼られた座標を読む。座標でなければ null（Claude に送る）。
 * 読めるもの：緯度経度（10進、どちらの順でもよい）、度分秒、平面直角（「9系 X=… Y=…」。系を書かなければ zone）、地域メッシュ（4・6・8桁）
 */
export function parseCoord(text: string, zone?: number): Parsed | null {
  const s = text.normalize('NFKC').replace(/[−‐‑–—]/g, '-').trim();
  // 地域メッシュ（数字だけ。日本の外の番号は座標とみなさない）
  const mesh = /^(\d{4})(?:-?(\d{2}))?(?:-?(\d{2}))?$/.exec(s);
  if (mesh) {
    const code = mesh.slice(1).filter(Boolean).join(''), at = meshCenter(code);
    return at && inJapan(at) ? { at, how: `地域メッシュ ${code} の中心` } : null;
  }
  // 度分秒
  const two = new RegExp(String.raw`^${DMS_ONE}\s*[,、/]?\s*${DMS_ONE}$`, 'i').exec(s);
  if (two) {
    const one = (g: string[]) => ({ hemi: (g[0] ?? g[4] ?? '').toUpperCase(), v: Number(g[1]) + Number(g[2] ?? 0) / 60 + Number(g[3] ?? 0) / 3600 });
    const c1 = one(two.slice(1, 6)), c2 = one(two.slice(6, 11));
    if ([c1, c2].some((c) => /^(S|W|南緯|西経)$/.test(c.hemi))) return { error: '南緯・西経の座標は日本の外です' };
    const latFirst = /^(N|北緯)$/.test(c1.hemi) || /^(E|東経)$/.test(c2.hemi) || (!c1.hemi && !c2.hemi && c1.v < c2.v);
    const at: LngLat = latFirst ? [c2.v, c1.v] : [c1.v, c2.v];
    return inJapan(at) ? { at, how: '度分秒' } : { error: '日本の範囲の外の座標です' };
  }
  // 平面直角（系か X/Y の文字があるもの）と、10進の緯度経度
  const pl = new RegExp(String.raw`^(?:第?(\d{1,2})系)?[\s,、:]*(X\s*[=:]?\s*)?${NUM}\s*m?${SEP}(?:Y\s*[=:]?\s*)?${NUM}\s*m?$`, 'i').exec(s);
  if (!pl) return null;
  const [, zs, xLabel, v1s, v2s] = pl;
  const v1 = Number(v1s), v2 = Number(v2s);
  if (!zs && !xLabel) {
    if (inJapan([v2, v1])) return { at: [v2, v1], how: '緯度経度' };
    if (inJapan([v1, v2])) return { at: [v1, v2], how: '緯度経度' };
    if (Math.abs(v1) < 1000 && Math.abs(v2) < 1000) return null; // 座標とは言えない数（Claude に送る）
  }
  const z = zs ? Number(zs) : zone;
  if (!z) return { error: '平面直角座標の系が分かりません。「9系 X=-35000 Y=-6000」のように系を書いてください' };
  if (!ORIGIN[z]) return { error: `平面直角座標の系は1〜19です（${z}系）` };
  const at = fromPlane(v1, v2, z);
  return inJapan(at) ? { at, how: `平面直角座標 ${z}系` } : { error: `${z}系では日本の範囲の外になります。系と、X（北）・Y（東）の順を確かめてください` };
}
