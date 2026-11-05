# 絵コンテ動画

提出用デモ動画の絵コンテです。過去の Claude Code ハッカソンの受賞作（CrossBeam、Elisa、TARA、MaestrIA、ARIA）の動画の組み立てにならっています。11/5 に、画面を地図アプリでおなじみの配置（左上の検索、カテゴリの札、左の結果パネル、右の地図ボタン。色と文字は案E）にし、地図を自前の東京の地図（実際の地理、地図アプリでよく使われる配色）に替えました。今は約4分5秒あります。応募の規則は3分なので、本番の撮影で3分に収めます。ビューアはまだないので、画面と数値は架空です。ただし地図、ルート、寄り先、踏切、トンネル、判定不能の区間は、自前の Overpass と Valhalla から取った実際のデータです（`data/`）。

## 組み立て

- 冒頭で「明日、Googleマップの商用利用が禁止されたら？」と問う（仮定と明示）。続けて、本当にあった前例（2006〜2026年の9件）を出典つきで見せる。根拠は `docs/research/google-map-changes.md`。
- なぜ要るか：OSMなら1社に頼らずに済む。でも今の道具は、検索文やタグを書ける人しか使えない。
- ほかの道具の課題を1行ずつ。作った人が名乗り、「3つの約束」（① 1社に頼らない ② 詳しくなくても使える ③ 確かめられる）を出す。
- 例1：現在地から、郵便局と手土産の店に寄って客先へ。結果を共有リンクで送る。(a) 住所、(b) 寄り先の候補、(c) 経由地つきのルート、(d) 共有リンクと外部通信の記録。
- 例2：試走コース（品川駅発着、トンネル2本、高速なし、60分以内）。(b) 踏切とトンネル、(c) 1回目は不合格 → 2回目で合格、判定不能、(d) 出典を焼き込んだ画像。続けて OSMノートの下書き。
- 約束を守った場面ごとに「① 解決」などの印を出し、画面右上の「約束」の欄が点灯する。最後は冒頭の問いに戻って終わる。

## ファイル

- `demo-storyboard.mp4`：書き出した動画（1280×720、30コマ/秒、約4分18秒、字幕あり、音声なし）
- `demo-storyboard-narrated.mp4`：上の動画に仮のナレーションを重ねたもの
- 動画2本と `maps/` は Git に入れない（大きく、作り直すたびに履歴が増えるため）。下の手順で作り直す
- `demo-poster.jpg`：表紙画像
- `storyboard.html`：動画の元ページ。`window.render(t)` で任意の時刻（秒）の画面を描く。要素の表示時間は `data-show="開始-終了"`、文字の打ち込みは `data-type="開始:1秒あたりの文字数"`、線の描画は `data-draw="開始-終了"`、地図の画像を左から出すのは `data-wipe="開始-終了"`、地図の寄り引きは `data-cam="時刻:倍率:tx:ty,…"`、地図の上の札の位置は `data-at="場面:点"`（`maps/pos.js` から）。`class="rise"` は下から浮き上がり、`class="slide"` はシートが下から上がり、`class="pop"` は印が押されるように出る。字幕の行に `data-silent` を付けると読み上げない
- `data/build-ex1.js`・`data/build-ex2.js`：例1・例2のデータを、自前の Overpass・Valhalla・ABR から取り直す（`data/ex1.json`・`data/ex2.json`）
- `data/build-nl.js`：例1の前の場面（札で出す郵便局と手土産の店、芝公園の範囲）を自前の Overpass から取る（`data/nl.json`）
- `scenes.js`：`data/` から地図の場面を描く（`maps/*.png` と、札の位置 `maps/pos.js`）
- `mapshot.js`：自前の地図（tokyo.pmtiles）を MapLibre で描き、PNG にする。`scenes.js` から呼ばれる
- `design/`：画面デザインの検討（案A〜F と操作パネルの一覧）。色・角丸・文字は案E（`design/option-e.html` の `:root`）。配置はその後、地図アプリでおなじみの形に変えた（`storyboard.html`）
- `render.js`：Playwright で1コマずつ撮影する
- `narrate.js`：字幕を macOS の `say`（Kyoko）で読み上げ、字幕の時間に合わせて動画に重ねる
- `package.json`：ルートが ES module なので、ここのスクリプトを CommonJS として動かすために置いている

## 書き出し

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

## ナレーション

字幕（`storyboard.html` の `.captext` の各行）を macOS の `say -v Kyoko` で読み上げます。英字の用語（GPX、ABR、OSM、MCP、SLA、API など）は、`narrate.js` の `READ` でカナの読みに置き換えます。字幕の時間に収まらない行は、読む速さを上げます（上限あり）。`data-silent` の行は読みません。上限でも収まらない行は `OVER` と表示します。

```bash
node narrate.js
```
