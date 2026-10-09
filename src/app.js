// GTFS-Pathways × PLATEAU 地下街 統合エディタ (画面)
//
// 起動時に自動突き合わせ (match.js) を走らせ、結果を 3D で重ねて表示する。
// 手で直した内容は edits (edits/<駅>.json) にだけ持ち、変更のたびに自動突き合わせをやり直す。
// 自動結果は保存しない。手修正は常に自動結果より優先される。

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { TriIndex, runMatch, MODE_NAMES } from './match.js?v=92dada0-mv0xp91l';
import { toLatLon, setOrigin } from './geo.js?v=92dada0-mv0xp91l';
import { stationGtfsFiles, extraFiles } from './export-files.js?v=92dada0-mv0xp91l';
import { makeZip } from './zip.js?v=92dada0-mv0xp91l';

const STATION = new URLSearchParams(location.search).get('station') || '402';
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const f2 = (v) => (v == null || Number.isNaN(v) ? '-' : Number(v).toFixed(2));

const LOC_TYPE = { 0: 'ホーム', 1: '駅', 2: '出入口', 3: '中継点', 4: '乗降エリア' };
const MODE_COLOR = { 1: 0xe0e0e0, 2: 0xff9f43, 3: 0x48dbfb, 4: 0xa29bfe, 5: 0xff6b6b, 6: 0x1dd1a1, 7: 0x1dd1a1 };
const STATUS_COLOR = { ok: 0x69db7c, info: 0x4aa3df, warn: 0xf39c12, error: 0xe74c3c, done: 0x7f8c8d, dim: 0x3a4148 };
const EDGE_STATUS_COLOR = { ok: 0x8a949e, info: 0x4aa3df, warn: 0xf39c12, error: 0xe74c3c, done: 0x5f6b6d, dim: 0x30363c };
const LAYERS = [
  { type: 'FloorSurface', label: '床', color: 0xc8b88a, opacity: 0.9, visible: true, ramp: true },
  { type: 'WallSurface', label: '外壁', color: 0x7f9fbf, opacity: 0.15, visible: true },
  { type: 'InteriorWallSurface', label: '内壁', color: 0x9fb8d0, opacity: 0.15, visible: true },
  { type: 'Door', label: '扉', color: 0x2ecc71, opacity: 0.5, visible: true },
  { type: 'IntBuildingInstallation', label: '設備 (階段など)', color: 0xd4a5ff, opacity: 0.35, visible: true },
  { type: 'CeilingSurface', label: '天井', color: 0x8395a7, opacity: 0.1, visible: false },
  { type: 'RoofSurface', label: '屋根 (上端)', color: 0x95a5a6, opacity: 0.15, visible: false },
  { type: 'GroundSurface', label: '底面', color: 0x7f6f5f, opacity: 0.3, visible: false },
  { type: 'ClosureSurface', label: '閉鎖面 (仮想)', color: 0xff66cc, opacity: 0.25, visible: false },
  { type: 'Window', label: '窓', color: 0x5dade2, opacity: 0.4, visible: false },
];

// ------------------------------------------------------------------ データ読み込み

// 公開版は app.js?v=<版> で読まれる (tools/publish.mjs)。データにも同じ版を付けて、更新後に古いキャッシュを使わせない
const VER = new URL(import.meta.url).search;
// 駅の一覧（prep/prep-all.mjs が作る）。駅ごとの地下街モデルのファイルと出典。無ければ新宿西口だけの古い形
const STATIONS = await fetch(`data/stations.json${VER}`).then((r) => (r.ok ? r.json() : [])).catch(() => []);
const ST = STATIONS.find((s) => s.id === STATION) || { id: STATION, plateau: 'plateau.json', credits: null };
const meta = await (await fetch(`data/${ST.plateau}${VER}`)).json();
// ローカル座標の原点は駅ごと。地下街モデルを作ったときの原点に合わせる（書き出しの緯度経度に使う）
if (meta.origin) setOrigin(meta.origin.lat, meta.origin.lon);
const bin = await (await fetch(`data/${meta.bin}${VER}`)).arrayBuffer();
const types = {};
for (const [t, L] of Object.entries(meta.layout)) {
  types[t] = {
    pos: new Float32Array(bin, L.pos.offset, L.pos.length),
    idx: new Uint32Array(bin, L.idx.offset, L.idx.length),
    tri: new Uint32Array(bin, L.tri.offset, L.tri.length),
  };
}
const gtfs = await (await fetch(`data/gtfs-${STATION}.json${VER}`)).json();

// ローカル (node server.mjs) なら手修正は edits/<駅>.json に、公開版 (GitHub Pages) ならブラウザに保存する
const STORE_KEY = `gtfs-pathway-edits-${STATION}`;
const serverEdits = await fetch(`api/edits/${STATION}`)
  .then((r) => (r.ok && (r.headers.get('content-type') || '').includes('json') ? r.json() : null))
  .catch(() => null);
const SERVER = serverEdits !== null;
// 公開版でブラウザにまだ手修正が無ければ、公開時に同梱した手修正 (リポジトリの edits/<駅>.json) から始める
const hasLocal = (() => { try { return !!localStorage.getItem(STORE_KEY); } catch { return false; } })();
const bundled = SERVER || hasLocal ? null
  : await fetch(`data/edits-${STATION}.json${VER}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
let edits = normalizeEdits(SERVER ? serverEdits : bundled || loadLocal());

function loadLocal() {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
  } catch {
    return {};
  }
}

const idx = {
  floor: new TriIndex(types.FloorSurface),
  roof: types.RoofSurface ? new TriIndex(types.RoofSurface) : null,
  walls: ['WallSurface', 'InteriorWallSurface'].filter((t) => types[t]).map((t) => new TriIndex(types[t])),
};

function normalizeEdits(e) {
  return {
    version: 1,
    station: STATION,
    offset: { dx: 0, dy: 0, ...(e.offset || {}) },
    levels: e.levels || {},
    nodes: e.nodes || {},
    pathways: e.pathways || {},
    addedNodes: e.addedNodes || [],
    addedPathways: e.addedPathways || [],
    deletedNodes: e.deletedNodes || [],
    deletedPathways: e.deletedPathways || [],
    seq: e.seq || 0,
  };
}

$('#station-name').textContent = `${gtfs.station_name} (${STATION})${gtfs.feed_version ? ' / ODPT ' + gtfs.feed_version : ''} / ${meta.source}`;
// 駅の切り替え（選ぶと ?station= を付けて開き直す）
if (STATIONS.length > 1) {
  const sel = $('#station-select');
  sel.innerHTML = STATIONS.map((s) => `<option value="${s.id}"${s.id === STATION ? ' selected' : ''}>${s.name} (${s.id})</option>`).join('');
  sel.hidden = false;
  sel.addEventListener('change', () => { location.search = '?station=' + encodeURIComponent(sel.value); });
}
if (ST.credits) {
  const c = $('#credit');
  c.textContent = '出典: ' + ST.credits.map((x) => x.replace(/ … .*$/, '')).join(' / ');
  c.title = c.textContent;
}

// ------------------------------------------------------------------ 3D の土台

const view = $('#view');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.localClippingEnabled = true;
view.appendChild(renderer.domElement);
const labelRenderer = new CSS2DRenderer();
Object.assign(labelRenderer.domElement.style, { position: 'absolute', top: '0', left: '0', pointerEvents: 'none' });
view.appendChild(labelRenderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x15181c);
const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 5000);
camera.up.set(0, 0, 1);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.screenSpacePanning = false; // 平行移動は地面に沿って
// 地図アプリなどに合わせ、左ドラッグで移動・右ドラッグで回転 (three.js の初めの値は逆)
controls.mouseButtons = { LEFT: THREE.MOUSE.PAN, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f45, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(-100, -150, 300);
scene.add(sun);

const world = new THREE.Group(); // 縦の強調 (scale.z) をまとめてかける
scene.add(world);

const B = meta.bounds;
const clip = { top: Math.ceil(B.zmax + 1), bottom: Math.floor(B.zmin - 1) - 10, zscale: 1, focusLevel: null };
const planes = [new THREE.Plane(new THREE.Vector3(0, 0, -1), 0), new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)];
function updatePlanes() {
  planes[0].constant = clip.top * clip.zscale;
  planes[1].constant = -clip.bottom * clip.zscale;
}

// ------------------------------------------------------------------ PLATEAU の面

const layerMeshes = {};
for (const L of LAYERS) {
  const buf = types[L.type];
  if (!buf) continue;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(buf.pos, 3));
  g.setIndex(new THREE.BufferAttribute(buf.idx, 1));
  g.computeVertexNormals();
  if (L.ramp) {
    const col = new Float32Array(buf.pos.length);
    const c = new THREE.Color();
    for (let i = 0; i < buf.pos.length; i += 3) {
      const t = (buf.pos[i + 2] - B.zmin) / (B.zmax - B.zmin);
      c.setHSL(0.08, 0.1, 0.24 + 0.3 * t); // 深いほど暗い無彩色 (状態の色を目立たせる)
      col[i] = c.r; col[i + 1] = c.g; col[i + 2] = c.b;
    }
    g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  }
  const m = new THREE.MeshLambertMaterial({
    color: L.ramp ? 0xffffff : L.color,
    vertexColors: !!L.ramp,
    transparent: L.opacity < 1,
    opacity: L.opacity,
    side: THREE.DoubleSide,
    depthWrite: L.opacity >= 0.6,
    clippingPlanes: planes,
    polygonOffset: !!L.ramp,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.visible = L.visible;
  mesh.userData = { type: L.type, tri: buf.tri };
  mesh.renderOrder = L.ramp ? 0 : 1;
  world.add(mesh);
  layerMeshes[L.type] = mesh;
}

$('#layers').innerHTML = LAYERS.filter((L) => layerMeshes[L.type]).map((L) => `
  <label class="layer"><input type="checkbox" data-layer="${L.type}" ${L.visible ? 'checked' : ''}>
    <span><i style="background:#${L.color.toString(16).padStart(6, '0')}"></i> ${L.label}</span>
    <input type="range" data-opacity="${L.type}" min="0.05" max="1" step="0.05" value="${L.opacity}" title="不透明度"></label>`).join('');
$('#layers').addEventListener('input', (ev) => {
  const t = ev.target;
  if (t.dataset.layer) layerMeshes[t.dataset.layer].visible = t.checked;
  if (t.dataset.opacity) {
    const m = layerMeshes[t.dataset.opacity].material;
    m.opacity = Number(t.value);
    m.transparent = m.opacity < 1;
    m.depthWrite = m.opacity >= 0.6;
    m.needsUpdate = true;
  }
});

// ------------------------------------------------------------------ 構内図 (国土交通省 構内地図データ)
// 階 (ordinal = level_index) ごとの床の形を、その階の推定標高 (手入力があればそれ) の少し上に、薄い面と輪郭線で描く。
// PLATEAU・ODPT と位置を見比べるためのもの。選択の対象にはしない。
const smap = await fetch(`data/stationmap-${STATION}.json${VER}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
const SMAP_KIND = { w: '通路・コンコース', s: '階段', e: 'エスカレーター', v: 'エレベーター', r: 'スロープ', t: 'トイレ' };
const SMAP_COLOR = { w: 0x9fb3c8, wt: 0x5b8dd6, s: 0xff9f43, e: 0xa29bfe, v: 0xff6b6b, r: 0x48dbfb, t: 0x4dabf7 };
const smapGroup = new THREE.Group();
world.add(smapGroup);
const smapState = { visible: true, opacity: 0.3, sig: '' };

function levelZByIndex(ord) {
  const l = Object.values(result.levels).find((v) => v.level_index === Number(ord));
  return l ? l.z : null;
}

function buildStationMap() {
  if (!smap) return;
  const sig = Object.keys(smap.levels).map(levelZByIndex).join(',');
  if (sig === smapState.sig) return; // 階の標高が変わったときだけ作り直す
  smapState.sig = sig;
  for (const o of smapGroup.children) { o.geometry.dispose(); o.material.dispose(); }
  smapGroup.clear();
  const fill = {}, line = {};
  for (const s of smap.spaces) {
    const z0 = levelZByIndex(s.ord);
    if (z0 == null) continue;
    const z = z0 + 0.06; // 床にめり込まないよう少し上
    const key = s.kind === 'w' && s.toll ? 'wt' : s.kind;
    const toV2 = (r) => { const a = []; for (let i = 0; i < r.length; i += 2) a.push(new THREE.Vector2(r[i], r[i + 1])); return a; };
    const contour = toV2(s.rings[0]), holes = s.rings.slice(1).map(toV2);
    const pts = [...contour, ...holes.flat()];
    const f = (fill[key] ||= []);
    for (const t of THREE.ShapeUtils.triangulateShape(contour, holes))
      for (const i of t) f.push(pts[i].x, pts[i].y, z);
    const l = (line[key] ||= []);
    for (const r of s.rings)
      for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) l.push(r[j], r[j + 1], z, r[i], r[i + 1], z);
  }
  for (const [key, pos] of Object.entries(fill)) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({
      color: SMAP_COLOR[key], transparent: true, opacity: smapState.opacity, depthWrite: false,
      side: THREE.DoubleSide, clippingPlanes: planes,
    }));
    m.renderOrder = 2;
    m.userData.smap = 'fill';
    smapGroup.add(m);
  }
  for (const [key, pos] of Object.entries(line)) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: SMAP_COLOR[key], transparent: true, opacity: Math.min(1, smapState.opacity * 3), clippingPlanes: planes,
    }));
    m.renderOrder = 3;
    m.userData.smap = 'line';
    smapGroup.add(m);
  }
  smapGroup.visible = smapState.visible;
}

if (smap) {
  $('#layers').insertAdjacentHTML('beforeend', `
    <label class="layer" title="国土交通省 構内地図データ (${esc(smap.source)})。階ごとに、その階の標高に描く">
      <input type="checkbox" data-smap="1" checked>
      <span><i style="background:#9fb3c8"></i> 構内図 (国交省)</span>
      <input type="range" data-smap-op="1" min="0.05" max="1" step="0.05" value="${smapState.opacity}" title="不透明度"></label>`);
  $('#layers').addEventListener('input', (ev) => {
    const t = ev.target;
    if (t.dataset.smap) { smapState.visible = t.checked; smapGroup.visible = t.checked; }
    if (t.dataset.smapOp) {
      smapState.opacity = Number(t.value);
      for (const o of smapGroup.children)
        o.material.opacity = o.userData.smap === 'fill' ? smapState.opacity : Math.min(1, smapState.opacity * 3);
    }
  });
}

// 選択中のリンクが貫く壁 / ノードに紐付けた面 を強調する
const highlight = new THREE.Group();
world.add(highlight);
function surfaceMesh(surfIds, color) {
  const want = new Set(surfIds);
  const pos = [];
  for (const [t, buf] of Object.entries(types)) {
    for (let k = 0; k < buf.tri.length; k++) {
      if (!want.has(buf.tri[k])) continue;
      for (let j = 0; j < 3; j++) {
        const v = buf.idx[k * 3 + j] * 3;
        pos.push(buf.pos[v], buf.pos[v + 1], buf.pos[v + 2]);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const m = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthTest: false });
  const mesh = new THREE.Mesh(g, m);
  mesh.renderOrder = 5;
  return mesh;
}

// ------------------------------------------------------------------ ノードとリンク

const graph = new THREE.Group();
world.add(graph);
let nodePts = [], edgeLines = null, labels = [];
const lineMats = [];

// ノードは、拡大・縮小しても画面上で同じ大きさの点 (Points) で描く。実寸の球だと引いたときに小さすぎて選びにくい。
// ノード・リンク・印は transparent にして、半透明の床・壁 (transparent) より後に描く。
// three.js は不透明なものを先に、半透明なものを後に描くので、不透明のままだと renderOrder を上げても
// 半透明の床が上から塗られて「床の裏」に隠れる。半透明の組の中では renderOrder の大きいものが後
function circleTexture(ring) {
  const S = 64, cv = document.createElement('canvas');
  cv.width = cv.height = S;
  const g = cv.getContext('2d');
  g.beginPath();
  g.arc(S / 2, S / 2, S / 2 - (ring ? 6 : 4), 0, Math.PI * 2);
  if (ring) { g.lineWidth = 8; g.strokeStyle = '#fff'; g.stroke(); }
  else { g.fillStyle = '#fff'; g.fill(); g.lineWidth = 6; g.strokeStyle = 'rgba(10,14,18,0.9)'; g.stroke(); }
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const DOT = circleTexture(false), RING = circleTexture(true);
const NODE_PX = 9, NODE_BIG_PX = 14; // 中継点・乗降エリア / 出入口・ホーム
function marker(color, size) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
  const m = new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, map: RING, transparent: true, alphaTest: 0.2, depthTest: false }));
  m.renderOrder = 20;
  m.visible = false;
  world.add(m);
  return m;
}
const selMarker = marker(0x4dabf7, 26);
const pendMarker = marker(0xffd43b, 24);
const hoverMarker = marker(0xffffff, 22);
const selEdgeMat = new LineMaterial({ color: 0x4dabf7, linewidth: 7, depthTest: false, transparent: true });
lineMats.push(selEdgeMat);
const selEdge = new LineSegments2(new LineSegmentsGeometry(), selEdgeMat);
selEdge.renderOrder = 19;
selEdge.visible = false;
world.add(selEdge);
const hoverEdgeMat = new LineMaterial({ color: 0xffffff, linewidth: 5, depthTest: false, transparent: true, opacity: 0.85 });
lineMats.push(hoverEdgeMat);
const hoverEdge = new LineSegments2(new LineSegmentsGeometry(), hoverEdgeMat);
hoverEdge.renderOrder = 18;
hoverEdge.visible = false;
world.add(hoverEdge);
const hoverSurf = new THREE.Group(); // マウスの下の面 (クリックで選ばれる面)
world.add(hoverSurf);

const LIFT = 0.25; // 床にめり込まないよう少し浮かせて描く
let result = null;
let nodeById = new Map(), edgeById = new Map();

function inRange(z) {
  return z >= clip.bottom - 0.5 && z <= clip.top + 0.5;
}

function nodeColor(n) {
  if (!inRange(n.z)) return STATUS_COLOR.dim;
  if (n.reviewed) return STATUS_COLOR.done;
  return STATUS_COLOR[n.status] ?? STATUS_COLOR.ok;
}

function edgeColor(e) {
  const a = nodeById.get(e.from), b = nodeById.get(e.to);
  if (!inRange(a.z) && !inRange(b.z)) return EDGE_STATUS_COLOR.dim;
  if ($('#edge-color').value === 'mode') return MODE_COLOR[e.mode] ?? 0xffffff;
  if (e.reviewed) return EDGE_STATUS_COLOR.done;
  return EDGE_STATUS_COLOR[e.status] ?? EDGE_STATUS_COLOR.ok;
}

function drawGraph() {
  const front = $('#graph-front').checked;
  for (const p of nodePts) { graph.remove(p); p.geometry.dispose(); p.material.dispose(); }
  nodePts = [];
  if (edgeLines) { graph.remove(edgeLines); edgeLines.geometry.dispose(); }
  for (const l of labels) graph.remove(l);
  labels = [];

  const nodes = result.nodes.filter((n) => n.z != null);
  const c = new THREE.Color();
  for (const big of [false, true]) {
    const pos = [], col = [];
    for (const n of nodes) {
      if ((n.location_type === '2' || n.location_type === '0') !== big) continue;
      pos.push(n.x, n.y, n.z + LIFT);
      c.setHex(nodeColor(n));
      col.push(c.r, c.g, c.b);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const p = new THREE.Points(g, new THREE.PointsMaterial({
      size: big ? NODE_BIG_PX : NODE_PX, sizeAttenuation: false, map: DOT, vertexColors: true,
      transparent: true, alphaTest: 0.2, depthTest: !front,
    }));
    p.renderOrder = 10;
    graph.add(p);
    nodePts.push(p);
  }

  const pos = [], col = [];
  for (const e of result.edges) {
    const a = nodeById.get(e.from), b = nodeById.get(e.to);
    pos.push(a.x, a.y, a.z + LIFT, b.x, b.y, b.z + LIFT);
    c.setHex(edgeColor(e));
    col.push(c.r, c.g, c.b, c.r, c.g, c.b);
  }
  const lg = new LineSegmentsGeometry();
  lg.setPositions(pos);
  lg.setColors(col);
  const lm = lineMats[1] || new LineMaterial({ linewidth: 3, vertexColors: true, transparent: true });
  if (!lineMats[1]) lineMats.push(lm);
  lm.depthTest = !front;
  lm.needsUpdate = true;
  edgeLines = new LineSegments2(lg, lm);
  edgeLines.renderOrder = 9;
  graph.add(edgeLines);

  for (const n of nodes) {
    if (n.location_type !== '2' && n.location_type !== '0' && !(sel && sel.kind === 'node' && sel.id === n.id)) continue;
    const div = document.createElement('div');
    div.className = 'label3d' + (sel && sel.id === n.id ? ' sel' : '');
    div.textContent = n.location_type === '0' ? `ホーム ${n.src?.platform_code ?? ''}` : n.name || n.id;
    const o = new CSS2DObject(div);
    o.position.set(n.x, n.y, n.z + 2.2 / clip.zscale);
    graph.add(o);
    labels.push(o);
  }
  drawSelection();
}

function drawSelection() {
  highlight.clear();
  selMarker.visible = false;
  selEdge.visible = false;
  pendMarker.visible = false;
  if (pendingFrom && nodeById.has(pendingFrom)) {
    const n = nodeById.get(pendingFrom);
    pendMarker.position.set(n.x, n.y, n.z + LIFT);
    pendMarker.visible = true;
  }
  if (!sel) return;
  if (sel.kind === 'node' && nodeById.has(sel.id)) {
    const n = nodeById.get(sel.id);
    selMarker.position.set(n.x, n.y, n.z + LIFT);
    selMarker.visible = true;
    const surfs = [];
    if (n.link) { const i = meta.surfaces.findIndex((s) => s.id === n.link); if (i >= 0) surfs.push(i); }
    if (surfs.length) highlight.add(surfaceMesh(surfs, 0x22d3ee));
  }
  if (sel.kind === 'edge' && edgeById.has(sel.id)) {
    const e = edgeById.get(sel.id);
    const a = nodeById.get(e.from), b = nodeById.get(e.to);
    selEdge.geometry.setPositions([a.x, a.y, a.z + LIFT, b.x, b.y, b.z + LIFT]);
    selEdge.visible = true;
    if (e.walls.length) highlight.add(surfaceMesh(e.walls, 0xff4757));
  }
  if (sel.kind === 'surface') highlight.add(surfaceMesh([sel.si], 0x22d3ee));
}

// ------------------------------------------------------------------ 状態・履歴・保存

let sel = null; // { kind: 'node'|'edge'|'surface', id, si? }
let tool = 'select';
let pendingFrom = null;
const undoStack = [], redoStack = [];

function recompute() {
  result = runMatch(gtfs, meta, idx, edits);
  buildStationMap();
  nodeById = new Map(result.nodes.map((n) => [n.id, n]));
  edgeById = new Map(result.edges.map((e) => [e.id, e]));
  if (sel && sel.kind === 'node' && !nodeById.has(sel.id)) sel = null;
  if (sel && sel.kind === 'edge' && !edgeById.has(sel.id)) sel = null;
  if (pendingFrom && !nodeById.has(pendingFrom)) pendingFrom = null;
  drawGraph();
  renderLevels();
  renderIssues();
  renderSelection();
  syncTransform();
  renderSearchList();
}

// merge に同じキーを渡した連続の変更 (標高の入力中・矢印キーでの移動など) は、1.5 秒以内なら 1 回の「元に戻す」にまとめる
let lastMerge = { key: null, at: 0 };
function commit(mutate, msg, merge = null) {
  const now = Date.now();
  if (!(merge && lastMerge.key === merge && now - lastMerge.at < 1500)) {
    undoStack.push(JSON.stringify(edits));
    if (undoStack.length > 200) undoStack.shift();
  }
  lastMerge = { key: merge, at: now };
  redoStack.length = 0;
  mutate(edits);
  recompute();
  scheduleSave();
  if (msg) toast(msg);
}

function undo() {
  if (!undoStack.length) return;
  lastMerge = { key: null, at: 0 };
  redoStack.push(JSON.stringify(edits));
  edits = JSON.parse(undoStack.pop());
  recompute();
  scheduleSave();
  toast('元に戻しました');
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(JSON.stringify(edits));
  edits = JSON.parse(redoStack.pop());
  recompute();
  scheduleSave();
  toast('やり直しました');
}

let saveTimer = null;
function setSaveState(text, cls = '') {
  const el = $('#save-state');
  el.textContent = text;
  el.className = 'save-state ' + cls;
}
function scheduleSave() {
  setSaveState('未保存', 'dirty');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    try {
      if (SERVER) {
        const r = await fetch(`api/edits/${STATION}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(edits) });
        if (!r.ok) throw new Error(r.status);
      } else {
        localStorage.setItem(STORE_KEY, JSON.stringify(edits));
      }
      setSaveState(`${SERVER ? '' : 'ブラウザに'}保存済み ${new Date().toLocaleTimeString('ja-JP')}`);
    } catch (e) {
      setSaveState(SERVER ? '保存に失敗' : 'ブラウザに保存できません。JSON で保存してください', 'error');
    }
  }, 400);
}

let toastTimer = null;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2200);
}

const nodeEdit = (id) => (edits.nodes[id] ||= {});
const edgeEdit = (id) => (edits.pathways[id] ||= {});
function cleanup(obj, id) {
  if (obj[id] && !Object.keys(obj[id]).length) delete obj[id];
}

// ------------------------------------------------------------------ 左パネル: 階・切断・位置合わせ

function renderLevels() {
  const rows = Object.entries(result.levels).sort((a, b) => b[1].level_index - a[1].level_index);
  const srcLabel = { auto: '床から', roof: '屋根から', dem: '地理院標高', manual: '手入力', extrapolated: '外挿' };
  $('#levels tbody').innerHTML = rows.map(([id, l]) => {
    const n = result.nodes.filter((x) => x.level_id === id).length;
    return `<tr data-level="${esc(id)}" class="${clip.focusLevel === id ? 'focus' : ''}">
      <td title="${n} ノード">${esc(id)}</td>
      <td><input type="number" step="0.05" value="${l.z.toFixed(2)}" data-level-z="${esc(id)}"></td>
      <td class="src ${l.source}" title="${l.support != null ? '票 ' + l.support : ''}">${srcLabel[l.source] || l.source}</td>
      <td>${l.source === 'manual' ? `<button class="small" data-level-auto="${esc(id)}" title="自動推定に戻す">自動</button>` : ''}</td></tr>`;
  }).join('');
}
$('#levels').addEventListener('change', (ev) => {
  const id = ev.target.dataset.levelZ;
  if (id == null) return;
  const v = Number(ev.target.value);
  if (Number.isFinite(v)) commit((e) => { e.levels[id] = v; }, `階 ${id} の標高を ${v} m にしました`);
});
$('#levels').addEventListener('click', (ev) => {
  const auto = ev.target.dataset.levelAuto;
  if (auto != null) return commit((e) => { delete e.levels[auto]; }, `階 ${auto} を自動推定に戻しました`);
  if (ev.target.tagName === 'INPUT') return;
  const tr = ev.target.closest('tr[data-level]');
  if (!tr) return;
  const id = tr.dataset.level;
  if (clip.focusLevel === id) return resetClip();
  const z = result.levels[id].z;
  clip.focusLevel = id;
  setClip(z + 3.5, z - 1.5);
});

const clipTop = $('#clip-top'), clipBottom = $('#clip-bottom');
const zLo = Math.floor(B.zmin - 15);
const zHi = Math.ceil(B.zmax + 10);
for (const el of [clipTop, clipBottom]) { el.min = zLo; el.max = zHi; }
function setClip(top, bottom) {
  clip.top = top;
  clip.bottom = bottom;
  clipTop.value = top;
  clipBottom.value = bottom;
  $('#clip-top-v').textContent = `${top.toFixed(1)} m`;
  $('#clip-bottom-v').textContent = `${bottom.toFixed(1)} m`;
  updatePlanes();
  drawGraph();
  renderLevels();
}
function resetClip() {
  clip.focusLevel = null;
  setClip(zHi, zLo);
}
clipTop.addEventListener('input', () => { clip.focusLevel = null; setClip(Number(clipTop.value), Math.min(clip.bottom, Number(clipTop.value))); });
clipBottom.addEventListener('input', () => { clip.focusLevel = null; setClip(Math.max(clip.top, Number(clipBottom.value)), Number(clipBottom.value)); });
$('#clip-reset').addEventListener('click', resetClip);

function viewFrom(kind) {
  const t = controls.target.clone();
  const d = Math.max(camera.position.distanceTo(t), 60);
  if (kind === 'top') camera.position.set(t.x, t.y - 0.01, t.z + d);
  else camera.position.set(t.x - d * 0.45, t.y - d * 0.6, t.z + d * 0.65);
}
$('#view-top').addEventListener('click', () => viewFrom('top'));
$('#view-oblique').addEventListener('click', () => viewFrom('oblique'));

$('#zscale').addEventListener('input', (ev) => {
  clip.zscale = Number(ev.target.value);
  $('#zscale-v').textContent = `×${clip.zscale}`;
  world.scale.z = clip.zscale;
  updatePlanes();
  drawGraph();
});
$('#graph-front').addEventListener('change', drawGraph);
$('#edge-color').addEventListener('change', drawGraph);

$('#off-dx').value = edits.offset.dx;
$('#off-dy').value = edits.offset.dy;
for (const id of ['#off-dx', '#off-dy']) {
  $(id).addEventListener('change', () => {
    const dx = Number($('#off-dx').value) || 0, dy = Number($('#off-dy').value) || 0;
    commit((e) => { e.offset = { dx, dy }; }, `ODPT 全体を東 ${dx} m / 北 ${dy} m ずらしました`);
  });
}

// ------------------------------------------------------------------ 右パネル: 選択の詳細

function issueTags(list) {
  if (!list.length) return '<span class="tag ok">問題なし</span>';
  return list.map((i) => `<div><span class="tag ${i.severity}">${i.severity === 'warn' ? '要確認' : '参考'}</span> ${esc(i.text)}${i.nearest ? ` <small>(床: ${i.nearest.map(f2).join(', ')})</small>` : ''}${i.walls ? ` <small>(${i.walls} 枚)</small>` : ''}</div>`).join('');
}

// 入力欄に打っている最中は欄を作り直さない (カーソル位置や打ちかけの値が消えるため)。欄を離れたら描き直す
const selKey = () => (sel ? `${sel.kind}:${sel.id ?? sel.si}` : '');
function renderSelection() {
  const box = $('#selection');
  const act = document.activeElement;
  if (act && act.tagName === 'INPUT' && act.type !== 'checkbox' && box.contains(act) && box.dataset.sel === selKey()) {
    act.addEventListener('blur', () => renderSelection(), { once: true });
    return;
  }
  renderSelectionBody(box);
  box.dataset.sel = selKey();
}

function renderSelectionBody(box) {
  if (!sel) {
    box.innerHTML = '<h2>選択</h2><p class="hint">ノード・リンク・面をクリックすると詳細が出ます。</p>';
    return;
  }
  if (sel.kind === 'node') {
    const n = nodeById.get(sel.id);
    const [lat, lon] = toLatLon(n.x, n.y);
    const iss = result.issues.filter((i) => i.kind === 'node' && i.id === n.id);
    const conn = result.edges.filter((e) => e.from === n.id || e.to === n.id);
    const levelOpts = Object.entries(result.levels).sort((a, b) => b[1].level_index - a[1].level_index)
      .map(([id]) => `<option value="${esc(id)}" ${id === n.level_id ? 'selected' : ''}>${esc(id)}</option>`).join('');
    const zTag = { manual: '手入力', floor: '床に吸着', level: '階の標高', children: '乗降エリアから' }[n.zSource] || n.zSource;
    const linked = n.link ? meta.surfaces.find((s) => s.id === n.link) : null;
    box.innerHTML = `<h2>ノード ${n.added ? '<span class="tag manual">追加</span>' : ''} ${n.moved && !n.added ? '<span class="tag manual">移動済み</span>' : ''}</h2>
      <dl>
        <dt>stop_id</dt><dd>${esc(n.id)}</dd>
        <dt>名前</dt><dd>${esc(n.name) || '<span class="hint">なし</span>'}</dd>
        <dt>種別</dt><dd>${LOC_TYPE[n.location_type] ?? n.location_type}</dd>
        <dt>階</dt><dd>${n.level_id ? `<select id="sel-level">${levelOpts}</select>` : '<span class="hint">なし</span>'}</dd>
        <dt>緯度経度</dt><dd>${lat.toFixed(6)}, ${lon.toFixed(6)}</dd>
        <dt>標高</dt><dd>${f2(n.z)} m <span class="tag ${n.zSource === 'manual' ? 'manual' : ''}">${zTag}</span></dd>
        <dt>PLATEAU</dt><dd>${linked ? `<span class="idlink" data-surface="${esc(linked.id)}">${esc(linked.type)}</span> <button class="small" id="unlink">解除</button>` : '<span class="hint">未紐付け (L で面をクリック)</span>'}</dd>
      </dl>
      ${n.candidates && n.candidates.length ? `<div class="cands"><span class="hint">下にある床面 (クリックでその標高に):</span><br>${n.candidates.map((c) => `<button class="small" data-cand="${c.z}">${f2(c.z)} m</button>`).join('')}</div>` : ''}
      <div class="row">標高を手入力 <input type="number" id="z-in" step="0.05" value="${f2(n.z)}" title="入力するとすぐ反映 (▲▼ で 0.05 m ずつ)"> m
        ${n.zSource === 'manual' ? '<button class="small" id="z-auto">自動に戻す</button>' : ''}</div>
      <p class="hint">位置は矢印キーで画面の左右・奥/手前へ 0.1 m (Shift で 1 m)、PageUp / PageDown で上下。</p>
      <h2>指摘</h2>${issueTags(iss)}
      <h2>つながるリンク (${conn.length})</h2>
      <div>${conn.map((e) => `<span class="idlink" data-edge="${esc(e.id)}">${esc(e.id)}</span> ${MODE_NAMES[e.mode] ?? e.mode} → ${esc(e.from === n.id ? e.to : e.from)}`).join('<br>') || '<span class="hint">なし</span>'}</div>
      <label class="row"><input type="checkbox" id="reviewed" ${n.reviewed ? 'checked' : ''}> 確認済みにする <kbd>R</kbd></label>
      <textarea id="note" placeholder="メモ">${esc(n.note)}</textarea>
      <div class="btns">
        ${n.moved && !n.added ? '<button id="reset-pos">位置を ODPT に戻す</button>' : ''}
        <button id="focus">ここへ移動 <kbd>F</kbd></button>
        <button class="danger" id="del">削除 <kbd>Del</kbd></button>
      </div>`;
    box.querySelector('#sel-level')?.addEventListener('change', (ev) => commit((e) => { nodeEdit(n.id).level_id = ev.target.value; }, `${n.id} の階を ${ev.target.value} にしました`));
    box.querySelectorAll('[data-cand]').forEach((b) => b.addEventListener('click', () => commit((e) => { nodeEdit(n.id).z = Number(b.dataset.cand); }, `${n.id} の標高を ${b.dataset.cand} m にしました`)));
    // 打つたびに反映 (打ちかけの値で何度も描き直さないよう 250 ms 待つ。Enter ならすぐ)
    const zIn = box.querySelector('#z-in');
    const applyZ = () => {
      clearTimeout(zTimer);
      const v = Number(zIn.value);
      if (zIn.value === '' || !Number.isFinite(v) || Math.abs(v - n.z) < 0.001) return;
      commit(() => { nodeEdit(n.id).z = Math.round(v * 100) / 100; }, `${n.id} の標高を ${v} m にしました`, `z:${n.id}`);
    };
    zIn.addEventListener('input', () => { clearTimeout(zTimer); zTimer = setTimeout(applyZ, 250); });
    zIn.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') applyZ(); });
    box.querySelector('#z-auto')?.addEventListener('click', () => commit((e) => { delete nodeEdit(n.id).z; cleanup(e.nodes, n.id); }, '標高を自動推定に戻しました'));
    box.querySelector('#unlink')?.addEventListener('click', () => commit((e) => { delete nodeEdit(n.id).link; delete nodeEdit(n.id).linkType; cleanup(e.nodes, n.id); }, '紐付けを解除しました'));
    box.querySelector('#reset-pos')?.addEventListener('click', () => commit((e) => { const ed = nodeEdit(n.id); delete ed.x; delete ed.y; delete ed.z; cleanup(e.nodes, n.id); }, '位置を ODPT の値に戻しました'));
    bindCommon(box, () => nodeEdit(n.id), edits.nodes, n.id);
  } else if (sel.kind === 'edge') {
    const e = edgeById.get(sel.id);
    const iss = result.issues.filter((i) => i.kind === 'edge' && i.id === e.id);
    const modeOpts = Object.entries(MODE_NAMES).map(([k, v]) => `<option value="${k}" ${k === e.mode ? 'selected' : ''}>${k}: ${v}</option>`).join('');
    box.innerHTML = `<h2>リンク ${e.added ? '<span class="tag manual">追加</span>' : ''}</h2>
      <dl>
        <dt>pathway_id</dt><dd>${esc(e.id)}</dd>
        <dt>から</dt><dd><span class="idlink" data-node="${esc(e.from)}">${esc(e.from)}</span> (${esc(nodeById.get(e.from).level_id)})</dd>
        <dt>へ</dt><dd><span class="idlink" data-node="${esc(e.to)}">${esc(e.to)}</span> (${esc(nodeById.get(e.to).level_id)})</dd>
        <dt>種別</dt><dd><select id="mode">${modeOpts}</select></dd>
        <dt>向き</dt><dd><label><input type="checkbox" id="bidir" ${e.bidir === '1' ? 'checked' : ''}> 双方向</label></dd>
        <dt>長さ</dt><dd>GTFS ${f2(e.gtfsLength)} m / 3D ${f2(e.length3d)} m</dd>
        <dt>高低差</dt><dd>${f2(e.dz)} m</dd>
        <dt>貫く壁</dt><dd>${e.walls.length ? `<span class="tag warn">${e.walls.length} 枚 (赤で表示)</span>` : 'なし'}</dd>
      </dl>
      <h2>指摘</h2>${issueTags(iss)}
      <label class="row"><input type="checkbox" id="reviewed" ${e.reviewed ? 'checked' : ''}> 確認済みにする <kbd>R</kbd></label>
      <textarea id="note" placeholder="メモ (例: 実際は開口部。PLATEAU の壁が閉じている)">${esc(e.note)}</textarea>
      <div class="btns"><button id="focus">ここへ移動 <kbd>F</kbd></button><button class="danger" id="del">削除 <kbd>Del</kbd></button></div>`;
    box.querySelector('#mode').addEventListener('change', (ev) => commit(() => { edgeEdit(e.id).pathway_mode = ev.target.value; }, `${e.id} を ${MODE_NAMES[ev.target.value]} にしました`));
    box.querySelector('#bidir').addEventListener('change', (ev) => commit(() => { edgeEdit(e.id).is_bidirectional = ev.target.checked ? '1' : '0'; }));
    bindCommon(box, () => edgeEdit(e.id), edits.pathways, e.id);
  } else if (sel.kind === 'surface') {
    const s = meta.surfaces[sel.si];
    const linkable = lastNode && nodeById.has(lastNode);
    box.innerHTML = `<h2>PLATEAU の面</h2>
      <dl>
        <dt>種類</dt><dd>${esc(s.type)}</dd>
        <dt>gml:id</dt><dd>${esc(s.id)}</dd>
        <dt>部屋</dt><dd>${esc(s.room) || '-'}</dd>
        <dt>標高</dt><dd>${f2(s.zmin)} 〜 ${f2(s.zmax)} m</dd>
        ${sel.point ? `<dt>クリック点</dt><dd>${f2(sel.point.z)} m</dd>` : ''}
      </dl>
      <div class="btns">${linkable ? `<button id="link-last">ノード ${esc(lastNode)} に紐付け</button>` : ''}</div>`;
    box.querySelector('#link-last')?.addEventListener('click', () => linkSurface(lastNode, sel.si));
  }
  box.querySelectorAll('[data-node]').forEach((el) => el.addEventListener('click', () => select({ kind: 'node', id: el.dataset.node }, true)));
  box.querySelectorAll('[data-edge]').forEach((el) => el.addEventListener('click', () => select({ kind: 'edge', id: el.dataset.edge }, true)));
  box.querySelectorAll('[data-surface]').forEach((el) => el.addEventListener('click', () => {
    const si = meta.surfaces.findIndex((s) => s.id === el.dataset.surface);
    if (si >= 0) select({ kind: 'surface', si });
  }));
}

function bindCommon(box, getEdit, store, id) {
  box.querySelector('#reviewed').addEventListener('change', (ev) => commit(() => {
    if (ev.target.checked) getEdit().reviewed = true; else { delete getEdit().reviewed; cleanup(store, id); }
  }));
  box.querySelector('#note').addEventListener('change', (ev) => commit(() => {
    if (ev.target.value) getEdit().note = ev.target.value; else { delete getEdit().note; cleanup(store, id); }
  }));
  box.querySelector('#focus').addEventListener('click', focusSelection);
  box.querySelector('#del').addEventListener('click', deleteSelection);
}

function linkSurface(nodeId, si) {
  const s = meta.surfaces[si];
  commit(() => { const ed = nodeEdit(nodeId); ed.link = s.id; ed.linkType = s.type; }, `${nodeId} を ${s.type} に紐付けました`);
}

// ------------------------------------------------------------------ 右パネル: 指摘の一覧

function renderIssues() {
  const fw = $('#f-warn').checked, fi = $('#f-info').checked, fr = $('#f-reviewed').checked;
  const list = result.issues.filter((i) => ((i.severity === 'warn' && fw) || (i.severity === 'info' && fi)) && (fr || !i.reviewed));
  list.sort((a, b) => (a.severity === b.severity ? a.id.localeCompare(b.id) : a.severity === 'warn' ? -1 : 1));
  const open = result.issues.filter((i) => i.severity === 'warn' && !i.reviewed).length;
  $('#issue-count').textContent = `要確認 ${open} 件 / 全 ${result.issues.length} 件`;
  $('#issues').innerHTML = list.slice(0, 800).map((i) => `<li data-kind="${i.kind}" data-id="${esc(i.id)}" class="${i.reviewed ? 'reviewed' : ''} ${sel && sel.id === i.id ? 'sel' : ''}">
    <i style="background:var(--${i.reviewed ? 'done' : i.severity})"></i>
    <div>${esc(i.text)}<div class="id">${i.kind === 'node' ? 'ノード' : 'リンク'} ${esc(i.id)}</div></div></li>`).join('');
}
for (const id of ['#f-warn', '#f-info', '#f-reviewed']) $(id).addEventListener('change', renderIssues);
$('#issues').addEventListener('click', (ev) => {
  const li = ev.target.closest('li[data-id]');
  if (li) select({ kind: li.dataset.kind, id: li.dataset.id }, true);
});

// ------------------------------------------------------------------ 選択・ツール

let lastNode = null;
let zTimer = null;
function select(s, focus = false) {
  sel = s;
  if (s && s.kind === 'node') lastNode = s.id;
  drawGraph();
  renderSelection();
  renderIssues();
  syncTransform();
  if (focus) focusSelection();
}

function selectionCenter() {
  if (!sel) return null;
  if (sel.kind === 'node') { const n = nodeById.get(sel.id); return n && new THREE.Vector3(n.x, n.y, n.z); }
  if (sel.kind === 'edge') {
    const e = edgeById.get(sel.id);
    if (!e) return null;
    const a = nodeById.get(e.from), b = nodeById.get(e.to);
    return new THREE.Vector3((a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2);
  }
  if (sel.kind === 'surface' && sel.point) return sel.point.clone();
  if (sel.kind === 'surface') return surfaceCenter(sel.si);
  return null;
}

function surfaceCenter(si) {
  const buf = types[meta.surfaces[si].type];
  const c = new THREE.Vector3();
  let n = 0;
  for (let k = 0; k < buf.tri.length; k++) {
    if (buf.tri[k] !== si) continue;
    for (let j = 0; j < 3; j++) {
      const v = buf.idx[k * 3 + j] * 3;
      c.x += buf.pos[v]; c.y += buf.pos[v + 1]; c.z += buf.pos[v + 2];
      n++;
    }
  }
  return n ? c.divideScalar(n) : null;
}

// ------------------------------------------------------------------ 探す (ID・名前)

// 候補の一覧 (datalist)。ノードは名前・種別・階、リンクは種別と両端を添える
function renderSearchList() {
  const opts = [];
  for (const n of result.nodes)
    opts.push(`<option value="${esc(n.id)}">${esc([n.name, LOC_TYPE[n.location_type], n.level_id && '階 ' + n.level_id].filter(Boolean).join(' / '))}</option>`);
  for (const e of result.edges)
    opts.push(`<option value="${esc(e.id)}">${esc(`${MODE_NAMES[e.mode] ?? e.mode} ${e.from} → ${e.to}`)}</option>`);
  $('#search-list').innerHTML = opts.join('');
}

// 完全一致 (ID・出入口名・gml:id) → 一部一致が 1 件ならそれ → 複数なら候補を知らせる
function searchAndSelect(raw) {
  const q = raw.trim().toLowerCase();
  if (!q) return;
  let hit = null;
  const nExact = result.nodes.find((n) => n.id.toLowerCase() === q || (n.name && n.name.toLowerCase() === q));
  const eExact = result.edges.find((e) => e.id.toLowerCase() === q);
  if (nExact) hit = { kind: 'node', id: nExact.id };
  else if (eExact) hit = { kind: 'edge', id: eExact.id };
  else {
    const si = meta.surfaces.findIndex((s) => s.id.toLowerCase() === q);
    if (si >= 0) hit = { kind: 'surface', si };
  }
  if (!hit) {
    const parts = [
      ...result.nodes.filter((n) => n.id.toLowerCase().includes(q) || (n.name && n.name.toLowerCase().includes(q))).map((n) => ({ kind: 'node', id: n.id })),
      ...result.edges.filter((e) => e.id.toLowerCase().includes(q)).map((e) => ({ kind: 'edge', id: e.id })),
    ];
    if (parts.length === 1) hit = parts[0];
    else if (parts.length > 1) return toast(`「${raw.trim()}」は ${parts.length} 件: ${parts.slice(0, 6).map((p) => p.id).join(', ')}${parts.length > 6 ? ' …' : ''}。候補から選んでください`);
    else return toast(`「${raw.trim()}」は見つかりません (削除したノードやリンクは出ません)`);
  }
  // 高さで切って隠れているものは、全体表示に戻してから選ぶ
  const z = hit.kind === 'node' ? nodeById.get(hit.id).z : hit.kind === 'edge' ? null : surfaceCenter(hit.si)?.z;
  const hidden = hit.kind === 'edge'
    ? (() => { const e = edgeById.get(hit.id); return !inRange(nodeById.get(e.from).z) && !inRange(nodeById.get(e.to).z); })()
    : z != null && !inRange(z);
  if (hidden) resetClip();
  select(hit, true);
  toast(`${hit.kind === 'surface' ? meta.surfaces[hit.si].type + ' ' + meta.surfaces[hit.si].id : hit.id} を選びました`);
}

$('#search').addEventListener('keydown', (ev) => {
  if (ev.key === 'Enter') { ev.preventDefault(); searchAndSelect(ev.target.value); }
  if (ev.key === 'Escape') ev.target.blur();
});
// 候補 (datalist) から選んだときは、そのまま選ぶ
$('#search').addEventListener('input', (ev) => {
  if (ev.inputType === 'insertReplacementText' || ev.inputType === undefined) {
    const v = ev.target.value.trim();
    if (nodeById.has(v) || edgeById.has(v)) searchAndSelect(v);
  }
});

function focusSelection() {
  const c = selectionCenter();
  if (!c) return;
  c.z *= clip.zscale;
  const dir = camera.position.clone().sub(controls.target);
  const dist = Math.min(Math.max(dir.length(), 25), 60);
  dir.setLength(dist);
  controls.target.copy(c);
  camera.position.copy(c).add(dir);
}

function deleteSelection() {
  if (!sel) return;
  if (sel.kind === 'node') {
    const id = sel.id, n = nodeById.get(id);
    commit((e) => {
      if (n.added) e.addedNodes = e.addedNodes.filter((a) => a.id !== id);
      else e.deletedNodes.push(id);
      delete e.nodes[id];
    }, `ノード ${id} を削除しました (つながるリンクも書き出されません)`);
  } else if (sel.kind === 'edge') {
    const id = sel.id, ed = edgeById.get(id);
    commit((e) => {
      if (ed.added) e.addedPathways = e.addedPathways.filter((p) => p.pathway_id !== id);
      else e.deletedPathways.push(id);
      delete e.pathways[id];
    }, `リンク ${id} を削除しました`);
  }
  sel = null;
  renderSelection();
}

function setTool(t) {
  tool = t;
  pendingFrom = null;
  document.querySelectorAll('[data-tool]').forEach((b) => b.classList.toggle('active', b.dataset.tool === t));
  const hints = {
    select: 'クリックで選択。左ドラッグで移動、右ドラッグで回転、ホイールで拡大縮小。選択中のノードは矢印キーで動かせます (Shift で 1 m、PageUp/Down で上下)。',
    move: '赤い矢印で東西、緑で南北、青で上下にドラッグ (水平だけなら標高は床に自動で合わせます)。床をクリックでその点へ。矢印キーで画面の左右・奥/手前へ 0.1 m (Shift で 1 m)。',
    addNode: '床をクリックすると、そこに中継点ノードを追加します。',
    addEdge: 'つなぐノードを順にクリック。続けてクリックすると数珠つなぎに追加。Esc で終了。',
    link: '選択中のノードに紐付ける PLATEAU の面 (扉など) をクリック。',
  };
  $('#hint').textContent = hints[t];
  syncTransform();
  drawSelection();
}
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool)));
$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);

// 移動ツール: 選択中ノードに矢印 (TransformControls) を付ける
const proxy = new THREE.Object3D();
world.add(proxy);
const tc = new TransformControls(camera, renderer.domElement);
tc.setSize(0.8);
scene.add(tc.getHelper());
let dragAxis = null;
tc.addEventListener('dragging-changed', (ev) => {
  controls.enabled = !ev.value;
  if (ev.value) dragAxis = tc.axis;
});
tc.addEventListener('objectChange', () => {
  selMarker.position.copy(proxy.position);
});
tc.addEventListener('mouseUp', () => {
  if (!sel || sel.kind !== 'node') return;
  const id = sel.id, p = proxy.position.clone();
  p.z -= LIFT;
  const n = nodeById.get(id);
  if (Math.hypot(p.x - n.x, p.y - n.y, p.z - n.z) < 0.01) return; // 矢印をつかんだだけ
  const zMoved = dragAxis && dragAxis.includes('Z');
  commit((e) => {
    const ed = nodeEdit(id);
    ed.x = Math.round(p.x * 100) / 100;
    ed.y = Math.round(p.y * 100) / 100;
    if (zMoved) ed.z = Math.round(p.z * 100) / 100;
  }, zMoved ? `${id} を移動しました (標高は手入力扱い)` : `${id} を水平に移動しました (標高は自動)`);
});
function syncTransform() {
  if (tool === 'move' && sel && sel.kind === 'node' && nodeById.has(sel.id)) {
    const n = nodeById.get(sel.id);
    proxy.position.set(n.x, n.y, n.z + LIFT);
    tc.attach(proxy);
  } else tc.detach();
}

// ------------------------------------------------------------------ クリック判定

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();

function screenOf(x, y, z) {
  const v = new THREE.Vector3(x, y, (z + LIFT) * clip.zscale).project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  return { x: ((v.x + 1) / 2) * r.width, y: ((1 - v.y) / 2) * r.height, behind: v.z > 1, depth: v.z };
}

// ---- 候補を集める
// ノード・リンクは画面上の距離で拾う (球にレイを当てるより確実)。面はレイが当たったものを手前から。
// 同じ場所をもう一度クリックすると、重なっている次の候補に移る (choose の cycle)。
const NODE_R = 12, EDGE_R = 7; // 拾う距離 (画面上の px)
const FLOOR_TYPES = ['FloorSurface', 'GroundSurface', 'IntBuildingInstallation'];

function graphCandidates(px, py, { nodes = true, edges = true } = {}) {
  const out = [];
  if (nodes) {
    for (const n of result.nodes) {
      if (n.z == null || !inRange(n.z)) continue;
      const s = screenOf(n.x, n.y, n.z);
      if (s.behind) continue;
      const d = Math.hypot(s.x - px, s.y - py);
      if (d < NODE_R) out.push({ kind: 'node', id: n.id, d, depth: s.depth });
    }
  }
  if (edges) {
    for (const e of result.edges) {
      const a = nodeById.get(e.from), b = nodeById.get(e.to);
      if (!inRange(a.z) && !inRange(b.z)) continue;
      const sa = screenOf(a.x, a.y, a.z), sb = screenOf(b.x, b.y, b.z);
      if (sa.behind || sb.behind) continue;
      const vx = sb.x - sa.x, vy = sb.y - sa.y, L = vx * vx + vy * vy;
      const t = L ? Math.max(0, Math.min(1, ((px - sa.x) * vx + (py - sa.y) * vy) / L)) : 0;
      const d = Math.hypot(sa.x + vx * t - px, sa.y + vy * t - py);
      // リンクはノードより後ろに並べる (端のノードの上ではノードを先に選ぶ)
      if (d < EDGE_R) out.push({ kind: 'edge', id: e.id, d: d + 100, depth: sa.depth + (sb.depth - sa.depth) * t });
    }
  }
  // 近い順。ほぼ同じ距離なら手前を先に
  out.sort((p, q) => (Math.abs(p.d - q.d) < 2 ? p.depth - q.depth : p.d - q.d));
  return out;
}

function surfaceCandidates(px, py, onlyTypes = null, max = 6) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set((px / r.width) * 2 - 1, -(py / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const meshes = Object.values(layerMeshes).filter((m) => m.visible && (!onlyTypes || onlyTypes.includes(m.userData.type)));
  const out = [], seen = new Set();
  for (const h of ray.intersectObjects(meshes, false)) {
    const p = world.worldToLocal(h.point.clone());
    if (p.z > clip.top + 0.01 || p.z < clip.bottom - 0.01) continue; // 切断で隠れている部分は拾わない
    const si = h.object.userData.tri[h.faceIndex];
    if (seen.has(si)) continue;
    seen.add(si);
    out.push({ kind: 'surface', si, point: p, type: h.object.userData.type });
    if (out.length >= max) break;
  }
  return out;
}

// ツールごとに、クリックで選べるものの候補
function candidatesFor(px, py) {
  if (tool === 'select') return [...graphCandidates(px, py), ...surfaceCandidates(px, py)];
  if (tool === 'move' || tool === 'link') {
    const g = graphCandidates(px, py, { edges: false });
    if (g.length) return g;
    if (!sel || sel.kind !== 'node') return [];
    return surfaceCandidates(px, py, tool === 'move' ? FLOOR_TYPES : null);
  }
  if (tool === 'addNode') return surfaceCandidates(px, py, FLOOR_TYPES, 1);
  if (tool === 'addEdge') return graphCandidates(px, py, { edges: false });
  return [];
}

// 床をクリックして置く操作 (移動先・ノード追加) は候補を切り替えず、いちばん手前の床を使う
const isPlacing = (list) => (tool === 'move' && list[0]?.kind === 'surface') || tool === 'addNode';

const keyOf = (c) => (c.kind === 'surface' ? 's' + c.si : c.kind[0] + c.id);
let cycle = { x: -99, y: -99, at: 0, i: 0, sig: '' };
// 同じ場所 (5 px 以内・4 秒以内) で同じ候補の組なら、次の候補を返す。advance=false は覗くだけ (マウスを乗せたとき)
function choose(px, py, list, advance) {
  if (!list.length) return { item: null, i: 0, n: 0 };
  const sig = list.map(keyOf).join('|');
  const again = Math.hypot(px - cycle.x, py - cycle.y) < 5 && Date.now() - cycle.at < 4000 && cycle.sig === sig;
  const i = again ? (cycle.i + 1) % list.length : 0;
  if (advance) cycle = { x: px, y: py, at: Date.now(), i, sig };
  return { item: list[i], i, n: list.length };
}

const SURFACE_NAMES = Object.fromEntries(LAYERS.map((L) => [L.type, L.label]));
function describe(c) {
  if (!c) return '';
  if (c.kind === 'node') {
    const n = nodeById.get(c.id);
    return `ノード ${n.id}${n.name ? ' ' + n.name : ''} (${LOC_TYPE[n.location_type] ?? ''}・階 ${n.level_id || '-'}・${f2(n.z)} m)`;
  }
  if (c.kind === 'edge') {
    const e = edgeById.get(c.id);
    return `リンク ${e.id} ${MODE_NAMES[e.mode] ?? e.mode} ${e.from} → ${e.to}`;
  }
  const s = meta.surfaces[c.si];
  return `${SURFACE_NAMES[s.type] ?? s.type} (${f2(c.point.z)} m)`;
}

// マウスの下で「クリックすると選ばれるもの」を強調する
let hoverSurfSi = -1;
function clearHoverSurf() {
  for (const o of hoverSurf.children) { o.geometry.dispose(); o.material.dispose(); }
  hoverSurf.clear();
}
function showHover(c) {
  hoverMarker.visible = false;
  hoverEdge.visible = false;
  if (!c || c.kind !== 'surface') { clearHoverSurf(); hoverSurfSi = -1; }
  if (!c) return;
  if (c.kind === 'node') {
    const n = nodeById.get(c.id);
    hoverMarker.position.set(n.x, n.y, n.z + LIFT);
    hoverMarker.visible = true;
  } else if (c.kind === 'edge') {
    const e = edgeById.get(c.id), a = nodeById.get(e.from), b = nodeById.get(e.to);
    hoverEdge.geometry.setPositions([a.x, a.y, a.z + LIFT, b.x, b.y, b.z + LIFT]);
    hoverEdge.visible = true;
  } else if (c.si !== hoverSurfSi) {
    // 面は塗らずに輪郭だけ (大きな床や天井を塗ると、マウスを動かすたびに画面の大半が光って見づらい)
    clearHoverSurf();
    const m = surfaceMesh([c.si], 0xfff3bf);
    const edges = new THREE.EdgesGeometry(m.geometry, 1);
    m.geometry.dispose();
    m.material.dispose();
    const line = new THREE.LineSegments(edges, new THREE.LineBasicMaterial({ color: 0xffe066, depthTest: false, transparent: true }));
    line.renderOrder = 18;
    hoverSurf.add(line);
    hoverSurfSi = c.si;
  }
}

function nearestLevel(z) {
  let best = null;
  for (const [id, l] of Object.entries(result.levels)) if (!best || Math.abs(l.z - z) < Math.abs(best[1].z - z)) best = [id, l];
  return best && best[0];
}

function onClick(px, py) {
  controls.update(); // 描画ループが止まっていた直後でも視点を最新にしてから判定する
  camera.updateMatrixWorld();
  const list = candidatesFor(px, py);
  const placing = isPlacing(list);
  const { item: c, i, n } = choose(px, py, list, !placing);
  if (n > 1 && !placing) toast(`重なっている ${n} 件の ${i + 1} 件目: ${describe(c)}（同じ場所をもう一度クリックで次へ）`);

  if (tool === 'select') return select(c ? { kind: c.kind, id: c.id, si: c.si, point: c.point } : null);
  if (tool === 'move') {
    if (c && c.kind === 'node') return select({ kind: 'node', id: c.id });
    if (!sel || sel.kind !== 'node') return toast('先に動かすノードをクリックしてください');
    if (!c) return;
    const id = sel.id;
    return commit((e) => {
      const ed = nodeEdit(id);
      ed.x = Math.round(c.point.x * 100) / 100;
      ed.y = Math.round(c.point.y * 100) / 100;
      ed.z = Math.round(c.point.z * 100) / 100;
    }, `${id} を床の上 (${f2(c.point.z)} m) に移動しました`);
  }
  if (tool === 'addNode') {
    if (!c) return toast('床をクリックしてください');
    let newId;
    commit((e) => {
      e.seq += 1;
      newId = `${STATION}X${String(e.seq).padStart(4, '0')}`;
      e.addedNodes.push({ id: newId, location_type: '3', level_id: nearestLevel(c.point.z), x: Math.round(c.point.x * 100) / 100, y: Math.round(c.point.y * 100) / 100 });
    }, 'ノードを追加しました');
    return select({ kind: 'node', id: newId });
  }
  if (tool === 'addEdge') {
    if (!c) return;
    if (!pendingFrom) { pendingFrom = c.id; drawSelection(); return toast(`${c.id} から。つなぐ先のノードをクリック`); }
    if (pendingFrom === c.id) return;
    const from = pendingFrom, to = c.id;
    if (result.edges.some((e) => (e.from === from && e.to === to) || (e.from === to && e.to === from)))
      return toast('その 2 つはすでにつながっています');
    let newId;
    commit((e) => {
      e.seq += 1;
      newId = `${STATION}LX${String(e.seq).padStart(4, '0')}`;
      e.addedPathways.push({ pathway_id: newId, from_stop_id: from, to_stop_id: to, pathway_mode: '1', is_bidirectional: '1' });
    }, `リンク ${from} → ${to} を追加しました (種別は通路。右で変更できます)`);
    pendingFrom = to;
    return select({ kind: 'edge', id: newId });
  }
  if (tool === 'link') {
    if (c && c.kind === 'node') return select({ kind: 'node', id: c.id });
    if (!sel || sel.kind !== 'node') return toast('先に紐付けるノードをクリックしてください');
    if (!c) return;
    return linkSurface(sel.id, c.si);
  }
}

let down = null;
renderer.domElement.addEventListener('pointerdown', (ev) => {
  down = { x: ev.offsetX, y: ev.offsetY, gizmo: tc.axis !== null, button: ev.button };
});
renderer.domElement.addEventListener('pointerup', (ev) => {
  if (!down || down.gizmo || down.button !== 0) return (down = null);
  if (Math.hypot(ev.offsetX - down.x, ev.offsetY - down.y) < 5) onClick(ev.offsetX, ev.offsetY);
  down = null;
});
let hoverReq = null;
renderer.domElement.addEventListener('pointermove', (ev) => {
  if (hoverReq || ev.buttons) return; // ボタンを押したまま (視点の移動・回転・矢印のドラッグ) は判定しない
  hoverReq = requestAnimationFrame(() => {
    hoverReq = null;
    if (!result) return;
    camera.updateMatrixWorld();
    const list = candidatesFor(ev.offsetX, ev.offsetY);
    const placing = isPlacing(list);
    const { item, i, n } = choose(ev.offsetX, ev.offsetY, list, false);
    showHover(item);
    renderer.domElement.style.cursor = item ? 'pointer' : '';
    let t = '';
    if (item) {
      t = (placing ? 'ここに置く: ' : 'クリックで: ') + describe(item);
      if (n > 1 && !placing) t += `（重なり ${n} 件中 ${i + 1} 件目。もう一度クリックで次）`;
    }
    $('#hover').textContent = t;
    $('#hover').title = t;
    $('#status').classList.toggle('hovering', !!t);
  });
});
renderer.domElement.addEventListener('pointerleave', () => {
  showHover(null);
  $('#hover').textContent = '';
  $('#status').classList.remove('hovering');
});

window.addEventListener('keydown', (ev) => {
  if (ev.target instanceof Element && ev.target.closest('input, textarea, select')) return;
  const k = ev.key.toLowerCase();
  if ((ev.ctrlKey || ev.metaKey) && k === 'z') { ev.preventDefault(); return ev.shiftKey ? redo() : undo(); }
  if ((ev.ctrlKey || ev.metaKey) && k === 'y') { ev.preventDefault(); return redo(); }
  if (ev.ctrlKey || ev.metaKey || ev.altKey) return;
  const tools = { v: 'select', m: 'move', n: 'addNode', c: 'addEdge', l: 'link' };
  if (tools[k]) return setTool(tools[k]);
  if (['arrowleft', 'arrowright', 'arrowup', 'arrowdown', 'pageup', 'pagedown'].includes(k) && sel && sel.kind === 'node') {
    ev.preventDefault();
    return nudge(k, ev.shiftKey);
  }
  if (k === 'delete' || k === 'backspace') return deleteSelection();
  if (k === 'f') return focusSelection();
  if (ev.key === '/') { ev.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  if (k === 't') return viewFrom('top');
  if (k === 'o') return viewFrom('oblique');
  if (k === 'r' && sel && sel.kind !== 'surface') return $('#reviewed')?.click();
  if (k === 'escape') {
    if (pendingFrom) { pendingFrom = null; drawSelection(); return; }
    return select(null);
  }
});

// 選択中のノードを、画面の左右・奥/手前 (水平) と上下へ少しずつ動かす。
// 水平に動かしても標高は自動 (床に吸着) のまま。上下は手入力扱い
function nudge(key, big) {
  const n = nodeById.get(sel.id);
  if (!n) return;
  const step = big ? 1 : 0.1;
  const r2 = (v) => Math.round(v * 100) / 100;
  if (key === 'pageup' || key === 'pagedown') {
    const z = r2(n.z + (key === 'pageup' ? step : -step));
    return commit(() => { nodeEdit(n.id).z = z; }, `${n.id} の標高を ${f2(z)} m にしました`, `nudge:${n.id}`);
  }
  // 画面の右 = カメラの x 軸 (OrbitControls は傾けないので水平)。奥 = 上向き × 右
  const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
  right.z = 0;
  right.normalize();
  const fwd = new THREE.Vector3(-right.y, right.x, 0);
  const [v, name] = { arrowright: [right, '右'], arrowleft: [right.clone().negate(), '左'], arrowup: [fwd, '奥'], arrowdown: [fwd.clone().negate(), '手前'] }[key];
  commit(() => {
    const ed = nodeEdit(n.id);
    ed.x = r2(n.x + v.x * step);
    ed.y = r2(n.y + v.y * step);
  }, `${n.id} を${name}へ ${step} m 動かしました`, `nudge:${n.id}`);
}

// ------------------------------------------------------------------ 書き出し

function buildExportBody() {
  const shifted = edits.offset.dx || edits.offset.dy;
  return {
    nodes: result.nodes.map((n) => {
      const [lat, lon] = toLatLon(n.x, n.y);
      return {
        id: n.id, name: n.name, location_type: n.location_type, level_id: n.level_id, x: n.x, y: n.y, z: n.z, lat, lon,
        zSource: n.zSource, moved: !!(n.moved || n.added || shifted), added: n.added, link: n.link,
        linkType: edits.nodes[n.id]?.linkType || '', floorSurfId: n.floorSurf != null ? meta.surfaces[n.floorSurf].id : '', status: n.status,
      };
    }),
    edges: result.edges.map((e) => ({ id: e.id, from: e.from, to: e.to, mode: e.mode, bidir: e.bidir, length3d: e.length3d, added: e.added, status: e.status })),
    levels: result.levels,
    issues: result.issues.map((i) => ({ kind: i.kind, id: i.id, severity: i.severity, code: i.code, text: i.text, reviewed: i.reviewed })),
  };
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const CREDIT = [
  '出典:',
  ...(ST.credits || [
    '3D都市モデル（Project PLATEAU）新宿区（2025年度） 国土交通省 … 地下街モデル LOD4',
    '東京都交通局・公共交通オープンデータ協議会 鉄道関連情報 (GTFS-Pathways) CC BY 4.0',
    '国土交通省「構内地図データ」(歩行空間ナビ) … 構内図 (表示だけ。書き出しには入らない)',
    '国土地理院 標高API … 地表の標高',
  ]).map((x) => '- ' + x),
  '  上記を加工して作成。x_ で始まるファイルは本ツールの拡張 (GTFS の仕様外)。',
].join('\n');

$('#export').addEventListener('click', async () => {
  const body = buildExportBody();
  if (SERVER) {
    try {
      const r = await fetch(`api/export/${STATION}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error);
      return toast(`${j.dir}/ に GTFS 一式を書き出しました (stops ${j.stops} 行 / pathways ${j.pathways} 行 / ${j.files.length} ファイル)`);
    } catch (e) {
      return toast(`書き出しに失敗: ${e.message}`);
    }
  }
  // 公開版: この駅の分だけを ZIP にしてダウンロード
  const files = { ...stationGtfsFiles(gtfs, body), ...extraFiles(STATION, body), 'README.txt': `${gtfs.station_name} (${STATION}) の編集結果\n\n${CREDIT}\n` };
  files['edits.json'] = JSON.stringify(edits, null, 2);
  download(`gtfs-pathway-${STATION}.zip`, makeZip(files));
  toast('この駅の stops / pathways / levels と標高 CSV を ZIP でダウンロードしました');
});

// 手修正の JSON を保存・読み込み (公開版ではこれが唯一の持ち出し手段)
$('#edits-save').addEventListener('click', () => {
  download(`edits-${STATION}.json`, new Blob([JSON.stringify(edits, null, 2) + '\n'], { type: 'application/json' }));
});
$('#edits-load').addEventListener('click', () => $('#edits-file').click());
$('#edits-file').addEventListener('change', async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  try {
    const raw = JSON.parse(await file.text());
    if (raw.station && raw.station !== STATION) throw new Error(`駅が違います (${raw.station})`);
    const loaded = normalizeEdits(raw);
    commit((e) => Object.assign(e, loaded), `${file.name} を読み込みました`);
    $('#off-dx').value = edits.offset.dx;
    $('#off-dy').value = edits.offset.dy;
  } catch (e) {
    toast(`読み込めません: ${e.message}`);
  }
});

// ------------------------------------------------------------------ 起動

function resize() {
  const w = view.clientWidth, h = view.clientHeight;
  renderer.setSize(w, h);
  labelRenderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  for (const m of lineMats) m.resolution.set(w, h);
}
new ResizeObserver(resize).observe(view);

recompute();
resetClip();
setTool('select');
resize();
setSaveState(`${SERVER ? 'ローカル' : '公開版 (ブラウザ保存)'} / ${Object.keys(edits.nodes).length || edits.addedNodes.length ? '手修正あり' : '手修正なし'}`);
$('#export').title = SERVER ? 'out/<駅>/ に GTFS 一式と標高 CSV を書き出す' : 'この駅の GTFS と標高 CSV を ZIP でダウンロード';

// 駅のノードが収まる位置にカメラを置く
{
  const ns = result.nodes.filter((n) => n.z != null);
  const cx = ns.reduce((s, n) => s + n.x, 0) / ns.length, cy = ns.reduce((s, n) => s + n.y, 0) / ns.length;
  const cz = ns.reduce((s, n) => s + n.z, 0) / ns.length;
  controls.target.set(cx, cy, cz);
  camera.position.set(cx - 120, cy - 160, cz + 150);
}

renderer.setAnimationLoop(() => {
  controls.update();
  renderer.render(scene, camera);
  labelRenderer.render(scene, camera);
});

window.__app = { get result() { return result; }, get edits() { return edits; }, select, setTool, onClick, candidatesFor, choose, tc, THREE, camera, layerMeshes, ray, renderer };
