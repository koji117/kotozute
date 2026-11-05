// OSM ノートの下書き：場所と問題の種類から、OSM に「地図が現地と違う」と知らせる文面を作る。
// アプリは OSM と通信しない。投稿は現地を見た本人が手で行う。確認方法は画面で本人が選ぶ（AI は選ばない。入力にもない）。
import { z } from 'zod';
import { defineOp, OpError, Ref, type Place } from './types';
import { ISSUES, type Issue } from './note_rules';
import { resolveRef } from '../server/session';

export interface NoteMethod { key: string; label: string; allowed: boolean; reason: string | null }
/** 確認方法。画面で本人が選ぶ。他社の地図は見せるが選べない */
export const NOTE_METHODS: NoteMethod[] = [
  { key: 'saw', label: '現地で見た', allowed: true, reason: null },
  { key: 'photo', label: '自分で撮った写真がある', allowed: true, reason: null },
  { key: 'drove', label: '現地を運転して確かめた', allowed: true, reason: null },
  { key: 'other_map', label: 'Googleマップで見た', allowed: false, reason: '他社の地図からの書き写しは OSM のルールでできない' },
];

export interface NoteDraftOutput {
  target: Place;
  issue: Issue;
  issue_label: string;
  what: string;
  where: string;
  /** OSM の要素のページ。OSM の要素でなければ null */
  osm_url: string | null;
  /** 何が／どこで／確認方法（空欄。画面で本人が選んだものを入れる） */
  draft: string;
  methods: NoteMethod[];
  /** OSM の新しいノートの画面（本人が開く） */
  note_url: string;
}

export const draftOsmNote = defineOp({
  name: 'draft_osm_note',
  title: 'OSMノートの下書き',
  description:
    'OSM ノートの下書きを作る（OSM の地図が現地と違うことを知らせる文面）。アプリは OSM と通信せず、投稿は現地を見た本人が手で行う。' +
    'target は問題のある場所の参照（クリックした点、検索の結果、osm:way/123 など。view: は使えない）。issue は問題の種類。' +
    '確認方法は画面で本人が選ぶので、入力にはない。「OSMが違っていた」「ノートを書きたい」「右折禁止なのに地図にない」と頼まれたときに使う。',
  input: z.object({
    target: Ref.describe('問題のある場所の参照。view: は使えない'),
    issue: z.enum(Object.keys(ISSUES) as [Issue, ...Issue[]]).describe(
      `問題の種類。${Object.entries(ISSUES).map(([k, v]) => `${k}＝${v.label}`).join('、')}`),
  }),
  direct: true,
  async run({ session }, { target, issue }): Promise<NoteDraftOutput> {
    if (target === 'view:') throw new OpError('bad_ref', 'ノートは場所を1つ選んで書きます。地図をクリックするか、検索の結果を使ってください');
    const place = resolveRef(session, target);
    const [lon, lat] = place.coord.map((x) => x.toFixed(5));
    const osm_url = place.osm ? `https://www.openstreetmap.org/${place.osm}` : null;
    const where = osm_url ? (place.name ? `${place.name}（${osm_url}）` : osm_url) : `緯度 ${lat}、経度 ${lon}`;
    const { label, what } = ISSUES[issue];
    return {
      target: place, issue, issue_label: label, what, where, osm_url,
      draft: [`何が：${what}`, `どこで：${where}`, '確認方法：'].join('\n'),
      methods: NOTE_METHODS,
      note_url: `https://www.openstreetmap.org/note/new#map=19/${lat}/${lon}`,
    };
  },
  llm: (out) => ({ target: out.target.name ?? out.target.ref, osm: out.target.osm ?? null, issue: out.issue_label }),
});
