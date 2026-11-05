// 住所：日本語の住所を自社の abr-geocoder で位置にする。結果は abr:N で参照する。
import { z } from 'zod';
import { defineOp, OpError, type GeocodeOutput } from './types';
import { addAbr } from '../server/session';
import { geocode, precisionOf } from '../services/abr';
import { inTokyo, REGION_LABEL } from '../services/region';

const OUT = `対応する地域は${REGION_LABEL}です`;
// 東京都以外の都道府県名で始まる住所（手元の ABR は東京都だけなので、その場合「東京都」にだけ一致してしまう）
const OTHER_PREF = /^(北海道|京都府|大阪府|[^都道府県\s]{2,3}県)/;

export const geocodeAddress = defineOp({
  name: 'geocode_address',
  title: '住所',
  description:
    '日本語の住所（例：東京都港区芝公園4-2-8）を ABR（デジタル庁のアドレス・ベース・レジストリ）で位置にする。' +
    '一致した部分、一致しなかった残り、座標の精度を返す。結果は abr:N の参照で返る。対応する地域は東京都（島しょ部を除く）。',
  input: z.object({
    address: z.string().min(1).max(100).describe('住所。都道府県から書くと確実（例：東京都港区芝公園4-2-8）'),
  }),
  direct: true,
  async run({ session }, input): Promise<GeocodeOutput> {
    const address = input.address.replace(/\p{Cc}/gu, '').trim();
    if (!address) throw new OpError('bad_input', '住所が空です');
    if (OTHER_PREF.test(address)) throw new OpError('out_of_area', OUT);
    const m = await geocode(address);
    // 都道府県にしか一致せず残りがある＝住所として読めなかった
    if (!m || m.match_level === 'unknown' || (m.match_level === 'pref' && m.unmatched)) {
      throw new OpError('not_found', '住所が見つかりません（ABR で一致しませんでした）');
    }
    if (!inTokyo(m.coord)) throw new OpError('out_of_area', OUT);
    // 座標が一致した深さより粗い点のとき（例：町字まで一致、座標は市区町村の代表点）、名前に精度を入れる。ピン・ルート・共有・画像のどこでも細かく見せない
    const name = m.level === m.match_level ? m.matched : `${m.matched}（${precisionOf(m.level)}）`;
    const place = addAbr(session, { name, coord: m.coord, kind: 'address' });
    return { place, input: address, matched: m.matched, unmatched: m.unmatched, level: m.level, precision: precisionOf(m.level) };
  },
  llm: (o) => ({ ref: o.place.ref, matched: o.matched, unmatched: o.unmatched, precision: o.precision }),
});
