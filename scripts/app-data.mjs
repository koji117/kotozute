// npm run app:dist の afterPack（electron-builder.yml）：地域の設定（data/region.json）が指すデータを、アプリの中のリポジトリと同じ場所に入れる。
// 入れるのは設定が指すファイルだけ（検索データ、地図タイル、境界、ルートの設定と tar、住所のデータと abrg）。古い検索データや作業の残りは入れない。
// リポジトリの外のファイル（--abr-cache などで渡したもの）は data/setup/app/<種類>/ に入れ、アプリの中の region.json はそこを指す（アプリの根からの相対）。
// コピーは APFS の複製（clonefile。ディスクを使わない）。モード（abrg の実行の権限）も写す。
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export default function afterPack(ctx) {
  const app = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`, 'Contents/Resources/app');
  if (!existsSync(join(ROOT, 'data/region.json'))) throw new Error('地域の設定（data/region.json）がありません。先に「npm run setup -- --region=tokyo」を回してください');
  const region = JSON.parse(readFileSync(join(ROOT, 'data/region.json'), 'utf8'));
  /** 中のパス：リポジトリの中なら同じ相対パス、外なら data/setup/app/<種類>/<名前> */
  const inApp = (kind, p) => {
    const r = relative(ROOT, resolve(ROOT, p));
    return r.startsWith('..') || isAbsolute(r) ? `data/setup/app/${kind}/${basename(p)}` : r.split(sep).join('/');
  };
  const put = (src, to) => {
    const dest = join(app, to);
    mkdirSync(dirname(dest), { recursive: true });
    copyFileSync(src, dest, constants.COPYFILE_FICLONE);
    chmodSync(dest, statSync(src).mode & 0o777);
    return to;
  };
  for (const k of ['tiles', 'boundary', 'osm_index', 'abr_cache', 'abrg_bin']) {
    if (region[k]) region[k] = put(resolve(ROOT, region[k]), inApp(k, region[k]));
  }
  if (region.valhalla_config) {
    const cfg = resolve(ROOT, region.valhalla_config);
    const tar = JSON.parse(readFileSync(cfg, 'utf8')).mjolnir.tile_extract; // 設定ファイルのフォルダからの相対（セットアップが書く形）
    if (!tar || isAbsolute(tar)) throw new Error(`ルートの設定（${cfg}）の tile_extract が設定ファイルのフォルダからの相対ではありません：${tar}`);
    region.valhalla_config = put(cfg, inApp('valhalla', region.valhalla_config));
    put(resolve(dirname(cfg), tar), join(dirname(region.valhalla_config), tar));
  }
  mkdirSync(join(app, 'data'), { recursive: true });
  writeFileSync(join(app, 'data/region.json'), JSON.stringify(region, null, 2) + '\n');
}
