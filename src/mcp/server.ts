// MCP サーバ（stdio）：OPS の操作を、同じ名前・説明・入力の検証のまま MCP のツールにする。つなぎ方は docs/mcp.md。
// AI は呼ばず、Claude API のキーも読まない（src/server/claude.ts を読み込まない）。実行：npm run mcp
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { OPS, findOp, runOp } from '../ops/registry';
import { exportDir } from '../ops/export_png';
import type { ExportRouteOutput, GeocodeOutput, ShareOutput } from '../ops/types';
import { getSession } from '../server/session';

// stdout は JSON-RPC だけに使う。ログはすべて stderr へ
console.log = console.info = console.debug = console.error;
// 共有リンク（data/shares）と操作ログ（logs/）は相対パスなので、どこから起動してもリポジトリの直下で動かす
process.chdir(fileURLToPath(new URL('../..', import.meta.url)));

// ponytail: セッションはプロセスに1つ。MCP の接続をやり直すと結果の参照（result:N、abr:N）は消える
const session = getSession(`mcp-${randomUUID()}`);
const WEB = process.env.KOTOZUTE_URL ?? 'http://localhost:8787'; // 共有リンクを開く画面（npm run server）

/** llm() の要約に足して返すもの。座標は返さない */
const EXTRA: Record<string, (o: any) => object> = {
  geocode_address: (o: GeocodeOutput) => ({ level: o.level }), // ABR の coordinates_level（一括処理で精度を数えるため）
  make_share_link: (o: ShareOutput) => ({ open: WEB + o.url }),
  // 画面がないのでファイルにして EXPORT_DIR に置き、パスと注意（ODbL）を返す。中身（座標）は返さない
  export_route: (o: ExportRouteOutput) => {
    const path = join(exportDir(), o.filename);
    writeFileSync(path, o.content);
    return { path, warning: o.warning };
  },
};
// OSM ノートの下書きは画面だけ（確認方法を本人が選び、止める語を画面で確かめるため）
const WEB_ONLY = 'draft_osm_note';
const MCP_OPS = OPS.filter((o) => o.name !== WEB_ONLY);

const server = new Server({ name: 'kotozute', version: '0.1.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, () => ({
  tools: MCP_OPS.map((op): Tool => ({
    name: op.name,
    title: op.title,
    description: op.description,
    inputSchema: z.toJSONSchema(op.input, { io: 'input' }) as Tool['inputSchema'],
  })),
}));

// 入力の検証は runOp が zod で行う（画面や Claude からの呼び出しと同じ）。失敗は日本語の文で isError にする
server.setRequestHandler(CallToolRequestSchema, async ({ params }): Promise<CallToolResult> => {
  if (params.name === WEB_ONLY) return { content: [{ type: 'text', text: 'OSMノートの下書きは画面で作ってください（確認方法は本人が選ぶため）' }], isError: true };
  const r = await runOp(params.name, { session, source: 'mcp' }, params.arguments ?? {});
  if (!r.ok) return { content: [{ type: 'text', text: r.error.message }], isError: true };
  const out = { ...(findOp(r.op)!.llm(r.output) as object), ...EXTRA[r.op]?.(r.output) };
  return { content: [{ type: 'text', text: JSON.stringify(out) }] };
});

await server.connect(new StdioServerTransport());
console.error('kotozute MCP server (stdio)');
