// レシピ：画面で成功した操作の並びを保存し、Claude を使わずに同じ順で呼び直す（Claude API が止まっても同じ地図を出す）。
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OSM_DATA_AS_OF } from '../attribution';
import { runOp } from '../ops/registry';
import { ID, newId } from '../ops/share';
import { OpError, type OpResult, type Recipe, type RecipeSaved, type Session } from '../ops/types';
import { getSession } from './session';

const DIR = join(process.env.KOTOZUTE_DATA_DIR ?? 'data', 'recipes'); // data/ は .gitignore 済み。Mac のアプリは KOTOZUTE_DATA_DIR に書く
// ponytail: 再実行で自社のサービスに同じ数だけ問い合わせるので、長いレシピは断る。要るなら上げる
const MAX_STEPS = 50;

/** POST /api/recipe。現在地は操作が here: を使ったときだけ入れる */
export function saveRecipe(s: Session): RecipeSaved {
  if (!s.history.length) throw new OpError('bad_input', 'まだ操作がありません。地図で探したり動かしたりしてから保存してください');
  if (s.history.length > MAX_STEPS) throw new OpError('limit', `レシピにできる操作は${MAX_STEPS}回までです。画面を読み込み直してから操作してください`);
  const usesHere = s.history.some((h) => JSON.stringify(h.input).includes('"here:"'));
  // クリックした点は、手順が使う click:N の一番大きい N までだけ入れる（番号は変えない。座標を貼っただけ・カードを見ただけの点は、ほかの人に見せない）
  const lastClick = Math.max(0, ...[...JSON.stringify(s.history.map((h) => h.input)).matchAll(/"click:(\d+)"/g)].map((m) => Number(m[1])));
  const recipe: Recipe = {
    id: newId(),
    created_at: new Date().toISOString(),
    osm_as_of: OSM_DATA_AS_OF,
    // hereLabel があるのは試用の現在地のとき（レシピの再実行の名前は、再実行の終わりに消える）
    context: { here: usesHere ? (s.here ?? null) : null, ...(usesHere && s.here && s.hereLabel ? { here_label: s.hereLabel } : {}), clicks: s.clicks.slice(0, lastClick) },
    steps: [...s.history],
  };
  mkdirSync(DIR, { recursive: true });
  writeFileSync(`${DIR}/${recipe.id}.json`, JSON.stringify(recipe));
  return { id: recipe.id, url: `/?r=${recipe.id}`, steps: recipe.steps, includes_here: !!recipe.context.here && !recipe.context.here_label };
}

/** GET /api/recipe/:id。形が違う ID と、ない ID は null（共有リンクと同じ検査。パスに使う前に形を確かめる） */
export function loadRecipe(id: string): Recipe | null {
  if (!ID.test(id)) return null;
  try {
    return JSON.parse(readFileSync(`${DIR}/${id}.json`, 'utf8')) as Recipe;
  } catch {
    return null;
  }
}

/**
 * セッションを作り直して、保存した順に操作を呼ぶ。同じ順なので result:N と abr:N の番号も同じになる。
 * 保存した人の現在地は再実行の間だけ使い、「現在地」とは呼ばない。終わったら消す（見ている人の here: にしない）
 */
export async function runRecipe(sessionId: string, r: Recipe): Promise<OpResult[]> {
  const s = getSession(sessionId, true);
  if (r.context.here) { s.here = r.context.here; s.hereLabel = r.context.here_label ?? 'レシピを保存した人の現在地'; }
  s.clicks = [...r.context.clicks];
  const steps: OpResult[] = [];
  try {
    for (const step of r.steps) {
      if (step.view) s.view = step.view;
      else delete s.view;
      steps.push(await runOp(step.op, { session: s, source: 'recipe' }, step.input));
    }
  } finally {
    if (s.hereLabel) { delete s.here; delete s.hereLabel; } // 途中で見ている人が現在地を送っていたら（/api/context）、それは残す
  }
  return steps;
}
