// 地域の設定（data/region.json）から、住所の道具（abrg）とアプリのサーバの起こし方を決める。npm start（scripts/start.mjs）と Mac のアプリ（desktop/main.mjs）が使う。
// パスは root（リポジトリの根。アプリでは Contents/Resources/app）からの相対。どちらも JS のまま動かすので TypeScript にしない。
// 環境変数が決まっていればそちらを使う（開発用）：OSM_BACKEND、OSM_INDEX、VALHALLA_MODE、VALHALLA_CONFIG、ABRG_BIN、ABRG_CACHE_PATH。ABR_URL があれば abrg を起こさない。
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/** abrg serve の起動のしかた。127.0.0.1 だけで待ち受ける。env はこれだけを渡す（API キーなど親の環境は渡さない） */
export function abrgServe({ bin, cache, port }) {
  return { cmd: bin, args: ['serve'], env: { ABRG_HTTP_HOST: '127.0.0.1', ABRG_HTTP_PORT: String(port), ABRG_CACHE_PATH: cache } };
}

/**
 * region：data/region.json の中身（なければ null）。env：サーバに足す環境変数（ABR_URL は abrg を起こしたあとで足す）。
 * abrg：起こす abrg の { bin, cache }（住所のデータがないか、ABR_URL が決まっていれば null）
 */
export function regionLaunch(root, env = process.env) {
  const file = resolve(root, 'data/region.json');
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

/** url が 200 を返すまで待つ（ms を過ぎたら失敗） */
export async function waitHttp(url, ms) {
  for (const t = Date.now(); Date.now() - t < ms; await new Promise((r) => setTimeout(r, 100))) {
    try { if ((await fetch(url)).ok) return; } catch {}
  }
  throw new Error(`${url} が ${ms / 1000} 秒以内に起動しませんでした`);
}
