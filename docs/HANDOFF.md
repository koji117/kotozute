# 引き継ぎ（2026-11-04 19:30 JST 時点）

クラウドのセッションで、調査・計画・絵コンテ動画まで終えました。ここからローカルで実装を始めます。

## 今の状態

- 計画：`docs/plan.md`
- 似ているサービスの調査：`docs/research/competitors.md`
- 絵コンテ動画：`docs/storyboard/demo-storyboard.mp4`（3分、字幕あり、**音声なし**）
- 手元だけのメモ：`private/`（Git に入れない。計画の見直し結果 `plan-critique.md`、背景調査、調査の生データ、共有ページの元ファイル）。勤め先の事情を含むので公開しない
- リポジトリ：今は非公開で作る想定。公開するかは確認事項3の答えしだい
- コード：まだない

## まだ終わっていないこと

1. 絵コンテ動画のナレーション音声（作業途中で止めた）。手順は `docs/storyboard/README.md`。
2. 運営への問い合わせ：既存OSSを部品として使ってよいか。
3. ユーザーへの確認事項（下の表）。
4. 公開前の見直し：リポジトリを公開する前に、勤め先の業種や社内の運用が分かる記述がないかを全ファイルで確かめる。コミットしたものは履歴に残るので、迷うものはコミットする前にユーザーに聞く。

## ユーザーへの確認事項（未回答）

| # | 確認すること | 答えで変わること |
|---|---|---|
| 1 | 運営から、既存OSSを使ってよいかの回答はあったか | 使えないなら構成を根本から見直す |
| 2 | 動画の冒頭に入れる数字と、作者の背景をどこまで動画に出すか | 冒頭のテロップと評価の比較基準 |
| 3 | 個人の公開リポジトリとして出してよいか（会社の確認） | 公開の可否 |
| 4 | 社員がOSMノートを投稿してよいという社内方針はあるか | ノート機能をどこまで作るか（今は下書きのコピーまで） |
| 5 | GeoJSON や GPX を社外に渡す想定はあるか | 書き出しの既定 |
| 6 | リポジトリのライセンス | README と LICENSE |
| 7 | Claude API のキーの用意と、M0 のツールループに使うモデル | M0 の実装 |

## 今日の手順

各プロジェクトの README を読んだ見直し役が組んだ手順です。まだ誰も実行して確かめていません。共有ページでは11/4 15時までに走らせる予定だったので、すぐに走らせてください。

**1〜4 はすべてリポジトリの直下で実行します**（`*.osm.pbf`、`ovp/`、`custom_files/`、`*.pmtiles`、`data/` は .gitignore 済み）。5 だけリポジトリの外で行います。

### 1. データの取得

```bash
curl -LO https://download.geofabrik.de/asia/japan/kanto-latest.osm.pbf
```

```bash
osmium fileinfo -e -g data.timestamp.last kanto-latest.osm.pbf
```

2つ目で出た時刻を「データ時点」として記録し、画面と書き出しに表示する。

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
- 標準のヘルスチェックは、データが2日より古いと失敗扱いになる。11/8の撮影前に `OVERPASS_HEALTHCHECK` を上書きする。
- 構築後、区のエリアで検索できるかを確かめる（例：世田谷区の踏切の件数が0より大きい）。
- 関東のデータで Docker Desktop のメモリとディスクが足りるかは未確認。割り当てを先に確かめる。

### 3. ルート（Valhalla）

```bash
mkdir -p custom_files && cp kanto-latest.osm.pbf custom_files/
```

```bash
docker run -d --name valhalla -p 8002:8002 -v "$PWD/custom_files":/custom_files ghcr.io/valhalla/valhalla-scripted:latest
```

- 構築中に時刻帯などのデータをネットから取るので、ネットにつながった状態で行う。
- 構築後、`custom_files/valhalla.json` の `service_limits.allow_hard_exclusions` を `true` にして再起動する。これがないと「高速を使わない」の指定が無視される。
- ルートの結果で `drive_on_right` が false（左側通行）になっているかを確かめる。関東だけのデータだと誤判定のおそれがある [推測]。

### 4. 地図（Protomaps）

```bash
pmtiles extract https://build.protomaps.com/<日付>.pmtiles tokyo.pmtiles --bbox=138.90,35.48,139.95,35.92 --maxzoom=15
```

- `<日付>` は直近のビルド日（YYYYMMDD）。Protomaps のビルド一覧で確かめる。1週間で消えるので今日中に保存する。
- フォントとアイコンは basemaps-assets を取得して自前で配信する。

```bash
mkdir -p data && curl -L -o data/basemaps-assets.zip https://github.com/protomaps/basemaps-assets/archive/refs/heads/main.zip
```

- スタイルの指定は `glyphs: "/assets/fonts/{fontstack}/{range}.pbf"`、`sprite: "/assets/sprites/v4/light"`、`layers("protomaps", namedFlavor("light"), {lang: "ja"})`（private/plan-critique.md による。実装時に Protomaps の文書で確かめる）。
- landcover レイヤはスタイルから外す（使う場合は ESA WorldCover（CC BY 4.0）を出典に足す）。

### 5. 住所（abr-geocoder）

abr-geocoder はリポジトリの**外**に clone する（既存のコードをリポジトリに入れないため）。

```bash
git clone https://github.com/digital-go-jp/abr-geocoder.git ../abr-geocoder
```

```bash
cd ../abr-geocoder/quickstart && docker compose up -d
```

- quickstart で使えるのは東京都の町字レベルまで。API は :3001。M0 はこれで足りる。
- 住居番号レベル（11/6まで。11/6夕方までに動かなければ町字レベルのまま進める）は、`../abr-geocoder` で次の順に実行する：`cp .env.example .env`（DB_PASSWORD を設定）→ `docker compose up -d postgres` → `docker compose run --rm abrdb_app init --pref 13 --category rsdtdsp --pos` → `docker compose run --rm abrdb_app import` → `docker compose run --rm abrg_app cache build` → `docker compose up -d abrg_app`（:3000）。
- private/plan-critique.md には `--category all --pos=true` という記載もあって食い違う。実行する前に abrdb/README.ja.md で確かめる。
- 画面の精度表示は応答の `coordinates_level` から作る。
- ABR の出典の文言は、デジタル庁の利用規約ページの記載例で確かめてから決める（案：「出典：デジタル庁『アドレス・ベース・レジストリ』を加工して作成」）。
