// 資料用の画像：いまの地図を、出典とデータ時点を焼き込んだ PNG にする。
// 画面（ai・direct）では画面が自分の地図から作る（src/web/main.ts の exportPng）。
// MCP では画面がないので、共有リンクを作り、その画面を headless で開いて同じ処理で作り、EXPORT_DIR に保存する。
import { execSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { defineOp, OpError, type ExportPngOutput } from './types';
import { makeShareLink } from './share';

export const exportPng = defineOp({
  name: 'export_png',
  title: '資料用の画像',
  description: 'いまの地図を、出典とデータ時点を焼き込んだ画像（PNG）にする。「資料に貼りたい」「画像にして」と頼まれたときに使う。',
  input: z.object({}),
  direct: true,
  async run(ctx): Promise<ExportPngOutput> {
    if (ctx.source !== 'mcp') return { mode: 'client' };
    const pw = playwright();
    if (!pw) throw new OpError('service', '画像をサーバで作るための Playwright が見つかりません（npm i -g @playwright/cli で入れてください）');
    const base = process.env.KOTOZUTE_BASE ?? 'http://127.0.0.1:8787';
    const share = await makeShareLink.run(ctx, {});
    // 画面のサーバが動いていて、いま作った共有を読めること（同じ data/shares を見ていること）
    const up = await fetch(`${base}/api/share/${share.id}`).then((r) => r.ok, () => false);
    if (!up) throw new OpError('service', `地図の画面のサーバ（${base}）に接続できないか、共有した地図を読めません。サーバを動かしてから試してください（KOTOZUTE_BASE）`);
    const browser = await launch(pw);
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
      await page.goto(`${base}/?s=${share.id}&png=1`);
      await page.waitForFunction(() => 'kotozutePng' in window, null, { timeout: 30_000 });
      // 画面の window.kotozutePng は data URL の Promise（地図の描画が落ち着いてから作る）
      const url: string = await page.evaluate(() => Promise.race([
        (window as any).kotozutePng,
        new Promise((_, reject) => setTimeout(() => reject(new Error('画像の作成が時間内に終わりませんでした')), 60_000)),
      ]));
      const dir = process.env.EXPORT_DIR ?? join(homedir(), 'kotozute-exports');
      mkdirSync(dir, { recursive: true });
      const path = join(dir, `kotozute-${new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '')}-${share.id}.png`);
      writeFileSync(path, Buffer.from(url.slice(url.indexOf(',') + 1), 'base64'));
      return { mode: 'file', path, share_url: `${base}${share.url}` };
    } catch (e) {
      throw e instanceof OpError ? e : new OpError('service', `画像を作れませんでした（${(e as Error).message.split('\n')[0]}）`);
    } finally {
      await browser.close();
    }
  },
  llm: (o) => o,
});

// Playwright はプロジェクトの依存に入れない。scripts/check-web.mjs と同じく、require('playwright') か、グローバルの @playwright/cli の中のものを使う
const require = createRequire(import.meta.url);
function playwright(): any {
  try { return require('playwright'); } catch {}
  try { return require(`${execSync('npm root -g').toString().trim()}/@playwright/cli/node_modules/playwright`); } catch {}
  return null;
}

// ponytail: Playwright の版に合うブラウザがないときの代わりは macOS（arm64）の headless shell だけ探す。check-web.mjs と同じ
async function launch(pw: any) {
  const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']; // headless でも WebGL を描く
  return pw.chromium.launch({ args }).catch(() => {
    const dir = join(homedir(), 'Library/Caches/ms-playwright');
    let shell: string | undefined;
    try { shell = readdirSync(dir).filter((d) => d.startsWith('chromium_headless_shell-')).sort().at(-1); } catch {}
    if (!shell) throw new OpError('service', '画像を作るための Chromium がありません（npx playwright install chromium を実行してください）');
    return pw.chromium.launch({ args, executablePath: join(dir, shell, 'chrome-headless-shell-mac-arm64/chrome-headless-shell') });
  });
}
