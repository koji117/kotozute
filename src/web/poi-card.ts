// 地点の詳細のカード（地図の印やベースマップの地点をクリックしたとき）。文はタグからテンプレートで作り、名前などはすべて逃がす。
import { html } from './panel';

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

export function poiCard(p: { name: string | null; kindLabel: string | null; tags?: Record<string, string>; osm?: string; asOf?: string; error?: string }): string {
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
    <div class="note">OSM上の情報（現地と違うことがある）</div>
    ${p.asOf ? html`<div class="note">データ時点 ${p.asOf.slice(0, 10)}</div>` : ''}
    ${p.osm && OSM_REF.test(p.osm) ? html`<div class="note"><a href="https://www.openstreetmap.org/${p.osm}" target="_blank" rel="noopener noreferrer">OSM で見る（${p.osm}）</a></div>` : ''}
  </div>`.s;
}
