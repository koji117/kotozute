// 確認の手順（設計書 §7 の 0）。足りないものがあれば、日本語で理由と直し方を返す（止めるのは呼ぶ側）。
// 調べるのは、これから回す手順に要るものだけ（例：--abr-cache があれば Docker も Go も見ない）。
import { spawnSync } from 'node:child_process';
import { existsSync, statfsSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname } from 'node:path';

export interface Needs {
  /** ABR のデータを作る（作業用の PostgreSQL）。コンテナの osmium を使うときも要る */
  docker: boolean;
  /** Docker に要るメモリ（GiB） */
  dockerMemGiB: number;
  /** Docker の置き場（DockerRootDir）に要る空き（GiB）。Linux のように置き場が手元にあるときだけ見る */
  dockerDiskGiB: number;
  /** abrg と ABR の取り込みの道具を作る */
  go: boolean;
  /** Go が要る理由のうち、作ってあるものを渡して避けられるオプション */
  goAvoid: string[];
  /** valhallajs の build_config と build_extract */
  python: boolean;
  osmium: 'auto' | 'host' | 'container' | null;
  pmtiles: boolean;
  /** 動作確認でアプリを起こすポート */
  port: number | null;
  diskBytes: number;
  /** 空きを見る場所 */
  dir: string;
}
export interface Found { osmium: 'host' | 'container' | null; pmtiles: 'host' | 'download' | null }

const GiB = (n: number) => (n / 2 ** 30).toFixed(1);

/** env：子のプロセスの PATH（確認のテストで、偽の docker や osmium を先に置くため） */
export async function prereq(n: Needs, env: NodeJS.ProcessEnv = process.env): Promise<{ ok: string[]; problems: string[]; found: Found }> {
  const ok: string[] = [], problems: string[] = [];
  const found: Found = { osmium: null, pmtiles: null };
  const sh = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 30_000 });
    return { ok: r.status === 0, out: (r.stdout ?? '').trim(), err: `${r.stderr ?? ''}${r.error?.message ?? ''}`, missing: (r.error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT' };
  };

  // 1. Node と node:sqlite（検索データは rtree と fts5 の trigram を使う）
  const [maj] = process.versions.node.split('.').map(Number);
  if (maj < 24) problems.push(`Node ${process.versions.node} は古すぎます。Node 24 以上を入れてください（nvm なら「nvm install」で .nvmrc の版が入ります）`);
  else {
    try {
      const { DatabaseSync } = await import('node:sqlite');
      const db = new DatabaseSync(':memory:');
      db.exec("CREATE VIRTUAL TABLE r USING rtree(id, a, b); CREATE VIRTUAL TABLE f USING fts5(x, tokenize='trigram');");
      db.close();
      ok.push(`Node ${process.versions.node}（node:sqlite の rtree と fts5）`);
    } catch (e) {
      problems.push(`この Node（${process.versions.node}）の node:sqlite では検索データを作れません（${(e as Error).message}）。Node 24 以上の公式の版を入れてください`);
    }
  }

  // 2. osmium：手元のものがなければ、Docker のコンテナの中のもの
  let docker = n.docker;
  if (n.osmium) {
    const host = n.osmium !== 'container' && sh('osmium', ['--version']).ok;
    if (host) { found.osmium = 'host'; ok.push('osmium（手元）'); }
    else if (n.osmium === 'host') problems.push('osmium がありません（--osmium=host）。Mac は「brew install osmium-tool」、Ubuntu は「sudo apt install osmium-tool」で入れてください');
    else { found.osmium = 'container'; docker = true; }
  }

  // 3. Docker（ABR のデータを作るときと、コンテナの osmium だけ）
  if (docker) {
    const why = [
      ...(n.docker ? ['住所のデータを作るときに使います（作ってある abrg.duckdb があれば --abr-cache=<パス> で Docker なしで進めます）'] : []),
      ...(found.osmium === 'container' ? ['手元に osmium がないので、コンテナの osmium を使います（Mac は「brew install osmium-tool」、Ubuntu は「sudo apt install osmium-tool」で osmium を入れれば要りません）'] : []),
    ].join('。');
    const v = sh('docker', ['version', '--format', '{{.Server.Version}}']);
    let up = false;
    if (v.missing) problems.push(`docker コマンドがありません。Docker Desktop（Mac）か Docker Engine（Linux）を入れてください。${why}`);
    else if (!v.ok && /permission denied/i.test(v.err)) problems.push(`Docker を使う権限がありません（docker.sock）。Linux では「sudo usermod -aG docker $USER」のあと、ログインし直してください。Mac では Docker Desktop を起動し直してください。${why}`);
    else if (!v.ok) problems.push(`Docker は入っていますが、動いていません。Docker を起動してから、もう一度回してください。${why}`);
    else {
      up = true;
      const mem = Number(sh('docker', ['info', '--format', '{{.MemTotal}}']).out) || 0;
      if (n.docker && mem && mem < n.dockerMemGiB * 2 ** 30) problems.push(`Docker が使えるメモリが ${GiB(mem)} GiB です。${n.dockerMemGiB} GiB 以上にしてください（Docker Desktop：設定 → Resources → Memory）`);
      else ok.push(`Docker ${v.out}${mem ? `（メモリ ${GiB(mem)} GiB）` : ''}${found.osmium === 'container' ? '。osmium はコンテナのものを使います' : ''}`);
      // Docker の置き場の空き。Mac の Docker Desktop では置き場が VM の中のパスで手元にないので見ない
      const root = n.docker ? sh('docker', ['info', '--format', '{{.DockerRootDir}}']).out : '';
      if (root.startsWith('/') && existsSync(root)) {
        const f = statfsSync(root), free = f.bavail * f.bsize;
        if (free < n.dockerDiskGiB * 2 ** 30) problems.push(`Docker の置き場（${root}）の空きは ${GiB(free)} GiB で、住所のデータを作るのに約 ${n.dockerDiskGiB} GiB 要ります（見積もり）。空きを作るか、作ってある abrg.duckdb を --abr-cache=<パス> で渡してください`);
      }
    }
    if (!up && found.osmium === 'container') found.osmium = null;
  }

  // 4. Go（abrg と ABR の取り込みの道具を作る。足りない版は Go が自分で取ってくる）
  if (n.go) {
    const g = sh('go', ['version']);
    const avoid = (what: string) => (n.goAvoid.length ? `。作ってあるものがあれば ${n.goAvoid.join(' と ')} で${what}進めます` : '');
    if (g.ok) ok.push(`Go（${g.out.replace(/^go version /, '')}）`);
    else problems.push(`Go がありません。住所の道具（abrg）を手元で作るのに使います。https://go.dev/dl/ から入れてください${avoid(' Go なしで')}`);
    // abrg は DuckDB を使うので cgo で作る（C のコンパイラが要る）。Mac の cc は Command Line Tools がないと入れる窓を出すので、xcode-select -p で見る
    if ((process.platform === 'darwin' ? sh('xcode-select', ['-p']) : sh('cc', ['--version'])).ok) ok.push('C のコンパイラ（cgo）');
    else {
      problems.push(`C のコンパイラがありません。住所の道具（abrg）は cgo で作ります。Mac は「xcode-select --install」、Ubuntu は「sudo apt install build-essential」で入ります${avoid('')}`);
    }
  }

  // 5. python3（valhallajs のルートのデータを作る道具）
  if (n.python) {
    const p = sh('python3', ['--version']);
    if (p.ok) ok.push(p.out || 'python3');
    else problems.push('python3 がありません。ルートのデータ（Valhalla）を作る道具が使います。Mac は「xcode-select --install」で入ります。作ってあるデータがあれば --valhalla-dir=<フォルダ> で渡してください');
  }

  // 6. pmtiles：手元になければ、固定した版を GitHub のリリースから取る（約16MB）
  if (n.pmtiles) {
    if (sh('pmtiles', ['version']).ok) { found.pmtiles = 'host'; ok.push('pmtiles（手元）'); }
    else if (pmtilesAsset()) { found.pmtiles = 'download'; ok.push(`pmtiles は手元にないので、${PMTILES.version} を GitHub から取ります`); }
    else problems.push(`pmtiles がありません。この機械（${process.platform} ${process.arch}）用の版を用意していません。https://github.com/protomaps/go-pmtiles から入れてください`);
  }

  // 7. 空きディスク
  let d = n.dir;
  while (!existsSync(d)) d = dirname(d);
  const s = statfsSync(d);
  const free = s.bavail * s.bsize;
  if (free < n.diskBytes) problems.push(`空きディスクが足りません。${d} の空きは ${GiB(free)} GiB で、この地域には約 ${GiB(n.diskBytes)} GiB 要ります（見積もり）。ファイルを消して空きを作ってから、もう一度回してください`);
  else ok.push(`空きディスク ${GiB(free)} GiB（要るのは約 ${GiB(n.diskBytes)} GiB）`);

  // 8. ポート（つないでみる。Mac では Docker が *:port を持っていても 127.0.0.1 の listen が通ってしまうため）
  if (n.port != null && !(await portFree(n.port))) {
    problems.push(`ポート ${n.port} はほかのプログラムが使っています。止めるか、--port-app=<番号> で別の番号にしてください`);
  }
  return { ok, problems, found };
}

export const portFree = (port: number) =>
  new Promise<boolean>((done) => {
    const c = connect(port, '127.0.0.1').once('connect', () => { c.destroy(); done(false); }).once('error', () => done(true));
  });

/** pmtiles の固定した版。sha256 は GitHub のリリースの digest（2026-11-06 に gh api で確かめた） */
export const PMTILES = {
  version: 'v1.31.2',
  assets: {
    'darwin-arm64': ['go-pmtiles-1.31.2_Darwin_arm64.zip', '40528f7f616fcbf91207cd48c8fc023d213f6d86c0cbf1f748732803d1880f3d'],
    'darwin-x64': ['go-pmtiles-1.31.2_Darwin_x86_64.zip', '1f0dc02eee6c58312dd6c509faee1b5c32f0596568af1bf51f1b034e7a88a65b'],
    'linux-arm64': ['go-pmtiles_1.31.2_Linux_arm64.tar.gz', 'f8bd47e7ea866863489cad588fbaf2f31f42e5821f7a03f009b3769f05801cb1'],
    'linux-x64': ['go-pmtiles_1.31.2_Linux_x86_64.tar.gz', '3ed7dbf4ec2e6dfe5e25b6f70d1ffc932729f93c86db353bf514dd71010a312f'],
  } as Record<string, [string, string]>,
};
export function pmtilesAsset(): { url: string; name: string; sha256: string } | null {
  const a = PMTILES.assets[`${process.platform}-${process.arch}`];
  return a ? { url: `https://github.com/protomaps/go-pmtiles/releases/download/${PMTILES.version}/${a[0]}`, name: a[0], sha256: a[1] } : null;
}
