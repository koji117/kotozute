# OSMビューア（仮称）：AIで動くOSMビューア

地図に詳しくない社員が、日本語ひとことで、出典つきの「渡せる地図」をつくる。Googleにも、公開サーバにも頼らずに。

「Built with Claude: Japan 2026」（テーマ1「あなたにしかない深さを」）への応募作品です。

> **状態：計画段階（2026-11-04）。** コードはまだありません。計画は [docs/plan.md](docs/plan.md)、絵コンテ動画は [docs/storyboard/](docs/storyboard/) にあります。

## できること（予定）

1. 場所・住所を探して表示する（住所はデジタル庁のアドレス・ベース・レジストリ）
2. 業務の言葉で地物を絞り込んで表示する（踏切、トンネル、一方通行など）
3. ルートと試走コースを作り、条件を満たしたかを機械的に確かめる
4. 出典とデータ時点を焼き込んだ資料用の画像と、共有リンクを作る

地図・検索・ルート・住所はすべて自社で動かし、外部の地図サービスは使いません。

## 期間中に作ったもの／使うOSS・公開データ

提出までに、この節で両者をはっきり分けて示します。

| 期間中に作ったもの | 使うOSS・公開データ（ライセンス） |
|---|---|
| （作成中） | OpenStreetMap（ODbL）、Protomaps、MapLibre GL JS、Overpass API、Valhalla、abr-geocoder（いずれも運営への確認中） |

## 出典

地図データ © OpenStreetMap contributors（[openstreetmap.org/copyright](https://www.openstreetmap.org/copyright)）
