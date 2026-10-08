// 緯度経度 <-> ローカル平面座標 (m)。新宿西口周辺の数百 m 四方なので、
// 原点での子午線・卯酉線曲率半径を使った局所的な線形近似で十分（誤差は cm 未満）。
// x = 東向き, y = 北向き, z = 標高 (T.P.)。ブラウザと前処理 (prep/) の両方から読む。

export const ORIGIN = { lat: 35.6929, lon: 139.7008 };

const a = 6378137;
const e2 = 0.00669438002290;
const phi = (ORIGIN.lat * Math.PI) / 180;
const w = Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
const N = a / w;
const M = (a * (1 - e2)) / w ** 3;
const KX = (Math.PI / 180) * N * Math.cos(phi);
const KY = (Math.PI / 180) * M;

export const toXY = (lat, lon) => [(lon - ORIGIN.lon) * KX, (lat - ORIGIN.lat) * KY];
export const toLatLon = (x, y) => [ORIGIN.lat + y / KY, ORIGIN.lon + x / KX];
