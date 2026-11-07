// 地点の詳細のカード（地図の印やベースマップの地点をクリックしたとき）。文はタグからテンプレートで作り、名前などはすべて逃がす。
import type { LngLat } from '../ops/types';
import { dms, mesh3, toPlane } from './jpcoord';
import { html, Raw } from './panel';

/** ベースマップ（Protomaps の pois）の kind のよくあるもの → 日本語名。一覧にない種類は名前だけ出す */
export const BASEMAP_KIND_JA: Record<string, string> = {
  park: '公園', garden: '庭園', zoo: '動物園', beach: '海岸', forest: '森林', marina: 'マリーナ', peak: '山頂',
  station: '駅', bus_stop: 'バス停', ferry_terminal: 'フェリーターミナル', aerodrome: '空港',
  stadium: 'スタジアム', university: '大学', school: '学校', library: '図書館', townhall: '役所', post_office: '郵便局',
  toilets: 'トイレ', drinking_water: '水飲み場', bench: 'ベンチ',
  restaurant: '飲食店', fast_food: 'ファストフード', cafe: 'カフェ', bar: 'バー',
  supermarket: 'スーパー', convenience: 'コンビニ', books: '書店', beauty: '美容室', electronics: '家電店', clothes: '衣料品店',
  attraction: '観光地', museum: '博物館・美術館', theatre: '劇場', artwork: 'アート作品',
};

const WHEELCHAIR: Record<string, string> = { yes: '利用できる', designated: '利用できる', limited: '一部利用できる', no: '利用できない' };
const OSM_REF = /^(node|way|relation)\/\d+$/;

function address(t: Record<string, string>) {
  const num = [t['addr:block_number'], t['addr:housenumber']].filter(Boolean).join('-');
  const body = t['addr:full'] ?? [t['addr:province'], t['addr:city'], t['addr:quarter'], t['addr:neighbourhood']].filter(Boolean).join('') + num;
  return [t['addr:postcode'] && `〒${t['addr:postcode']}`, body].filter(Boolean).join(' ');
}

/** リンクは http と https だけ（javascript: などは出さない） */
const link = (u?: string) => u && /^https?:\/\//i.test(u) ? html`<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>` : '';

/** 座標の行：緯度経度、度分秒、平面直角（zone がない地域では出さない）、3次メッシュ。地図の位置から画面の中で計算する */
function coordRows([lng, lat]: LngLat, zone?: number): Raw {
  const p = zone ? toPlane([lng, lat], zone) : null;
  const rows: [string, string[]][] = [ // 値は部分ごとに折り返す（数字の途中で切らない）
    ['緯度経度', [`${lat.toFixed(6)},`, lng.toFixed(6)]],
    ['度分秒', [`北緯${dms(lat)}`, `東経${dms(lng)}`]],
    ...(p ? [[`平面直角 ${zone}系`, [`X ${p.x.toFixed(1)} m`, `Y ${p.y.toFixed(1)} m`]] as [string, string[]]] : []),
    ['地域メッシュ', [`${mesh3([lng, lat])}（3次）`]],
  ];
  return html`<div class="kv">${rows.map(([k, v]) => html`<div><b>${k}</b><span>${v.map((x, i) => html`${i ? ' ' : ''}<span class="nw">${x}</span>`)}</span></div>`)}</div>`;
}
const COORD_NOTE = '座標は地図の位置から計算（測量の値ではない）。平面直角は JGD2011';

/** クリックした場所や、貼った座標の場所のカード */
export function placeCard(title: string, at: LngLat, zone?: number): string {
  return html`<div class="poi"><h3>${title}</h3>${coordRows(at, zone)}<div class="note">${COORD_NOTE}</div></div>`.s;
}

export function poiCard(p: { name: string | null; kindLabel: string | null; tags?: Record<string, string>; osm?: string; asOf?: string; error?: string; at?: LngLat; zone?: number }): string {
  const t = p.tags ?? {};
  const rows = ([
    ['住所', address(t)],
    ['営業時間', t.opening_hours], // OSM に書かれたまま
    ['電話', t.phone ?? t['contact:phone']],
    ['ウェブサイト', link(t.website ?? t['contact:website'])],
    ['車いす', t.wheelchair && (WHEELCHAIR[t.wheelchair] ?? t.wheelchair)],
    ['運営', t.operator],
    ['ブランド', t['brand:ja'] ?? t.brand],
  ] as const).filter(([, v]) => v);
  return html`<div class="poi">
    <h3>${p.name ?? '名前なし'}</h3>
    ${p.kindLabel ? html`<div class="od">${p.kindLabel}</div>` : ''}
    ${rows.length ? html`<div class="kv">${rows.map(([k, v]) => html`<div><b>${k}</b><span>${v}</span></div>`)}</div>` : ''}
    ${p.error ? html`<div class="note warn">詳細を取れませんでした：${p.error}</div>` : ''}
    ${p.at ? html`<details class="coord"><summary>座標</summary>${coordRows(p.at, p.zone)}<div class="note">${COORD_NOTE}</div></details>` : ''}
    <div class="note">OSM上の情報（現地と違うことがある）</div>
    ${p.asOf ? html`<div class="note">データ時点 ${p.asOf.slice(0, 10)}</div>` : ''}
    ${p.osm && OSM_REF.test(p.osm) ? html`<div class="note"><a href="https://www.openstreetmap.org/${p.osm}" target="_blank" rel="noopener noreferrer">OSM で見る（${p.osm}）</a></div>` : ''}
  </div>`.s;
}
