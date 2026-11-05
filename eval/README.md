# 評価セット

日本語の依頼を Claude に渡し、Claude が選んだ操作とその結果が正しいかを、プログラムで採点する。
**この評価セットは、プロンプト（`src/server/claude.ts` の SYSTEM）とツールの説明を調整する前にコミットする。** git の履歴で順番を示す。

- `set.jsonl`：問題（1行1問）。40問（(a)〜(d) 各10問）＋罠10問。
- `scripts/eval.ts`：採点。結果は `eval/runs/<日時>.json` に保存する。
- 実行：`npx tsx scripts/eval.ts`（自社の Overpass・Valhalla・ABR と `.env` のキーが要る。1回で Claude を約150回呼ぶ）。`--only a01,b03` で一部だけ。

## 問題の分け方

| group | 操作 | 例 |
|---|---|---|
| a | 場所・住所 | 住所、施設の名前、駅 |
| b | 地物の絞り込み | 郵便局、踏切、トンネル、範囲と半径 |
| c | ルート・試走コース | 寄り先つきのルート、高速なし、試走コースの合否 |
| d | 資料用の地図・共有・表示 | 共有リンク、ピン、画像、GPX、表示の切り替え（(e) もここに入れる） |
| trap | 罠 | 東京都の外、島しょ部、存在しない施設、辞書にない言葉、座標の指定、0件 |

## 1問の形

```json
{"id":"a01","group":"a","text":"港区芝公園4-2-8を地図に出して",
 "setup":{"view":{"bbox":[139.715,35.645,139.789,35.691],"zoom":13.5},"here":null,"clicks":[],"ops":[]},
 "expect":{"calls":["geocode_address"],"geocode":{"near":[139.7461,35.6583],"within_m":100}},
 "note":"正解の根拠：OSM の東京タワー（node/9497354785）"}
```

- `setup`：依頼の前の画面の状態。省略したものは既定値。
  - `view`：画面の範囲。既定は `{"bbox":[139.715,35.645,139.789,35.691],"zoom":13.5}`（芝・新橋のあたり）。
  - `here`：現在地 `{"coord":[経度,緯度],"accuracy_m":30}`。既定は `null`（現在地なし）。
  - `clicks`：クリックした点の列。`click:1` から順に番号がつく。
  - `ops`：依頼の前に AI を通さずに行う操作（札を押した、など）。`{"op":"find_features","input":{...}}` の形。
- `expect`：採点の条件。**書いたものはすべて満たして合格**。書いていないものは見ない。
- `note`：正解の根拠（どのデータで確かめたか）。正解の座標は ABR の結果を使わず、OSM の要素など別のデータで決める。

## 採点の条件（expect）

「最後の」は、その操作の成功した呼び出しのうち最後のもの。座標の比較はすべて距離（m）。

| キー | 意味 |
|---|---|
| `calls` | 成功した操作の名前がこの順に現れる（間に別の操作があってもよい） |
| `not_calls` | この操作は成功していない |
| `geocode` | 最後の `geocode_address` の `place.coord` が `near` から `within_m` 以内 |
| `search` | 最後の `search_place` の `items` の先頭5件に、`osm`（例 `"node/123"`）に一致するもの、または `near` から `within_m` 以内のものがある |
| `features` | 成功した `find_features` の入力（言葉ごとに分けて呼んでもよい）：`words` は全部の呼び出しの言葉の和が集合として一致。`area` があれば、どの呼び出しも参照の種類が一致（`"view:"`、`"here:"`、`"result"`、`"abr"`、`"click"`）。`radius_m` があれば、どの呼び出しも一致 |
| `route` | 最後の `route`：`from` と `to` は `"here:"` か `{"near":[..],"within_m":..}`（出力の `from.coord` / `to.coord` と比べる）。`stops` は寄り先の言葉の列（出力の `stops[].chosen.kind` と順番どおりに一致）。`stops_any_order` は順番を問わずに一致。`avoid_highways`、`keep_order` は書いたときだけ入力と比べる |
| `course` | 最後の `plan_course` の入力：`tunnels`、`max_minutes`、`avoid_highways` が一致。`start` は `{"near":..,"within_m":..}` で出力の `start.coord` と比べる |
| `check` | 最後の `check_route` の入力：`tunnels`、`max_minutes`、`avoid_highways` が一致 |
| `view` | `set_view` が成功している（移動と表示の切り替えを分けて呼んでもよい）。`show` の言葉は依頼のあとの地図で表示中、`hide` の言葉は非表示。`target` は、最後に地図を動かした `set_view` の出力 `target.coord` が `{"near":..,"within_m":..}` の内側か、`null` なら地図を動かした `set_view` がない |
| `share` | `true` なら `make_share_link` が成功 |
| `pins` | 成功した `add_pin` の回数がこの数 |
| `export` | `"png"` なら `export_png`、`"gpx"` / `"geojson"` なら `export_route` の入力 `format` が一致して成功 |
| `note_draft` | 最後の `draft_osm_note` の入力 `issue` が一致 |
| `outcome` | 罠の結果。下の表 |

### 罠の結果（outcome）

| 値 | 合格の条件 |
|---|---|
| `"out_of_area"` | どれかの操作が `out_of_area` か `not_found` で失敗するか、検索が0件。そのあと地図を動かす操作（`set_view`、`route`、`plan_course`）が成功していない |
| `"not_found"` | どれかの操作が `not_found` で失敗するか、検索が0件。そのあと地図を動かす操作が成功していない |
| `{"unknown_words":["本屋"]}` | `unknown_words` が成功し、その言葉を含む。辞書の別の言葉に置き換えた `find_features` が成功していない |
| `"no_coords"` | 成功した操作の入力に、座標らしい数字（`\d{2,3}\.\d{3,}`）がない。名前の欄に座標を書いて検索しても不合格 |
| `"zero"` | `find_features` が成功し、どれかの言葉が0件 |

罠でも、Claude がツールを呼ばずに止まったら不合格にする。画面の文章はツールの結果から作るので、ツールを呼ばないと画面に「対応地域の外です」「見つかりません」が出ないため。

## すべての問題で数えるもの

- **捏造**：成功した操作の入力に座標らしい数字（`\d{2,3}\.\d{3,}`）がある、または `unknown_words` に依頼文にない言葉がある。目標0回。
- 時間、Claude を呼んだ回数、止まり方（`stop`）。

## 評価が前提にする操作（まだない操作も含む）

評価はこの名前と入力で採点する。実装はこれに合わせる。

| 操作 | 入力 |
|---|---|
| `search_place` | `{name, area: Ref}` |
| `geocode_address` | `{address}` |
| `find_features` | `{words: Word[], area: Ref, radius_m}` |
| `route` | `{from: Ref, to: Ref, stops: {ref: Ref\|null, word: Word\|null}[], keep_order, avoid_highways}` |
| `plan_course`（例2） | `{start: Ref, tunnels: number\|null, max_minutes: number\|null, avoid_highways: boolean}`。start を出て start に戻る周回コースを、プログラムが候補を作って探す（最大5案、ルート計算は最大10回）。合否表つき |
| `check_route`（例2） | `{tunnels: number\|null, max_minutes: number\|null, avoid_highways: boolean}`。いま地図にあるルートを判定し、合否表を返す |
| `set_view` | `{target: Ref, show: Word[], hide: Word[]}` |
| `add_pin` | `{target: Ref}`。場所にピンを立てる。ピンの名前は結果の名前 |
| `make_share_link` | `{}` |
| `export_png` | `{}`。いまの地図を、出典とデータ時点を焼き込んだ画像にする |
| `export_route` | `{format: "gpx" \| "geojson"}`。社内確認用（ライセンスの注意つき） |
| `draft_osm_note` | `{target: Ref, issue: "turn_restriction" \| "oneway" \| "road_missing" \| "road_closed" \| "name_wrong" \| "poi_closed" \| "poi_missing" \| "other"}`。確認方法は画面で本人が選ぶ（AI は選ばない） |
| `unknown_words` | `{words: string[]}` |
