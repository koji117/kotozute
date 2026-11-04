# 絵コンテ動画

提出用デモ動画（3分）の絵コンテです。ビューアはまだないので、画面・地図・数値はすべて架空です。地図は模式図で、実際の地理ではありません。

- `demo-storyboard.mp4`：書き出した動画（1280×720、3分、字幕あり、音声なし）
- `demo-poster.jpg`：表紙画像
- `storyboard.html`：動画の元ページ。`window.render(t)` で任意の時刻（秒）の画面を描く。要素の表示時間は `data-show="開始-終了"`、文字の打ち込みは `data-type="開始:1秒あたりの文字数"`、線の描画は `data-draw="開始-終了"`
- `render.js`：Playwright で1コマずつ撮影する

## 書き出し

Playwright と ffmpeg が必要です。コマンドはすべて `docs/storyboard` で実行します（render.js は今いるディレクトリの storyboard.html を開き、frames/ もそこに作ります）。storyboard.html は Google Fonts を読むので、ネット接続が要ります。出力の `fonts` の行に false があれば、字体が置き換わっています。

```bash
cd docs/storyboard
```

```bash
npm install --no-save playwright && npx playwright install chromium
```

```bash
node render.js full frames
```

```bash
ffmpeg -y -framerate 12 -i frames/f%05d.jpg -c:v libx264 -preset slow -crf 23 -pix_fmt yuv420p -r 24 -movflags +faststart demo-storyboard.mp4
```

## ナレーション（未完了）

字幕（`storyboard.html` の `.captext` の各行）を読み上げる音声を付ける予定でした。方法は決まっていません。候補：

- macOS 標準の読み上げ（`say -v Kyoko` など）
- Open JTalk（オープンソース。声のデータのクレジット表記が必要）
- VOICEVOX（自然な声。キャラクターごとの利用規約とクレジット表記が必要）
- 自分で録音する

字幕の時間に読み上げが収まらない場面は、その場面だけ動画を延ばす（3分を少し超える）。英字の用語（GPX、ABR、OSM、MCP、Claude Code など）は、読み上げ用にカナの読みを用意する。
