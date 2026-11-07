# デモ動画と絵コンテ

## 提出用のデモ動画（`demo.html`。2026-11-06〜）

撮影はしない（2026-11-06 にユーザーが決定）。本物のアプリを Playwright で動かして録り（録る側は別の作業。結果は `~/kotozute-video/events.json`）、このページで絵の場面と組み合わせて3分の動画にする。声は ElevenLabs（make.sh の既定。`TTS=say` なら macOS の Kyoko）、字幕つき。

- `demo.html`：動画の元ページ。`docs/plan.md` §7 の 180 秒の割り振りに、Mac のアプリの場面（約8秒）を Claude Code の場面から移して入れた。冒頭の読み上げを速さ 240 以下に収めるため、12–25.5 を 1.5 秒のばした。全体は 179.5 秒。
  - 0–14.35 冒頭（あなたの組織では…／SLA がない／合わなくなれば、業務が止まる）／14.35–22.4 これまでの前例4件／22.4–42.25 課題・作った人・約束／42.25–65.45 例1／65.45–72.45 共有リンク／72.45–77.45 札（AI を通さない）／77.45–88.25 日本の住所と座標／88.25–116.25 例2 (c)(d)／116.25–121.25 期間中に作ったもの ／ 使ったOSS・公開データ／121.25–148.65 Claude Code での開発／148.65–163.65 外部通信の記録とレシピ／163.65–171.65 Mac のアプリ／171.65–179.5 おわり
  - (e) 地図の表示と例2 (b) 踏切とトンネルは、2026-11-07 に削った（録る側はまだ s2-view と s4-feat を録るが、使わない）
  - 冒頭に出す4つの件（2018 無料枠の縮小、2019 地図の作り替え、Google Earth の画像、2026 Earth Pro の配布終了）は、それぞれ解決する場面の印に「↩ 冒頭の問い：…」として戻す（冒頭の問題は画面で解決して見せる）。
  - 約束の欄は、ルートや印が隠れないよう録画の右側に置き、録る側は地図の右に余白を足す（record.mjs の OVERLAY_RIGHT）。共有リンクと書き出した画像の窓が出ている間は、約束の欄を消す。
  - アプリの場面は `<video>`（録画）。`SHOTS` で、録画の印（marks）の区間を動画の時刻の枠に置く。録画が枠より長ければ速め、字幕帯の右に「早送り ×1.4」のような札を出す。短ければ最後のコマで止める。`sent` から `answered` まで（Claude の待ち時間）は切り、「Claude の待ち時間を短くしています（実際は ◯秒）」の札を、応答のあとの枠のあいだ（6秒まで）出す。
  - `window.render(t)` は録画をその時刻のコマまで送り（`seeked` を待つ）、終わってから返す。コマはずれない（11/6 に、コマ番号を色にした録画で 90 コマを確かめた。WebM と MP4 のどちらも合う）。
  - 字幕や札の `{名前}` は、`events.json` の `results`（画面が受け取った `/api/chat`・`/api/op` などの応答）からテンプレートで埋める（`V`）。アプリから来る数字や名前は書かない。値が取れなければ「？」にし、render.js が「足りないもの」として出す。「分からない（データなし）」は動画に出さない決まりなので、出たら「？」になる。
  - ③ の見せ方：解釈の行（`Claudeが読んだ`）は、画面の「解釈」と同じ作り（`src/web/panel.ts` の `pairs`）で結果から作る。`地図のデータが答えた` は結果の値（件数、分、◯/×）だけに付ける。
  - Claude Code の場面は、リポジトリにある日付つきの記録だけ（`logs/hook-blocks.jsonl`、`logs/tag-audit.json`、評価のコミット cafb4a3 → 2c9102a → 2be320c → ceafe28、MCP の f0bac95）。hook と tag-auditor の記録は、render.js がコミット済みの版（`git show HEAD:…`）を読んで入れる。「Google のフォント配信を◯回止めた」の数も、この版から数える（コミットしていない行は数えない）。作業フォルダの名前（`.claude/worktrees/<名前>/`）は「(worktree)/」と出す。
  - 期間中に作ったもの ／ 使ったOSS・公開データの札は、README の2つの表から。
  - フォントは自前（`@fontsource`、`node_modules`）。ネット接続は要らない。
- `render.js`：`demo.html` を 1920×1080（1280×720 を 1.5 倍）、30コマ/秒で撮る。出力は `~/kotozute-video/`（Git の外）。
- `narrate.js`：字幕（埋めたあとの文）を読み上げ、`~/kotozute-video/preview.mp4` を作る。読み上げの速さは 240 まで（超えると OVER と出るので、字幕を短くするか時間を足す）。音量は -14 LUFS にそろえる（ffmpeg の loudnorm）。
- `dummy-events.js`：本物の録画がまだないときの確かめ用。ffmpeg の testsrc でダミーの録画と `events.json` を `~/kotozute-video/dummy/` に作る。ダミーのときは画面の上に赤い札が出る。

### events.json の形（録る側との約束）

```
{ base, recorded_at, viewport,
  clips: [{ id, file /* events.json のある場所から見たパス */, duration_s, marks: [{ name, t /* 録画の中の秒 */ }], png? }],
  results: { <場面の id>: <画面が受け取った最初の応答の JSON>, '<場面の id>:2': <2つ目の応答>, … } }
```

- 場面の id（この順）：`s1-chips`、`s2-view`、`s3-ex1`、`s3b-share`、`s4-feat`、`s4-ex2`、`s4b-png`、`s5-adv`、`s5-recipe`、`s6-app`。
- 印は少なくとも `start`、`typed`（打ち込むとき）、`sent`、`answered`、`done`。
- 2つ目からの応答（`s1-chips:2` など）は、`demo.html` が場面ごとの配列にまとめる。
- 書き出した画像そのものは、`s4b-png` の `downloads` の1つ目（`png` があればそれ）。
- 外部通信の記録の数は `s5-adv` の結果から。なければ `s3-ex1`（録る側は「詳細」を例1の結果で開く。例2の「詳細」には車線数の「分からない」が出るため）。
- `s6-app` は、アプリの窓（1280×788）が 1920×1080 の真ん中に置かれた録画。`demo.html` は 1.5 倍にして窓の中身だけを見せる。
- `s6-app`（Mac のアプリの窓）がなければ、入れ方の絵だけを出す。
- 録画は縦横比を保って画面（1280×640。動画では 1920×960）に収める。1280×640（2:1）の画面で録ると余白なしで収まり、ほかの比は左右か上下が墨色になる。文字をくっきり出すには、録画の大きさを 1920×960 にするとよいはず（未確認）。

### 作り方

本番（機能の凍結のあと）は、1つのコマンドで録画から mp4 まで作る。リポジトリのどこからでもよい。

```bash
sh scripts/video/make.sh
```

録画（`scripts/video/record.mjs`。kotozute のサーバが :8787 で動いていること）→ コマ（`render.js full`）→ 声（`narrate.js`）→ `~/kotozute-video/kotozute-demo-<日付>-<時刻>.mp4`。字幕に「？」が出るとき（結果に足りないものがあるとき）は、コマを撮る前に止まる。180秒を超えたら失敗で終わる。`sh scripts/video/make.sh --no-record` は今の `events.json` のまま作る。`sh scripts/video/make.sh ex2` は例2の組だけ録り直してから作る。

下は1つずつ動かすとき。コマンドはすべて `docs/storyboard` で実行する。Playwright（scripts/check-web.mjs と同じ探し方）と ffmpeg が要る。

```bash
node render.js preview
```

確かめ用の数枚（`~/kotozute-video/preview/`）。`node render.js preview 45,99` で時刻を選べる。

```bash
node render.js full && node narrate.js
```

全部のコマ（`~/kotozute-video/frames/`、約5分）→ `~/kotozute-video/demo-silent.mp4` → 声を重ねて `~/kotozute-video/preview.mp4`（`MP4=…` で出力先を変える）。`FRAMES=1500-1650 node render.js full` で一部のコマだけ撮り直せる。`node narrate.js check` は声の長さだけを確かめる（字幕の時間に収まらない行は `OVER`）。

ダミーで確かめるとき：

```bash
node dummy-events.js && EVENTS=~/kotozute-video/dummy/events.json node render.js preview
```

## 前の絵コンテ（`storyboard.html`、11/5 版）

提出用デモ動画の絵コンテです。過去の Claude Code ハッカソンの受賞作（CrossBeam、Elisa、TARA、MaestrIA、ARIA）の動画の組み立てにならっています。11/5 に、画面を地図アプリでおなじみの配置（左上の検索、カテゴリの札、左の結果パネル、右の地図ボタン。色と文字は案E）にし、地図を自前の東京の地図（実際の地理、地図アプリでよく使われる配色）に替えました。今は約4分5秒あります。応募の規則は3分なので、本番の撮影で3分に収めます。ビューアはまだないので、画面と数値は架空です。ただし地図、ルート、寄り先、踏切、トンネル、判定不能の区間は、自前の Overpass と Valhalla から取った実際のデータです（`data/`）。

### 組み立て

- 冒頭は「あなたの組織では、Googleマップを無料で使っていませんか？」と問い、SLA がないこと、「規約を決めるのも、変えるのもGoogle。合わなくなれば、業務が止まります。」と続ける（11/7 にユーザーが決定）。続けて、本当にあった前例4件を出典つきで見せる。根拠は `docs/research/google-map-changes.md`。
- なぜ要るか：OSMなら1社に頼らずに済む。でも今の道具は、検索文やタグを書ける人しか使えない。
- ほかの道具の課題を1行ずつ。作った人が名乗り、「3つの約束」（① 1社に頼らない ② 詳しくなくても使える ③ 確かめられる）を出す。
- 例1：現在地から、郵便局と手土産の店に寄って客先へ。結果を共有リンクで送る。(a) 住所、(b) 寄り先の候補、(c) 経由地つきのルート、(d) 共有リンクと外部通信の記録。
- 例2：試走コース（品川駅発着、トンネル2本、高速なし、60分以内）。(b) 踏切とトンネル、(c) 1回目は不合格 → 2回目で合格、判定不能、(d) 出典を焼き込んだ画像。続けて OSMノートの下書き。
- 約束を守った場面ごとに「① 解決」などの印を出し、画面右上の「約束」の欄が点灯する。最後は冒頭の問いに戻って終わる。

### ファイル

- `demo-storyboard.mp4`：書き出した動画（1280×720、30コマ/秒、約4分18秒、字幕あり、音声なし）
- `demo-storyboard-narrated.mp4`：上の動画に仮のナレーションを重ねたもの
- 動画2本と `maps/` は Git に入れない（大きく、作り直すたびに履歴が増えるため）。下の手順で作り直す
- `demo-poster.jpg`：表紙画像（11/5 の版。文は前の冒頭の問いのままで、今の動画の冒頭とは違う）
- `storyboard.html`：動画の元ページ。`window.render(t)` で任意の時刻（秒）の画面を描く。要素の表示時間は `data-show="開始-終了"`、文字の打ち込みは `data-type="開始:1秒あたりの文字数"`、線の描画は `data-draw="開始-終了"`、地図の画像を左から出すのは `data-wipe="開始-終了"`、地図の寄り引きは `data-cam="時刻:倍率:tx:ty,…"`、地図の上の札の位置は `data-at="場面:点"`（`maps/pos.js` から）。`class="rise"` は下から浮き上がり、`class="slide"` はシートが下から上がり、`class="pop"` は印が押されるように出る。字幕の行に `data-silent` を付けると読み上げない
- `data/build-ex1.js`・`data/build-ex2.js`：例1・例2のデータを、自前の Overpass・Valhalla・ABR から取り直す（`data/ex1.json`・`data/ex2.json`）
- `data/build-nl.js`：例1の前の場面（札で出す郵便局と手土産の店、芝公園の範囲）を自前の Overpass から取る（`data/nl.json`）
- `scenes.js`：`data/` から地図の場面を描く（`maps/*.png` と、札の位置 `maps/pos.js`）
- `mapshot.js`：自前の地図（tokyo.pmtiles）を MapLibre で描き、PNG にする。`scenes.js` から呼ばれる
- `design/`：画面デザインの検討（案A〜F と操作パネルの一覧）。色・角丸・文字は案E（`design/option-e.html` の `:root`）。配置はその後、地図アプリでおなじみの形に変えた（`storyboard.html`）。11/4〜5 の初めのころの案なので、画面の言葉（「合否表」「判定不能」、前の3つの約束など）は今のアプリと違う。地図の画像は自前の tokyo.pmtiles から `mapshot.js` で描いたもので、出典は © OpenStreetMap contributors（https://www.openstreetmap.org/copyright）と Protomaps
- `render.js`・`narrate.js`：今は `demo.html` 用。`storyboard.html` 用の版は git の履歴（3751219）にある
- `package.json`：ルートが ES module なので、ここのスクリプトを CommonJS として動かすために置いている

### 書き出し（storyboard.html 用の、前の render.js）

Playwright と ffmpeg が必要です。コマンドはすべて `docs/storyboard` で実行します（render.js は今いるディレクトリの storyboard.html を開き、frames/ もそこに作ります）。storyboard.html は Google Fonts を読むので、ネット接続が要ります。出力の `fonts` の行に false があれば、字体が置き換わっています。地図を描き直すときは、先に kotozute のサーバ（:8787）と Overpass・Valhalla・ABR を動かしておきます。

```bash
cd docs/storyboard
```

```bash
npm install --no-save playwright && npx playwright install chromium
```

地図のデータと場面を作り直すとき（データが変わったときだけ）：

```bash
node data/build-ex1.js && node data/build-ex2.js && node data/build-nl.js && node scenes.js
```

```bash
node render.js full frames
```

```bash
ffmpeg -y -framerate 30 -i frames/f%05d.jpg -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -r 30 -movflags +faststart demo-storyboard.mp4
```

### ナレーション（storyboard.html 用の、前の narrate.js）

字幕（`storyboard.html` の `.captext` の各行）を macOS の `say -v Kyoko` で読み上げます。英字の用語（GPX、ABR、OSM、MCP、SLA、API など）は、`narrate.js` の `READ` でカナの読みに置き換えます。字幕の時間に収まらない行は、読む速さを上げます（上限あり）。`data-silent` の行は読みません。上限でも収まらない行は `OVER` と表示します。

```bash
node narrate.js
```
