// 操作の共通の型。Claude のツール、MCP のツール、画面の札（AI を通さない直接の呼び出し）が同じ定義を使う。
// 画面からも型だけ読む（import type）。サーバ専用の処理はここに書かない。
import { z } from 'zod';
import { DICT_KEYS, type DictKey } from './dict';

export type LngLat = [number, number];
/** [西, 南, 東, 北] */
export type BBox = [number, number, number, number];

// ===== 位置の参照 =====
// LLM が場所を指すときはこれだけを使う。生の緯度経度は受け付けない（CLAUDE.md「実行時に絶対に守るルール」）。
//   here:            ブラウザの位置情報で取った現在地（画面で許可を求め、精度を出す）
//   view:            いま画面に映っている範囲
//   click:N          地図をクリックした N 番目の点
//   result:N         検索や地物の結果の N 番目
//   abr:N            住所（ABR）の N 番目の結果
//   osm:node/123 など OSM の要素
export const REF_PATTERN = /^(here:|view:|click:[1-9]\d{0,3}|result:[1-9]\d{0,4}|abr:[1-9]\d{0,3}|osm:(node|way|relation)\/[1-9]\d{0,11})$/;
export const Ref = z.string().regex(REF_PATTERN)
  .describe('場所の参照。here: / view: / click:N / result:N / abr:N / osm:node/123 のどれか。緯度経度は書かない');
export const Word = z.enum(DICT_KEYS).describe('業務の言葉（辞書のキー）');

// ===== 場所 =====
export interface Place {
  ref: string;
  /** OSM の name（なければ null）。description・note・fixme などの自由文タグは持たない */
  name: string | null;
  coord: LngLat;
  kind: DictKey | 'address' | 'place' | 'here' | 'click';
  /** 'node/123'。OSM の要素なら */
  osm?: string;
  /** 面の地物（公園など）の範囲。分かれば */
  bbox?: BBox;
}

// ===== セッション（サーバのメモリ。src/server/session.ts が作る） =====
export interface Layer { word: DictKey; refs: string[]; visible: boolean }
export interface Session {
  id: string;
  here?: { coord: LngLat; accuracy_m: number };
  view?: { bbox: BBox; zoom: number };
  clicks: LngLat[];
  /** ref → 場所（result:N、abr:N、osm:… を入れる。here: と click: は都度作る） */
  places: Map<string, Place>;
  nextResult: number;
  nextAbr: number;
  /** 地図に出ている地物の印（find_features の結果）。set_view で表示を切り替える */
  layers: Partial<Record<DictKey, Layer>>;
  route?: RouteOutput;
}

// ===== 操作の定義 =====
export type Source = 'ai' | 'direct' | 'mcp';
export interface OpContext { session: Session; source: Source }

export type OpErrorCode = 'not_found' | 'out_of_area' | 'bad_ref' | 'limit' | 'service' | 'bad_input';
/** 操作の失敗。message は画面にそのまま出す日本語（結果にない固有名詞や数字は入れない） */
export class OpError extends Error {
  constructor(public code: OpErrorCode, message: string) { super(message); }
}

export interface OpDef<S extends z.ZodObject = z.ZodObject, O = unknown> {
  name: string;
  /** 画面の「解釈」と操作ログに出す日本語の名前 */
  title: string;
  /** Claude と MCP に渡す説明 */
  description: string;
  input: S;
  /** 画面の札やボタンから AI を通さずに呼んでよいか */
  direct: boolean;
  run(ctx: OpContext, input: z.infer<S>): Promise<O>;
  /** LLM に返す要約。名前・件数・参照だけにする。座標と自由文タグは入れない */
  llm(output: O): unknown;
}
export const defineOp = <S extends z.ZodObject, O>(op: OpDef<S, O>) => op;

export type OpResult<O = unknown> =
  | { op: string; title: string; source: Source; input: unknown; ok: true; output: O }
  | { op: string; title: string; source: Source; input: unknown; ok: false; error: { code: OpErrorCode; message: string } };

// ===== 操作ごとの出力（画面はこの形を見てテンプレートで文章を作る） =====
export interface GeocodeOutput {
  place: Place; // ref は abr:N
  input: string;
  matched: string; // ABR の matched_address
  unmatched: string | null; // 一致しなかった残り（例「2-8」）
  /** ABR の coordinates_level（そのまま） */
  level: string;
  /** 精度の日本語（言い換えない：住居番号の位置／街区の代表点／町字の代表点 など） */
  precision: string;
}
/** capped：Overpass の件数の上限で切れた（total は本当の件数ではなく「以上」）。widened：画面の中になかったので東京都全体から探した */
export interface SearchPlaceOutput { query: string; items: Place[]; total: number; truncated: boolean; capped: boolean; widened: boolean }
export interface FeatureGroup { word: DictKey; label: string; interpretation: string; count: number; items: Place[]; truncated: boolean }
/** area.radius_m：場所の周りを探したときの半径。範囲（画面や公園）で探したときは null */
export interface FindFeaturesOutput { area: { ref: string; label: string; bbox: BBox; radius_m: number | null }; groups: FeatureGroup[] }
export interface Step { type: number; text: string; street: string | null; km: number }
export interface Leg { from: string; to: string; minutes: number; km: number; shape: LngLat[]; steps: Step[] }
export interface StopChoice { requested: string; chosen: Place; alternatives: { place: Place; extra_min: number }[] }
export interface RouteOutput {
  from: Place; to: Place; stops: StopChoice[]; legs: Leg[];
  total: { minutes: number; km: number };
  /** 寄り道しない場合 */
  direct: { minutes: number; km: number };
  extra_min: number;
  avoid_highways: boolean; keep_order: boolean;
  /** 試した組み合わせの数 */
  tried: number;
}
export interface SetViewOutput { target: Place | null; bbox: BBox; shown: DictKey[]; hidden: DictKey[] }
/** includes_here：共有したルートに現在地が入っている（開いた人に見える） */
export interface ShareOutput { id: string; url: string; includes_here: boolean }
export interface UnknownWordsOutput { words: string[] }

/** 共有リンクで保存する地図の状態（GET /api/share/:id） */
export interface ShareState {
  id: string; created_at: string;
  /** 共有したときの OSM のデータ時点（あとでデータを更新しても、この地図の時点を出す） */
  osm_as_of: string;
  layers: { word: DictKey; items: Place[] }[];
  route?: RouteOutput;
  pins: Place[];
  bbox: BBox | null;
}

// ===== 画面とサーバのやりとり（src/server/main.ts と src/web が同じ形を使う） =====
export interface ChatRequest { sessionId: string; text: string; view?: Session['view'] }
export interface ChatResponse { steps: OpResult[]; stop: 'done' | 'max_steps' | 'no_tool' | 'refusal' | 'error'; error?: string }
export interface OpRequest { sessionId: string; input: unknown; view?: Session['view'] }
export interface ContextRequest { sessionId: string; here?: Session['here'] | null; view?: Session['view']; click?: LngLat }
export interface ContextResponse { clickRef?: string }
