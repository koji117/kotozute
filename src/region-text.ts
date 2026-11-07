// 地域で変わる文を1か所にまとめる（Claude に渡る文と、画面の文）。地域の設定（src/region.ts の REGION）から作る。
// 東京（既定）では前の文と1バイトも変えない。Claude に渡る文は check-quick が scripts/fixtures/claude-text-tokyo.txt と比べる（評価は回し直せないため）。
// 例の文（港区芝公園4-2-8、品川駅、東京タワー）は、どの地域でも東京のまま（形を見せるだけ）。
// 画面（vite）からも読むので、node の機能を使わない。
import { REGION } from './region';

const { id, label, name } = REGION;

// ===== Claude に渡る文 =====
/** システムプロンプトの1行目（src/server/claude.ts の SYSTEM） */
export const SYSTEM_ROLE = `あなたは「ことづて」の操作係です。地図に詳しくない社員が日本語で頼んだことを、${label}の地図の操作に変えます。地図のデータは OpenStreetMap です。`;
/** 画面の状態の「画面の範囲」が、ないとき（src/server/claude.ts の contextBlock） */
export const VIEW_NONE = `なし（${name}全体）`;
/** 画面の範囲がないときの view: の名前（src/server/session.ts。find_features の結果で Claude に渡る） */
export const VIEW_NONE_NAME = label;
/** search_place：画面の外から探し直したかを返すキー */
export const WIDENED_KEY = `widened_to_${id}`;
/** search_place の説明のうち、探す範囲の文 */
export const SEARCH_PLACE_SCOPE = `画面に1件もなければ${name}全体から探す（${WIDENED_KEY}）。それ以外の参照なら${name}全体から探す。`;
/** search_place：画面の範囲が地域にかからない */
export const VIEW_OUTSIDE = `画面の範囲が${label}の外です`;
/** geocode_address の説明の最後の文 */
export const GEOCODE_SCOPE = `対応する地域は${label}。`;
/** 地域の外の場所（geocode_address、route、plan_course） */
export const OUT_OF_AREA = `対応する地域は${label}です`;
/** plan_course：経由地にできるトンネルがない */
export const noCourseTunnels = (km: number) =>
  `出発地から${km}km以内の${name}の中に、経由地にできる名前のある道路トンネルがOSM上で見つかりません（現地にないとは限らない）`;

// ===== 画面の文 =====
/** 右下の札（src/web/index.html） */
export const REGION_PILL = label;
/** 場所の検索で、画面の外から探し直したとき */
export const WIDENED_NOTE = `画面の中になかったので、${name}全体から探しました`;
/** 試走コースの経由地の候補の説明 */
export const courseCandidates = (km: number) => `出発地から${km}km以内の、${name}の中の名前のある道路トンネル`;
/** サーバが地域の外の座標（現在地、クリック、貼った座標）を断るとき。島しょ部も東京都なので、受け付ける範囲の名前（label）で言う */
export const OUTSIDE_POINT = `対応する地域（${label}）の外です`;

// 地物の検索の出どころ（2026-11-06 にユーザーが決定：手元の検索データのときは「手元の検索データ（OSM）」と言う）。
// osm_backend がない今のデモ（Overpass）では、前と同じ文のまま
const LOCAL = REGION.osm_backend === 'sqlite';
/** 結果パネルの「詳細」の札の説明 */
export const CHIP_SOURCE = LOCAL ? '札は AI を通さずに、手元の検索データ（OSM）から直接さがします' : '札は AI を通さずに、自社の Overpass へ直接たずねます';
/** 寄り先の検索が失敗したときの文 */
export const STOP_SEARCH_ERROR = LOCAL ? '地物の検索（手元の検索データ）がエラーを返しました。少し待ってから試してください' : '地物の検索（自社の Overpass）がエラーを返しました。少し待ってから試してください';
