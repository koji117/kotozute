// 地域の設定。セットアップが書いた data/region.json（Git に入れない）があればそれ、なければ Git の中の既定（東京、src/region.default.json）。
// 画面（vite）はこのファイルを読まず、build のときに REGION の値を埋め込む（vite.config.ts）。設定を変えたら vite build をやり直す。
// パスはリポジトリの根からの相対（サーバはリポジトリの根で起動する。dist や地図のフォントと同じ）。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
/** リポジトリの根からの相対パスを絶対パスにする（MCP のように別のフォルダから起動しても読めるように） */
export const fromRoot = (p: string) => resolve(ROOT, p);

// REGION_FILE は確認用（scripts/check-quick.ts が東京と別の地域の Claude の文を作るとき）
const file = process.env.REGION_FILE ?? [fromRoot('data/region.json'), fromRoot('src/region.default.json')].find((f) => existsSync(f))!;
export const REGION: RegionConfig = JSON.parse(readFileSync(file, 'utf8'));
