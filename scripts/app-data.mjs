// npm run app:dist の afterPack（electron-builder.yml）：アプリに道具を入れて、アプリ全体に ad-hoc の署名をする。
// 地図のデータ（検索データ、地図タイル、ルート、住所）は入れない。アプリが初めて開いたときに取って作る（設計書 §17、scripts/setup/app-data-build.ts）。
// 入れるもの（アプリの中の bin/）：
//   abrg：住所の道具。data/region.json の abrg_bin か data/setup/abr/abrg（npm run setup が Go で作ったもの）
//   pmtiles と pmtiles-LICENSE：地図を切り出す道具（固定した版。GitHub のリリースから取り、sha256 を確かめる）。
//     BSD-3-Clause なのでライセンスの文も入れる。リリースの zip には入っていないので、同じ版（v1.31.2）の LICENSE を scripts/pmtiles-LICENSE に置いた
// コピーは APFS の複製（clonefile。ディスクを使わない）。モード（実行の権限）も写す。
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tsImport } from 'tsx/esm/api';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const put = (src, dest) => {
  mkdirSync(join(dest, '..'), { recursive: true });
  copyFileSync(src, dest, constants.COPYFILE_FICLONE);
  chmodSync(dest, statSync(src).mode & 0o777);
};

export default async function afterPack(ctx) {
  const bundle = join(ctx.appOutDir, `${ctx.packager.appInfo.productFilename}.app`);
  const bin = join(bundle, 'Contents/Resources/app/bin');

  const region = existsSync(join(ROOT, 'data/region.json')) ? JSON.parse(readFileSync(join(ROOT, 'data/region.json'), 'utf8')) : {};
  const abrg = [region.abrg_bin, 'data/setup/abr/abrg'].filter(Boolean).map((p) => resolve(ROOT, p)).find((p) => existsSync(p));
  if (!abrg) throw new Error('住所の道具（abrg）がありません。先に「npm run setup -- --region=tokyo」を回して data/setup/abr/abrg を作ってください');
  put(abrg, join(bin, 'abrg'));

  // アプリは Apple Silicon の Mac だけなので、作る機械にかかわらず darwin-arm64 の版を入れる
  const { pmtilesBin } = await tsImport('./setup/tiles.ts', import.meta.url);
  const { pmtilesAsset } = await tsImport('./setup/prereq.ts', import.meta.url);
  const dir = join(ROOT, 'data/setup/app-pmtiles'); // 取った zip は残し、次からは取らない
  const exe = await pmtilesBin('download', dir, (m) => console.log(`  ${m}`), pmtilesAsset('darwin-arm64'));
  put(exe, join(bin, 'pmtiles'));
  put(join(ROOT, 'scripts/pmtiles-LICENSE'), join(bin, 'pmtiles-LICENSE'));

  // 中身をすべて入れたあとで、アプリ全体に ad-hoc の署名をする（Apple の開発者登録なし）。
  // 署名で中身を封じないと、ダウンロードしたアプリを開いたとき Mac が「壊れている」と出し、ターミナルのコマンドが要る。
  // 封じてあれば「システム設定 → プライバシーとセキュリティ → このまま開く」で開ける（コマンドは要らない）
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', bundle], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', bundle], { stdio: 'inherit' });
}
