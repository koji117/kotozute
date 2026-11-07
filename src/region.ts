// 地域の設定。REGION_FILE があればそれ（Mac のアプリが今のデータの region.json を渡す）、
// なければセットアップが書いた data/region.json（Git に入れない）、それもなければ Git の中の既定（東京、src/region.default.json）。
// 画面（vite）はこのファイルを読まず、build のときに REGION の値を埋め込む（vite.config.ts）。
// サーバは画面を返すときに今の値を入れ、埋め込んだ値を上書きする（src/server/main.ts。アプリで「最新にする」のあと、build をやり直さずにデータ時点が変わる）。
// パスはリポジトリの根からの相対か、絶対パス（サーバはリポジトリの根で起動する。dist や地図のフォントと同じ）。
import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BBox, LngLat } from './ops/types.ts';

export interface RegionConfig {
  /** Claude に渡るキーにも使う（widened_to_<id>） */
  id: string;
  /** 受け付ける範囲の名前（例：東京都（島しょ部を除く）） */
  label: string;
  /** 短い名前（例：東京都） */
  name: string;
  prefs: { code: number; name: string }[];
  /** 地図ファイルの切り出し範囲。地図の動かせる範囲で、地域の判定は境界でも行う */
  bbox: BBox;
  view: { center: LngLat; zoom: number };
  /** 境界のファイル：{ rings }（1つのまとまり）か { groups: rings[] }（県ごとのまとまり） */
  boundary: string;
  tiles: string;
  osm_index: string;
  osm_backend?: 'overpass' | 'sqlite';
  osm_as_of: string;
  tiles_as_of: string;
  // ここから下はセットアップが書く（npm start が読む。Git の中の既定にはない）
  /** ルートのデータの設定（valhallajs の組み込み。VALHALLA_CONFIG） */
  valhalla_config?: string;
  /** 住所のデータ（abrg の DuckDB） */
  abr_cache?: string;
  /** 住所の道具（abrg） */
  abrg_bin?: string;
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** リポジトリの根からの相対パスを絶対パスにする（MCP のように別のフォルダから起動しても読めるように） */
export const fromRoot = (p: string) => resolve(ROOT, p);

// REGION_FILE は Mac のアプリと確認用（scripts/check-quick.ts が東京と別の地域の Claude の文を作るとき）
const file = process.env.REGION_FILE ?? [fromRoot('data/region.json'), fromRoot('src/region.default.json')].find((f) => existsSync(f))!;
export const REGION: RegionConfig = JSON.parse(readFileSync(file, 'utf8'));

/** 画面に渡す値。サーバだけが使うパス（手元の絶対パスのことがある）は渡さない。地図ファイルは名前だけ（サーバが /tiles/<名前> で配る） */
export function webRegion({ boundary, osm_index, valhalla_config, abr_cache, abrg_bin, ...r }: RegionConfig) {
  return { ...r, tiles: basename(r.tiles) };
}
