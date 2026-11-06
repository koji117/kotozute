# ことづて（kotozute）

言葉を託すと、渡せる地図が返ってくる。AI で動く OpenStreetMap（OSM）のビューアです。

## 概要

地図に詳しくない人が、日本語ひとことで、出典つきの「渡せる地図」をつくれるようにしました。地図・地物検索・ルート・住所はすべて手元のサーバで動かし、外に出る通信は Claude API だけです。札とボタンは AI を通さずに動くので、Claude API が止まっても地図は使えます。地図の業界に長くいる作者が、Claude Code を開発の中心にして作りました。

「Built with Claude: Japan 2026」（テーマ1「あなたにしかない深さを」）への応募作品です。対応する地域は東京都（島しょ部を除く）です。

## 何ができるか

| 操作 | できること |
|---|---|
| (a) 場所・住所 | 住所をデジタル庁のアドレス・ベース・レジストリ（ABR）で調べ、座標の精度（住居番号の位置、街区の代表点など）をそのまま出す。施設や駅は OSM の名前で探す |
| (b) 地物の絞り込み | 郵便局、手土産、コンビニ、踏切、トンネルなど13語を、辞書で OSM のタグにして探す。どう解釈したかを毎回出す（例：「踏切＝railway=level_crossing（歩行者用の踏切（railway=crossing）は含まない）」）。0件は「OSM上で0件（現地にないとは限らない）」と出す |
| (c) ルート・試走コース | 現在地から、郵便局やコンビニに寄って目的地へ。寄り道で増えた時間を出す。試走コース（例：トンネル2本、高速なし、60分以内）は、経由地の候補をプログラムが作り、通った道の OSM のタグで合否表を作る。タグがなければ「判定不能」 |
| (d) 資料用の地図・共有 | 共有リンク、出典とデータ時点を焼き込んだ画像、GPX・GeoJSON（社内確認用。ODbL の注意つき）、ピン |
| (e) 地図の表示 | 「芝公園のあたりを大きく。郵便局だけ残して」のように、移動・拡大・表示の切り替えも日本語で頼める |

このほか：

- **札とボタン**：検索の横の札（郵便局・手土産・コンビニ・踏切・トンネル）と右下のボタン（現在地・拡大・縮小）は、AI を通さずに手元のサービスへ直接たずねます。
- **レシピ**：行った操作の並びを保存し、Claude を使わずに同じ順で再実行できます。
- **外部通信の記録**：操作のたびに、サーバが出した通信を「自社のサービス」「api.anthropic.com」「その他の外部」に分けて数えて見せます。
- **OSM ノートの下書き**：地図の誤りに気づいたら、OSM のノートの下書きを作ります。確認方法は本人が選び（「Googleマップで見た」は選べない）、会社を表す語や「試走」などが入っているとコピーできません。アプリは OSM と通信しません。投稿は現地を見た本人が手で行います。
- **MCP**：同じ操作を MCP のツールとしても使えます（`docs/mcp.md`）。

## 3つの約束

| 約束 | どう守るか |
|---|---|
| ① 1社に頼らない | 地図ファイル、フォント、アイコンを自前で配信する。地物検索（Overpass）、ルート（Valhalla）、住所（abr-geocoder）も手元の Docker で動かす。公開の地図サーバや公開 CDN は使わない。外に出るのは Claude API だけで、それも外部通信の記録で見せる。札・ボタン・レシピは Claude なしで動く |
| ② 詳しくなくても使える | いつもの地図アプリと同じ配置。日本語で頼める。業務の言葉を辞書で OSM のタグにする |
| ③ 確かめられる | 解釈、OSM の要素ID、データ時点、住所の精度を出す。0件と判定不能をそのまま出す。画面の文章はツールの結果からテンプレートで作るので、結果にない名前や数字は出ない |

AI が地図に嘘を描かないための決まり：

- 場所は参照（`abr:N`、`result:N`、`osm:way/…`、`click:N`、`here:`）だけで指す。AI が書いた緯度経度は受け付けない。
- Overpass の検索文は AI に書かせない。辞書から選んだタグと範囲で、プログラムが組み立てる。範囲の面積、件数、時間に上限がある。
- 操作の入力は、サーバが型（zod）で検証する。

## 画面と操作の流れ

1. 左上の検索に日本語で頼む。または検索の横の札を押す。
2. Claude が操作（ツール）を1つずつ選び、サーバが手元のサービスで実行する。札は Claude を通らない。
3. 結果は左のパネル（スマホでは下部のシート）に、解釈・件数・精度・合否表などとして出る。技術的な情報（OSM のタグ、数え方、内訳、ID、外部通信の記録）は、パネルの下の「詳細」にまとめる（はじめは閉じている）。
   「今いる場所から」のように現在地を使う依頼で現在地がまだなければ、送る前に位置情報の許可を求める。取れなければ依頼を送らず、理由と次の手（地図をクリックする）を出す。
4. パネルの下のボタンで、共有リンク、画像、GPX（社内用）、レシピを作る。

デモの例1：「今いる場所から、郵便局で書類を出して、手土産を買ってから、港区芝公園4-2-8へ。ルートを共有リンクで」。
デモの例2：品川駅を出て品川駅に戻る試走コース（トンネル2本、高速なし、60分以内）。

## 期間中に作ったもの

このリポジトリの最初のコミットは 2026-11-04 です。下のものはすべてこのリポジトリのコミットで作りました（`git log` で順番が見えます）。

| もの | 場所 |
|---|---|
| 操作（13個）と、その型・検証・操作ログ。Claude のツール、MCP のツール、画面の札が同じ定義を使う | `src/ops/` |
| 業務の言葉と OSM タグの辞書 | `src/ops/dict.ts` |
| サーバ（API、Claude のツールループ、レシピ、外部通信の記録、共有リンク） | `src/server/` |
| 自社の Overpass・Valhalla・ABR への問い合わせ、東京都の範囲の判定 | `src/services/` |
| 画面（地図アプリの配置、結果パネル、合否表、画像の書き出し） | `src/web/` |
| MCP サーバ | `src/mcp/` |
| 出典表示の定数 | `src/attribution.ts` |
| 確認のスクリプト、評価のスクリプト、データを作るスクリプト | `scripts/` |
| 評価セット（50問）と結果 | `eval/` |
| Claude Code の hooks、サブエージェント、Skill | `.claude/` |
| 計画、調査、絵コンテ、デモ用のデータ | `docs/` |
| 東京都の境界（OSM のデータから作ったもの） | `src/services/tokyo-boundary.json` |

- 絵コンテ（`docs/storyboard/`）は動画を作るための道具で、アプリではありません。画面と数値の一部は架空です。書き出すときに Web フォントをネットから読みます（`docs/storyboard/README.md`）。
- abr-geocoder に東京都のデータを取り込む小さなスクリプトは `scripts/abr-import.sh` です。abr-geocoder 本体はリポジトリの外に clone し、そのディレクトリを引数に渡します（`docs/HANDOFF.md`）。

## 使ったOSS・公開データ

既存の OSS を部品として使ってよいかは、運営に問い合わせ中です（未回答）。

### OSS

ライセンスは、手元に入っているものの `package.json`、LICENSE や COPYING のファイル、Homebrew の情報で確かめました。

| 名前（版） | 何に使うか | ライセンス | 確かめた場所 |
|---|---|---|---|
| MapLibre GL JS（6.16.0） | 地図の表示 | BSD-3-Clause | `node_modules/maplibre-gl/package.json` |
| pmtiles（4.5.0） | 地図ファイル（PMTiles）を読む | BSD-3-Clause | `node_modules/pmtiles/package.json` |
| @protomaps/basemaps（5.7.2） | 地図のスタイル | BSD-3-Clause | `node_modules/@protomaps/basemaps/package.json` |
| basemaps-assets | 地図の文字（PBF）とアイコン | 文字は SIL Open Font License、アイコンは MIT の tangrams/icons から作ったもの | basemaps-assets の README |
| @fontsource/m-plus-1（5.3.1）、@fontsource/noto-sans-mono（5.3.0） | 画面の文字 | OFL-1.1 | 各 `package.json` |
| Hono（4.13.16）、@hono/node-server（2.1.6） | サーバ | MIT | 各 `package.json` |
| zod（4.6.7） | 入力の検証 | MIT | `package.json` |
| @anthropic-ai/sdk（1.4.0） | Claude API | Apache-2.0 | `package.json` |
| @modelcontextprotocol/sdk（1.32.2） | MCP サーバ | MIT | `package.json` |
| Vite（8.3.5）、tsx（4.23.15）、TypeScript（7.0.2）、@types/node（26.6.6） | ビルドと実行、型 | Vite・tsx・@types/node は MIT、TypeScript は Apache-2.0 | 各 `package.json` |
| Playwright（@playwright/cli 0.1.1 の中のもの） | 画面の確認、MCP での画像の書き出し（プロジェクトの依存には入れていない） | Apache-2.0 | グローバルに入れた `package.json` |
| Overpass API（0.7.62.11、Docker イメージ wiktorn/overpass-api） | 地物検索 | **未確認**（イメージのラベルにも、コンテナの中にもライセンスの記載が見つからない） | — |
| Valhalla（3.9.1、Docker イメージ valhalla-scripted） | ルート | MIT | コンテナの中の `COPYING`（イメージのラベルには記載なし） |
| abr-geocoder（デジタル庁） | 住所 | MIT | clone した abr-geocoder の `LICENSE` |
| PostgreSQL（17.11、Docker イメージ postgres:17） | abr-geocoder のデータベース | PostgreSQL License | コンテナの中の copyright |
| osmium-tool（1.19.1） | OSM データの変換（構築のときだけ） | GPL-3.0-or-later | Homebrew の情報 |
| pmtiles CLI（1.31.2） | 地図ファイルの切り出し（構築のときだけ） | BSD-3-Clause | Homebrew の情報 |

### 公開データ

| データ | 何に使うか | 条件 |
|---|---|---|
| OpenStreetMap（Geofabrik の関東の抽出。データ時点 2026-11-03T21:24:04Z） | 地物検索、ルート、施設名の検索、東京都の境界 | ODbL 1.0。© OpenStreetMap contributors |
| Protomaps の日ごとのビルド（東京の範囲を切り出し。時点 2026-11-04T04:00:00Z） | 地図の表示 | 中身は OSM と Natural Earth のデータ（ファイルの説明による）。landcover レイヤ（ESA WorldCover 由来）はファイルに入っているが、スタイルから外して表示しない。出典に「Protomaps」を入れる。ビルドそのものの利用条件は**未確認** |
| デジタル庁「アドレス・ベース・レジストリ」（東京都、住居表示、座標つき） | 住所 | 利用規約の確認と出典の文言は**未確認** |
| 23区の区役所の住所（`docs/demo/ward-offices.csv`） | MCP の一括処理のデモ | OSM のデータを含むので ODbL 1.0。OSM の住所が使えなかった9区（住所のタグがない7区と、タグが使えない渋谷・豊島）は区の公式サイトの所在地（`docs/demo/README.md`） |

## 出典の表示

出典は `src/attribution.ts` の1か所で管理しています。地図の画面、共有リンクの画面、書き出す画像に必ず入れます。

| いつ | 表示する文言 | リンク |
|---|---|---|
| いつも | © OpenStreetMap contributors | https://www.openstreetmap.org/copyright |
| いつも | Protomaps | https://protomaps.com |
| ルートがあるとき | 経路: Valhalla | https://github.com/valhalla/valhalla |
| 住所を使ったとき | 出典：デジタル庁「アドレス・ベース・レジストリ」を加工して作成 | https://www.digital.go.jp/policies/base_registry_address |
| いつも | データ時点：OSM 2026-11-03／地図 2026-11-04 | — |

- ABR の文言は、デジタル庁の利用規約の記載例でまだ確かめていません（**未確認**。コードにもそう書いてあります）。
- GPX と GeoJSON には、出典、データ時点、Open Database License (ODbL) 1.0 を中に入れます。

## 構成

```
ブラウザ（MapLibre GL JS。札・ボタン・日本語の依頼）
   │  このサーバとだけ話す
   ▼
アプリのサーバ（Hono、127.0.0.1:8787）
   ├─ 札・ボタン ──────────────┐
   ├─ 日本語の依頼 → Claude API（ツールを選ぶ）
   │                           ▼
   │                  操作の一覧（src/ops、zod で検証、操作ログ）
   │                           ├─ Overpass（Docker、関東の OSM、:12345）
   │                           ├─ Valhalla（Docker、関東の OSM、:8002）
   │                           └─ abr-geocoder（Docker、東京都の ABR、:3002）
   └─ 地図ファイル・フォント・アイコンの配信（自前）

MCP サーバ（stdio）─→ 同じ操作の一覧（AI を呼ばない、キーを読まない）
```

- 日本語の依頼に使うモデルは `claude-sonnet-5-5`（`src/server/claude.ts`）。キーはサーバの `.env` の `ANTHROPIC_API_KEY` から読み、ブラウザには置きません。
- 画面の文章は、ツールの結果からテンプレートで作ります。Claude の文章は画面に出しません。

## 動かし方

準備（データの取得、Overpass・Valhalla・abr-geocoder のコンテナ、地図ファイル）と起動の手順は `docs/HANDOFF.md` にあります。準備ができたら、リポジトリの直下で：

```bash
npm install
```

```bash
npx vite build
```

```bash
npm run server
```

ブラウザで http://localhost:8787 を開きます。日本語の依頼を使うときは、`.env` に `ANTHROPIC_API_KEY` を書きます。札とボタンはキーがなくても使えます。

確かめ方（`scripts/check-*.ts`、`scripts/check-web.mjs`）も `docs/HANDOFF.md` にあります。

## 評価

日本語の依頼を本物の Claude に渡し、選んだ操作と結果をプログラムで採点します（`eval/README.md`）。

- 50問：(a)〜(d) 各10問（(e) 表示の操作は (d) に入れる）と、罠10問（東京都の外、存在しない施設、辞書にない言葉、座標の指定、0件）。
- 正解の座標は、ABR の結果を使わずに OSM の要素など別のデータで決めています。
- **評価セットは自分たちで作ったものです。** 100% はこの50問での結果で、ほかの依頼でも同じとは言えません。
- 評価セットは、プロンプトを調整する前にコミットしました（f799188）。調整は 47bf364 です。

| 回 | 何のあと | 正答 | 捏造 | 費用 |
|---|---|---|---|---|
| 1 | 4つの操作が一通り動いた時点（M1） | 39/50（78%） | 0回 | $0.38 |
| 2 | 評価1回目で落ちた問いを受けた修正（e96db0e：都の境界、画面の外の検索、読めない住所、Claude に渡す画面の状態にルートの有無）と、試走コース、ピンと書き出し、レシピ、ノート、MCP の6つの機能、レビューの修正のあと。SYSTEM プロンプトは未調整 | 47/50（94%） | 0回 | $0.43 |
| 3 | SYSTEM プロンプトに2行を足したあと（頼まれていない地物を足さない。0件なら名前を言い換えて探し直さない） | 50/50（100%） | 0回 | $0.42 |

「捏造」は、操作の入力に座標らしい数字があった回数と、依頼文にない言葉を「辞書にない言葉」として出した回数です。2回目と3回目の間に、落ちた3問だけで調整を試しました（3/3）。結果のファイルは `eval/runs/` にあります。

```bash
npx tsx scripts/eval.ts
```

自社の Overpass・Valhalla・ABR と `.env` のキーが要ります。1回で Claude を約140回呼び、約 $0.4、約5分かかります。`--only a01,b03` や `--group trap` で一部だけ回せます。

## Claude Code の使い方

開発は Claude Code が中心です。目的ごとに次のものを使いました。

| 仕組み | 何のため | 場所 |
|---|---|---|
| CLAUDE.md | 決定事項と、実行時に守るルール（公開サービスを呼ばない、座標を受け付けない、検索文を AI に書かせない、など） | `CLAUDE.md` |
| PreToolUse hook | 開発中に、Google の地図やフォント、公開 Overpass、公開 CDN などのホスト名を含む書き込みと取得を、理由をつけて止める。止めた記録は `logs/hook-blocks.jsonl` に追記する（今は6件。Google のフォント配信が4件、Google が2件） | `.claude/hooks/block-public.mjs` |
| Stop hook | 型チェックと速い検査（評価セットの形、書き出しの出典表示、辞書の色と解釈）が通るまで作業を終わらせない | `.claude/hooks/stop-checks.mjs`、`scripts/check-quick.ts` |
| サブエージェント eval-runner | 評価を回し、前回と比べて報告する。お金がかかるので、承認があるときだけ回す | `.claude/agents/eval-runner.md` |
| サブエージェント tag-auditor | 辞書の言葉が関東の OSM データに何件あるかを数え、0件や少ない言葉の直し方の案を出す | `.claude/agents/tag-auditor.md`、`scripts/tag-audit.ts` |
| Skill kotozute-dictionary | 辞書に言葉を足す・直すときの手順と決まり | `.claude/skills/kotozute-dictionary/SKILL.md` |
| ワークフローと並行の worktree | 11/5 に、6つの作業（試走コース、ピンと書き出し、レシピと外部通信の記録、OSM ノート、MCP、開発用の部品）を別々の worktree で並行して作り、1つにまとめた。まとめたときの食い違いは 1baac81、レビューの指摘は 19261dc で直した | 6つの作業は 4877cd5、665bed3、615e25e、09a7f49、652ab34、8c94575 |
| 評価の順番 | 評価セットをプロンプトの調整より前にコミットし、評価の結果も1回ずつコミットした | f799188 → f2bba9f → e96db0e → 3a215f9 → 47bf364 |

hooks が効くのは開発中の Claude Code だけです。アプリの実行時の通信は、アプリのコード（外部通信の記録）で見せます。

## MCP

画面と同じ操作を、Claude Desktop や Claude Code から MCP のツールとして使えます。たとえば23区の区役所の住所23件をまとめて住所にし、精度ごとに数えて、共有リンクにできます。MCP サーバは AI を呼ばず、Claude API のキーも読みません。つなぎ方は `docs/mcp.md` にあります。

## ライセンス

このリポジトリのコードは Apache License 2.0 です（`LICENSE`）。Copyright 2026 koji117。

地図のデータ（OpenStreetMap、ODbL）、住所のデータ（ABR）、部品として使っている OSS は、それぞれのライセンスに従います（上の表）。
