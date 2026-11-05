// レシピを Claude を使わずに再実行し、操作ごとの結果を出す（サーバを動かさず、このプロセスの中で呼ぶ）。
// 実行：npx tsx scripts/run-recipe.ts <id>（自社の Overpass・Valhalla・ABR が動いていること。API キーは要らない）
import { findOp } from '../src/ops/registry';
import { installNetlog, withNetlog } from '../src/server/netlog';
import { loadRecipe, runRecipe } from '../src/server/recipe';

installNetlog();
const recipe = loadRecipe(process.argv[2] ?? '');
if (!recipe) {
  console.error('レシピが見つかりません（使い方：npx tsx scripts/run-recipe.ts <10文字のID>）');
  process.exit(1);
}
console.log(`レシピ ${recipe.id}（作成 ${recipe.created_at.slice(0, 10)}、保存したときの OSM ${recipe.osm_as_of.slice(0, 10)}）を Claude を使わずに再実行します`);
const [steps, net] = await withNetlog(() => runRecipe(`recipe-cli-${process.pid}`, recipe));
for (const [i, s] of steps.entries()) {
  // 中身は LLM に返すのと同じ要約（名前・件数・参照だけ。座標は出さない）
  console.log(`${i + 1}. ${s.title}（${s.op}）`, s.ok ? JSON.stringify(findOp(s.op)!.llm(s.output)) : `失敗：${s.error.message}`);
}
console.log(`外部通信：自社のサービス ${net.self}件、api.anthropic.com ${net.anthropic}件、その他の外部 ${net.other}件`);
process.exit(steps.every((s) => s.ok) ? 0 : 1);
