// 出典表示はこの1か所で管理する（地図画面、共有リンクの画面、書き出す画像で共通）。
export const OSM_DATA_AS_OF = '2026-11-03T21:24:04Z'; // kanto-latest.osm.pbf（osmium fileinfo の data.timestamp.last）
export const MAP_TILES_AS_OF = '2026-11-04T04:00:00Z'; // tokyo.pmtiles（planetiler:osm:osmosisreplicationtime）

export const ATTRIBUTION = {
  osm: { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
  protomaps: { text: 'Protomaps', url: 'https://protomaps.com' },
  valhalla: { text: '経路: Valhalla', url: 'https://github.com/valhalla/valhalla' },
  // 文言はデジタル庁の利用規約の記載例で確かめてから確定する [未確認]
  abr: { text: '出典：デジタル庁「アドレス・ベース・レジストリ」を加工して作成', url: 'https://www.digital.go.jp/policies/base_registry_address' },
} as const;

export type AttributionUse = { route?: boolean; address?: boolean };

export function attributionParts(use: AttributionUse = {}) {
  return [
    ATTRIBUTION.osm,
    ATTRIBUTION.protomaps,
    ...(use.route ? [ATTRIBUTION.valhalla] : []),
    ...(use.address ? [ATTRIBUTION.abr] : []),
  ];
}

const dateJa = (iso: string) => iso.slice(0, 10);
export const dataAsOfText = () => `データ時点：OSM ${dateJa(OSM_DATA_AS_OF)}／地図 ${dateJa(MAP_TILES_AS_OF)}`;

export const attributionHtml = (use: AttributionUse = {}) =>
  [...attributionParts(use).map(p => `<a href="${p.url}" target="_blank" rel="noopener">${p.text}</a>`), dataAsOfText()].join(' | ');
