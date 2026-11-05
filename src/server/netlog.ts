// 外部通信の記録：API の要求1件の間に、サーバが出した HTTP の要求をホスト名で数える。
// 画面（ブラウザ）はこのサーバとだけ話すので、外へ出る通信はここで数えるものだけ。
// 同時に来た要求が混ざらないよう、数える箱は AsyncLocalStorage で要求ごとに分ける。
import { AsyncLocalStorage } from 'node:async_hooks';
import type { NetLog } from '../ops/types';

const box = new AsyncLocalStorage<Map<string, number>>();
/** 自社のサービス（地図・検索・ルート・住所）。どれも手元の Docker とプロセス */
const SELF = new Set(['localhost', '127.0.0.1', '[::1]']);
const ANTHROPIC = 'api.anthropic.com';

let installed = false;
/** globalThis.fetch を1回だけ包む。サーバの起動時に呼ぶ（Anthropic の SDK も、作られたときの fetch を使う） */
export function installNetlog() {
  if (installed) return;
  installed = true;
  const orig = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const m = box.getStore();
    if (m) {
      const url = input instanceof Request ? input.url : String(input);
      const host = URL.canParse(url) ? new URL(url).hostname : '（読めない宛先）';
      m.set(host, (m.get(host) ?? 0) + 1);
    }
    return orig(input, init);
  };
}

/** f の間にサーバが出した要求を数える */
export async function withNetlog<T>(f: () => Promise<T>): Promise<[T, NetLog]> {
  const m = new Map<string, number>();
  const v = await box.run(m, f);
  const net: NetLog = { hosts: Object.fromEntries(m), self: 0, anthropic: 0, other: 0 };
  for (const [h, n] of m) net[SELF.has(h) ? 'self' : h === ANTHROPIC ? 'anthropic' : 'other'] += n;
  return [v, net];
}
