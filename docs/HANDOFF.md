# 引き継ぎ（2026-11-05 の終わりの時点）

表記：**[事実]** コード・コマンドの出力・結果のファイルで確かめた、**[推測]** 調べた範囲での判断、**[未確認]** 確かめていない。印のない文は [事実]。

計画は `docs/plan.md`、MCP は `docs/mcp.md`、評価は `eval/README.md`、デモのデータは `docs/demo/README.md`、絵コンテは `docs/storyboard/README.md`。

## 今の状態：動くもの

ブラウザの画面、日本語の依頼（Claude）、MCP の3つの入口が、同じ操作（`src/ops/registry.ts` の `OPS`、13個）を通る。操作の入力はサーバが zod で検証し、呼び出しは `logs/ops.jsonl` に1行ずつ残る（Git に入れない）。

| 機能 | 中身 | 主なファイル |
|---|---|---|
| (a) 場所・住所 | `geocode_address`（自社の ABR、:3002。精度は `coordinates_level` をそのまま日本語にする）、`search_place`（OSM の名前で検索） | `src/ops/geocode_address.ts`、`src/ops/search_place.ts` |
| (b) 地物の絞り込み | `find_features`。辞書（13語）からプログラムが Overpass の検索文を組み立てる。トンネルはつながった way を1本、50m 未満は数えない | `src/ops/dict.ts`、`src/ops/find_features.ts` |
| (c) ルート | `route`。`here:` などから寄り先（ルートから 300m 以内の候補）を経由して目的地へ。寄り道で増えた時間を出す | `src/ops/route.ts` |
| (c) 試走コース・合否表 | `plan_course`（候補はプログラムが作る。最大5案、ルート計算は最大10回）、`check_route`（way の生のタグを取り直して判定） | `src/ops/plan_course.ts`、`src/ops/check_route.ts` |
| (d) 共有リンク | `make_share_link`。表示中の印・ルート・住所・ピンを `data/shares/` に保存して `/?s=<id>` で開く | `src/ops/share.ts` |
| (d) 画像 | `export_png`。出典とデータ時点を焼き込んだ PNG。画面では画面が作る。MCP では共有リンクの画面を Playwright で開いて作る | `src/ops/export_png.ts` |
| (d) GPX・GeoJSON | `export_route`。中に出典・ODbL 1.0・データ時点を入れ、社内確認用の注意を返す | `src/ops/export_route.ts` |
| (d) ピン | `add_pin`。共有リンクにも入る | `src/ops/add_pin.ts` |
| (e) 地図の表示 | `set_view`（移動・拡大と、印の表示・非表示）。場所は参照だけ | `src/ops/set_view.ts` |
| 辞書にない言葉 | `unknown_words`。依頼文にそのまま書かれた言葉だけ通す | `src/ops/unknown_words.ts` |
| OSM ノートの下書き | `draft_osm_note`。確認方法は画面で本人が選ぶ（「Googleマップで見た」は選べない）。止める語があるとコピーできない。アプリは OSM と通信しない | `src/ops/draft_osm_note.ts`、`src/ops/note_rules.ts` |
| レシピ | 成功した操作の並びを `data/recipes/` に保存し、Claude を使わずに同じ順で再実行する（画面の `/?r=<id>`、`scripts/run-recipe.ts`） | `src/server/recipe.ts` |
| 外部通信の記録 | サーバが出した HTTP の要求を、要求ごとにホスト名で数える（自社のサービス／`api.anthropic.com`／その他の外部）。結果の最後に「外部通信の記録（この操作の間）」として出る | `src/server/netlog.ts` |
| MCP | stdio のサーバ。12個のツール（`draft_osm_note` は画面だけ）。AI を呼ばず、キーも読まない | `src/mcp/server.ts`、`docs/mcp.md` |
| 評価 | 50問（下の「評価」） | `eval/`、`scripts/eval.ts` |

- 画面：左上に検索（日本語の依頼もここ）、その横にカテゴリの札（郵便局・手土産・コンビニ・踏切・トンネル）、結果は左のパネル（幅 440px）、右下に現在地・拡大・縮小のボタンと出典。幅 767px 以下では結果を下部のシートにする。札とボタンは AI を通さない（`POST /api/op/:name`）。
- 日本語の依頼：`claude-sonnet-5-5`（`src/server/claude.ts`）。キーは `.env` の `ANTHROPIC_API_KEY`（中身は表示しない）。画面の文章はツールの結果からテンプレートで作る。
- データ時点：OSM 2026-11-03T21:24:04Z、地図ファイル 2026-11-04T04:00:00Z（`src/attribution.ts`）。
- 対応地域の判定：東京都の行政界（OSM relation 1543125 の outer、本土側だけ、約20mで間引き）。`scripts/build-tokyo-boundary.ts` が `src/services/tokyo-boundary.json` を作る。
- 住所：ABR を住居表示つき・座標つき（`--pos`）で取り込み直した。「港区芝公園4-2-8」は街区の代表点（`rsdtdsp_blk`、「東京都港区芝公園4丁目2」、残り「-8」）になる。ABR にこの街区の住居番号8がないため。点は OSM の東京タワーから 100m 以内。住居番号の位置（`rsdtdsp_rsdt`）まで一致する住所もある（23区の区役所では17件、6件は街区の代表点。`docs/mcp.md`）。

## 動かし方

**1〜3 はリポジトリの直下、ABR だけは `../abr-geocoder` で実行する。**

### 1. Overpass と Valhalla（Docker）

```bash
docker start overpass valhalla
```

- コンテナは作ってある（作り方は下の「作り直すときの手順」）。再起動の設定は `no` なので、Docker を起動し直したら毎回 `docker start` が要る。
- Overpass は :12345、Valhalla は :8002。

### 2. 住所（ABR、:3002）

```bash
cd ../abr-geocoder && docker compose up -d abrg_app
```

- compose のプロジェクトはリポジトリの外の `../abr-geocoder`（既存のコードをリポジトリに入れないため）。`abrg_app` を上げると `postgres` も上がる。DB は 127.0.0.1:55432、API は 127.0.0.1:3002 だけで待ち受ける。
- 取り込み直すときは `../abr-geocoder/kotozute-import.sh`（東京都、住居表示、`--pos`。DB のパスワードはこのスクリプトが作り、表示しない）。
- 前の quickstart（:3001、町字レベル）はアプリでは使っていない。ただし絵コンテのデータを作る `docs/storyboard/data/build-ex1.js` はまだ :3001 を使う。

### 3. アプリのサーバ

```bash
npx vite build
```

```bash
ALLOWED_HOSTS=<tailnet-host> npm run server
```

- サーバは 127.0.0.1:8787 だけで待ち受ける。tailnet からは `https://<tailnet-host>:8453/`（`tailscale serve --https=8453` が 127.0.0.1:8787 へ）。ALLOWED_HOSTS にない Host の API は 403。
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
| `npx tsx scripts/tag-audit.ts` | 辞書の言葉ごとの件数（東京・関東） | Overpass（24回問い合わせ、1分ほど） |
| `npx tsx scripts/eval.ts` | 評価（50問） | 全部のサービスと `.env` のキー。**お金がかかる**：1回で Claude を138〜141回呼び、約 $0.4、約5分 |

- Overpass は、同じ検索文を別のプロセスから約30秒以内にもう一度送ると `duplicate_query` で断る。アプリのプロセスの中では同じ検索文を120秒覚える。確認のスクリプトを続けて何度も回さない。
- Stop hook（`.claude/hooks/stop-checks.mjs`）は型チェックと `check-quick.ts` を回す。

## 評価

| 回 | いつ（UTC） | コミット | 何のあと | 正答 | (a) | (b) | (c) | (d) | 罠 | 捏造 | 費用 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 11/5 12:19 | dba0608 | M1（評価セットのコミット直後） | 39/50（78%） | 9/10 | 10/10 | 6/10 | 5/10 | 9/10 | 0 | $0.38 |
| 2 | 11/5 13:44 | 3b6ff6f | 6つの機能とレビューの修正。プロンプトは未調整 | 47/50（94%） | 10/10 | 9/10 | 10/10 | 10/10 | 8/10 | 0 | $0.43 |
| 試し | 11/5 13:50 | 17b1ba4 | 2回目で落ちた3問だけ | 3/3 | | 1/1 | | | 2/2 | 0 | $0.04 |
| 3 | 11/5 13:51 | 17b1ba4 | SYSTEM プロンプトに2行（b9fd0b9 でコミット） | 50/50（100%） | 10/10 | 10/10 | 10/10 | 10/10 | 10/10 | 0 | $0.42 |

- 評価セットはプロンプトを調整する前にコミットした（00dad40）。調整は b9fd0b9。
- 評価セットは自分たちで作った。100% はこの50問での結果で、ほかの依頼でも同じとは言えない。
- 結果のファイルは `eval/runs/`。評価は3回まで（2026-11-05 にユーザーが決定）。3回を使い切った。

## 分かっている限界

- 例2のデモ（品川駅、トンネル2本、高速なし、60分以内）の今の結果：1案目は仙台坂トンネルだけで13.1分、トンネル1本で不合格。2案目はふたばトンネル＋仙台坂トンネルで21.2分、合格。候補の順は「名前のあるトンネル → 出発地に近い」。絵コンテ（東京港トンネル 31分 → ＋仙台坂トンネル 33分）と違う。この順はユーザーの確認待ち。
- 住所：ABR に住居番号の点がない住所は、街区の代表点になる（例：港区芝公園4-2-8）。絵コンテの例1は「住居番号の位置」と出しているので、今のデータと違う。
- 地域の判定：境界は約20mで間引いてある。境界のすぐ近くでは判定がずれうる。
- セッションはサーバのメモリだけ。サーバを再起動すると `result:N` などの参照は消える。共有リンクとレシピのファイルは消さない（期限なし）。
- MCP：画面がないので `here:` と `click:N` は使えない。`export_png` は Playwright と :8787 のサーバが要る。
- Overpass と Valhalla のコンテナは 0.0.0.0 で公開している（`docker ps`）。ABR とアプリは 127.0.0.1 だけ。[推測] 手元だけにするなら `-p 127.0.0.1:12345:80` のように作り直す。
- Overpass の標準のヘルスチェックは、データが2日より古いと失敗する。11/5 の時点では healthy と出ている。`OVERPASS_HEALTHCHECK` は上書きしていない。11/8 の撮影前に確かめる。
- Valhalla の左側通行の判定（`drive_on_right`）は確かめていない [未確認]。
- ABR の出典の文言は、デジタル庁の利用規約の記載例で確かめていない [未確認]（`src/attribution.ts`）。
- 合否表の「判定不能」の区間数を、今のデータで絵コンテと比べていない [未確認]。
- 使いやすさテスト（家族や友人）はまだ。デモ動画の本番の撮影もまだ。

## ユーザーの判断を待っていること

1. `.env` に `NOTE_BLOCK_WORDS`（社名など。カンマ区切り）を足す。社名はリポジトリに入れないので、ユーザーが自分で書く。今は `.env` にない。
2. コミットの作者のメールアドレスが Mac のホスト名のままになっている（`git log` で見える）。公開するなら、その前に履歴の書き換えが要る。どうするか決める。
3. この文書の「動かし方」に tailnet のホスト名がある。公開する前に残すか消すかを決める。
4. `docs/demo/ward-offices.csv` の9区（千代田、文京、墨田、品川、大田、渋谷、中野、杉並、豊島）の住所は区の公式サイトから取った。手で見直していない。
5. リポジトリのライセンス（LICENSE）は未定。
6. 運営への問い合わせ（既存のOSSを部品として使ってよいか）は未回答。
7. 例2の候補の順（上の「分かっている限界」）。絵コンテに合わせるか、今の順で絵コンテを直すか。
8. サブエージェントが `.claude/hooks/stop-checks.mjs` を変えて、`scripts/check-quick.ts` も回すようにした（79993bd）。ユーザーはまだ確認していない。
9. 開発用の hook `.claude/hooks/block-public.mjs` を直そうとした編集は、権限の仕組みが自己変更として止めた。変更は入っていない。

### 前からの確認事項

| # | 確認すること | 今の状態 |
|---|---|---|
| 1 | 運営から、既存OSSを使ってよいかの回答 | 未回答（上の6） |
| 2 | 動画の冒頭に入れる数字と、作者の背景をどこまで動画に出すか | 未回答 |
| 3 | 個人の公開リポジトリとして出してよいか（会社の確認） | 未回答 |
| 4 | 社員がOSMノートを投稿してよいという社内方針 | 未回答（アプリは下書きのコピーまで） |
| 5 | GeoJSON や GPX を社外に渡す想定 | 未回答（今は社内確認用の注意を出す） |
| 6 | リポジトリのライセンス | 未定（上の5） |
| 7 | Claude API のキーとモデル | キーは `.env` にある。モデルはコードで `claude-sonnet-5-5` |

## 公開前の見直し

リポジトリを公開する前に、勤め先の業種や社内の運用が分かる記述がないかを全ファイルで確かめる。コミットしたものは履歴に残るので、迷うものはコミットする前にユーザーに聞く。上の2と3もこのときに片づける。

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

### 5. 住所（abr-geocoder）

abr-geocoder はリポジトリの**外**に clone する。

```bash
git clone https://github.com/digital-go-jp/abr-geocoder.git ../abr-geocoder
```

```bash
../abr-geocoder/kotozute-import.sh
```

- スクリプトは `.env` を作り（DB のパスワードを生成）、手元だけで待ち受ける設定にして、`init --pref 13 --category rsdtdsp --pos -y` → `import` → `cache build` → `up -d abrg_app` の順に動かす。記録は `../abr-geocoder/kotozute-import.log`。
- スクリプトはリポジトリの外にあり、Git に入っていない。clone し直したら作り直す。

### 6. 都の境界

```bash
npx tsx scripts/build-tokyo-boundary.ts
```

Overpass の OSM データから `src/services/tokyo-boundary.json` を作る。データを取り直したら作り直す。
