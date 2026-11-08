// 公開版（KOTOZUTE_PUBLIC=1）だけの上限。インターネットに出すとき、Claude の費用とマシンの負荷を抑える（2026-11-08 にユーザーが決定）。
// 日の数は日本時間の日付で数え直す。IP は Cloudflare のトンネルが付ける CF-Connecting-IP（手元からの呼び出しは 'local'）
// ponytail: メモリだけ。サーバを動かし直すと数え直しになる。続けて数えるならファイルに書く

export interface LimitOptions {
  /** 日本語の依頼：1日の合計 */
  chatDay: number;
  /** 日本語の依頼：1つの IP の1日の回数 */
  chatIp: number;
  /** どの API も：1つの IP の1分の回数 */
  perMin: number;
  /** 共有リンクとレシピの保存：1日の合計 */
  saveDay: number;
}

export function makeLimits(o: LimitOptions, now = () => Date.now()) {
  let day = '', chats = 0, saves = 0;
  const chatBy = new Map<string, number>();
  const minute = new Map<string, { m: number; n: number }>();
  const roll = () => {
    const d = new Date(now() + 9 * 3600e3).toISOString().slice(0, 10);
    if (d !== day) { day = d; chats = 0; saves = 0; chatBy.clear(); }
  };
  return {
    /** 1分の回数を数え、上限の中なら true */
    hit(ip: string): boolean {
      const m = Math.floor(now() / 60e3);
      const r = minute.get(ip);
      if (r && r.m === m) return ++r.n <= o.perMin;
      if (minute.size > 10_000) minute.clear();
      minute.set(ip, { m, n: 1 });
      return true;
    },
    /** 日本語の依頼を1回数える。上限なら、どちらの上限か */
    chat(ip: string): 'ok' | 'day' | 'ip' {
      roll();
      if (chats >= o.chatDay) return 'day';
      const n = chatBy.get(ip) ?? 0;
      if (n >= o.chatIp) return 'ip';
      chats++;
      chatBy.set(ip, n + 1);
      return 'ok';
    },
    /** 保存を1回数え、上限の中なら true */
    save(): boolean {
      roll();
      return ++saves <= o.saveDay;
    },
  };
}

/** 環境変数から作る。KOTOZUTE_PUBLIC=1 でなければ null（上限なし） */
export function limitsFromEnv(env = process.env) {
  if (env.KOTOZUTE_PUBLIC !== '1') return null;
  const num = (k: string, d: number) => { const v = Number(env[k]); return Number.isInteger(v) && v > 0 ? v : d; };
  return makeLimits({ chatDay: num('CHAT_PER_DAY', 300), chatIp: num('CHAT_PER_IP', 20), perMin: num('API_PER_MIN', 60), saveDay: num('SAVE_PER_DAY', 1000) });
}

export const LIMIT_TEXT = {
  minute: '短い時間に多くの操作がありました。1分ほど待ってから試してください',
  day: '公開版の今日の日本語の依頼は、上限に達しました。地図、カテゴリのボタン、座標の貼り付け、レシピの再実行は使えます',
  ip: '公開版で1人が1日に頼める日本語の依頼の回数に達しました。地図、カテゴリのボタン、座標の貼り付け、レシピの再実行は使えます',
  save: '公開版の今日の保存（共有リンクとレシピ）は、上限に達しました',
};
