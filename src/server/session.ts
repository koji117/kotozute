// セッション（画面1つぶんの状態）と、位置の参照の解決。サーバのメモリに置く。
import { REF_PATTERN, OpError, type Place, type Session } from '../ops/types';
import { REGION_LABEL, TOKYO_BBOX } from '../services/region';

// ponytail: メモリだけ。サーバを止めると消える。続きが要るならファイルに書く
const sessions = new Map<string, Session>();

export function getSession(id: string): Session {
  if (!/^[\w-]{8,64}$/.test(id)) throw new OpError('bad_input', 'セッションIDが不正です');
  let s = sessions.get(id);
  if (!s) {
    s = { id, clicks: [], places: new Map(), nextResult: 1, nextAbr: 1, layers: {} };
    sessions.set(id, s);
  }
  return s;
}

/** 検索や地物の結果を result:N として登録する */
export function addResult(s: Session, p: Omit<Place, 'ref'>): Place {
  const place = { ...p, ref: `result:${s.nextResult++}` };
  s.places.set(place.ref, place);
  if (p.osm) s.places.set(`osm:${p.osm}`, place);
  return place;
}

/** 住所の結果を abr:N として登録する */
export function addAbr(s: Session, p: Omit<Place, 'ref'>): Place {
  const place = { ...p, ref: `abr:${s.nextAbr++}` };
  s.places.set(place.ref, place);
  return place;
}

/** 参照を場所にする。知らない参照は OpError('bad_ref')。LLM が書いた座標はここを通らないので使えない */
export function resolveRef(s: Session, ref: string): Place {
  if (!REF_PATTERN.test(ref)) throw new OpError('bad_ref', `場所の参照「${ref}」の形が正しくありません`);
  if (ref === 'here:') {
    if (!s.here) throw new OpError('bad_ref', '現在地がまだありません。画面の現在地ボタンで位置情報を許可するか、地図をクリックしてください');
    return { ref, name: '現在地', coord: s.here.coord, kind: 'here' };
  }
  if (ref === 'view:') {
    const [w, sth, e, n] = s.view?.bbox ?? TOKYO_BBOX;
    return { ref, name: s.view ? '画面の範囲' : REGION_LABEL, coord: [(w + e) / 2, (sth + n) / 2], kind: 'place', bbox: s.view?.bbox ?? TOKYO_BBOX };
  }
  const m = ref.match(/^click:(\d+)$/);
  if (m) {
    const c = s.clicks[Number(m[1]) - 1];
    if (!c) throw new OpError('bad_ref', `クリックした点「${ref}」はありません`);
    return { ref, name: `クリックした点${m[1]}`, coord: c, kind: 'click' };
  }
  const p = s.places.get(ref);
  if (!p) throw new OpError('bad_ref', `「${ref}」はこの画面の結果にありません。先に検索してください`);
  return p;
}
