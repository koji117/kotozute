// 辞書にない言葉：依頼にあった地物の言葉が辞書にないとき、画面で正直に「辞書にない」と出すための操作。
import { z } from 'zod';
import { defineOp, type UnknownWordsOutput } from './types';

export const unknownWords = defineOp({
  name: 'unknown_words',
  title: '辞書にない言葉',
  description: '依頼にある地物の言葉が辞書のキーにないときに、その言葉を依頼の書き方のまま渡す（例：本屋、銭湯）。辞書の別の言葉に言い換えない。',
  input: z.object({
    words: z.array(z.string().min(1).max(20)).min(1).max(5).describe('辞書にない言葉。依頼に書かれたとおり。1〜5個'),
  }),
  direct: false,
  async run(_ctx, { words }): Promise<UnknownWordsOutput> {
    return { words: [...new Set(words)] };
  },
  llm: (out) => out,
});
