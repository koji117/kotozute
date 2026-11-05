// ルートの曲がり方の日本語。Valhalla の maneuver の type と道路名からテンプレートで作る（Valhalla の案内文は使わない）。
import type { Step } from './types';
import type { Maneuver } from '../services/valhalla';

/** 「15」「C1」のような路線番号だけの名前 */
const isRouteNo = (s: string) => /^[A-Za-z]{0,2}\d+[A-Za-z]?$/.test(s.trim());
export const streetOf = (names?: string[]) => names?.find((n) => n.trim() && !isRouteNo(n)) ?? null;

const turn = (what: string, s: string | null) => (s ? `${what}して${s}へ` : what);
const bear = (dir: string, s: string | null) => (s ? `${dir}へ　${s}` : `${dir}へ`);

/** resume：寄り道先から走り出す区間（最初の区間でない） */
export function stepText(m: Maneuver, resume = false): string {
  const s = streetOf(m.street_names);
  // type の番号は Valhalla の Maneuver::Type
  switch (m.type) {
    case 1: case 2: case 3: return s ? `${s}を${resume ? '進む' : '出発'}` : '出発';
    case 4: return '到着';
    case 5: return '到着・右側';
    case 6: return '到着・左側';
    case 7: return s ? `道なりに${s}へ` : '道なりに進む';
    case 8: case 22: return s ? `${s}を直進` : '直進';
    case 9: return bear('やや右', s);
    case 16: return bear('やや左', s);
    case 23: return bear('右寄り', s);
    case 24: return bear('左寄り', s);
    case 10: return turn('右折', s);
    case 15: return turn('左折', s);
    case 11: return turn('大きく右折', s);
    case 14: return turn('大きく左折', s);
    case 12: case 13: return turn('Uターン', s);
    case 17: return s ? `ランプを直進して${s}へ` : 'ランプを直進';
    case 18: return s ? `右のランプから${s}へ` : '右のランプへ';
    case 19: return s ? `左のランプから${s}へ` : '左のランプへ';
    case 20: return s ? `右の出口から${s}へ` : '右の出口へ';
    case 21: return s ? `左の出口から${s}へ` : '左の出口へ';
    case 25: case 37: case 38: return s ? `${s}に合流` : '合流';
    case 26: return m.roundabout_exit_count ? `環状交差点に入り、${m.roundabout_exit_count}番目の出口へ` : '環状交差点に入る';
    case 27: return s ? `環状交差点を出て${s}へ` : '環状交差点を出る';
    case 28: return 'フェリーに乗る';
    case 29: return 'フェリーを降りる';
    default: return '道なりに進む';
  }
}

export const toSteps = (ms: Maneuver[], resume = false): Step[] =>
  ms.map((m) => ({ type: m.type, text: stepText(m, resume), street: streetOf(m.street_names), km: Math.round(m.length * 100) / 100 }));
