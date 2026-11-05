// 業務の言葉と OSM タグの辞書。検索の組み立て、Claude のツールの選択肢、画面の「解釈」の表示で共通に使う。
// Overpass QL は LLM に書かせない。ここにある filter だけをプログラムが組み立てる（src/services/overpass.ts）。
// 画面からも読むので、サーバ専用のものは import しない。

export interface DictEntry {
  /** 画面の札とツールの選択肢に出す名前 */
  label: string;
  /** 依頼文でこう言われたらこの言葉とみなす（Claude への説明に使う） */
  aliases: string[];
  /** Overpass の要素の種類と条件。複数あれば OR */
  queries: { elements: 'node' | 'way' | 'nwr'; filter: string }[];
  /** 画面に出す解釈。「どう受け取ったか」を毎回見せる */
  interpretation: string;
}

const COURIER = 'ヤマト|佐川|FedEx|UPS|DHL|Postal Service';

export const DICT = {
  post_office: {
    label: '郵便局', aliases: ['郵便局', 'ポスト以外の郵便窓口'],
    // OSM では宅配便の営業所にも amenity=post_office が付いている（関東で約80件）。operator・brand・name で除く
    queries: [{ elements: 'nwr', filter: `["amenity"="post_office"]["operator"!~"${COURIER}",i]["brand"!~"${COURIER}",i]["name"!~"${COURIER}|クロネコ|Yamato",i]` }],
    interpretation: '郵便局＝amenity=post_office（ヤマト運輸・佐川急便など宅配便の営業所は除く）',
  },
  souvenir: {
    label: '手土産', aliases: ['手土産', 'お土産', '菓子折り', '和菓子', '洋菓子', 'ケーキ屋'],
    queries: [{ elements: 'nwr', filter: '["shop"~"^(confectionery|pastry)$"]' }],
    interpretation: '手土産＝和菓子・洋菓子の店（shop=confectionery、shop=pastry）',
  },
  convenience: {
    label: 'コンビニ', aliases: ['コンビニ', 'コンビニエンスストア'],
    queries: [{ elements: 'nwr', filter: '["shop"="convenience"]' }],
    interpretation: 'コンビニ＝shop=convenience',
  },
  cafe: {
    label: 'カフェ', aliases: ['カフェ', '喫茶店', 'コーヒー'],
    queries: [{ elements: 'nwr', filter: '["amenity"="cafe"]' }],
    interpretation: 'カフェ＝amenity=cafe',
  },
  parking: {
    label: '駐車場', aliases: ['駐車場', 'パーキング', 'コインパーキング'],
    queries: [{ elements: 'nwr', filter: '["amenity"="parking"]' }],
    interpretation: '駐車場＝amenity=parking（駐輪場は含まない）',
  },
  fuel: {
    label: 'ガソリンスタンド', aliases: ['ガソリンスタンド', '給油', 'スタンド'],
    queries: [{ elements: 'nwr', filter: '["amenity"="fuel"]' }],
    interpretation: 'ガソリンスタンド＝amenity=fuel',
  },
  toilets: {
    label: 'トイレ', aliases: ['トイレ', 'お手洗い', '公衆トイレ'],
    queries: [{ elements: 'nwr', filter: '["amenity"="toilets"]' }],
    interpretation: 'トイレ＝amenity=toilets（店の中のトイレは含まない）',
  },
  park: {
    label: '公園', aliases: ['公園'],
    queries: [{ elements: 'nwr', filter: '["leisure"="park"]' }],
    interpretation: '公園＝leisure=park',
  },
  station: {
    label: '駅', aliases: ['駅'],
    queries: [{ elements: 'nwr', filter: '["railway"="station"]' }],
    interpretation: '駅＝railway=station',
  },
  hospital: {
    label: '病院', aliases: ['病院'],
    queries: [{ elements: 'nwr', filter: '["amenity"="hospital"]' }],
    interpretation: '病院＝amenity=hospital（診療所は含まない）',
  },
  level_crossing: {
    label: '踏切', aliases: ['踏切', '踏み切り'],
    queries: [{ elements: 'node', filter: '["railway"="level_crossing"]' }],
    interpretation: '踏切＝railway=level_crossing（歩行者用の踏切（railway=crossing）は含まない）',
  },
  foot_crossing: {
    label: '歩行者用の踏切', aliases: ['歩行者用の踏切', '歩行者踏切', '人道踏切'],
    queries: [{ elements: 'node', filter: '["railway"="crossing"]' }],
    interpretation: '歩行者用の踏切＝railway=crossing（車の通る踏切は含まない）',
  },
  tunnel: {
    label: 'トンネル', aliases: ['トンネル'],
    // 車の通る道路だけ。歩道や建物の通り抜け（tunnel=building_passage）、暗渠（culvert）は含まない。
    // つながった way は find_features で1本にまとめ、50m 未満は数えない
    queries: [{ elements: 'way', filter: '["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential|service|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link)$"]["tunnel"="yes"]' }],
    interpretation: 'トンネル＝道路の tunnel=yes（つながった区間は1本、50m未満は数えない。建物の通り抜けと暗渠は含まない）',
  },
} as const satisfies Record<string, DictEntry>;

export type DictKey = keyof typeof DICT;
export const DICT_KEYS = Object.keys(DICT) as [DictKey, ...DictKey[]];

/** 画面の札に並べる言葉（左から） */
export const CHIPS: DictKey[] = ['post_office', 'souvenir', 'convenience', 'level_crossing', 'tunnel'];
