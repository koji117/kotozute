// 出典表示はこの1か所で管理する（地図画面、共有リンクの画面、書き出す画像で共通）。
import { REGION } from './region';

export const OSM_DATA_AS_OF = REGION.osm_as_of; // OSM データ（osmium fileinfo の data.timestamp.last）
export const MAP_TILES_AS_OF = REGION.tiles_as_of; // 地図ファイル（planetiler:osm:osmosisreplicationtime）

export const ATTRIBUTION = {
  osm: { text: '© OpenStreetMap contributors', url: 'https://www.openstreetmap.org/copyright' },
  protomaps: { text: 'Protomaps', url: 'https://protomaps.com' },
  valhalla: { text: '経路: Valhalla', url: 'https://github.com/valhalla/valhalla' },
  // デジタル庁「アドレス・ベース・レジストリの利用規約」（PDL1.0。各データセットのライセンス欄は CC BY 4.0）の、加工したときの記載例の形（2026-11-08 に確かめた）
  abr: { text: '出典：デジタル庁「アドレス・ベース・レジストリ」を加工して作成', url: 'https://www.digital.go.jp/policies/base_registry_address' },
} as const;

/** OSM のデータベースのライセンス（GPX・GeoJSON の書き出しに入れる） */
export const ODBL = { id: 'ODbL-1.0', text: 'Open Database License (ODbL) 1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/' } as const;

export type AttributionUse ={ route?: boolean; address?: boolean };

export function attributionParts(use: AttributionUse = {}) {
  return [
    ATTRIBUTION.osm,
    ATTRIBUTION.protomaps,
    ...(use.route ? [ATTRIBUTION.valhalla] : []),
    ...(use.address ? [ATTRIBUTION.abr] : []),
  ];
}

const dateJa = (iso: string) => iso.slice(0, 10);
/** osm：共有リンクの地図は、作ったときの OSM のデータ時点を出す */
export const dataAsOfText = (osm: string = OSM_DATA_AS_OF) => `データ時点：OSM ${dateJa(osm)}／地図 ${dateJa(MAP_TILES_AS_OF)}`;

export const attributionHtml = (use: AttributionUse = {}) =>
  [...attributionParts(use).map(p => `<a href="${p.url}" target="_blank" rel="noopener">${p.text}</a>`), dataAsOfText()].join(' | ');
