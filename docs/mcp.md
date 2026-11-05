# MCP サーバ

画面の札や日本語の依頼と同じ操作（`src/ops/registry.ts` の `OPS`）を、MCP のツールとして使えるようにする。Claude Desktop や Claude Code から、たとえば23区の区役所の住所一覧（`docs/demo/ward-offices.csv`）をまとめて住所にできる。

- 入口：`src/mcp/server.ts`（stdio）。公式の TypeScript SDK（`@modelcontextprotocol/sdk` v1）を使う。
- ツールの名前・説明・入力の検証は、画面や Claude から呼ぶときと同じ（`runOp` を `source: 'mcp'` で呼ぶ）。操作ログ（`logs/ops.jsonl`）にも `"source":"mcp"` で1行ずつ残る。
- **MCP サーバは AI を呼ばず、Claude API のキーも読まない。** 外に出る通信はない。使うのは手元の Overpass（:12345）、Valhalla（:8002）、ABR（:3002）だけ。
- 場所は参照（`abr:N`、`result:N`、`osm:node/123` など）で渡す。緯度経度は受け付けない。
- セッションはサーバのプロセスに1つ。つなぎ直すと、それまでの `abr:N` や `result:N` は使えなくなる。
- 画面がないので `here:`（現在地）と `click:N` は使えない。`view:` は、`set_view` で地図を動かすまでは東京都全体。

## 返すもの

| 場合 | 返すもの |
|---|---|
| 成功 | 操作の要約（画面の Claude に返すものと同じ。名前・件数・参照だけで、座標は入れない）の JSON。`geocode_address` には ABR の `coordinates_level` そのままの `level` を、`make_share_link` には画面で開ける `open`（URL）を足す |
| 失敗 | `isError: true` と、画面に出すのと同じ日本語の文 |

`open` の URL の頭は環境変数 `KOTOZUTE_URL`（既定 `http://localhost:8787`）。共有リンクの中身は `data/shares/` に保存されるので、同じリポジトリで `npm run server` を動かしていれば開ける。

## 先に動かすもの

- 手元の Overpass、Valhalla、ABR（`docs/HANDOFF.md`）。
- `npm install`（リポジトリの直下で）。

## Claude Desktop からつなぐ

`~/Library/Application Support/Claude/claude_desktop_config.json` に足す。`/ABSOLUTE/PATH/kotozute` はこのリポジトリの絶対パスに、`/opt/homebrew/bin/node` は `which node` の結果に置き換える。

```json
{
  "mcpServers": {
    "kotozute": {
      "command": "/opt/homebrew/bin/node",
      "args": [
        "/ABSOLUTE/PATH/kotozute/node_modules/tsx/dist/cli.mjs",
        "/ABSOLUTE/PATH/kotozute/src/mcp/server.ts"
      ],
      "env": { "KOTOZUTE_URL": "http://localhost:8787" }
    }
  }
}
```

- `command` は絶対パスで書く。Claude Desktop から起動するときは、シェルの `PATH` が使えないことがある。
- `env` に `ANTHROPIC_API_KEY` を入れない（使わないので要らない）。
- 書いたら Claude Desktop を再起動する。

## Claude Code からつなぐ

```sh
claude mcp add kotozute -- node /ABSOLUTE/PATH/kotozute/node_modules/tsx/dist/cli.mjs /ABSOLUTE/PATH/kotozute/src/mcp/server.ts
```

- 既定はこのフォルダだけで使える設定（`--scope local`）。どのフォルダからでも使うなら `-s user` を付ける。
- `claude mcp list` でつながったかを見る。

## 注意

- クライアントから `npm run mcp` で起動しない。npm が最初に「`> mcp`」などの行を stdout に出し、MCP のやりとり（JSON-RPC）が壊れる。手で試すときだけ `npm run --silent mcp` を使う。
- サーバのログは stderr に出す（stdout は JSON-RPC だけ）。

## 確かめ方

```sh
npx tsx scripts/check-mcp.ts
```

SDK のクライアントで、キーを外した環境・リポジトリの外のフォルダからサーバを起動し、ツールの一覧、`geocode_address`（港区芝公園4-2-8）、`search_place`、入力の誤り、23区の区役所の住所の一括処理と精度の集計、共有リンクを確かめる。MCP サーバが読み込むファイルに `src/server/claude.ts` がないことも確かめる。

## 一括処理の例（デモ）

Claude Desktop に `docs/demo/ward-offices.csv` の中身を貼り、次のように頼む。

> この23件の住所を geocode_address で順に調べて、精度ごとに件数をまとめて。最後に共有リンクを作って。

住所のピン（`abr:N`）は共有リンクに入るので、`open` の URL を開くと23区の区役所が地図に出る。2026-11-05 の確認では、住居番号の位置が17件、街区の代表点が6件だった（`scripts/check-mcp.ts` の出力）。
