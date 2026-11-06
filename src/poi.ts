// 地点の詳細（地図の印をクリックしたときのカード）に出す OSM のタグ。
// description・note・fixme などの自由文は出さない。Claude のツール（OPS）には入れない（Claude に渡る文を変えないため）。

export const DETAIL_KEYS = [
  'name', 'name:ja',
  'addr:postcode', 'addr:province', 'addr:city', 'addr:quarter', 'addr:neighbourhood', 'addr:block_number', 'addr:housenumber', 'addr:full',
  'opening_hours', 'phone', 'contact:phone', 'website', 'contact:website', 'wheelchair', 'operator', 'brand', 'brand:ja',
] as const;

export const pickDetails = (tags: Record<string, string>): Record<string, string> =>
  Object.fromEntries(DETAIL_KEYS.filter((k) => Object.hasOwn(tags, k)).map((k) => [k, tags[k]]));

/** GET /api/poi/:type/:id の応答 */
export interface PoiResponse { osm: string; tags: Record<string, string>; osm_as_of: string }
