// OSM ノートの下書きの決まり：問題の種類と、入れてはいけない語（社内の言葉、会社を表す語、試走など）。
// 画面からも読む（問題の種類の名前）。
// 本物の社名はリポジトリに入れず、.env（.gitignore 済み）の NOTE_BLOCK_WORDS にカンマ区切りで書く。
export const BLOCK_WORDS = ['試走', '社内', '客先', '顧客', '弊社', '当社', '株式会社', '有限会社', '（株）', '(株)', '㈱'];

/** 問題の種類（draft_osm_note の issue）。label は画面、what は下書きの「何が」 */
export const ISSUES = {
  turn_restriction: { label: '右左折の規制', what: '右左折の禁止が、OSMにない、または現地と違う可能性' },
  oneway: { label: '一方通行', what: '一方通行の有無や向きが、OSMと現地で違う可能性' },
  road_missing: { label: '道がない', what: '現地にある道が、OSMにない可能性' },
  road_closed: { label: '通れない道', what: 'OSMでは通れる道が、現地では通行止めや廃止になっている可能性' },
  name_wrong: { label: '名前の違い', what: 'OSMの名前が、現地の表示と違う可能性' },
  poi_closed: { label: '閉店・廃止', what: 'OSMにある施設が、閉店または廃止している可能性' },
  poi_missing: { label: '施設がない', what: '現地にある施設が、OSMにない可能性' },
  other: { label: 'その他', what: 'OSMの内容が、現地と違う可能性' },
} as const;
export type Issue = keyof typeof ISSUES;

// 全角・半角（ＡＢＣ／ABC、ｶﾅ／カナ、㈱／(株)）と大文字・小文字の違いでは抜けないようにそろえる
const norm = (s: string) => s.normalize('NFKC').toLowerCase();

/** text に入っている止める語。words の順で、そろえると同じになる語は最初の1つだけ */
export function blockedWords(text: string, extra: string[] = []): string[] {
  const t = norm(text);
  const seen = new Set<string>();
  return [...BLOCK_WORDS, ...extra].filter((w) => {
    const n = norm(w);
    if (!n || seen.has(n)) return false;
    seen.add(n);
    return t.includes(n);
  });
}

/** .env の NOTE_BLOCK_WORDS（カンマ区切り）。呼ぶたびに読む */
export const envBlockWords = () => (process.env.NOTE_BLOCK_WORDS ?? '').split(/[,、]/).map((w) => w.trim()).filter(Boolean);
