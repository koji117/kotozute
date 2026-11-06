// Task 4b の部品（scripts/setup/valhalla.ts と abr.ts）を呼ぶための型と読み込み。
// このブランチにはまだそのファイルがないので、パスを組み立てて動的に読む（型の確認は通る。ないときは日本語で止まる）。
// ponytail: Task 4b を取り込んだら静的 import に替える
import type { Log } from './tools';

export interface ValhallaModule {
  /** <dir>/valhalla_tiles.tar と <dir>/valhalla.json だけを残す */
  buildValhalla(o: { pbf: string; dir: string; jobs: number; log: Log }): Promise<void>;
}
export interface AbrModule {
  /** <dir>/abrg.duckdb を作る（作るときだけ Docker の PostgreSQL） */
  buildAbrData(o: { pref: string; dir: string; log: Log }): Promise<void>;
  /** <dir>/abrg を手元の Go で作り、そのパスを返す */
  buildAbrg(o: { dir: string; log: Log }): Promise<string>;
  /** abrg serve の起こし方（127.0.0.1 だけで待ち受ける） */
  abrgServe(o: { bin: string; cache: string; port: number }): { cmd: string; args: string[]; env: Record<string, string> };
}

async function load<T>(name: string, what: string): Promise<T> {
  try {
    return (await import(new URL(`./${name}.ts`, import.meta.url).href)) as T;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND' && String((e as Error).message).includes(`${name}.ts`)) {
      throw new Error(`${what}の部品（scripts/setup/${name}.ts）がまだありません。Task 4b を取り込んでから回してください`);
    }
    throw e;
  }
}
export const valhalla = () => load<ValhallaModule>('valhalla', 'ルート（Valhalla）');
export const abr = () => load<AbrModule>('abr', '住所（ABR）');
