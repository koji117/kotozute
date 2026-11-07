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

---

## 追加（2026-11-06。設計書 §16 Mac のアプリ。機能の凍結は 11/8 19:00）

Task 4 のうち、Valhalla と ABR を Docker で動かす部分は Task 4b に置き換える。ABR のデータを作るとき（PostgreSQL）だけ Docker を使う。

### Task 4b: ルートを valhallajs に、住所を Mac 用の abrg に

**Files:**
- Modify: `src/services/valhalla.ts`、`package.json`（`"@valhallajs/valhallajs": "3.7.0"` を dependencies に。版は固定）
- Create: `scripts/setup/valhalla.ts`、`scripts/setup/abr.ts`、`scripts/check-setup-services.ts`

**Interfaces:**
- Produces:
  - `src/services/valhalla.ts`：環境変数 `VALHALLA_MODE=embedded` と `VALHALLA_CONFIG=<valhalla.json のパス>` のとき、HTTP の代わりに `Actor.fromConfigFile` の Actor を使う（最初に使うときに作る）。今の関数の名前・引数・戻り値・エラーの文は変えない。既定は HTTP（今の Docker）。
  - `buildValhalla(o: { pbf: string; dir: string; jobs: number; log: Log }): Promise<void>`：valhallajs の道具（`build_config`、`build_tiles`、tar にする手順）で `<dir>/valhalla_tiles.tar` と `<dir>/valhalla.json` だけを残す。設定は設計書 §8.2 と同じ（`allow_hard_exclusions=true`、admins と timezones なし、`elevation=""`、速度表は OpenStreetMapSpeeds c9c6872、作ったあとタイルのフォルダと速度表を消す）。Docker なし。
  - `buildAbrData(o: { pref: string; dir: string; log: Log }): Promise<void>` → `<dir>/abrg.duckdb`（作るときだけ Docker の PostgreSQL。Task 4 Step 2 のとおり、作業の残りを消す）
  - `buildAbrg(o: { dir: string; log: Log }): Promise<string>` → 手元の Go で `ABR_COMMIT` の `abrg` を Mac（arm64）用に作り、`<dir>/abrg` のパスを返す。上流の作り方の指定（CGO、タグ）を写す。
  - `abrgServe(o: { bin: string; cache: string; port: number }): { cmd: string; args: string[]; env: Record<string,string> }`
- [ ] **Step 1:** 関東の pbf で valhallajs の tar を作る（`~/kotozute-parity/valhalla-js/`）。かかった時間と最大メモリを記録。
- [ ] **Step 2: テスト**：組み込みで `~/kotozute-setup-lab/valhalla/scripts/compare.sh` と同じ26本を引き、`results/cmp-tokyo-prod.txt`（今の Docker 3.9.1）と比べる。違いがあれば一覧にする（時間、距離、通る道）。デモのルート（例1：品川駅 高輪口 → 泉岳寺駅前郵便局 → 文銭堂 → 芝公園4丁目2、例2：品川駅の周回コース）も比べる。`drive_on_right=false`、ハード除外。
- [ ] **Step 3: テスト**：Mac 用の `abrg` で東京の `abrg.duckdb`（`~/kotozute-setup-lab/abr/tokyo-cache/abrg.duckdb` の写し）を 127.0.0.1:18032 で動かし、`~/kotozute-setup-lab/abr/cmp.sh` の18の住所が :3002 と同じ。
- [ ] **Step 4:** `OSM_BACKEND=overpass VALHALLA_MODE=embedded VALHALLA_CONFIG=… npx tsx scripts/check-course.ts` と `check-route.ts`（ABR_URL は Step 3 の abrg）が通るか。数字が今と違えば、その違いを記録する（直さない。ユーザーに伝える）。
- [ ] **Step 5:** コミット

### Task 11: Mac のアプリ（Electron）

**Files:**
- Create: `desktop/main.mjs`、`desktop/preload.mjs`、`desktop/key.html`、`electron-builder.yml`、`scripts/check-desktop.mjs`
- Modify: `package.json`（devDependencies に `"electron": "44.9.3"`、`"electron-builder": "26.18.0"`。scripts に `"app": "electron desktop/main.mjs"`、`"app:dist": "electron-builder --mac dmg --arm64"`）、サーバが書き込む場所（共有リンク、レシピ、操作の記録、書き出し）を環境変数 `KOTOZUTE_DATA_DIR` で変えられるようにする（既定は今の場所）

**Interfaces:**
- Consumes: Task 3 の `OSM_BACKEND`／`OSM_INDEX`、Task 5 の `REGION`（`data/region.json`）、Task 4b の `VALHALLA_MODE`／`VALHALLA_CONFIG` と `abrgServe`。まだ取り込まれていなければ環境変数で渡し、統合のときにつなぐ。
- Produces:
  - main：空いたポートを2つ選ぶ → `abrg serve`（子のプロセス）→ サーバ（`ELECTRON_RUN_AS_NODE=1` の Electron で `src/server/main.ts` を動かす。TypeScript をどう動かすか（tsx を入れる、先に JS にする）は作る人が決める。起動は5秒以内）→ `/` が 200 になるまで待つ → 窓を出す。窓を閉じたら子のプロセスを全部止めて終わる。
  - キー：初めて開いたとき `desktop/key.html`（日本語）でキーを入れてもらう。`safeStorage` で暗号化して userData に保存。「キーなしで使う」も選べる。メニューに「API キーを変える」「終了」。キーは画面・ログに出さない。サーバには環境変数で渡す。
  - アプリの中のデータの置き場所：リポジトリと同じ並び（`tokyo.pmtiles`、`data/region.json`、`data/setup/…`、`data/basemaps-assets-src/…`）を Resources に入れ、サーバの相対パスがそのまま効くようにする（asar は使わない）。書き込む場所は `~/Library/Application Support/kotozute/`。
  - `electron-builder.yml`：appId `jp.kotozute.app`（仮）、productName `ことづて`、mac target dmg arm64、署名なし（`identity: null`）、入れるファイルの一覧（開発用のファイルとテストは入れない、`.env` を絶対に入れない）。
- [ ] **Step 1: テスト（`scripts/check-desktop.mjs`）**：Playwright の `_electron.launch` でアプリを開く（キーなしを選ぶ）→ 地図が出る → 郵便局の札で印が出る → 窓を閉じると子のプロセスが残らない（`ps` で確かめる）。キーの画面の文にキーの値が出ない。
- [ ] **Step 2:** 失敗を確かめる → 作る → 通るのを確かめる（開発中は今の Overpass、Docker の Valhalla と ABR に向けてよい）。
- [ ] **Step 3:** `npm run app:dist` で `.dmg` ができる（データはまだ小さい仮のものでよい）。大きさを記録。`.env` が中にないことを確かめる（`find` で）。
- [ ] **Step 4:** コミット

### Task 12: アプリのデータと通しの確認（私がする）

- [x] 東京のデータ（SQLite の検索データ、valhallajs の tar、`abrg.duckdb`、`abrg`、`tokyo.pmtiles`、フォントとアイコン、`data/region.json`）を作り、アプリに入れて `.dmg` を作る。
- [x] 比べる確認（golden）をアプリと同じ組み合わせ（SQLite、組み込みの Valhalla、Mac の abrg）で回す。
- [ ] `.dmg` を入れるところから試す（この Mac の別の場所、MacBook Air）。
- [ ] README（Mac のアプリの入れ方と開き方、確かめた環境、Apple Silicon だけ、署名なし、使ったOSS）。

## 追加 2（2026-11-07。設計書 §17：データはアプリに入れず、あとから取って作る。機能の凍結は 11/8 19:00）

Task 13〜15 は別々の worktree で同時に進め、私が setup に合わせる。固定の pbf は `~/kotozute-backup/kanto-latest.osm.pbf`（kanto-261103、523821119 バイト）。比べる相手は `data/setup/osm/kanto-261103/osm.db`（osmium で作ったもの）と `~/kotozute-parity/golden-app.json`。

### Task 13: OSM の pbf を TypeScript で読む（osmium をやめる）
- 作る：`scripts/setup/pbf.ts`（依存なし。`node:zlib` と自前の protobuf の読み方。zlib と raw の blob、DenseNodes と Nodes、Way、Relation、ヘッダの osmosis_replication_timestamp、要素の時刻の最大）。
- 直す：`buildOsmIndex(o: { pbf: string; out: string; log: Log })`（osmium の引数をなくす）。表と行と入れる順（点→線→relation、番号順）は今と同じ。`scripts/setup/main.ts` の index の手順から osmium をなくす（境界の手順は osmium のまま。東京は境界を作らない）。
- 確かめる：固定の pbf から作った osm.db と今の osm.db の、すべての表の行が同じ（比べるスクリプト `scripts/check-osm-db.ts`）。時間と最大メモリを測る（目安：3分、2GB）。

### Task 14: ルートのデータを Python なしで作る
- 直す：`buildValhalla(o: { pbf; dir; jobs; log })` は `<dir>/valhalla_tiles/`（フォルダ）と `<dir>/valhalla.json`（tile_dir は `valhalla_tiles`、tile_extract は空）を作る。設定は今の build_config の出力を元にした JSON（Git に入れる）から JS で作る。python3 の確認をなくす。`src/services/valhalla.ts` は tile_extract が空なら tile_dir を確かめる。
- 確かめる：固定の pbf から作り、SQLite と組み込みの Valhalla と手元の abrg で golden を回し、`golden-app.json` との違いが 0/107。時間、最大メモリ、フォルダの大きさを測る。

### Task 15: アプリがデータを取って作る、地図のデータの画面
- 作る：`scripts/setup/app-data-build.ts`（Electron の Node で tsx で動かす。手順：空きの確認 → 関東の pbf（続きから、md5）→ 検索データ → ルート → 地図（最新のビルド、アプリに入れた pmtiles）→ 住所（GitHub Releases、sha256）→ `region.json`。進み具合は1行1つの JSON で stdout に出す）。試すための差し替え：`KOTOZUTE_PBF_URL`、`KOTOZUTE_TILES_FILE`、`KOTOZUTE_ABR_URL`。
- `desktop/data.html` と preload：取るもの・大きさ・通信先の説明、「ダウンロードして作る」、進み具合、止める、エラーの文。メニュー「地図のデータ…」：OSM と地図の時点、「最新にする」。
- `desktop/main.mjs`：データは `<userData>/data/<日時>/`。今のデータは `<userData>/data/current.json`。サーバと abrg に `REGION_FILE` を渡す。更新ができたら切り替えて、サーバと abrg を起こし直し、窓を読み直し、古いものを消す。
- サーバ：画面を返すときに今のデータ時点を渡す（build で埋め込んだ値を上書き）。地図ファイルは絶対パスでも配る。
- `.dmg`：データを入れない。`valhalla_build_tiles` と、固定した版の pmtiles（sha256 を確かめる）とそのライセンスの文を入れる。
- 確かめる：`KOTOZUTE_USER_DATA` を空にして、データの画面 → 作る（差し替えで手元のファイル）→ 地図が出る。止めて続きから。更新で切り替わる。

### Task 16: 合わせて通しで確かめる（私がする）
- 3つを setup に合わせる。check-setup、check-quick、tsc。固定の pbf で通しで作り、golden 0/107。`.dmg` を作り、空の userData から入れて試す。住所の DuckDB を Releases に置くのは、リポジトリを公開するとき（ユーザーの確認のあと）。
- 合わせる順：Task 15 は Task 14 と同じときか、先に入れる。今の `scripts/app-data.mjs` は tile_extract（tar）を探す。Task 14 だけを入れてルートのデータを作り直すと、tar が消えて tile_extract が空になり、`npm run app:dist` の afterPack が止まって `.dmg` が作れない（Task 14 のレビューの指摘）。Task 15 を入れるまで、setup で `--redo=valhalla` や作り直しを回さない。§17 で `.dmg` にデータを入れないので、app-data.mjs に valhalla_tiles/ を写す処理は足さない。
