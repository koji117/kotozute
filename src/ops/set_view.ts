// 地図の表示：日本語の依頼で拡大・移動し、地図に出ている印の表示を切り替える（例「芝公園のあたりを大きく。郵便局だけ残して」）。
import { z } from 'zod';
import { type DictKey } from './dict';
import { defineOp, Ref, Word, type BBox, type SetViewOutput } from './types';
import { resolveRef } from '../server/session';
import { bboxKm2 } from '../services/region';

/** 点の周りに作る範囲の半径（m） */
const AROUND_M = 250;
const r6 = (x: number) => Math.round(x * 1e6) / 1e6;

export const setView = defineOp({
  name: 'set_view',
  title: '地図の表示',
  description:
    '地図を拡大・移動し、地図に出ている印の表示を切り替える。target の場所に地図を合わせる（view: なら動かさない）。' +
    'show と hide は、すでに地図に出ている印（find_features の結果）だけに効く。まだ出ていない言葉は先に find_features で探す。' +
    '「◯◯だけ残して」は、◯◯を show に、地図に出ている他の言葉を hide に入れる。',
  input: z.object({
    target: Ref.describe('地図を合わせる場所の参照。動かさないなら view:'),
    show: z.array(Word).max(12).describe('表示する印の言葉（辞書のキー）'),
    hide: z.array(Word).max(12).describe('隠す印の言葉（辞書のキー）'),
  }),
  direct: true,
  async run({ session }, { target, show, hide }): Promise<SetViewOutput> {
    const place = target === 'view:' ? null : resolveRef(session, target);
    let bbox = resolveRef(session, 'view:').bbox!;
    if (place) {
      // 面の範囲が点の周りより狭い（建物や、幅0の線）ときは点の周りにする
      const around = aroundBBox(place.coord);
      bbox = place.bbox && bboxKm2(place.bbox) > bboxKm2(around) ? place.bbox : around;
      // 同じ依頼の中で次の操作が view: を使ったときに、動かした後の範囲になるようにする
      session.view = { bbox, zoom: Math.round(Math.log2(360 / (bbox[2] - bbox[0]))) };
    }
    const toggle = (words: DictKey[], visible: boolean) => [...new Set(words)].filter((w) => {
      const layer = session.layers[w];
      if (layer) layer.visible = visible;
      return !!layer;
    });
    const shown = toggle(show, true);
    const hidden = toggle(hide, false); // 両方にある言葉は隠す
    return { target: place, bbox, shown: shown.filter((w) => !hidden.includes(w)), hidden };
  },
  llm: (out) => ({ target: out.target ? (out.target.name ?? out.target.ref) : '画面の範囲（動かさない）', shown: out.shown, hidden: out.hidden }),
});

function aroundBBox([lng, lat]: [number, number]): BBox {
  const dx = AROUND_M / (111320 * Math.cos((lat * Math.PI) / 180)), dy = AROUND_M / 110570;
  return [r6(lng - dx), r6(lat - dy), r6(lng + dx), r6(lat + dy)];
}
