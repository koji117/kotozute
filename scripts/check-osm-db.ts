// 2つの検索データ（osm.db）の表を、行ごとに比べる（pbf の読み方を変えたときに、中身が変わっていないかを確かめる）。
// 表ごとに、行の数と「片方にしかない行」の数を出す。値が違う行は両方に数える。
// 実行：node --disable-warning=ExperimentalWarning --import tsx scripts/check-osm-db.ts <a.db> <b.db>
// 1つでも違えば終了コード 1。
import { existsSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const [a, b] = process.argv.slice(2);
if (!a || !b || !existsSync(a) || !existsSync(b)) {
  console.error('使い方：scripts/check-osm-db.ts <a.db> <b.db>（2つとも、あるファイル）');
  process.exit(2);
}
const db = new DatabaseSync(a, { readOnly: true });
db.prepare('ATTACH DATABASE ? AS b').run(b);

// 比べる列（name_fts は中身を rowid で、word_rtree は範囲を id で）
const TABLES: Record<string, string> = {
  schema: "type, name, tbl_name, sql FROM {}.sqlite_master",
  meta: 'k, v FROM {}.meta',
  words: 'i, word FROM {}.words',
  feat: 'fid, type, osm_id, minx, miny, maxx, maxy, tags, geom, nodes, ways FROM {}.feat',
  wgeom: 'id, geom FROM {}.wgeom',
  word_rtree: 'id, minx, maxx, miny, maxy FROM {}.word_rtree',
  name_exact: 'v, fid FROM {}.name_exact',
  name_fts: 'rowid, name, name_ja FROM {}.name_fts',
  hw: 'id, t FROM {}.hw',
};
const one = (sql: string) => Number((db.prepare(`SELECT count(*) AS n FROM (${sql})`).get() as { n: number }).n);

let bad = 0;
console.log('表\ta の行\tb の行\ta だけ\tb だけ');
for (const [name, cols] of Object.entries(TABLES)) {
  const q = (s: string) => `SELECT ${cols.replace('{}', s)}`;
  const [na, nb] = [one(q('main')), one(q('b'))];
  const [onlyA, onlyB] = [one(`${q('main')} EXCEPT ${q('b')}`), one(`${q('b')} EXCEPT ${q('main')}`)];
  if (na !== nb || onlyA || onlyB) bad++;
  console.log(`${name}\t${na}\t${nb}\t${onlyA}\t${onlyB}`);
}
db.close();
if (bad) {
  console.error(`違う表：${bad}`);
  process.exit(1);
}
console.log('すべての表が同じ');
