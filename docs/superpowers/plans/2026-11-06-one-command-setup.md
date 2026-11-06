# 1つのコマンドのセットアップ と 地点の詳細：実装の計画

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `npm run setup -- --region=<地域>` 1つで、軽い構成（SQLite の検索データ、tar だけの Valhalla、DuckDB だけの ABR）を作って動かす。あわせて、地図の地点をクリックすると詳細のカードを出す。

**Architecture:** Overpass への問い合わせを `src/services/osm.ts` の5つの関数にまとめ、中を Overpass と SQLite の2つにする（既定は overpass）。地域の値は `src/region.default.json`（Git に入る、東京）と `data/region.json`（セットアップが書く）から読み、Claude に渡る文はテンプレートで作って東京では1バイトも変えない。セットアップは `scripts/setup/` の手順の部品と、それを順に回す `scripts/setup/main.ts`。

**Tech Stack:** Node 24 以上（`node:sqlite`）、TypeScript（tsx）、Hono、MapLibre、Docker（Valhalla、ABR）、osmium、pmtiles。新しい npm パッケージは入れない。

**Spec:** `docs/superpowers/specs/2026-11-06-one-command-setup-design.md`（2026-11-06 にユーザーが Q1〜Q9 をおすすめのとおりで承認）

## Global Constraints

- 新しい npm パッケージを入れない。SQLite は `node:sqlite`。
- `--region=tokyo`（と Git の中の既定）で、Claude に渡る文（`SYSTEM`、`toolDefs()`、`contextBlock`、ツールの結果のキー）を1バイトも変えない。`scripts/fixtures/claude-text-tokyo.txt` と check-quick で比べる。
- コードの `OSM_BACKEND` の既定は `overpass`。`data/region.json` の `osm_backend` か環境変数 `OSM_BACKEND` で `sqlite` にする。
- 実行時に公開サービスへ通信しない（CLAUDE.md「実行時に絶対に守るルール」）。セットアップの取得先は設計書 §3 の一覧だけ。
- 動いているコンテナ `overpass`、`valhalla`、`abr-abrg_app-1`、`abr-postgres-1`、`abrg-quickstart` を止めない・変えない。本体のフォルダの `tokyo.pmtiles`、`kanto-latest.osm.pbf` は読むだけ（作業フォルダからはシンボリックリンク）。写しは `~/kotozute-backup/`。
- 試しのポートとコンテナ名：アプリ 18787、Valhalla 18002、ABR 18031。コンテナは `kotozute-*`、`127.0.0.1` だけで待ち受け、ラベル `kotozute.region=<id>`。
- `.env` を読まない・表示しない。ログでは KEY、TOKEN、SECRET、PASSWORD を含むキーの値を伏せる。
- 画面とセットアップの文は日本語。コードのコメントは今のコードに合わせて日本語。
- コミットのメッセージは日本語で、最後に `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。push しない。
- Overpass は同じ検索文を約30秒以内に別のプロセスから送ると断る。続けて回さない。`limit` で失敗したら60秒待って1回だけやり直す。
- 比べる確認の結果は `~/kotozute-parity/` に置く（/tmp は消える）。

## Review Focus

1. 検索データ（osm.db）や `data/region.json` がないとき（セットアップ前の clone、別のフォルダから起動した MCP、check-quick、Stop hook）：読み込みで落ちず、最初に使ったときに「検索データがありません。`npm run setup` を回してください」と出す。→ Task 3 のテスト。
2. セットアップをダウンロードや作成の途中で止めて、もう一度回す：続きから回り、壊れたファイルを使わない（`.part`、作ってから rename）。→ Task 6 のテスト。
3. Docker が動いていない、docker.sock の権限がない、ポートが使われている、ディスクが足りない：確認の手順が日本語で理由と直し方を出して止まる。→ Task 6 のテスト。
4. 地点の詳細のタグに悪い値（`<script>` を含む名前、`javascript:` の website）：文字は逃がし、リンクは http と https だけ。→ Task 2 のテスト。
5. 名前の検索に記号（`.*`、`\`、`"`、FTS の記号 `*` `"` `NEAR`）や1〜2文字：Overpass と同じ件数（注入は0件）、SQL はパラメータで渡す。→ Task 3 のテスト。

---

### Task 0: 今の Claude の文を書き出す（作業の前の記録）

**Files:**
- Modify: `src/server/claude.ts`（`SYSTEM` と `contextBlock` に `export` を付けるだけ。文は変えない）
- Create: `scripts/claude-text.ts`、`scripts/fixtures/claude-text-tokyo.txt`
- Modify: `scripts/check-quick.ts`

**Interfaces:**
- Produces: `renderClaudeText(): string`（`scripts/claude-text.ts`。`SYSTEM`、`JSON.stringify(toolDefs())`、`contextBlock` に画面の範囲あり／なしのセッションを渡した2つの結果を、見出し行で区切ってつなぐ）

- [ ] **Step 1:** `npx tsx scripts/claude-text.ts > scripts/fixtures/claude-text-tokyo.txt`（今のコードで1回だけ）
- [ ] **Step 2:** check-quick に追加：`assert.equal(renderClaudeText(), readFileSync('scripts/fixtures/claude-text-tokyo.txt','utf8'))`。違えば最初に違う行を出す。
- [ ] **Step 3:** `npx tsc --noEmit -p . && npx tsx scripts/check-quick.ts` → `check-quick: ok`
- [ ] **Step 4:** コミット（本体のフォルダ。`export` は動いているサーバの動きを変えない）

### Task 1: 比べる確認（golden）

**Files:**
- Create: `scripts/golden.ts`

**Interfaces:**
- Consumes: `src/ops/registry.ts` の操作の実行、`src/server/recipe.ts` の `runRecipe`、`eval/set.jsonl`、`eval/runs/2026-11-05T13-51-03-359Z.json`
- Produces: `npx tsx scripts/golden.ts --out <file>` → `{ coverage: Record<op, {ok:number, fail:number}>, cases: Record<caseId, StepRecord[]> }`。`StepRecord = { op, input, ok, output | error, llm }`、キーは並べ替え、時刻・所要時間・netlog・共有リンクの ID・書き出しのファイル名は `<id>` などに置き換える。

- [ ] **Step 1:** 対象：`data/recipes/*.json`（全部）、評価の第3回の50問（各問の新しいセッションに `setup.view ?? DEFAULT_VIEW`、`here`、`clicks` を入れ、`setup.ops` を先に回してから、第3回で Claude が呼んだ操作を同じ順に回す）、デモの場面（例1：here=品川駅 高輪口 node/265050703 の座標、geocode 港区芝公園4-2-8、route の寄り先 post_office と souvenir、keep_order true。例2：品川駅から plan_course トンネル2本・高速なし・60分）。1つのプロセスで順に回す。
- [ ] **Step 2:** 失敗にする条件：第3回で成功した操作が失敗した、どこかの操作が `limit` で失敗した。終わりに op ごとの成功と失敗の数を出す。`OPLOG_FILE` は一時ファイルにする。
- [ ] **Step 3:** 今の作り（Overpass :12345、Valhalla :8002、ABR :3002）で `npx tsx scripts/golden.ts --out ~/kotozute-parity/golden-old.json` を1回。成功の数を記録する。例2 の1回目 13.1分（合わない）→ 2回目 21.2分（すべて合う）が入っていることを確かめる。
- [ ] **Step 4:** 同じものをもう1回（60秒あけて）回し、2つの結果が同じ（`diff` が空）ことを確かめる（置き換えが足りているか）。
- [ ] **Step 5:** コミット

### Task 2: 地点の詳細（本体のフォルダに入れる）

**Files:**
- Create: `src/poi.ts`（`DETAIL_KEYS`、`pickDetails`）、`src/web/poi-card.ts`（カードの HTML、ベースマップの種類の日本語名）
- Modify: `src/services/overpass.ts`（`elementTags`）、`src/server/main.ts`（`GET /api/poi/:type/:id`）、`src/web/main.ts`（クリック）、`src/web/style.css`、`scripts/check-web.mjs`、`scripts/check-quick.ts`

**Interfaces:**
- Produces:
  - `DETAIL_KEYS: readonly string[]` = `name`、`name:ja`、`addr:postcode`、`addr:province`、`addr:city`、`addr:quarter`、`addr:neighbourhood`、`addr:block_number`、`addr:housenumber`、`addr:full`、`opening_hours`、`phone`、`contact:phone`、`website`、`contact:website`、`wheelchair`、`operator`、`brand`、`brand:ja`
  - `pickDetails(tags: Record<string,string>): Record<string,string>`（DETAIL_KEYS だけ残す）
  - `elementTags(osm: string /* 'node/123' */): Promise<Record<string,string> | null>`（Overpass：`node(123);out tags;` の形。見つからなければ null）。Task 3 が同じ名前を `osm.ts` に移す。
  - `GET /api/poi/:type/:id` → `{ osm: string, tags: Record<string,string> /* pickDetails 済み */, osm_as_of: string }`。type は node|way|relation、id は1〜12桁の数字。それ以外は 400、見つからなければ 404。
  - `poiCard(p: { name: string|null; kindLabel: string|null; tags?: Record<string,string>; osm?: string; asOf?: string }): string`
  - `BASEMAP_KIND_JA: Record<string,string>`（Protomaps の `pois` の `kind` のよくあるもの → 日本語名）

- [ ] **Step 1: テスト（check-quick、ネットなし）**：`pickDetails({name:'a', description:'x', note:'y', fixme:'z', website:'https://e'})` が `{name:'a', website:'https://e'}`。`poiCard({name:'<script>x</script>', tags:{website:'javascript:alert(1)'}})` に `<script>` も `javascript:` の href もない。`poiCard({name:'郵便局', tags:{website:'https://example.jp'}})` に `href="https://example.jp"` と `rel="noopener noreferrer"`。
- [ ] **Step 2:** 失敗を確かめる → 実装 → 通るのを確かめる。
- [ ] **Step 3: クリック**：今のクリック（`click:N` を作る）はそのまま。加えて `map.queryRenderedFeatures(e.point)` で、先に自分の印（`feat-c`、`marks-c`。GeoJSON の properties に `osm` と辞書の `label` を入れる）、なければベースマップの `pois` の地点を探す。自分の印は `/api/poi` を呼んでカードに詳細を出す。ベースマップの地点は名前と `BASEMAP_KIND_JA[kind]` だけ（一覧にない種類は名前だけ。OSM の要素は探さない）。カードは `maplibregl.Popup`。カードの文：OSM の ID へのリンク（`https://www.openstreetmap.org/<type>/<id>`）、データ時点、「OSM上の情報（現地と違うことがある）」。営業時間は OSM に書かれたまま。
- [ ] **Step 4: 共有リンクの画面**：同じカードを出す。`click:N` は作らない。
- [ ] **Step 5: check-web に追加**：例1の札で出た郵便局の印をクリック → カードに名前と「OSM上の情報」がある。ベースマップの地点をクリック → カードに名前がある（地点が見つかる座標を探して使う）。スマホの幅でカードが画面に収まる。
- [ ] **Step 6:** `npx tsc --noEmit -p . && npx tsx scripts/check-quick.ts && node scripts/check-web.mjs` → 全部 ok
- [ ] **Step 7:** コミット（作業フォルダで。本体への取り込みは私がする）

### Task 3: 検索データ（osm.ts と SQLite）

**Files:**
- Create: `src/services/osm.ts`、`src/services/osm-sqlite.ts`、`scripts/setup/osm-index.ts`、`scripts/setup/tools.ts`、`scripts/check-osm.ts`
- Modify: `src/ops/find_features.ts`、`src/ops/search_place.ts`、`src/ops/route.ts`、`src/ops/plan_course.ts`、`src/ops/check_route.ts`、`src/services/overpass.ts`、`src/server/main.ts`（`/api/poi` を `osm.elementTags` に）、`src/web/panel.ts`（Q3 の言葉は Task 7 で入れる。ここでは触らない）

**Interfaces:**
- Consumes: Task 2 の `elementTags`、`DETAIL_KEYS`。Task 5 の `REGION.osm_index`、`REGION.osm_backend`（Task 5 がまだなら、環境変数 `OSM_INDEX` と `OSM_BACKEND` を読む小さな関数を `osm.ts` に置き、統合のときに Task 5 の値に替える）
- Produces（`src/services/osm.ts`）:
  - `features(word: DictKey, area: Area, geom?: boolean): Promise<{ elements: OsmElement[] }>`
  - `names(name: string, bbox: BBox, exact: boolean): Promise<{ elements: OsmElement[] }>`
  - `wayTags(ids: number[]): Promise<Map<number, Record<string,string>>>`
  - `courseTunnels(start: LngLat, radiusM: number, roads: string): Promise<{ elements: OsmElement[] }>`
  - `elementTags(osm: string): Promise<Record<string,string> | null>`
  - 範囲の上限（`areaClause` の 400km²、半径 3000m）はどちらの中身でも先に確かめる。
  - Overpass の中身は、今の QL の文字列をそのまま作る（呼ぶ側から移すだけ）。
- Produces（`scripts/setup/osm-index.ts`）: `buildOsmIndex(o: { pbf: string; out: string; osmium: Osmium; log: Log }): Promise<{ rows: Record<string,number>; bytes: number }>`。`out` は `out + '.tmp'` に作ってから rename。
- Produces（`scripts/setup/tools.ts`）: `type Log = (msg: string) => void`、`type Osmium = (args: string[]) => ChildProcess`（`osmiumFor(mode: 'host'|'container', dataDir: string): Osmium`。コンテナでは `dataDir` を `/data` に載せ、パスは `dataDir` からの相対で渡す）

- [ ] **Step 1:** 元にするもの：`~/kotozute-setup-lab/overpass-sqlite/build-slim.mjs`（作る）、`query.mjs`（答える）。どちらも Overpass と4つの問い合わせで一致した [事実]。TypeScript に移す。辞書の条件は `DICT` の `queries` を読んで解く（`=`、`~`、`!~`、`,i`）。距離は 1e7/90 m/度。結果の順は（種類、ID）で 201件まで。試走コースの道路の条件は上限より先。地点の詳細のために、辞書の地物と名前のある要素は `DETAIL_KEYS` のタグも持つ。データ時点 `data.timestamp.last` を meta に入れる。
- [ ] **Step 2: テスト（`scripts/check-osm.ts`、関東の pbf から作った osm.db を使う）**：品川駅の周り 500m の郵便局、芝公園の 2km 四方の手土産、20km² の中の「品川駅」、品川駅の 6km のトンネル（形つき）、例1の回廊 300m、ランダムな道 200本のタグ。それぞれ `~/kotozute-setup-lab/overpass-sqlite/op-*.json`（Overpass の答え）と要素・順・座標が一致。名前に `.*`、`a\\`、`"`、`*`、`NEAR` → 0件で、例外なし。1文字・2文字の名前も Overpass と同じ件数。osm.db がないとき `features` は `OpError('service', '検索データがありません。npm run setup を回してください')`。`import` しただけではファイルを開かない。
- [ ] **Step 3:** 呼ぶ側の5か所を `osm.*` に替える。toPlace、トンネルと踏切のまとめ、範囲の判定、並べ替えは変えない。`check_route` の `wayTags` は `osm.wayTags` に。
- [ ] **Step 4:** `OSM_BACKEND=overpass` で `npx tsx scripts/check-places.ts`、`check-course.ts` が今と同じに通る（Overpass の中身が文字列を変えていないこと）。
- [ ] **Step 5:** `OSM_BACKEND=sqlite OSM_INDEX=<osm.db>` で同じ確認が通る。`node --disable-warning=ExperimentalWarning` で警告を消す。
- [ ] **Step 6:** コミット

### Task 4: Valhalla と ABR の手順

**Files:**
- Create: `scripts/setup/valhalla.ts`、`scripts/setup/abr.ts`、`scripts/check-setup-services.ts`

**Interfaces:**
- Consumes: Task 3 の `Log`
- Produces:
  - `VALHALLA_IMAGE = 'ghcr.io/valhalla/valhalla-scripted@sha256:e2078b63…'`（今のイメージの digest を `docker image inspect` で確かめて全部書く）
  - `buildValhalla(o: { pbf: string; dir: string; jobs: number; log: Log }): Promise<void>` → `<dir>/valhalla_tiles.tar` と `<dir>/valhalla.json` だけを残す
  - `valhallaRun(o: { dir: string; port: number; name: string; region: string }): string[]`（`docker run` の引数。`--entrypoint valhalla_service`、`-v <dir>:/data:ro`、`/data/valhalla.json 2`、再起動の設定なし）
  - `buildAbr(o: { pref: string /* '13' | 'all' | 都道府県コード */; dir: string; log: Log }): Promise<void>` → `<dir>/abrg.duckdb`
  - `abrRun(o: { dir: string; port: number; name: string; region: string }): string[]`（`abrg serve`、キャッシュは読み取り専用、メモリの上限なし）
  - `ABR_COMMIT = '8215e09…'`（今の `../abr-geocoder` の HEAD を確かめて全部書く）

- [ ] **Step 1: Valhalla**：元は `~/kotozute-setup-lab/valhalla/scripts/build.sh`。`valhalla_build_config`（tile extract と tile dir、`service_limits.allow_hard_exclusions=true`、concurrency=jobs、admin と timezone は無いパス、`additional_data.elevation=""`、`mjolnir.default_speeds_config` は OpenStreetMapSpeeds の commit c9c6872 の `default_speeds.json`（sha256 を確かめる））→ `valhalla_build_tiles -j <jobs>`（落ちたら1回だけやり直す）→ `valhalla_build_extract` → タイルのフォルダ、速度表を消す。pbf は読み取り専用で載せ、写さない。タイルはコンテナの中の作業場所に作り、tar だけを `dir` に書く。Linux では `--user $(id -u):$(id -g)`。
- [ ] **Step 2: ABR**：`ABR_COMMIT` の abr-geocoder を codeload から `data/setup/abr-src/` に取る（`../abr-geocoder` は使わない・変えない）。PostgreSQL は自分の docker network の中だけ（ポートを外に出さない）。`abr-import.sh` と同じ順（`init --pref <pref> --category rsdtdsp --pos -y` → `import` → `cache build`、`ABRG_CACHE_MEMORY_LIMIT=1GB`）。DB の合言葉は `crypto.randomBytes` で作り、表示しない。終わったら `abrg.duckdb` だけ残し、PostgreSQL のコンテナ、volume、network、作業のイメージ、作ったときのキャッシュ（専用の buildx builder を作って最後に消す、か Go のコンテナで作って module の volume を消す）を消す。残るのは `abrg` の実行用のイメージ1つ。動いている ABR（`abr-*`）のイメージとコンテナには触らない。
- [ ] **Step 3: テスト**（`scripts/check-setup-services.ts`）：関東の pbf で作った tar を `kotozute-valhalla` で 18002 に起こし、`~/kotozute-setup-lab/valhalla/scripts/compare.sh` の26本が `results/cmp-tokyo-prod.txt` と同じ。`trace_attributes` の `drive_on_right` が false。高速のハード除外が効く。東京で作った `abrg.duckdb` を `kotozute-abr` で 18031 に起こし、`~/kotozute-setup-lab/abr/cmp.sh` の18の住所が :3002 と同じ（港区芝公園4-2-8 は `rsdtdsp_blk`）。作ったあとの `docker system df` で、ABR の作業の残りがないこと。
- [ ] **Step 4:** 作るときの最大メモリを記録する（cgroup の値）。
- [ ] **Step 5:** コミット

### Task 5: 地域の設定と Claude に渡る文

**Files:**
- Create: `src/region.default.json`、`src/region.ts`、`src/region-text.ts`
- Modify: `src/services/region.ts`、`src/attribution.ts`、`src/server/claude.ts`、`src/server/session.ts`、`src/server/main.ts`、`src/ops/search_place.ts`、`src/ops/geocode_address.ts`、`src/ops/route.ts`、`src/ops/plan_course.ts`、`src/web/main.ts`、`src/web/panel.ts`、`src/web/index.html`、`vite.config.ts`、`scripts/check-quick.ts`

**Interfaces:**
- Produces:
  - `interface RegionConfig { id: string; label: string; name: string; prefs: { code: number; name: string }[]; bbox: BBox; view: { center: LngLat; zoom: number }; boundary: string; tiles: string; osm_index: string; osm_backend?: 'overpass'|'sqlite'; osm_as_of: string; tiles_as_of: string }`（パスはリポジトリの根からの相対）
  - `REGION: RegionConfig`（`src/region.ts`。`data/region.json` があればそれ、なければ `src/region.default.json`。パスは `import.meta.url` から解く）
  - `src/region-text.ts`：Claude に渡る地域の文を作る関数（設計書 §8.5 と code-inventory の一覧：claude.ts の SYSTEM と contextBlock、search_place の説明・エラー・`widened_to_${id}` のキー、geocode_address の説明とエラー、route と plan_course のエラー、session の「画面の範囲」の名前）。画面の文（panel.ts の2か所、server の 400 の文、index.html の札）も同じファイルから。
  - 境界のファイルは `{ rings }`（1つのまとまり）か `{ groups: rings[] }`。判定は「どれかのまとまりの中（まとまりの中は偶奇規則）」。
  - `src/region.default.json` は今の値：id `tokyo`、label `東京都（島しょ部を除く）`、name `東京都`、prefs `[{code:13,name:'東京都'}]`、bbox `[138.9,35.48,139.95,35.92]`、view（今の `src/web/main.ts` の最初の表示）、boundary `src/services/tokyo-boundary.json`、tiles `tokyo.pmtiles`、osm_index `data/setup/osm/kanto-261103/osm.db`、osm_as_of `2026-11-03T21:24:04Z`、tiles_as_of `2026-11-04T04:00:00Z`、osm_backend なし（＝overpass）
- Consumes: Task 0 の `scripts/fixtures/claude-text-tokyo.txt`

- [ ] **Step 1: テスト**：check-quick の Claude の文の比べるが、テンプレートにしたあとも通る。加えて、`REGION` を大阪府の設定（label `大阪府`、prefs `[{code:27,name:'大阪府'}]`）にして `renderClaudeText()` を作ると、「東京都」が例の文（港区芝公園4-2-8、品川駅、東京タワー）以外に出てこない。
- [ ] **Step 2:** `geocode_address` の他の県の住所を断る正規表現は、`REGION.prefs` にない県だけを断る（東京では今と同じ入力を断る）。
- [ ] **Step 3:** 画面：地図の範囲、最初の表示、タイルの URL（`/tiles/<REGION.tiles>`）、右下の札の名前、データ時点を `REGION` から。Vite は build のときに `REGION` を入れる（`define` か alias）。サーバのタイルの道筋も `REGION.tiles`。
- [ ] **Step 4:** `npx tsc --noEmit -p . && npx tsx scripts/check-quick.ts` → ok。`npx vite build` が通る。`node scripts/check-web.mjs` が全部 ok（今の作りに向けて）。
- [ ] **Step 5:** コミット

### Task 6: セットアップのコマンド

**Files:**
- Create: `scripts/setup.mjs`（入口。`node_modules` がなければ `npm ci`、それから `node --import tsx scripts/setup/main.ts`）、`scripts/setup/main.ts`、`scripts/setup/prereq.ts`、`scripts/setup/download.ts`、`scripts/setup/boundary.ts`、`scripts/setup/tiles.ts`、`scripts/setup/steps.ts`（印、ロック、ログ）、`scripts/setup/regions.json`、`scripts/start.mjs`、`.nvmrc`、`scripts/check-setup.ts`
- Modify: `package.json`（`"setup": "node scripts/setup.mjs"`、`"start": "node scripts/start.mjs"`、`"engines": { "node": ">=24" }`）

**Interfaces:**
- Consumes: Task 3 `buildOsmIndex`、`osmiumFor`、`Log`。Task 4 `buildValhalla`、`valhallaRun`、`buildAbr`、`abrRun`。Task 5 `RegionConfig`。
- Produces:
  - 引数：`--region`（必須）、`--pbf`、`--tiles-file`、`--keep-pbf`、`--maxzoom=14|15`、`--islands=main|all`、`--jobs`（既定2）、`--dry-run`、`--port-app`（8787）、`--port-valhalla`（8002）、`--port-abr`（3002）、`--osmium=auto|host|container`、`--redo=<手順>`
  - 出力：`data/region.json`（`RegionConfig`。セットアップは `osm_backend: 'sqlite'` を書く）、`data/setup/…`（設計書 §7）、`data/setup/logs/setup-<時刻>.log`

- [ ] **Step 1: 元にするもの**：`~/kotozute-setup-lab/fresh-laptop/prereq.mjs`、`download.mjs`、`~/kotozute-setup-lab/region/boundary.mjs`、`regions.json`、`~/kotozute-setup-lab/tiles/poly2geojson.mjs`。
- [ ] **Step 2: テスト（`scripts/check-setup.ts`、ネットと Docker なし）**：引数の解釈（知らない地域 → 日本語のエラーと地域の一覧）。地域の解決：`tokyo` → データ kanto（`kanto-261103.osm.pbf`）・pref 13・今の bbox と境界。`osaka` → データ kansai・pref 27・islands main。`kanto` → pref all・7県。`japan` → pref all・islands all。印：入力が同じなら手順を飛ばし、違えばやり直す。ダウンロード：途中の `.part` から続ける（小さいローカルの HTTP サーバで、途中で切って確かめる）。md5 が違えば捨てる。確認の手順：Docker なし、docker.sock の権限なし、ポートが使用中、ディスク不足のそれぞれで、日本語の理由と直し方。
- [ ] **Step 3:** 手順（設計書 §7 の 0〜14）を順に回す。重い手順は1つずつ。固定の pbf が 404 なら最新を使い、注意を出す。`--tiles-file` と行き先が同じファイルなら何もしない（消さない・上書きしない）。osmium と pmtiles は手元にあればそれ、なければコンテナと GitHub のリリース（版と sha256 を固定）。最新のタイルのビルドは HEAD で今日から8日前まで探し、版が「4.」か確かめる。フォントとアイコンは減らさない。地域の設定は `data/region.json` に書き、`npx vite build`。
- [ ] **Step 4:** `scripts/start.mjs`：`docker start kotozute-valhalla kotozute-abr`（失敗したら「Docker を起動してください」）→ サーバを起動（`node --disable-warning=ExperimentalWarning --import tsx src/server/main.ts`）。
- [ ] **Step 5:** `npm run setup -- --region=tokyo --dry-run`、`--region=kagawa --dry-run`、`--region=kanto --dry-run`、`--region=japan --dry-run` が、要るディスク・メモリ・ダウンロードを出して止まる。
- [ ] **Step 6:** コミット

### Task 7: 統合と言葉（私がする）

- [ ] 作業フォルダのブランチ `setup` に Task 3〜6 を順に取り込む。Task 2 は本体の `main` に取り込み、`setup` にも入れる。
- [ ] Q3 の言葉（panel.ts の札の説明、Overpass のエラーの文）を `osm_backend` が sqlite のときだけ変える（東京の既定の画面は変えない）。
- [ ] `check-quick`、型、`check-web` が通る。

### Task 8: 東京を最初から回して比べる（私がする）

- [ ] 作業フォルダで `npm run setup -- --region=tokyo --pbf=<本体の pbf> --tiles-file=<本体の tokyo.pmtiles> --port-app=18787 --port-valhalla=18002 --port-abr=18031`
- [ ] `git status --porcelain` が空。
- [ ] `OSM_BACKEND=sqlite VALHALLA_URL=http://127.0.0.1:18002 ABR_URL=http://127.0.0.1:18031 npx tsx scripts/golden.ts --out ~/kotozute-parity/golden-new.json` → `golden-old.json` との `diff` が空。
- [ ] 同じ環境で check-places、check-route、check-course、check-server、check-mcp、check-recipe-netlog（自社の数だけ変わってよい）、check-pins-export、`WEB_BASE=http://localhost:18787 node scripts/check-web.mjs`。画面の写しは `~/kotozute-parity/shots-new/` に写す。
- [ ] 11/6 22:00 の確認（設計書 §12）。

### Task 9: 軽さを測る（私がする。使いやすさテストの時間を避ける）

- [ ] Docker のメモリを絞って東京を最初から（作るコンテナに `--memory 4g --memory-swap 4g`）。最大メモリを記録。
- [ ] 香川県を手元の osmium なし（`--osmium=container`）で。境界、1県の住所、osmium 1.15 の結果。
- [ ] 日本全国の住居表示の取り込みを1回（時間、ディスク、メモリ）。重すぎれば Q5 (b)。
- [ ] MacBook Air で東京（Air に Docker と Node があれば）。

### Task 10: 確認と切り替えと文書（私がする）

- [ ] 11/7 16:00 の確認（設計書 §10）。通れば Q2 (a)：元に戻す手順を先に試してから、この Mac を新しい作りにする。
- [ ] README（入れ方、確かめた環境、Linux は試していない、Docker Desktop の契約の注意、使ったOSSの表）、①の言い方（ノートPCで確かめたら）、HANDOFF の作り直しの手順、CLAUDE.md（決定事項 Q1〜Q9、構成、取得先の一覧）、Skill kotozute-dictionary（辞書を変えたら `--redo=index`、pbf が要る）。
