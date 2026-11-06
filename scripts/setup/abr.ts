// 住所（ABR）の部品。設計書 §8.3・§16。
//   buildAbrg：手元の Go で Mac 用の abrg を作る（Docker なし）
//   buildAbrData：住所のデータ（DuckDB のファイル1つ）を作る。Docker を使うのは作るときの PostgreSQL だけ
//   （abrg serve の起動のしかた abrgServe は src/launch.mjs。npm start と Mac のアプリが使う）
// abr-geocoder は ABR_COMMIT に固定し、codeload から取る（../abr-geocoder は使わない・変えない）。
// Go の作業の残り（ソース、モジュール、Go の新しい版、DuckDB の拡張）は <dir>/abr-build にだけ置き、終わったら消す。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { childEnv, run, type Log } from './run';

/** 使う abr-geocoder の版（11/6 の ../abr-geocoder の HEAD。今のデモの ABR と同じ） */
export const ABR_COMMIT = '8215e09e805713f97f65604a8acd9e6dbf5d0bf5';
const PG_IMAGE = 'postgres:17@sha256:653186fe15006c099d2fb3bc1d8461c1dee9d036c43f2e5fdaf4f22e5e601876'; // 上流の docker-compose.yml と同じ postgres:17。11/5 の版に固定
const NO_GO = 'Go が見つかりません。住所の道具（abrg）は手元の Go で作ります（https://go.dev/dl/。足りない版は Go が自分で取ってきます）';

/** <work>/src に ABR_COMMIT のソースを置く（.commit が同じならそのまま使う） */
async function source(work: string, log: Log): Promise<string> {
  const src = path.join(work, 'src');
  if ((await readFile(path.join(src, '.commit'), 'utf8').catch(() => '')).trim() === ABR_COMMIT) return src;
  await rm(src, { recursive: true, force: true });
  await mkdir(src, { recursive: true });
  log(`abr-geocoder（${ABR_COMMIT.slice(0, 7)}）のソースを取得します`);
  const res = await fetch(`https://codeload.github.com/digital-go-jp/abr-geocoder/tar.gz/${ABR_COMMIT}`, { signal: AbortSignal.timeout(300_000) });
  if (!res.ok || !res.body) throw new Error(`abr-geocoder のソースを取得できません（${res.status}）`);
  const tar = spawn('tar', ['-xzf', '-', '--strip-components=1', '-C', src], { stdio: ['pipe', 'ignore', 'pipe'] });
  Readable.fromWeb(res.body as any).pipe(tar.stdin);
  await new Promise<void>((ok, ng) => tar.on('close', (c) => (c === 0 ? ok() : ng(new Error('abr-geocoder のソースを展開できません')))));
  await writeFile(path.join(src, '.commit'), ABR_COMMIT + '\n');
  return src;
}

/** Go の作業の場所を work の中だけにする（GOFLAGS=-modcacherw で、あとで消せる） */
const goEnv = (work: string): NodeJS.ProcessEnv => ({
  ...childEnv(), CGO_ENABLED: '1', GOFLAGS: '-modcacherw',
  GOPATH: path.join(work, 'go'), GOMODCACHE: path.join(work, 'go', 'mod'), GOCACHE: path.join(work, 'go', 'cache'),
});

/** 作業の場所を消す。Go が自分で取ってきた新しい版（golang.org/toolchain）は -modcacherw でも読み取り専用なので、先に書けるようにする */
async function rmWork(work: string): Promise<void> {
  await run('chmod', 'chmod', ['-R', 'u+w', work], { log: () => {} }).catch(() => {});
  await rm(work, { recursive: true, force: true });
}

/** 上流の Dockerfile と同じ作り方（CGO_ENABLED=1、-ldflags に -w -s と版・commit の埋め込み。タグなし）で name を out に作る */
async function goBuild(name: 'abrg' | 'abrdb', work: string, out: string, log: Log): Promise<void> {
  const src = await source(work, log);
  const version = (await readFile(path.join(src, name, 'VERSION'), 'utf8')).trim();
  const v = 'github.com/digital-go-jp/abr-geocoder/common/version';
  log(`${name} ${version} を作ります`);
  await run(`go build ${name}`, 'go', ['build', `-ldflags=-w -s -X ${v}.Version=${version} -X ${v}.Commit=${ABR_COMMIT.slice(0, 7)}`, '-o', out, `./cmd/${name}`],
    { log, cwd: path.join(src, name), env: goEnv(work), missing: NO_GO });
}

/** Mac 用の abrg を <dir>/abrg に作り、そのパスを返す */
export async function buildAbrg(o: { dir: string; log: Log }): Promise<string> {
  const dir = path.resolve(o.dir);
  const work = path.join(dir, 'abr-build');
  const bin = path.join(dir, 'abrg');
  try {
    await goBuild('abrg', work, bin + '.tmp', o.log);
    await rename(bin + '.tmp', bin);
  } finally {
    await rmWork(work);
  }
  return bin;
}

/**
 * pref（'13'、'all' など）の住居表示を座標つきで取り込み、<dir>/abrg.duckdb を作る。今の scripts/abr-import.sh と同じ順
 * （init --category rsdtdsp --pos → import → cache build）。PostgreSQL は使い捨てのコンテナで、127.0.0.1 の空いたポートにだけ出す。
 * 合言葉は作るたびに作り、表示しない。終わったら（失敗しても）コンテナと volume と作業の場所を消す
 */
export async function buildAbrData(o: { pref: string; dir: string; log: Log }): Promise<void> {
  const dir = path.resolve(o.dir);
  const work = path.join(dir, 'abr-build');
  const name = `kotozute-abr-build-${randomBytes(4).toString('hex')}`;
  const pw = randomBytes(24).toString('hex');
  const log: Log = (m) => o.log(m.replaceAll(pw, '***'));
  const docker = (args: string[], out?: string[]) => run(`docker ${args[0]}`, 'docker', args, { log, out, env: { ...childEnv(), POSTGRES_PASSWORD: pw }, missing: 'docker が見つかりません。Docker を入れて起動してください' });
  try {
    await goBuild('abrdb', work, path.join(work, 'abrdb'), log);
    await goBuild('abrg', work, path.join(work, 'abrg'), log);

    log('作業用の PostgreSQL を起こします');
    // POSTGRES_PASSWORD は値を書かずに渡す（docker の引数に合言葉が出ないように、環境から読ませる）
    await docker(['run', '-d', '--rm', '--name', name, '--label', `kotozute.abr-build=${o.pref}`, '-e', 'POSTGRES_USER=postgres', '-e', 'POSTGRES_PASSWORD', '-e', 'POSTGRES_DB=abrdb', '-p', '127.0.0.1::5432', PG_IMAGE]);
    const out: string[] = [];
    await docker(['port', name, '5432/tcp'], out);
    const port = /127\.0\.0\.1:(\d+)/.exec(out.join(''))?.[1];
    if (!port) throw new Error('作業用の PostgreSQL のポートが分かりません');
    for (let i = 0; ; i++) {
      if (await docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'abrdb', '-h', '127.0.0.1'], []).then(() => true, () => false)) break;
      if (i >= 90) throw new Error('作業用の PostgreSQL が90秒たっても起きません');
      await new Promise((r) => setTimeout(r, 1000));
    }

    // HOME を作業の場所にして、DuckDB の拡張（postgres、zipfs）もそこに入れる。cwd も作業の場所（DuckDB の一時ファイル）
    const env = {
      ...childEnv(), HOME: path.join(work, 'home'), DB_HOST: '127.0.0.1', DB_PORT: port, DB_USER: 'postgres', DB_PASSWORD: pw, DB_NAME: 'abrdb', DB_SSLMODE: 'disable',
      ABRDB_DOWNLOAD_DIR: path.join(work, 'download'), ABRG_CACHE_MEMORY_LIMIT: '1GB',
    };
    await mkdir(env.HOME, { recursive: true });
    log(`住所のデータを取り込みます（都道府県 ${o.pref}、住居表示、座標つき）`);
    await run('abrdb init', path.join(work, 'abrdb'), ['init', '--pref', o.pref, '--category', 'rsdtdsp', '--pos', '-y'], { log, env, cwd: work });
    await run('abrdb import', path.join(work, 'abrdb'), ['import'], { log, env, cwd: work });
    // 作業の場所で作り、できてから置き換える（途中で止まっても、半端なファイルを <dir>/abrg.duckdb に残さない）
    log('住所の検索用のファイル（DuckDB）を作ります');
    const db = path.join(work, 'abrg.duckdb');
    for (const f of [db, db + '.wal']) await rm(f, { force: true }); // 前に止まった回の残り
    await run('abrg cache build', path.join(work, 'abrg'), ['cache', 'build', '--cache', db], { log, env, cwd: work });
    await rm(path.join(dir, 'abrg.duckdb.wal'), { force: true }); // 古いファイルの .wal を新しいファイルに当てない
    await rename(db, path.join(dir, 'abrg.duckdb'));
  } finally {
    await docker(['rm', '-f', '-v', name], []).catch(() => {});
    await rmWork(work);
  }
}
