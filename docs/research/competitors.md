# 似ているサービスの調査（2026年11月4日時点）

表記：**[事実]** 一次資料かコードで確認、**[報道]** 報道で確認、**[推測]** 推論、**[未確認]** 確かめられていない。

## 結論

- 計画全体（日本語、社内の非専門家向け、地図・検索・ルートを自社で運用、4つの操作、OSMノートの下書き）をまとめて満たすサービスは、調べた範囲では見つからなかった [推測]。「見つからない」は「存在しない」の証明ではない。
- 「AIに話しかけて地図を動かす」こと自体はありふれている。
- 日本企業の製品ページはこの環境から開けず、報道でのみ確認した。調査の途中で検索の上限に達したため、Atlas、CARTO、Aino と、Googleの「マップに相談」の細かい機能は [未確認]。

## 近いもの

| サービス | 何ができるか | 計画との違い |
|---|---|---|
| Googleマップ「マップに相談」 | 条件の多い場所探しやルートの相談を会話で行う。日本では2026年8月から順次提供 [事実：告知の存在。中身は報道] | Google自身なので依存は残る |
| [TRIDENT](https://github.com/yuiseki/TRIDENT)（日本、MIT） | 自然言語→OSMの検索条件→地図表示。日本語の設計資料あり [事実] | ルート、共有、書き出しは未実装。国内で最も近い先行例 |
| [osmable](https://github.com/yuiseki/osmable)（日本） | AIエージェント向けのOSM用CLI（検索、ルート、到達圏）[事実] | 地図表示と書き出しは対象外 |
| [GeoAI WebGIS Agent](https://github.com/satriatva/geoai-webgis-agent)（MIT） | 文章で住所検索・周辺検索・ルート沿い検索。接続先を自前サーバに切り替え可 [事実] | 英語とインドネシア語。共有・書き出し・ノートなし |
| [TurnByTurn](https://github.com/johngcarlsson-usc/TurnByTurn) | 自然言語でルート。外部サービスを呼ばない自前構成 [事実] | 米国と英語。地物検索や資料用地図なし |
| [SPOT](https://github.com/dw-innovation/SPOT)（AGPL） | 複雑な条件で自前のOSMデータを検索。保存とURL共有 [事実] | 日本語対応の記載なし。ルートなし |
| [TomTom](https://github.com/tomtom-international/tomtom-maps-mcp)・[Mapbox](https://github.com/mapbox/mcp-server) の MCP | Claude の会話内に地図、検索、ルート。Mapbox は地図画像も出せる [事実] | 地図会社のAPIに依存 |
| [Onda](https://github.com/GRizzi91/onda) | 一文から周回ルート、検証器で条件確認、GPXと共有リンク [事実] | 地物の条件（踏切を通るなど）は指定できない |
| [scenic-routing-mcp](https://github.com/orofarne/scenic-routing-mcp) | 自然言語→自前Valhalla→GPX [事実] | 歩行者向けで景観が条件 |
| [ai-geocorder](https://github.com/naogify/ai-geocorder)（日本） | 日本語→OSM検索→地図表示の小さなデモ [事実] | 公開サーバと OpenAI に依存 |
| [maplibre-gl-geoagent](https://github.com/opengeos/maplibre-gl-geoagent) | ブラウザ内で LLM が MapLibre を操作する部品 [事実] | 検索とルートはない |
| 日本の地図会社 | ゼンリンデータコム「デザイン地図AI」、ゼンリンと Preferred Networks の提携（2026-10-29）[報道]、ジオテクノロジーズ「GeoTechAgent」、インフォマティクス「GC Navi AIチャット」[未確認] | データ源と、利用者が自分で運用できるかは確かめていない [未確認]。デザイン地図AIは資料用の地図と重なる [報道] |

## 操作ごとの状況

| 操作 | 既存の状況 | まだ新しいところ [推測] |
|---|---|---|
| (a) 場所・住所 | ありふれている | 日本の住所の精度（ABRとの組み合わせ） |
| (b) 地物の絞り込み | 2023年から多数 | ほぼない |
| (c) ルート・試走コース | 自然言語でのルートはある | 地物の条件で作るコースの機械的な検証と判定不能の表示 |
| (d) 資料用の地図・共有 | 部分的にある | 非専門家が日本語で作る、出典表示の正しい資料用地図 |
| OSMノートの下書き | 見つからなかった | AIで下書きし、人が確かめて投稿する流れ |

## 参考になる知見

- [WRIの実験](https://github.com/wri/applied-ai-experiments/blob/main/experiments/mcp-web-map/brief.md)：単純な地図移動は手が速い。チャットは複数手順の依頼で役立つ。ツール呼び出しを見せると信頼につながる [事実]。
- LLM に Overpass QL を直接書かせる先行デモは、作者自身が「壊れやすい」と書いている [事実]。
