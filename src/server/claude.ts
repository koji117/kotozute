// Claude のツールループ。依頼文と画面の状態を渡し、Claude が選んだ操作を runOp で順に実行する。
// 画面の文章はツールの結果からテンプレートで作るので、Claude の最後の文章は画面に出さない。
import { existsSync } from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { DICT, DICT_KEYS } from '../ops/dict';
import { findOp, runOp, toolDefs } from '../ops/registry';
import type { ChatResponse, OpResult, Session } from '../ops/types';
import { REGION_LABEL } from '../services/region';

// キーは .env から読む。中身は表示しない
if (existsSync('.env')) process.loadEnvFile('.env');

const MODEL = 'claude-sonnet-5-5';
const MAX_CALLS = 6;
const MAX_RECENT = 30;

// system と tools は毎回同じ中身にする（キャッシュのため）。依頼ごとの状態は user の文に入れる
const SYSTEM = [
  `あなたは「ことづて」の操作係です。地図に詳しくない社員が日本語で頼んだことを、${REGION_LABEL}の地図の操作に変えます。地図のデータは OpenStreetMap です。`,
  '',
  '守ること：',
  '- 必ずツールで操作する。ツールを使わずに答えない。合うツールがなければ、何もせずに一文で終える。',
  '- 場所は参照だけで指す：here:（現在地）、view:（いま画面に映っている範囲）、click:N（地図をクリックした N 番目の点）、result:N（検索や地物の結果）、abr:N（住所の結果）、osm:node/123 など。参照は、画面の状態かツールの結果に出たものだけを使う。',
  '- 緯度経度や座標は書かない。',
  '- here: は、画面の状態に「現在地（here:）：あり」とあるときだけ使う。',
  '- 「この範囲」「この辺」「画面の中」は view: を使う。',
  '- 住所（例：港区芝公園4-2-8）は geocode_address で調べ、返った abr:N を使う。',
  '- 施設や場所の名前（例：品川駅、東京タワー）は search_place で調べ、返った result:N を使う。',
  '- 地物の言葉は下の辞書のキーだけを使う。辞書にない地物の言葉は unknown_words に渡す。辞書の別の言葉に言い換えない。',
  '- 経由地は頼まれた順に並べる。',
  '- 表示の依頼（拡大、移動、表示の切り替え、「◯◯だけ残して」）は set_view を使う。',
  '- 共有の依頼（共有して、リンクを送りたい）は make_share_link を使う。',
  '- ツールがエラーを返したら、内容を読み、直せるなら直して呼び直す。',
  '- 画面の文章はツールの結果から作られる。あなたの最後の文章は画面に出ないので、一文だけ短く書いて終える。',
  '',
  '辞書（キー：名前／こう言われたらこのキー）：',
  ...DICT_KEYS.map((k) => `- ${k}：${DICT[k].label}／${DICT[k].aliases.join('、')}`),
].join('\n');

const TOOLS = toolDefs();

let client: Anthropic | undefined;

export async function chat(session: Session, text: string): Promise<ChatResponse> {
  if (!process.env.ANTHROPIC_API_KEY) return { steps: [], stop: 'error', error: 'Claude API のキー（ANTHROPIC_API_KEY）がサーバにありません' };
  client ??= new Anthropic();
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: `${contextBlock(session)}\n\n【依頼】\n${text}` }];
  const steps: OpResult[] = [];
  for (let i = 0; i < MAX_CALLS; i++) {
    let res: Anthropic.Beta.BetaMessage;
    try {
      res = await client.beta.messages.create({
        model: MODEL,
        max_tokens: 16000,
        betas: ['server-side-fallback-2026-07-01'],
        fallbacks: 'default',
        system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
        tools: TOOLS,
        tool_choice: { type: 'auto' }, // このモデルでは any / tool は 400 になる
        output_config: { effort: 'medium' },
        messages,
      });
    } catch (e) {
      return { steps, stop: 'error', error: apiError(e) };
    }
    messages.push({ role: 'assistant', content: res.content });
    if (res.stop_reason === 'refusal') return { steps, stop: 'refusal' };
    if (res.stop_reason === 'max_tokens') return { steps, stop: 'error', error: 'Claude の応答が長すぎて途中で切れました' };
    const uses = res.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use');
    if (res.stop_reason !== 'tool_use' || uses.length === 0) return { steps, stop: steps.length ? 'done' : 'no_tool' };
    const results: Anthropic.Beta.BetaToolResultBlockParam[] = [];
    for (const u of uses) {
      const r = await runOp(u.name, { session, source: 'ai' }, u.name === 'unknown_words' ? quoted(u.input, text) : u.input);
      steps.push(r);
      results.push(r.ok
        ? { type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(findOp(u.name)!.llm(r.output)) }
        : { type: 'tool_result', tool_use_id: u.id, content: r.error.message, is_error: true });
    }
    messages.push({ role: 'user', content: results });
  }
  return { steps, stop: 'max_steps' };
}

/** 辞書にない言葉は、依頼文にそのまま書かれたものだけ通す（Claude が作った言葉を画面に出さない）。全部落ちたら runOp が bad_input にする */
function quoted(input: unknown, text: string): unknown {
  const words = (input as { words?: unknown } | null)?.words;
  return Array.isArray(words) ? { words: words.filter((w) => typeof w === 'string' && w.trim() !== '' && text.includes(w)) } : input;
}

/** 依頼ごとに渡す画面の状態。座標は入れず、参照と名前と件数だけ */
function contextBlock(s: Session): string {
  const layers = Object.values(s.layers).map((l) => `${DICT[l!.word].label}（${l!.word}）${l!.refs.length}件・${l!.visible ? '表示中' : '非表示'}`);
  const recent = [...s.places].filter(([k]) => /^(result|abr):/.test(k)).slice(-MAX_RECENT).map(([k, p]) => `${k} ${p.name ?? '（名前なし）'}`);
  return [
    '【画面の状態】',
    `現在地（here:）：${s.here ? `あり（精度 半径${Math.round(s.here.accuracy_m)}m）` : 'なし'}`,
    `画面の範囲（view:）：${s.view ? 'あり' : 'なし（東京都全体）'}`,
    `クリックした点：${s.clicks.length ? `click:1〜click:${s.clicks.length}` : 'なし'}`,
    `地図に出ている印：${layers.join('、') || 'なし'}`,
    `最近の結果：${recent.join('、') || 'なし'}`,
  ].join('\n');
}

function apiError(e: unknown): string {
  console.error('[claude]', e);
  if (e instanceof Anthropic.AuthenticationError) return 'Claude API のキーが正しくありません';
  if (e instanceof Anthropic.RateLimitError) return 'Claude API が混んでいます。少し待ってから試してください';
  if (e instanceof Anthropic.BadRequestError) return 'Claude API への依頼の形が正しくありません';
  if (e instanceof Anthropic.APIConnectionError) return 'Claude API に接続できません';
  if (e instanceof Anthropic.APIError) return `Claude API がエラーを返しました（${e.status}）`;
  return 'Claude とのやりとりの途中でエラーが起きました';
}
