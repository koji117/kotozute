# Google 以外の地図サービスの変更（2026-11-08 に調べた）

動画の前例（4行目「これまでも、規約の変更、有料化、値上げ、サービスの終了が、何度もありました」）に、Google 以外の例を足すために調べた。
ユーザーがトランスクリプトのコメントで「Google 以外の例があったら挙げて」と頼んだ。Google の例は `google-map-changes.md`。

一次の資料（提供元のドキュメント、お知らせ、リリースノート）で確かめたものだけを書く。

## 動画に入れたもの

| 年 | サービス | 何が起きたか | 一次の資料 |
|---|---|---|---|
| 2020 | Mapbox GL JS | 12月8日の v2.0.0 から、3条項 BSD ライセンスをやめた。新しい条件は LICENSE.txt。v2 に上げると Mapbox の利用規約に同意することになる（v1 は BSD のまま） | v2.0.0 のリリースノート：https://github.com/mapbox/mapbox-gl-js/releases/tag/v2.0.0 |
| 2024 | Bing Maps for Enterprise（Microsoft） | 提供の終了を発表。無料のアカウントは 2025年6月30日まで、有料（Enterprise）のアカウントは 2028年6月30日まで。移る先は Azure Maps | Microsoft Learn の Bing Maps のドキュメント：https://learn.microsoft.com/en-us/bingmaps/ （「Bing Maps for Enterprise is deprecated and will be retired. Free account customers can continue to use Bing Maps for Enterprise services until 6/30/2025. Enterprise account customers … until 6/30/2028.」）。Bing Maps のブログ：https://blogs.bing.com/maps/2025/6/Bing-Maps-for-Enterprise-Basic-Account-shutdown-June-30%2C2025/ （2024年5月21日の発表にふれている） |

- Mapbox の年は、リリースノートの日付（12月8日）と、各社の記事（2020年12月）による。リリースノートのページには年が出ていない。
- Bing の「2024年5月21日」は、上のブログが引く発表の日。最初のお知らせの本文は、まだ読んでいない。

## 動画に入れなかったもの

| 年 | サービス | 何が起きたか | 一次の資料 | 入れなかった理由 |
|---|---|---|---|---|
| 2025 | HERE（Limited Plan） | 無料の Limited Plan を 2025年8月31日に終了。そのあとは HERE のサービスを使えない。Base Plan へ移るには請求先と住所を入れる | https://www.here.com/learn/blog/july-2025-platform-release-notes/ | カードの数を増やしすぎないため（入れるのは2件まで） |
| 2014・2020 | Yahoo! JAPAN の地図の API（YOLP） | 一部の API と SDK の提供を終了（2014年5月31日、2020年10月31日） | 開発者向けのお知らせの一覧：https://developer.yahoo.co.jp/changelog/map.html | 一覧の見出しを見ただけで、本文を読んでいない |
