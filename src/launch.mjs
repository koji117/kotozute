// 地域の設定（data/region.json か、アプリが作ったデータの region.json）から、住所の道具（abrg）とアプリのサーバの起こし方を決める。
// npm start（scripts/start.mjs）と Mac のアプリ（desktop/main.mjs）が使う。
// パスは root（リポジトリの根。アプリでは Contents/Resources/app）からの相対か、絶対パス。どちらも JS のまま動かすので TypeScript にしない。
// 環境変数が決まっていればそちらを使う（開発用）：OSM_BACKEND、OSM_INDEX、VALHALLA_MODE、VALHALLA_CONFIG、ABRG_BIN、ABRG_CACHE_PATH。ABR_URL があれば abrg を起こさない。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** abrg serve の起動のしかた。127.0.0.1 だけで待ち受ける。env はこれだけを渡す（API キーなど親の環境は渡さない） */
export function abrgServe({ bin, cache, port }) {
  return { cmd: bin, args: ['serve'], env: { ABRG_HTTP_HOST: '127.0.0.1', ABRG_HTTP_PORT: String(port), ABRG_CACHE_PATH: cache } };
}

/**
 * region：地域の設定（file。既定は data/region.json）の中身（なければ null）。env：サーバに足す環境変数（ABR_URL は abrg を起こしたあとで足す）。
 * abrg：起こす abrg の { bin, cache }（住所のデータがないか、ABR_URL が決まっていれば null）。
 * Mac のアプリは file に今のデータの region.json（中のパスは絶対パス）を、env の ABRG_BIN にアプリの中の abrg を渡す
 */
export function regionLaunch(root, env = process.env, file = resolve(root, 'data/region.json')) {
  const region = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : null;
  const abs = (p) => (p ? resolve(root, p) : undefined);
  const add = {};
  const set = (k, v) => { if (!env[k] && v) add[k] = v; };
  set('OSM_BACKEND', region?.osm_backend);
  set('OSM_INDEX', abs(region?.osm_index));
  if (region?.valhalla_config) { set('VALHALLA_MODE', 'embedded'); set('VALHALLA_CONFIG', abs(region.valhalla_config)); }
  const bin = env.ABRG_BIN || abs(region?.abrg_bin), cache = env.ABRG_CACHE_PATH || abs(region?.abr_cache);
  return { region, env: add, abrg: !env.ABR_URL && bin && cache ? { bin, cache } : null };
}

/**
 * 開発中の abrg（npm run setup が Go で作ったもの）：data/region.json の abrg_bin か data/setup/abr/abrg。なければ undefined。
 * 作ったアプリの中の bin/abrg は、これを scripts/app-data.mjs が写したもの。npm run app（bin/ がない）はこれを使う
 */
export function devAbrg(root) {
  let r = {};
  try { r = JSON.parse(readFileSync(resolve(root, 'data/region.json'), 'utf8')); } catch {}
  return [r.abrg_bin, 'data/setup/abr/abrg'].filter(Boolean).map((p) => resolve(root, p)).find((p) => existsSync(p));
}

/** url が 200 を返すまで待つ（ms を過ぎたら失敗） */
export async function waitHttp(url, ms) {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 100))) {
    try { if ((await fetch(url)).ok) return; } catch {}
  }
  throw new Error(`${url} が ${ms / 1000} 秒以内に起動しませんでした`);
}
