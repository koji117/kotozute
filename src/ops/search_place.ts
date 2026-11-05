// 場所の検索：名前で OSM の要素を探す（自社の Overpass）。住所の検索は ABR で別に行う。
import { z } from 'zod';
import { defineOp, OpError, Ref, type BBox, type SearchPlaceOutput } from './types';
import { addResult, resolveRef } from '../server/session';
import { LIMITS, overpass, toPlace } from '../services/overpass';
import { distM, inTokyo, REGION_LABEL, TOKYO_BBOX } from '../services/region';

const MAX = 10;

/** QL の文字列リテラル（"…"）の中身。ここが利用者の文字の注入の境目 */
const qlStr = (s: string) => s.replace(/[\\"]/g, '\\$&');
/** 正規表現の記号を文字そのものにする（Overpass の ~ は POSIX ERE） */
const reLit = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 名前で探す検索文。exact は完全一致、そうでなければ name / name:ja の部分一致（大文字小文字を区別しない） */
function nameQuery(name: string, bbox: BBox, exact: boolean): string {
  const [w, s, e, n] = bbox;
  const b = `(${s},${w},${n},${e})`;
  const v = qlStr(name);
  let parts: string;
  if (exact) {
    parts = ['name', 'name:ja', 'alt_name', 'official_name'].map((k) => `nwr["${k}"="${v}"]${b};`).join('');
    // 「品川駅」は OSM では駅の name が「品川」なので、駅として探し直す
    const st = name.match(/^(.+)駅$/);
    if (st) parts += `nwr["railway"="station"]["name"="${qlStr(st[1])}"]${b};`;
  } else {
    const re = qlStr(reLit(name));
    parts = `nwr["name"~"${re}",i]${b};nwr["name:ja"~"${re}",i]${b};`;
  }
  return `[out:json][timeout:${LIMITS.timeout_s}];(${parts});out bb tags ${LIMITS.max_items + 1};`;
}

export const searchPlace = defineOp({
  name: 'search_place',
  title: '場所の検索',
  description:
    '名前で場所（建物、駅、公園、店など）を OSM から探す。住所（丁目・番地）はこの操作では探さない。' +
    '完全一致を先に探し、なければ名前の一部で探す。area が view: なら画面の範囲から探し、' +
    '画面に1件もなければ東京都全体から探す（widened_to_tokyo）。それ以外の参照なら東京都全体から探す。どちらもその場所に近い順に並べる。結果は result:N の参照で返る（最大10件）。',
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
    // 画面の範囲は画面から届く値なので、東京都の範囲で切ってから使う
    const v = input.area === 'view:' ? session.view?.bbox : undefined;
    const [W, S, E, N] = TOKYO_BBOX;
    const bbox: BBox = v ? [Math.max(v[0], W), Math.max(v[1], S), Math.min(v[2], E), Math.min(v[3], N)] : TOKYO_BBOX;
    if (!(bbox[0] < bbox[2] && bbox[1] < bbox[3])) throw new OpError('out_of_area', `画面の範囲が${REGION_LABEL}の外です`);
    const search = async (b: BBox) => {
      let { elements } = await overpass(nameQuery(name, b, true));
      if (!elements.length) ({ elements } = await overpass(nameQuery(name, b, false)));
      // ponytail: Overpass は上限 +1 件で切るので、それより多いと近い順が全体の近い順とは限らない。total も上限で止まる
      const found = elements
        .map((e) => toPlace(e, 'place'))
        .filter((p) => inTokyo(p.coord))
        .sort((a, b) => distM(a.coord, center.coord) - distM(b.coord, center.coord))
        .slice(0, LIMITS.max_items);
      return { found, capped: elements.length > LIMITS.max_items };
    };
    let { found, capped } = await search(bbox);
    // 画面の中に1件もなければ、東京都全体から画面の中心に近い順に探す（画面の外の駅や名所を、地図を動かさずに探せるように）
    const widened = !!v && found.length === 0;
    if (widened) ({ found, capped } = await search(TOKYO_BBOX));
    const items = found.slice(0, MAX).map((p) => addResult(session, p));
    return { query: name, items, total: found.length, truncated: found.length > items.length, capped, widened };
  },
  llm: (out) => ({ query: out.query, widened_to_tokyo: out.widened, total: out.total, total_is_lower_bound: out.capped, truncated: out.truncated, items: out.items.map((p) => ({ ref: p.ref, name: p.name })) }),
});
