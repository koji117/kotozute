// ルートのデータを作る（@valhallajs/valhallajs の道具。Docker なし）。設計書 §8.2・§16。
// 残すのは <dir>/valhalla_tiles.tar と <dir>/valhalla.json だけ。タイルのフォルダと速度表は消す。
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { run, type Log } from './run';

// 速度表は OpenStreetMapSpeeds の commit c9c6872 に固定する（今の Docker の Valhalla と同じ中身）
const SPEEDS_URL = 'https://raw.githubusercontent.com/OpenStreetMapSpeeds/schema/c9c6872d5ec656f5d290944b44eb1a103ed539fa/default_speeds.json';
const SPEEDS_SHA256 = '9953f78c2407b8d2e3701fce6cc93c6a91b207a365a5d2f5564a6d1c231e5ba7';

const PKG = path.dirname(createRequire(import.meta.url).resolve('@valhallajs/valhallajs'));
// build_config は Python 3.10 の書き方（list[str] | None）を含み、Mac に入っている Python 3.9 では読めない。
// 注釈を評価しない指定（from __future__ import annotations と同じ）で読んで回す。出力は Python 3.14 で回したものと同じ
const PY_FUTURE = 'import sys,__future__; p=sys.argv[1]; sys.argv=sys.argv[1:]; exec(compile(open(p).read(), p, "exec", __future__.annotations.compiler_flag, dont_inherit=True), {"__name__": "__main__"})';

const NO_PYTHON = 'python3 が見つかりません。ルートのデータを作る道具（valhallajs の build_config と build_extract）は Python 3.8 以上で動きます。Mac では「xcode-select --install」で入ります';

export async function buildValhalla(o: { pbf: string; dir: string; jobs: number; log: Log }): Promise<void> {
  // Mac の /usr/bin/python3 は、Command Line Tools がないと入れる窓を出して 0 以外で終わる（ENOENT にならない）。先に版まで確かめる
  await run('python3', 'python3', ['-I', '-c', 'import sys; sys.exit(sys.version_info < (3, 8))'], { log: () => {}, missing: NO_PYTHON }).catch(() => { throw new Error(NO_PYTHON); });
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
    const out: string[] = [];
    await run('build_config', 'python3', ['-I', '-c', PY_FUTURE, path.join(PKG, 'valhalla_build_config'),
      '--mjolnir-tile-dir', path.join(work, 'tiles'),
      '--mjolnir-tile-extract', path.join(work, 'valhalla_tiles.tar'),
      // admins と timezones は作らない（ない場所を指す）。結果は同じで、左側通行の判定も同じ（設計書 §8.2）
      '--mjolnir-admin', path.join(work, 'none', 'admins.sqlite'),
      '--mjolnir-timezone', path.join(work, 'none', 'timezones.sqlite'),
      '--mjolnir-concurrency', String(o.jobs),
      '--mjolnir-default-speeds-config', path.join(work, 'default_speeds.json'),
      '--service-limits-allow-hard-exclusions', 'True',
      '--additional-data-elevation', '',
    ], { log: o.log, out, missing: NO_PYTHON });
    await writeFile(cfg, out.join(''));

    // 道具は直に回す。bin/valhalla-cli.js を通すと、シグナルで落ちた（メモリ不足で kill など）ときも終了コード 0 になり、半端なタイルを tar にしてしまう
    const tiles = () => run('build_tiles', path.join(PKG, process.platform, process.arch, 'valhalla_build_tiles'), ['-c', cfg, '-j', String(o.jobs), path.resolve(o.pbf)], { log: o.log });
    o.log(`ルートのタイルを作ります（${o.jobs} スレッド）`);
    await tiles().catch(async (e: Error) => {
      o.log(`${e.message}。1回だけやり直します`);
      await rm(path.join(work, 'tiles'), { recursive: true, force: true });
      await tiles();
    });
    o.log('タイルを tar にまとめます');
    await run('build_extract', 'python3', ['-I', path.join(PKG, 'valhalla_build_extract'), '-c', cfg, '-O'], { log: o.log, missing: NO_PYTHON });

    // 動かすときの設定。パスは設定ファイルからの相対にして、フォルダごと動かせるようにする（src/services/valhalla.ts が解く）。
    // 作るときだけのパス（速度表、admins、timezones）は空にし、作った機械のパスを残さない。
    // 渋滞の情報（traffic_extract）は使わない。記録は出さない（組み込みでは問い合わせのたびにサーバの標準出力へ出るため）
    const c = JSON.parse(await readFile(cfg, 'utf8'));
    Object.assign(c.mjolnir, { tile_extract: 'valhalla_tiles.tar', tile_dir: 'valhalla_tiles', default_speeds_config: '', admin: '', timezone: '', traffic_extract: '' });
    c.logging = { ...c.logging, type: '' };
    // 設定も作業の場所に書いてから置く。tar を最後に置く（tar があれば設定もそろっている）
    await writeFile(path.join(work, 'valhalla.run.json'), JSON.stringify(c, null, 2) + '\n');
    await rename(path.join(work, 'valhalla.run.json'), path.join(dir, 'valhalla.json'));
    await rename(path.join(work, 'valhalla_tiles.tar'), path.join(dir, 'valhalla_tiles.tar'));
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
