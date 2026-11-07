// 場所の検索：名前で OSM の要素を探す（自社の Overpass）。住所の検索は ABR で別に行う。
import { z } from 'zod';
import { defineOp, OpError, Ref, type BBox, type SearchPlaceOutput } from './types';
import { addResult, resolveRef } from '../server/session';
import { names } from '../services/osm';
import { LIMITS, toPlace, type OsmElement } from '../services/overpass';
import { distM, inTokyo, TOKYO_BBOX } from '../services/region';
import { SEARCH_PLACE_SCOPE, VIEW_OUTSIDE, WIDENED_KEY } from '../region-text';

const MAX = 10;
/** 漢字にはさまれた「ヶ・ケ・が・ヵ」 */
const KE = /(?<=\p{Script=Han})[ヶケがヵ](?=\p{Script=Han})/gu;

export const searchPlace = defineOp({
  name: 'search_place',
  title: '場所の検索',
  description:
    '名前で場所（建物、駅、公園、店など）を OSM から探す。住所（丁目・番地）はこの操作では探さない。' +
    '完全一致を先に探し、なければ名前の一部で探す。area が view: なら画面の範囲から探し、' +
    SEARCH_PLACE_SCOPE + 'どちらもその場所に近い順に並べる。結果は result:N の参照で返る（最大10件）。',
  input: z.object({
    name: z.string().min(1).max(40).describe('探す名前（例：東京タワー）'),
    area: Ref.describe('探す範囲と並べ方の基準。view: は画面の範囲'),
  }),
  direct: true,
  async run({ session }, input): Promise<SearchPlaceOutput> {
    // 制御文字は検索文に入れない
    const name = input.name.replace(/\p{Cc}/gu, '').trim();
    if (!name) throw new OpError('bad_input', '探す名前が空です');
    const center = resolveRef(session, input.area);
    // 画面の範囲は画面から届く値なので、地域の範囲で切ってから使う
    const v = input.area === 'view:' ? session.view?.bbox : undefined;
    const [W, S, E, N] = TOKYO_BBOX;
    const bbox: BBox = v ? [Math.max(v[0], W), Math.max(v[1], S), Math.min(v[2], E), Math.min(v[3], N)] : TOKYO_BBOX;
    if (!(bbox[0] < bbox[2] && bbox[1] < bbox[3])) throw new OpError('out_of_area', VIEW_OUTSIDE);
    // 「〜駅」で駅（railway=station）があれば駅だけにする（同じ名前のバス停などを出発地に選ばないように）
    const isStation = (e: OsmElement) => e.tags?.railway === 'station' && inTokyo(toPlace(e, 'place').coord);
    const wantStation = name.endsWith('駅');
    const search = async (b: BBox) => {
      let { elements } = await names(name, b, true);
      // 霞ヶ関・霞ケ関・霞が関のように書き方が分かれる名前は、完全一致が0件のとき（「〜駅」なら駅が1つもないときも）、
      // 書き換えて完全一致で探し直し、足す（市ヶ谷駅：ヶ のバス停はあるが、駅は 市ケ谷）
      if (!elements.length || (wantStation && !elements.some(isStation))) {
        const seen = new Set(elements.map((e) => `${e.type}/${e.id}`));
        const more: OsmElement[] = [];
        for (const c of ['ヶ', 'ケ', 'が']) {
          const alt = name.replace(KE, c);
          if (alt === name) continue;
          for (const e of (await names(alt, b, true)).elements) {
            if (!seen.has(`${e.type}/${e.id}`)) { seen.add(`${e.type}/${e.id}`); more.push(e); }
          }
        }
        elements = [...elements, ...more];
      }
      if (!elements.length) ({ elements } = await names(name, b, false));
      const picked = wantStation && elements.some(isStation) ? elements.filter(isStation) : elements;
      // ponytail: Overpass は上限 +1 件で切るので、それより多いと近い順が全体の近い順とは限らない。total も上限で止まる
      const found = picked
        .map((e) => toPlace(e, 'place'))
        .filter((p) => inTokyo(p.coord))
        .sort((a, b) => distM(a.coord, center.coord) - distM(b.coord, center.coord))
        .slice(0, LIMITS.max_items);
      return { found, capped: elements.length > LIMITS.max_items };
    };
    let { found, capped } = await search(bbox);
    // 画面の中に1件もなければ、地域全体から画面の中心に近い順に探す（画面の外の駅や名所を、地図を動かさずに探せるように）
    const widened = !!v && found.length === 0;
    if (widened) ({ found, capped } = await search(TOKYO_BBOX));
    const items = found.slice(0, MAX).map((p) => addResult(session, p));
    return { query: name, items, total: found.length, truncated: found.length > items.length, capped, widened };
  },
  llm: (out) => ({ query: out.query, [WIDENED_KEY]: out.widened, total: out.total, total_is_lower_bound: out.capped, truncated: out.truncated, items: out.items.map((p) => ({ ref: p.ref, name: p.name })) }),
});
