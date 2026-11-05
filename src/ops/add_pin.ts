// ピン：場所にピンを立てる。ピンは地図に残り、共有リンクと画像に入る。名前は結果の名前（Place.name）をそのまま使う。
import { z } from 'zod';
import { defineOp, OpError, Ref, type AddPinOutput } from './types';
import { resolveRef } from '../server/session';

const MAX_PINS = 100;

export const addPin = defineOp({
  name: 'add_pin',
  title: 'ピン',
  description:
    '場所にピンを立てる。ピンは地図に残り、共有リンクと画像に入る。場所は参照で指す（住所は geocode_address の abr:N、' +
    '施設は search_place の result:N）。同じ場所に2回立てても1本。最大100本。',
  input: z.object({
    target: Ref.describe('ピンを立てる場所の参照。view: は使えない'),
  }),
  direct: true,
  async run({ session }, { target }): Promise<AddPinOutput> {
    if (target === 'view:') throw new OpError('bad_ref', '「view:」は画面の範囲なので、ピンは立てられません。場所を検索するか、地図をクリックしてください');
    const place = resolveRef(session, target);
    // 同じ場所：同じ参照か、同じ OSM の要素（別の検索で result:N が変わっても1本）
    let pin = session.pins.find((p) => p.ref === place.ref || (!!place.osm && p.osm === place.osm));
    if (!pin) {
      if (session.pins.length >= MAX_PINS) throw new OpError('limit', `ピンは${MAX_PINS}本までです`);
      pin = place;
      session.pins.push(pin);
    }
    return { pin, count: session.pins.length };
  },
  llm: (o) => ({ pin: { ref: o.pin.ref, name: o.pin.name }, count: o.count }),
});
