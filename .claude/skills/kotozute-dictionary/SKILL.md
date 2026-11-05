---
name: kotozute-dictionary
description: ことづての「業務の言葉と OSM タグの辞書」（src/ops/dict.ts）に言葉を足す、直す、消すときの手順と決まり。郵便局・踏切・トンネルのような言葉の追加、OSM タグの条件（含めるタグ・除くタグ）の変更、画面の解釈の文、札（CHIPS）、印の色（COLOR）を変えるときに使う。
---

# 業務の言葉と OSM タグの辞書

辞書は `src/ops/dict.ts` の `DICT` の1か所だけにあります。次のすべてが同じ定義を使います。

| 使う場所 | 使うもの |
|---|---|
| 地物の検索（`src/services/overpass.ts` の `featureParts`） | `queries` |
| Claude のツールの選択肢（`src/ops/types.ts` の `Word`）とシステムプロンプトの言葉の一覧（`src/server/claude.ts`） | キー、`label`、`aliases` |
| 画面の札・結果パネル（`src/web/main.ts`、`src/web/panel.ts`） | `label`、`interpretation`、`CHIPS` |
| 評価の採点（`scripts/eval.ts`：辞書にない言葉を別の言葉に言い換えたかの判定） | `label`、`aliases` |
| 件数の監査（`scripts/tag-audit.ts`） | `queries` |

## 決まり（必ず守る）

- **Overpass QL を LLM に書かせない。** LLM が選べるのは辞書のキーだけです。検索文はプログラムが `queries` と範囲から組み立てます。`filter` に範囲（`(around:…)` や bbox）や `out` を書かないでください。
- **解釈は毎回画面に出す。** `interpretation` は「どう受け取ったか」を利用者に見せる文です。空にしないでください。
- **0件は正直に出す。** 画面は「OSM上で0件（現地にないとは限らない）」と出します。0件を避けるために、意味の違うタグを足して件数を増やさないでください。
- **自由文のタグは使わない。** `description`、`note`、`fixme` などは条件にも結果にも使いません（LLM に渡さない）。
- **辞書にない言葉は、辞書にないまま。** 依頼に辞書にない言葉（例：本屋、駐輪場）があれば `unknown_words` で「辞書にない」と出します。近い言葉に言い換える辞書の作り方（例：駐車場の `aliases` に「駐輪場」を入れる）はしません。
- **決まっていないことは、ユーザーに聞く。** どの店を含めるか（例：手土産に和菓子と洋菓子だけか）は業務の判断です。勝手に決めないでください。

## 言葉を足す手順

1. **キー**：英小文字と `_`（例：`level_crossing`）。一度 `eval/set.jsonl` で使ったキーは変えないでください（評価が採点できなくなります）。
2. **`label`**：札とツールの選択肢に出す日本語の名前。短く、地図に詳しくない人の言葉で。
3. **`aliases`**：依頼文でこう言われたらこの言葉とみなす言い方。依頼文に**そのまま出てくる形**で書きます（評価は依頼文に `label` か `aliases` のどれかが含まれるかで言い換えを判定します）。
4. **`queries`**：`{ elements, filter }` の列。複数あれば OR です。
   - `elements`：`node`（点だけのもの。例：踏切）、`way`（線。例：トンネル）、`nwr`（点でも面でも描かれるもの。店や施設はふつうこれ）。
   - `filter`：Overpass のタグの条件だけを書きます。
     - 含める：`["amenity"="post_office"]`、値を複数：`["shop"~"^(confectionery|pastry)$"]`（正規表現は `^…$` で囲む）
     - 除く：`["operator"!~"ヤマト|佐川",i]`（`,i` は大文字・小文字を区別しない）、タグがないもの：`[!"access"]`
   - 例：郵便局は宅配便の営業所にも `amenity=post_office` が付いているので、`operator`・`brand`・`name` で除いています。トンネルは車の通る道路だけにして、建物の通り抜けと暗渠を除いています。
5. **`interpretation`**：`<label>＝<タグ>（<含まないもの>）` の形で書きます。例：`踏切＝railway=level_crossing（歩行者専用の railway=crossing は含まない）`。
6. **印の色**：`src/web/panel.ts` の `COLOR` に足します（必須。`#RRGGBB`）。色は案E の色（`docs/storyboard/design/option-e.html` の `:root`）から選びます。
7. **札にするなら**：`src/ops/dict.ts` の `CHIPS` に足し、`src/web/panel.ts` の `CHIP_ICON` に 16×16 の線画のアイコンを足します（自前で描く。他社の地図アプリのアイコンはまねない）。札は横に並ぶので、増やす前にユーザーに聞いてください。

言葉を直す・消すときも同じ場所を直します。消すときは `CHIPS`、`COLOR`、`CHIP_ICON` と、その言葉を使う `eval/set.jsonl` の問題も見直します（評価セットを変えるときはユーザーに聞く）。

## 確かめる（足したら必ず）

1. `npx tsx scripts/tag-audit.ts`：言葉ごとに、東京と関東の OSM データで当てはまる数を自社の Overpass で数えます（アプリと同じ検索文）。0件の言葉があると失敗します。少ない言葉には印が付きます。結果は `logs/tag-audit.json`。報告と直し方の案が欲しいときはサブエージェント `tag-auditor` に頼みます。
2. `npx tsx scripts/check-places.ts`：地物の検索の操作を自社の Overpass で確かめます。Overpass は同じ検索文が1分に4回ほど続くと断るので、続けて何度も回さないでください。
3. `npx tsx scripts/check-quick.ts`：評価セットが辞書にない言葉を使っていないか、言葉ごとに `COLOR` と解釈があるか（ネットワークなし。Stop hook でも回ります）。
4. `npx tsc --noEmit -p .`
5. 辞書を変えると、Claude のシステムプロンプトの言葉の一覧も変わります。評価（サブエージェント `eval-runner`）を回すかはユーザーに聞きます（本物の Claude API を約150回呼び、お金がかかります）。
