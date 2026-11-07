// ルートのデータを作る（@valhallajs/valhallajs の valhalla_build_tiles。Docker も Python も使わない）。設計書 §8.2・§16・§17。
// 残すのは <dir>/valhalla_tiles/（タイルのフォルダ）と <dir>/valhalla.json だけ。作業の場所と速度表は消す。
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { run, type Log } from './run';

// 速度表は OpenStreetMapSpeeds の commit c9c6872 に固定する（今の Docker の Valhalla と同じ中身）
const SPEEDS_URL = 'https://raw.githubusercontent.com/OpenStreetMapSpeeds/schema/c9c6872d5ec656f5d290944b44eb1a103ed539fa/default_speeds.json';
const SPEEDS_SHA256 = '9953f78c2407b8d2e3701fce6cc93c6a91b207a365a5d2f5564a6d1c231e5ba7';

const PKG = path.dirname(createRequire(import.meta.url).resolve('@valhallajs/valhallajs'));

// 設定のひな形（valhalla-config.json）は、valhallajs 3.7.0 の valhalla_build_config（Python）を次の引数で回した出力そのまま：
//   --mjolnir-tile-dir '' --mjolnir-tile-extract '' --mjolnir-admin '' --mjolnir-timezone '' --mjolnir-concurrency 1
//   --mjolnir-default-speeds-config '' --service-limits-allow-hard-exclusions True --additional-data-elevation ''
// valhallajs の版を上げたら作り直す。check-setup が、今の build_config の出力と同じかを確かめる
const TEMPLATE = readFileSync(new URL('./valhalla-config.json', import.meta.url), 'utf8');

/** 作るときの設定。build_config に同じ値を渡したときと同じものを返す。tar は作らないので tile_extract は空 */
export function buildConfig(o: { tileDir: string; admin: string; timezone: string; speeds: string; jobs: number }) {
  const c = JSON.parse(TEMPLATE);
  Object.assign(c.mjolnir, { tile_dir: o.tileDir, tile_extract: '', admin: o.admin, timezone: o.timezone, concurrency: o.jobs, default_speeds_config: o.speeds });
  return c;
}

export async function buildValhalla(o: { pbf: string; dir: string; jobs: number; log: Log }): Promise<void> {
  const dir = path.resolve(o.dir);
  const work = path.join(dir, 'valhalla-build'); // 作業の場所。終わったら（失敗しても）消す
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  try {
    o.log('速度表を取得します（OpenStreetMapSpeeds c9c6872）');
    const res = await fetch(SPEEDS_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`速度表を取得できません（${res.status}）`);
    const speeds = Buffer.from(await res.arrayBuffer());
    if (createHash('sha256').update(speeds).digest('hex') !== SPEEDS_SHA256) throw new Error('速度表の中身が固定した版と違います（sha256 が合いません）');
    await writeFile(path.join(work, 'default_speeds.json'), speeds);

    const cfg = path.join(work, 'valhalla.json');
    const tilesDir = path.join(work, 'tiles');
    const c = buildConfig({
      tileDir: tilesDir,
      // admins と timezones は作らない（ない場所を指す）。結果は同じで、左側通行の判定も同じ（設計書 §8.2）
      admin: path.join(work, 'none', 'admins.sqlite'),
      timezone: path.join(work, 'none', 'timezones.sqlite'),
      speeds: path.join(work, 'default_speeds.json'),
      jobs: o.jobs,
    });
    await writeFile(cfg, JSON.stringify(c, null, 2) + '\n');

    // 道具は直に回す。bin/valhalla-cli.js を通すと、シグナルで落ちた（メモリ不足で kill など）ときも終了コード 0 になり、半端なタイルを使ってしまう
    const tiles = () => run('build_tiles', path.join(PKG, process.platform, process.arch, 'valhalla_build_tiles'), ['-c', cfg, '-j', String(o.jobs), path.resolve(o.pbf)], { log: o.log });
    o.log(`ルートのタイルを作ります（${o.jobs} スレッド）`);
    await tiles().catch(async (e: Error) => {
      o.log(`${e.message}。1回だけやり直します`);
      await rm(tilesDir, { recursive: true, force: true });
      await tiles();
    });
    // タイル（.gph）のほかは消す。前に tar にしていたとき（build_extract）も .gph だけを入れていた
    const extra = (await readdir(tilesDir, { recursive: true, withFileTypes: true })).filter((f) => f.isFile() && !f.name.endsWith('.gph'));
    for (const f of extra) await rm(path.join(f.parentPath, f.name));
    if (extra.length) o.log(`タイルのほかのファイルを消しました：${extra.map((f) => path.relative(tilesDir, path.join(f.parentPath, f.name))).join('、')}`);

    // 動かすときの設定。パスは設定ファイルからの相対にして、フォルダごと動かせるようにする（src/services/valhalla.ts が解く）。
    // 作るときだけのパス（速度表、admins、timezones）は空にし、作った機械のパスを残さない。
    // 渋滞の情報（traffic_extract）は使わない。記録は出さない（組み込みでは問い合わせのたびにサーバの標準出力へ出るため）
    Object.assign(c.mjolnir, { tile_extract: '', tile_dir: 'valhalla_tiles', default_speeds_config: '', admin: '', timezone: '', traffic_extract: '' });
    c.logging = { ...c.logging, type: '' };
    // 前の版の tar を先に消し、設定を置き、タイルのフォルダを最後に置く（フォルダがあれば設定もそろっている。作りかけのフォルダは置かない）
    await rm(path.join(dir, 'valhalla_tiles.tar'), { force: true });
    await writeFile(path.join(work, 'valhalla.run.json'), JSON.stringify(c, null, 2) + '\n');
    await rename(path.join(work, 'valhalla.run.json'), path.join(dir, 'valhalla.json'));
    await rename(path.join(dir, 'valhalla_tiles'), path.join(work, 'old-tiles')).catch((e: NodeJS.ErrnoException) => { if (e.code !== 'ENOENT') throw e; });
    await rename(tilesDir, path.join(dir, 'valhalla_tiles'));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
