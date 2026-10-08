# GTFS-Pathways × PLATEAU 統合エディタ (公開版)

https://tyra0119.github.io/pj_GTFS-pathway/

都営大江戸線 新宿西口駅の GTFS-Pathways (駅構内の経路) を、PLATEAU の地下街 3D モデル (LOD4) に自動で重ね、
ずれや矛盾を 3D 画面で確認しながら手で直すためのツールです。

- 手修正はブラウザに保存されます。別の PC に持っていくときは「JSON 保存」「JSON 読込」を使ってください。
- 「書き出し」で、この駅の stops / pathways / levels と標高の CSV (x_*.csv) を ZIP でダウンロードできます。

このリポジトリは書き出し専用です。ソースは別リポジトリ (GTFS-pathway) にあり、`node tools/publish.mjs` で生成しています。

## 出典

- 3D都市モデル（Project PLATEAU）新宿区（2025年度） 国土交通省 — 地下街モデル LOD4 を加工
- 東京都交通局・公共交通オープンデータ協議会「鉄道関連情報 (GTFS-Pathways)」 CC BY 4.0 — 新宿西口駅の分を加工
- 国土地理院 標高 API — 地表の標高
- three.js (MIT License) — vendor/three/
