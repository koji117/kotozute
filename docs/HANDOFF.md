# 引き継ぎ（2026-11-05 の終わりの時点。2026-11-06 の決定と変更を足した）

> これは 11/5〜6 の記録です（11/7 の一部を足しました）。今の動かし方と確かめ方は `README.md`、決まったことは `CLAUDE.md` の「決定事項」にあります。食い違うときは、README と CLAUDE.md が正しいです。

表記：**[事実]** コード・コマンドの出力・結果のファイルで確かめた、**[推測]** 調べた範囲での判断、**[未確認]** 確かめていない。印のない文は [事実]。

計画は `docs/plan.md`、MCP は `docs/mcp.md`、評価は `eval/README.md`、デモのデータは `docs/demo/README.md`、絵コンテは `docs/storyboard/README.md`。

## 今の状態：動くもの

ブラウザの画面、日本語の依頼（Claude）、MCP の3つの入口が、同じ操作（`src/ops/registry.ts` の `OPS`、13個）を通る。操作の入力はサーバが zod で検証し、呼び出しは `logs/ops.jsonl` に1行ずつ残る（Git に入れない）。

| 機能 | 中身 | 主なファイル |
|---|---|---|
| (a) 場所・住所 | `geocode_address`（自社の ABR、:3002。精度は `coordinates_level` をそのまま日本語にする）、`search_place`（OSM の名前で検索） | `src/ops/geocode_address.ts`、`src/ops/search_place.ts` |
| (b) 地物の絞り込み | `find_features`。辞書（13語）からプログラムが Overpass の検索文を組み立てる。トンネルはつながった way を1本、50m 未満は数えない。同じ名前の上下線は1本（cdc1041）。踏切は 40m 以内（同じ名前か片方が名前なし）か、同じ名前で 200m 以内の OSM の点を1か所にまとめ、カードは「Nか所」、「詳細」にまとめる前の点の数（cdc1041） | `src/ops/dict.ts`、`src/ops/find_features.ts` |
| (c) ルート | `route`。`here:` などから寄り先（ルートから 300m 以内の候補）を経由して目的地へ。寄り道で増えた時間を出す | `src/ops/route.ts` |
| (c) 試走コース・条件の確認 | `plan_course`（候補はプログラムが作る。最大5案、ルート計算は最大10回）、`check_route`（way の生のタグを取り直して判定） | `src/ops/plan_course.ts`、`src/ops/check_route.ts` |
| (d) 共有リンク | `make_share_link`。表示中の印・ルート・住所・ピンを `data/shares/` に保存して `/?s=<id>` で開く | `src/ops/share.ts` |
| (d) 画像 | `export_png`。出典とデータ時点を焼き込んだ PNG。画面では画面が作る。MCP では共有リンクの画面を Playwright で開いて作る | `src/ops/export_png.ts` |
| (d) GPX・GeoJSON | `export_route`。中に出典・ODbL 1.0・データ時点を入れ、社内確認用の注意を返す | `src/ops/export_route.ts` |
| (d) ピン | `add_pin`。共有リンクにも入る | `src/ops/add_pin.ts` |
| (e) 地図の表示 | `set_view`（移動・拡大と、印の表示・非表示）。場所は参照だけ | `src/ops/set_view.ts` |
| 辞書にない言葉 | `unknown_words`。依頼文にそのまま書かれた言葉だけ通す | `src/ops/unknown_words.ts` |
| OSM ノートの下書き | `draft_osm_note`。確認方法は画面で本人が選ぶ（「Googleマップで見た」は選べない）。止める語があるとコピーできない。アプリは OSM と通信しない | `src/ops/draft_osm_note.ts`、`src/ops/note_rules.ts` |
| レシピ | 成功した操作の並びを `data/recipes/` に保存し、Claude を使わずに同じ順で再実行する（画面の `/?r=<id>`、`scripts/run-recipe.ts`） | `src/server/recipe.ts` |
| 外部通信の記録 | サーバが出した HTTP の要求を、要求ごとにホスト名で数える（自社のサービス／`api.anthropic.com`／その他の外部）。結果パネルの「詳細」（はじめは閉じる）に出る（f2aeab9） | `src/server/netlog.ts` |
| MCP | stdio のサーバ。12個のツール（`draft_osm_note` は画面だけ）。AI を呼ばず、キーも読まない | `src/mcp/server.ts`、`docs/mcp.md` |
| 評価 | 50問（下の「評価」） | `eval/`、`scripts/eval.ts` |

- 画面：左上に検索（日本語の依頼もここ）、その横にカテゴリの札（郵便局・手土産・コンビニ・踏切・トンネル）、結果は左のパネル（幅 440px）、右下に現在地・拡大・縮小のボタンと出典。幅 767px 以下では結果を下部のシートにする。札とボタンは AI を通さない（`POST /api/op/:name`）。
- 結果パネル：技術的な情報（OSM のタグ、数え方、内訳、ID、車線数（参考）、外部通信の記録）は下の「詳細」にまとめ、はじめは閉じる（f2aeab9）。解釈の行は操作ごとに番号をつける（cdc1041）。
- 現在地がないまま「今いる場所から…」と頼むと、送る前に位置情報の許可を求める。取れなければ Claude に送らず、理由と次の手を出す（f2aeab9）。
- 日本語の依頼：`claude-sonnet-5-5`（`src/server/claude.ts`）。キーは `.env` の `ANTHROPIC_API_KEY`（中身は表示しない）。画面の文章はツールの結果からテンプレートで作る。
- データ時点：OSM 2026-11-03T21:24:04Z、地図ファイル 2026-11-04T04:00:00Z（`src/attribution.ts`）。
- 対応地域の判定：東京都の行政界（OSM relation 1543125 の outer、本土側だけ、約20mで間引き）。`scripts/build-tokyo-boundary.ts` が `src/services/tokyo-boundary.json` を作る。
- 住所：ABR を住居表示つき・座標つき（`--pos`）で取り込み直した。「港区芝公園4-2-8」は街区の代表点（`rsdtdsp_blk`、「東京都港区芝公園4丁目2」、残り「-8」）になる。ABR にこの街区の住居番号8がないため。点は OSM の東京タワーから 100m 以内。住居番号の位置（`rsdtdsp_rsdt`）まで一致する住所もある（23区の区役所では17件、6件は街区の代表点。`docs/mcp.md`）。

## 動かし方

**すべてリポジトリの直下で実行する（ABR のコマンドはサブシェルで `../abr-geocoder` に移る）。**

### 1. Overpass と Valhalla（Docker）

```bash
docker start overpass valhalla
```

- コンテナは作ってある（作り方は下の「作り直すときの手順」）。再起動の設定は `no` なので、Docker を起動し直したら毎回 `docker start` が要る。
- Overpass は :12345、Valhalla は :8002。

### 2. 住所（ABR、:3002）

```bash
(cd ../abr-geocoder && docker compose up -d abrg_app)
```

- compose のプロジェクトはリポジトリの外の `../abr-geocoder`（既存のコードをリポジトリに入れないため）。`abrg_app` を上げると `postgres` も上がる。DB は 127.0.0.1:55432、API は 127.0.0.1:3002 だけで待ち受ける。
- 取り込み直すときは `scripts/abr-import.sh ../abr-geocoder`（東京都、住居表示、`--pos`。DB のパスワードはこのスクリプトが作り、表示しない）。
- 前の quickstart（:3001、町字レベル）はアプリでは使っていない。ただし絵コンテのデータを作る `docs/storyboard/data/build-ex1.js` はまだ :3001 を使う。

### 3. アプリのサーバ

```bash
npx vite build
```

```bash
ALLOWED_HOSTS=<tailnet-host> npm run server
```

- サーバは 127.0.0.1:8787 だけで待ち受ける。tailnet からは `https://<tailnet-host>:8453/`（`tailscale serve --https=8453` が 127.0.0.1:8787 へ）。ALLOWED_HOSTS にない Host の API は 403。
- 置き場所は2つ（2026-11-06 にユーザーが決定）。1人なら手元の機械。チームなら共有サーバで、前に reverse proxy を置き、`ALLOWED_HOSTS` にその名前を入れる。どちらもアプリのサーバは 127.0.0.1 だけで待ち受ける。共有リンクを開けるのは、そのサーバに届く人だけ。届かない人に渡すのは画像。
- 開発中は `npm run dev`（vite :5173。`/api`・`/tiles`・`/assets` は :8787 へ）。
- 起動時に「NOTE_BLOCK_WORDS が .env にありません」と出る。下の「ユーザーの判断を待っていること」の1。

### 4. MCP

`docs/mcp.md`。クライアントからは `npm run mcp` で起動しない（npm の出力が JSON-RPC を壊す）。

### 動いているかの確認

```bash
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:12345/api/status
```

```bash
curl -s -m 5 -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8002/status
```

```bash
curl -s -m 5 -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3002/geocode?address=%E6%9D%B1%E4%BA%AC%E9%83%BD%E6%B8%AF%E5%8C%BA'
```

## 確かめ方

| コマンド | 確かめること | 要るもの |
|---|---|---|
| `npm run -s typecheck` | 型 | なし |
| `npx tsx scripts/check-quick.ts` | 評価セットの形、書き出しの出典表示、辞書の色と解釈（1秒ほど） | なし |
| `node .claude/hooks/block-public.mjs --test` | 公開サービスを止める hook の判定 | なし |
| `npx tsx scripts/check-note.ts` | OSM ノートの下書きと止める語 | なし |
| `npx tsx scripts/check-places.ts` | `find_features`、`search_place` | Overpass |
| `npx tsx scripts/check-route.ts` | `geocode_address`、`route` | ABR、Valhalla、Overpass |
| `npx tsx scripts/check-course.ts` | `plan_course`、`check_route`、トンネルのまとめ方 | Valhalla、Overpass |
| `npx tsx scripts/check-pins-export.ts` | `add_pin`、共有のピン、`export_route`、`export_png` | Valhalla。MCP の画像は Playwright と :8787 のサーバがあるときだけ |
| `npx tsx scripts/check-recipe-netlog.ts` | レシピの再実行と外部通信の記録 | Overpass、ABR |
| `npx tsx scripts/check-mcp.ts` | MCP（キーなし・リポジトリの外から起動、23件の一括処理） | Overpass、ABR |
| `npx tsx scripts/check-server.ts` | API、ツール定義、Claude のループ | Overpass、ABR。`.env` にキーがあると本物の Claude を1回呼ぶ |
| `node scripts/check-web.mjs` | 画面の配置と動き（vite :5199 を起動して Playwright で開く） | :8787 のサーバ、Playwright |
| `npx tsx scripts/tag-audit.ts` | 辞書の言葉ごとの件数（東京・関東） | Overpass（26回問い合わせ、1分ほど）。コミット済みの `logs/tag-audit.json` は `foot_crossing` を足す前の12語の結果なので、回し直す |
| `npx tsx scripts/eval.ts` | 評価（50問） | 全部のサービスと `.env` のキー。**お金がかかる**：1回で Claude を138〜141回呼び、約 $0.4、約5分 |

- Overpass は、同じ検索文を別のプロセスから約30秒以内にもう一度送ると `duplicate_query` で断る。アプリのプロセスの中では同じ検索文を120秒覚える。確認のスクリプトを続けて何度も回さない。
- Stop hook（`.claude/hooks/stop-checks.mjs`）は型チェックと `check-quick.ts` を回す。

## 評価

| 回 | いつ（UTC） | コミット | 何のあと | 正答 | (a) | (b) | (c) | (d) | 罠 | AIが座標を作った回数 | 費用 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 11/5 12:19 | 3f32641 | M1（評価セットのコミット直後） | 39/50（78%） | 9/10 | 10/10 | 6/10 | 5/10 | 9/10 | 0 | $0.38 |
| 2 | 11/5 13:44 | 229492d | 評価1回目で落ちた問いを受けた修正（821586f：都の境界、画面の外の検索、読めない住所、Claude に渡す画面の状態にルートの有無）と、6つの機能、レビューの修正のあと。SYSTEM プロンプトは未調整 | 47/50（94%） | 10/10 | 9/10 | 10/10 | 10/10 | 8/10 | 0 | $0.43 |
| 試し | 11/5 13:50 | 2be320c | 2回目で落ちた3問だけ | 3/3 | | 1/1 | | | 2/2 | 0 | $0.04 |
| 3 | 11/5 13:51 | 2be320c | SYSTEM プロンプトに2行（ceafe28 でコミット） | 50/50（100%） | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 0 | $0.42 |

- 評価セットはプロンプトを調整する前にコミットした（cafb4a3）。調整は ceafe28。
- 評価セットは自分たちで作った。100% はこの50問での結果で、ほかの依頼でも同じとは言えない。
- 結果のファイルは `eval/runs/`。評価は3回まで（2026-11-05 にユーザーが決定）。3回を使い切った。
- 「AIが座標を作った回数」は、結果のファイルと `scripts/eval.ts` では `fabrications`（前の呼び名は「捏造」）。中身と限界は `eval/README.md`。
- 言い方（2026-11-06 にユーザーが決定）：設計の決まり「画面の文章は、ツールの入力と結果からテンプレートで作る（Claude の自由な文章は出さない）」と、測った結果「自作の50問で 78%→94%→100%」を分けて言う。画面の文章は評価で測っていない。

## 分かっている限界

- 例2のデモ（品川駅、トンネル2本、高速なし、60分以内）の今の結果：1案目は仙台坂トンネルだけで13.1分、トンネル1本で「合わない」。2案目はふたばトンネル＋仙台坂トンネルで21.2分、「すべて合う」。候補の順は「名前のあるトンネル → 出発地に近い」。絵コンテ（東京港トンネル 31分 → ＋仙台坂トンネル 33分）と違う。この順は 2026-11-06 にユーザーが決定した。絵コンテは撮影前に今のデータで直す。2案目の 21.2分・9.75km は、11/6 の画面の確認（Claude なし、`logs/ops.jsonl` の 01:49Z）でも同じ。1案目の 13.1分 は 11/6 の記録になく [未確認]。
- 住所：ABR に住居番号の点がない住所は、街区の代表点になる（例：港区芝公園4-2-8）。絵コンテの例1は「住居番号の位置」と出しているので、今のデータと違う。
- 地域の判定：境界は約20mで間引いてある。境界のすぐ近くでは判定がずれうる。
- セッションはサーバのメモリだけ。サーバを再起動すると `result:N` などの参照は消える。共有リンクとレシピのファイルは消さない（期限なし）。
- MCP：画面がないので `here:` と `click:N` は使えない。`export_png` は Playwright と :8787 のサーバが要る。
- Overpass と Valhalla のコンテナは 0.0.0.0 で公開している（`docker ps`）。ABR（`abr-abrg_app-1`、`abr-postgres-1`）とアプリは 127.0.0.1 だけ。前の ABR quickstart（コンテナ abrg-quickstart、:3001。絵コンテの build-ex1.js だけが使う）も 0.0.0.0 で公開している。使わないときは `docker stop abrg-quickstart`。[推測] 手元だけにするなら `-p 127.0.0.1:12345:80` のように作り直す。
- Overpass のヘルスチェック（コンテナの `/app/docker-healthcheck.sh`）は、ランダムな node を1つ問い合わせて応答に Overpass があるかを見るだけで、データの古さは見ない（2026-11-05 にコンテナの中で確認）。2日は start_period（48時間）。11/5 の時点で healthy。
- Valhalla の左側通行の判定（`drive_on_right`）は確かめていない [未確認]。
- ABR の出典の文言は、デジタル庁の利用規約の記載例で確かめていない [未確認]（`src/attribution.ts`）。
- 条件の確認の「分からない（データなし）」：絵コンテの「車線数タグのない8区間は「分からない（データなし）」」は今の作りにない（車線数は条件の確認に使わず「詳細」の参考）。11/6 の例2の確認では「分からない（データなし）」なし（missing 0）。
- 使いやすさテスト（家族や友人）はまだ（下の「使いやすさテスト」）。デモ動画の本番の撮影もまだ。

## 11/6 の通し（ブラウザ、本物の Claude）

ヘッドレスのブラウザで、本物の Claude（`claude-sonnet-5-5`）を使い、現在地を品川駅 高輪口にして3回通した。依頼は「今いる場所から、郵便局で書類を出して、手土産を買ってから、港区芝公園4-2-8へ。ルートを共有リンクで」。

- 3回とも同じ結果：操作は 住所 → ルート → 共有リンク。ルートは 現在地 → 泉岳寺駅前郵便局 → 文銭堂 → 東京都港区芝公園4丁目2。7.3分・3.65km、寄り道で +0分、16通りの組み合わせを試した。
- 1回 5〜8秒。外部通信の記録は 自社 18〜20件、`api.anthropic.com` 4件、その他 0件。
- 絵コンテの例1は 7.9分・3.75km なので、撮影前に直す。

## 撮影の前に確かめること

- [ ] Geo Guidelines が「revenue-generating」を定義しているか [未確認]。定義していれば、動画の一言から「境目はあいまいで」を外す。今わかっていることは `docs/research/google-map-changes.md`。
- [ ] Google の利用規約の「保証の否認」の今の文面 [未確認]。ユーザーの論点「無料の Google マップには、続ける約束（SLA）がない」の根拠になる。この一言の文言はまだ決まっていない。
- [ ] 撮影は Mac Studio の localhost で行う。tailnet の URL で開くと、共有リンクの欄に私的なホスト名が出る。
- [ ] 現在地は Chrome DevTools の Sensors で品川駅 高輪口（OSM node/265050703、35.6288086, 139.7379847）にする。字幕「現在地は撮影用に設定（品川駅 高輪口）」を出す。
- [ ] 絵コンテの数字を今のデータに直す。
  - 例1：7.9分・3.75km → 7.3分・3.65km（上の「11/6 の通し」）。
  - 例2 (b)：北品川の範囲（絵コンテの例2の場面）で、踏切は OSM の点 8個 → 3か所（北品川第一踏切、品川第2踏切、品川第1踏切）。絵コンテと同じ。トンネルは 3本（環状六号線、名前なし、山手トンネル）で、絵コンテは 2本。首都高のトンネルも数える（2026-11-06 にユーザーが決定。下の10）ので、動画は3本。
  - 例2 (c)：仙台坂トンネル 13.1分 「合わない」 → ふたばトンネルを足して 21.2分 「すべて合う」。2回目の 21.2分・9.75km は 11/6 の画面の確認（Claude なし、`logs/ops.jsonl` の 01:49Z）でも同じ。1回目の 13.1分 は 11/6 の記録になく [未確認]。車線数は条件の確認に使わず「詳細」の参考。11/6 の確認では「分からない（データなし）」なし（missing 0）。
- [ ] 絵コンテの数字以外も直す：約束の名前（①「あなたの地図を、あなたのマシンに」、③「言葉はAI、答えは地図」）、「Claude が止まっても、業務は止まらない」の札、実際になかった2つの場面（地図タイルの公開サーバを hook が止めた、0件のタグは辞書から外す）、外す場面（OSMノート、MCP、比較表）、3分の割り振り（`docs/plan.md` §7）。
- [ ] README の ① を「あなたの地図を、あなたのマシンに」に直す。確かめるのはこの Mac（Mac Studio）だけでよく、言い方は弱めない（2026-11-06 にユーザーが変更）。確かめた環境は事実として書く。
- [x] 例1のブラウザでの通し3回（11/6 に済み。上の「11/6 の通し」）。
- [ ] 例2と、札・表示の操作の場面の通し。例2 は 11/6 に本物の Claude で回していない。

## 使いやすさテスト（11/7 の午前。2026-11-06 にユーザーが決定）

- 家族か友人2人。1人15〜20分。会社の情報は使わない。
- 渡すのはデモの2つの課題だけ。依頼の文ではなく、目的として伝える。教えない。
- 記録するのは、最初に打った言葉と、つまずいた所。
- 凍結（11/7 22時）までに直すのは、先に進めなくなる問題だけ。

## ユーザーの判断を待っていること

1. `.env` に `NOTE_BLOCK_WORDS`（社名など。カンマ区切り）を足す。社名はリポジトリに入れないので、ユーザーが自分で書く。今は `.env` にない。
2. （済み 2026-11-06）コミットの作者のメールアドレスを GitHub の noreply アドレスに書き換えた（日付はそのまま。ユーザーが決定）。このリポジトリの user.email も同じにした。
3. （済み 2026-11-06）この文書の tailnet のホスト名を `<tailnet-host>` に置き換え、履歴からも消した（ユーザーが決定）。
4. `docs/demo/ward-offices.csv` の9区（千代田、文京、墨田、品川、大田、渋谷、中野、杉並、豊島）の住所は区の公式サイトから取った。手で見直していない。
5. （決定 2026-11-06）リポジトリのライセンスは Apache-2.0、`Copyright 2026 koji117`（ユーザーが決定）。`LICENSE` を置いた（b652c8f）。
6. （決定 2026-11-06）運営への問い合わせ（既存のOSSを部品として使ってよいか）は未回答のまま。追いかけて問い合わせない（ユーザーが決定）。動画に5秒の札「期間中に作ったもの ／ 使ったOSS・公開データ」を入れ、README の表と3つの未確認はそのまま残す。
7. （決定 2026-11-06）例2の候補の順は今の順（名前のあるトンネル → 出発地に近い）にする（ユーザーが決定）。絵コンテの例2の数字は、撮影前に今のデータで直す。
8. （決定 2026-11-06）サブエージェントが変えた Stop hook（`.claude/hooks/stop-checks.mjs` が `scripts/check-quick.ts` も回す）は、このまま使う（ユーザーが決定）。
9. 開発用の hook `.claude/hooks/block-public.mjs` を直そうとした編集は、権限の仕組みが自己変更として止めた。変更は入っていない。
10. （決定 2026-11-06）「トンネル」に首都高（`highway=motorway`）のトンネル（例：山手トンネル）を含める（ユーザーが決定）。辞書は前から含めているので変えていない。北品川の範囲は3本で、絵コンテの2本は撮影前に直す。

### 前からの確認事項

| # | 確認すること | 今の状態 |
|---|---|---|
| 1 | 運営から、既存OSSを使ってよいかの回答 | 未回答。追いかけない（上の6） |
| 2 | 動画の冒頭に入れる数字と、作者の背景をどこまで動画に出すか | 決定：名乗りは「地図の業界に長くいる」だけ（2026-11-04） |
| 3 | 個人の公開リポジトリとして出してよいか（会社の確認） | 済み：大丈夫（2026-11-07 にユーザーが回答） |
| 4 | 社員がOSMノートを投稿してよいという社内方針 | 未回答（アプリは下書きのコピーまで） |
| 5 | GeoJSON や GPX を社外に渡す想定 | 未回答（今は社内確認用の注意を出す） |
| 6 | リポジトリのライセンス | 決定：Apache-2.0（上の5） |
| 7 | Claude API のキーとモデル | キーは `.env` にある。モデルはコードで `claude-sonnet-5-5` |

## 公開前の見直し

リポジトリを公開する前に、勤め先の業種や社内の運用が分かる記述がないかを全ファイルで確かめる。コミットしたものは履歴に残るので、迷うものはコミットする前にユーザーに聞く。

2026-11-07：履歴の全部を調べ、最初のころのコミットに残っていた、社内の運用として読める文と、それが映った古い絵コンテの動画とポスター画像を、履歴から消した（ユーザーが決定。git filter-branch。README などに書いたコミットの番号は、書き換え後の番号に直した）。

## 作り直すときの手順（11/4〜11/5 に実行済み）

データやコンテナを作り直すときだけ使う。`*.osm.pbf`、`ovp/`、`custom_files/`、`*.pmtiles`、`data/` は .gitignore 済み。

### 1. データの取得

```bash
curl -LO https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf
```

```bash
osmium fileinfo -e -g data.timestamp.last kanto-latest.osm.pbf
```

2つ目の時刻を `src/attribution.ts` の `OSM_DATA_AS_OF` に書く（今は 2026-11-03T21:24:04Z）。

### 2. 地物検索（Overpass）

```bash
mkdir -p ovp && osmium cat kanto-latest.osm.pbf -o ovp/kanto.osm.bz2
```

```bash
docker run -d --name overpass -e OVERPASS_MODE=init -e OVERPASS_PLANET_URL=file:///db/kanto.osm.bz2 -e OVERPASS_META=yes -e OVERPASS_USE_AREAS=true -e OVERPASS_STOP_AFTER_INIT=false -v "$PWD/ovp":/db -p 12345:80 wiktorn/overpass-api
```

- `OVERPASS_MODE=init` を必ず付ける（既定の clone だと公開サーバから複製する）。
- ファイル名を `planet.osm.bz2` にしない（起動時に同じ名前へコピーするので、元のファイルを消してしまう）。
- 差分更新のURLは設定しない。

### 3. ルート（Valhalla）

```bash
mkdir -p custom_files && cp kanto-latest.osm.pbf custom_files/
```

```bash
docker run -d --name valhalla -p 8002:8002 -v "$PWD/custom_files":/custom_files ghcr.io/valhalla/valhalla-scripted:latest
```

- 構築中に時刻帯などのデータをネットから取るので、ネットにつながった状態で行う。
- 構築後、`custom_files/valhalla.json` の `service_limits.allow_hard_exclusions` を `true` にして再起動する（今は `true`）。これがないと「高速を使わない」の指定が無視される。

### 4. 地図（Protomaps）

```bash
pmtiles extract https://build.protomaps.com/<日付>.pmtiles tokyo.pmtiles --bbox=138.90,35.48,139.95,35.92 --maxzoom=15
```

- `<日付>` は直近のビルド日（YYYYMMDD）。ビルドは1週間で消えるので、切り出した `tokyo.pmtiles` を保存しておく。時点は `src/attribution.ts` の `MAP_TILES_AS_OF`。
- フォントとアイコン（basemaps-assets）は `data/basemaps-assets-src/` に展開して自前で配信する。

```bash
mkdir -p data && curl -L -o data/basemaps-assets.zip https://github.com/protomaps/basemaps-assets/archive/refs/heads/main.zip
```

```bash
unzip -q data/basemaps-assets.zip -d data/basemaps-assets-src
```

- 展開すると `data/basemaps-assets-src/basemaps-assets-main` ができる。サーバはここから配信する（`src/server/main.ts` の `ASSETS`）。

### 5. 住所（abr-geocoder）

abr-geocoder はリポジトリの**外**に clone する。

```bash
git clone https://github.com/digital-go-jp/abr-geocoder.git ../abr-geocoder
```

```bash
scripts/abr-import.sh ../abr-geocoder
```

- スクリプト（`scripts/abr-import.sh`）は abr-geocoder のディレクトリを引数に取る。`.env` を作り（DB のパスワードを生成し、表示しない）、手元だけで待ち受ける設定にして、`init --pref 13 --category rsdtdsp --pos -y` → `import` → `cache build` → `up -d abrg_app` の順に動かす。11/5 に動かしたときの記録は `../abr-geocoder/kotozute-import.log`。

### 6. 都の境界

```bash
npx tsx scripts/build-tokyo-boundary.ts
```

Overpass の OSM データから `src/services/tokyo-boundary.json` を作る。データを取り直したら作り直す。
