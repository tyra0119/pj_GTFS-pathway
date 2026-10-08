// 自動突き合わせ: GTFS-Pathways のノード・リンクを PLATEAU 地下街の面に重ね、
// 標高を推定し、手で直すべき箇所を「指摘 (issue)」として返す。
// three.js に依存しない素の JS。ブラウザ (app.js) と Node (prep/report.mjs) の両方で使う。
//
// 入力:
//   plateau … { types: { FloorSurface: {pos, idx, tri}, ... }, surfaces: [...] , bounds }
//   gtfs    … prep/build-gtfs.mjs の出力 (1 駅分)
//   edits   … 手修正 (edits/<駅>.json)。自動結果より常に優先する
// 出力:
//   { levels, nodes, edges, issues }

export const PARAMS = {
  floorSearchR: 1.0, // ノード位置から床面を探す半径 (m)
  levelSnapTol: 1.5, // 階の推定標高からこの範囲の床面に吸着する (m)
  levelMinGap: 0.3, // 上下の階の標高差の最小値 (m)
  levelGapPerIndex: 2.0, // level_index が 1 違う階どうしに最低限ほしい標高差 (m)。0.5 違いなら 1.0 m
  defaultLevelHeight: 5.0, // 推定できない階を外挿するときの 1 階あたりの高さ (m)
  eyeHeight: 1.0, // 壁の貫通判定をする床からの高さ (m)
  walkwayMaxDz: 1.0, // 通路 (mode 1) で許す高低差 (m)
  verticalMinDz: 0.3, // 階段・エスカレーターで最低限ほしい高低差 (m)
};

export const MODE_NAMES = {
  1: '通路', 2: '階段', 3: '動く歩道', 4: 'エスカレーター', 5: 'エレベーター', 6: '改札', 7: '出場改札',
};

export const ISSUE_TEXT = {
  NO_FLOOR: 'ノードの下に PLATEAU の床面がない',
  OUTSIDE_MODEL: 'PLATEAU 地下街モデルの範囲外',
  LEVEL_MISMATCH: '床面はあるが、階の推定標高と合わない',
  NOT_MODELLED: 'この階の床が PLATEAU に無い (上の階の床だけある)',
  WALL_CROSS: 'リンクが壁を貫通している',
  DZ_WALKWAY: '通路なのに高低差が大きい',
  DZ_FLAT: '階段・エスカレーターなのに高低差がない',
  ELEVATOR_HORIZ: 'エレベーターの水平移動が大きい',
  LENGTH_DIFF: 'GTFS の length と 3D の長さが大きく違う',
  LEVEL_ESTIMATED: '階の標高を床面から決められず外挿した',
};

const SEVERITY_RANK = { error: 3, warn: 2, info: 1, ok: 0 };
export const worst = (issues) =>
  issues.reduce((w, i) => (SEVERITY_RANK[i.severity] > SEVERITY_RANK[w] ? i.severity : w), 'ok');

// ---------------------------------------------------------------- 空間索引

/** 三角形群を 2D グリッドに登録し、点の近く・線分の近くの三角形を素早く引く */
export class TriIndex {
  constructor(buf, cell = 2) {
    this.pos = buf.pos;
    this.idx = buf.idx;
    this.tri = buf.tri;
    this.cell = cell;
    this.grid = new Map();
    const { pos, idx } = this;
    for (let t = 0; t < idx.length / 3; t++) {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (let k = 0; k < 3; k++) {
        const v = idx[t * 3 + k] * 3;
        x0 = Math.min(x0, pos[v]); x1 = Math.max(x1, pos[v]);
        y0 = Math.min(y0, pos[v + 1]); y1 = Math.max(y1, pos[v + 1]);
      }
      for (let gx = Math.floor(x0 / cell); gx <= Math.floor(x1 / cell); gx++)
        for (let gy = Math.floor(y0 / cell); gy <= Math.floor(y1 / cell); gy++) {
          const key = gx * 100003 + gy;
          let a = this.grid.get(key);
          if (!a) this.grid.set(key, (a = []));
          a.push(t);
        }
    }
  }

  candidates(x0, y0, x1, y1) {
    const c = this.cell, out = new Set();
    for (let gx = Math.floor(x0 / c); gx <= Math.floor(x1 / c); gx++)
      for (let gy = Math.floor(y0 / c); gy <= Math.floor(y1 / c); gy++) {
        const a = this.grid.get(gx * 100003 + gy);
        if (a) for (const t of a) out.add(t);
      }
    return out;
  }

  vert(t, k) {
    const v = this.idx[t * 3 + k] * 3;
    return [this.pos[v], this.pos[v + 1], this.pos[v + 2]];
  }
}

// 点 p から 2D 三角形 abc への最近点 (重心座標付き)
function closestOnTri2D(px, py, a, b, c) {
  const v0x = b[0] - a[0], v0y = b[1] - a[1], v1x = c[0] - a[0], v1y = c[1] - a[1];
  const v2x = px - a[0], v2y = py - a[1];
  const d00 = v0x * v0x + v0y * v0y, d01 = v0x * v1x + v0y * v1y, d11 = v1x * v1x + v1y * v1y;
  const d20 = v2x * v0x + v2y * v0y, d21 = v2x * v1x + v2y * v1y;
  const den = d00 * d11 - d01 * d01;
  if (Math.abs(den) > 1e-12) {
    const v = (d11 * d20 - d01 * d21) / den, w = (d00 * d21 - d01 * d20) / den, u = 1 - v - w;
    if (u >= 0 && v >= 0 && w >= 0) return { d: 0, u, v, w };
  }
  // 外側: 3 辺への最近点のうち最も近いもの
  let best = null;
  const edges = [[a, b, 0, 1], [b, c, 1, 2], [c, a, 2, 0]];
  for (const [p, q, i, j] of edges) {
    const ex = q[0] - p[0], ey = q[1] - p[1];
    const L = ex * ex + ey * ey;
    let s = L > 0 ? ((px - p[0]) * ex + (py - p[1]) * ey) / L : 0;
    s = Math.max(0, Math.min(1, s));
    const dx = p[0] + ex * s - px, dy = p[1] + ey * s - py;
    const d = Math.hypot(dx, dy);
    if (!best || d < best.d) {
      const bc = [0, 0, 0];
      bc[i] = 1 - s; bc[j] = s;
      best = { d, u: bc[0], v: bc[1], w: bc[2] };
    }
  }
  return best;
}

/** (x, y) の真上・真下にある床面の候補。近い標高はまとめて、標高の高い順に返す */
export function floorCandidates(floorIdx, x, y, r = PARAMS.floorSearchR) {
  const hits = [];
  for (const t of floorIdx.candidates(x - r, y - r, x + r, y + r)) {
    const a = floorIdx.vert(t, 0), b = floorIdx.vert(t, 1), c = floorIdx.vert(t, 2);
    const h = closestOnTri2D(x, y, a, b, c);
    if (h.d > r) continue;
    hits.push({ z: h.u * a[2] + h.v * b[2] + h.w * c[2], d: h.d, surf: floorIdx.tri[t] });
  }
  hits.sort((p, q) => q.z - p.z);
  const clusters = [];
  for (const h of hits) {
    const last = clusters[clusters.length - 1];
    if (last && last.z - h.z < 0.3) {
      if (h.d < last.d) Object.assign(last, { d: h.d, surf: h.surf, z: h.z });
    } else clusters.push({ ...h });
  }
  return clusters;
}

// 線分と三角形の交差 (Möller–Trumbore)。0 < t < 1 で交差すれば true
function segTri(o, dir, a, b, c) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const p = [dir[1] * e2[2] - dir[2] * e2[1], dir[2] * e2[0] - dir[0] * e2[2], dir[0] * e2[1] - dir[1] * e2[0]];
  const det = e1[0] * p[0] + e1[1] * p[1] + e1[2] * p[2];
  if (Math.abs(det) < 1e-9) return false;
  const inv = 1 / det;
  const s = [o[0] - a[0], o[1] - a[1], o[2] - a[2]];
  const u = (s[0] * p[0] + s[1] * p[1] + s[2] * p[2]) * inv;
  if (u < 0 || u > 1) return false;
  const q = [s[1] * e1[2] - s[2] * e1[1], s[2] * e1[0] - s[0] * e1[2], s[0] * e1[1] - s[1] * e1[0]];
  const v = (dir[0] * q[0] + dir[1] * q[1] + dir[2] * q[2]) * inv;
  if (v < 0 || u + v > 1) return false;
  const t = (e2[0] * q[0] + e2[1] * q[1] + e2[2] * q[2]) * inv;
  return t > 0.02 && t < 0.98; // 端点ちょうどの壁は数えない
}

/** a→b の線分が貫く壁の面 (surface 番号) の一覧 */
export function wallCrossings(wallIdxs, a, b) {
  const dir = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const hit = new Set();
  for (const idx of wallIdxs) {
    const cand = idx.candidates(Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[0], b[0]), Math.max(a[1], b[1]));
    for (const t of cand) {
      const s = idx.tri[t];
      if (hit.has(s)) continue;
      if (segTri(a, dir, idx.vert(t, 0), idx.vert(t, 1), idx.vert(t, 2))) hit.add(s);
    }
  }
  return [...hit];
}

// ---------------------------------------------------------------- 階の標高

/**
 * 階ごとに、その階のノードの下にある床面の標高を投票で集め、
 * 「階番号が下がるほど標高も下がる」制約の下で投票数の合計が最大になる組を選ぶ (DP)。
 * 地上階 (level_index >= 0) は地下街の床に投票させない。level 0 は groundZ (地表の標高) を使う。
 * 決まらなかった階は前後の階から外挿する。手修正の値があればそれを使う。
 */
export function estimateLevels(levels, nodes, cands, levelEdits = {}, groundZ = null, groundSource = 'roof') {
  const peaksOf = (lid) => {
    const bins = new Map();
    for (const n of nodes) {
      if (n.level_id !== lid) continue;
      for (const c of cands.get(n.id) || []) {
        const b = Math.round(c.z / 0.25);
        bins.set(b, (bins.get(b) || 0) + 1);
      }
    }
    const peaks = [];
    for (const [b, w] of bins) {
      const s = w + 0.5 * ((bins.get(b - 1) || 0) + (bins.get(b + 1) || 0));
      if ((bins.get(b - 1) || 0) > w || (bins.get(b + 1) || 0) > w) continue;
      if (w >= 2) peaks.push({ z: b * 0.25, w: s });
    }
    peaks.sort((p, q) => q.w - p.w);
    return peaks.slice(0, 6);
  };

  const ls = [...levels].sort((a, b) => Number(b.level_index) - Number(a.level_index));
  const opts = ls.map((l) => {
    if (levelEdits[l.level_id] != null) return [{ z: Number(levelEdits[l.level_id]), w: 1e6, manual: true }];
    const li = Number(l.level_index);
    if (li === 0 && groundZ != null) return [{ z: groundZ, w: 1e3, ground: groundSource }];
    if (li >= 0) return [null];
    return [null, ...peaksOf(l.level_id)];
  });

  // DP: 状態 = 「直前に標高を決めた階の選択」。null (この階は決めない) を選んでも状態は変わらない。
  // 状態を「今の階の選択」で持つと、null どうしが 1 つにまとまって別経路の可能性が消えるので注意。
  // 手入力の階は順序の制約を受けない (利用者の判断を優先する)。
  let states = new Map([['top', { lastZ: Infinity, lastIdx: Infinity, score: 0, picks: [] }]]);
  for (let i = 0; i < ls.length; i++) {
    const next = new Map();
    const put = (key, st) => {
      const cur = next.get(key);
      if (!cur || st.score > cur.score) next.set(key, st);
    };
    for (const [key, st] of states) {
      opts[i].forEach((o, k) => {
        if (!o) return put(key, { ...st, picks: [...st.picks, null] });
        const li = Number(ls[i].level_index);
        const gap = Number.isFinite(st.lastIdx) ? Math.max(PARAMS.levelMinGap, PARAMS.levelGapPerIndex * (st.lastIdx - li)) : 0;
        if (!o.manual && !(o.z <= st.lastZ - gap)) return;
        put(`${i}:${k}`, { lastZ: o.z, lastIdx: li, score: st.score + o.w, picks: [...st.picks, o] });
      });
    }
    states = next;
  }
  const bestState = [...states.values()].reduce((p, q) => (q.score > p.score ? q : p));
  const chosen = bestState.picks;

  // 外挿: 決まった階が 1 つ以上あれば、そこから 1 階 (level_index 1) あたり既定の高さで延ばす。
  // 0.5 刻みの中間階が多く、実測の傾きは安定しないので固定値にしている (画面で手修正する前提)
  const known = ls.map((l, i) => ({ idx: Number(l.level_index), o: chosen[i] })).filter((v) => v.o);
  const slope = PARAMS.defaultLevelHeight;

  const result = {};
  ls.forEach((l, i) => {
    const li = Number(l.level_index);
    const o = chosen[i];
    if (o) {
      const source = o.manual ? 'manual' : o.ground || 'auto';
      result[l.level_id] = { z: o.z, support: source === 'auto' ? o.w : null, source, level_index: li };
      return;
    }
    let z;
    if (known.length) {
      // 最も近い既知の階から傾きで外挿 (間にあれば線形補間)
      const above = known.filter((v) => v.idx > li).sort((a, b) => a.idx - b.idx)[0];
      const below = known.filter((v) => v.idx < li).sort((a, b) => b.idx - a.idx)[0];
      if (above && below) z = below.o.z + ((li - below.idx) / (above.idx - below.idx)) * (above.o.z - below.o.z);
      else if (above) z = above.o.z - (above.idx - li) * slope;
      else z = below.o.z + (li - below.idx) * slope;
    } else z = li * PARAMS.defaultLevelHeight;
    result[l.level_id] = { z: Math.round(z * 100) / 100, support: 0, source: 'extrapolated', level_index: li };
  });
  return result;
}

// ---------------------------------------------------------------- 本体

/** 手修正を反映した「今のグラフ」を作る (自動推定の前段) */
export function applyEdits(gtfs, edits) {
  const e = edits || {};
  const off = e.offset || { dx: 0, dy: 0 };
  const nodeEd = e.nodes || {};
  const deleted = new Set(e.deletedNodes || []);
  const nodes = [];
  for (const s of gtfs.stops) {
    if (s.stop_id === gtfs.station || deleted.has(s.stop_id)) continue;
    const ed = nodeEd[s.stop_id] || {};
    nodes.push({
      id: s.stop_id,
      src: s,
      name: s.stop_name,
      location_type: s.location_type,
      parent: s.parent_station,
      level_id: ed.level_id ?? s.level_id,
      x: ed.x ?? s.x + off.dx,
      y: ed.y ?? s.y + off.dy,
      zManual: ed.z ?? null,
      moved: ed.x != null,
      link: ed.link ?? null,
      reviewed: !!ed.reviewed,
      note: ed.note || '',
      added: false,
    });
  }
  for (const a of e.addedNodes || []) {
    if (deleted.has(a.id)) continue;
    const ed = nodeEd[a.id] || {};
    nodes.push({
      id: a.id, src: null, name: a.name || '', location_type: a.location_type || '3', parent: gtfs.station,
      level_id: ed.level_id ?? a.level_id, x: ed.x ?? a.x, y: ed.y ?? a.y, zManual: ed.z ?? a.z ?? null,
      moved: true, link: ed.link ?? null, reviewed: !!ed.reviewed, note: ed.note || '', added: true,
    });
  }
  const ids = new Set(nodes.map((n) => n.id));
  const delEdges = new Set(e.deletedPathways || []);
  const edgeEd = e.pathways || {};
  const edges = [];
  for (const p of [...gtfs.pathways, ...(e.addedPathways || []).map((p) => ({ ...p, _added: true }))]) {
    if (delEdges.has(p.pathway_id)) continue;
    if (!ids.has(p.from_stop_id) || !ids.has(p.to_stop_id)) continue;
    const ed = edgeEd[p.pathway_id] || {};
    edges.push({
      id: p.pathway_id,
      src: p,
      from: p.from_stop_id,
      to: p.to_stop_id,
      mode: String(ed.pathway_mode ?? p.pathway_mode),
      bidir: String(ed.is_bidirectional ?? p.is_bidirectional ?? '1'),
      gtfsLength: p.length ? Number(p.length) : null,
      reviewed: !!ed.reviewed,
      note: ed.note || '',
      added: !!p._added,
    });
  }
  return { nodes, edges };
}

/**
 * 自動突き合わせを走らせる。
 * idx = { floor: TriIndex, walls: [TriIndex...], doors: TriIndex|null }
 */
export function runMatch(gtfs, plateau, idx, edits) {
  const { nodes, edges } = applyEdits(gtfs, edits);
  const B = plateau.bounds;
  const inside = (n) => n.x >= B.xmin && n.x <= B.xmax && n.y >= B.ymin && n.y <= B.ymax;

  const cands = new Map();
  for (const n of nodes) cands.set(n.id, inside(n) ? floorCandidates(idx.floor, n.x, n.y) : []);

  const levelIndex = Object.fromEntries(gtfs.levels.map((l) => [l.level_id, Number(l.level_index)]));
  const isStreet = (n) => (levelIndex[n.level_id] ?? -1) >= 0;

  // 地表の標高: 前処理で国土地理院の標高 API から取った値があればそれ (source: dem)。
  // 無ければ地上階ノードの近くにある地下街の屋根面 (地下構造物の上端) の最高値の中央値 (source: roof。高めに出やすい)
  let groundZ = gtfs.ground ? gtfs.ground.z : null;
  if (groundZ == null && idx.roof) {
    const tops = [];
    for (const n of nodes) {
      if (!isStreet(n) || !inside(n)) continue;
      const rs = floorCandidates(idx.roof, n.x, n.y, 3);
      if (rs.length) tops.push(rs[0].z);
    }
    tops.sort((a, b) => a - b);
    if (tops.length) groundZ = Math.round(tops[Math.floor(tops.length / 2)] * 100) / 100;
  }

  const levels = estimateLevels(gtfs.levels, nodes, cands, (edits && edits.levels) || {}, groundZ, gtfs.ground ? 'dem' : 'roof');

  const issues = [];
  const add = (kind, id, code, severity, extra = {}) => {
    const reviewed = kind === 'node' ? byId.get(id)?.reviewed : edgeById.get(id)?.reviewed;
    issues.push({ kind, id, code, severity, text: ISSUE_TEXT[code], reviewed: !!reviewed, ...extra });
  };
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const edgeById = new Map(edges.map((e) => [e.id, e]));

  for (const n of nodes) {
    const lv = levels[n.level_id];
    const lz = lv ? lv.z : null;
    const cs = cands.get(n.id);
    n.candidates = cs;
    n.issues = [];
    if (n.zManual != null) {
      n.z = n.zManual;
      n.zSource = 'manual';
    } else if (isStreet(n)) {
      n.z = lz ?? 0;
      n.zSource = 'level';
    } else if (cs.length && lz != null) {
      const near = cs.reduce((b, c) => (Math.abs(c.z - lz) < Math.abs(b.z - lz) ? c : b));
      if (Math.abs(near.z - lz) <= PARAMS.levelSnapTol) {
        n.z = near.z;
        n.zSource = 'floor';
        n.floorSurf = near.surf;
      } else {
        n.z = lz;
        n.zSource = 'level';
      }
    } else {
      n.z = lz ?? 0;
      n.zSource = 'level';
    }

    if (n.zSource !== 'manual') {
      if (!inside(n)) n.issues.push(['OUTSIDE_MODEL', 'info']);
      else if (isStreet(n)) { /* 地上は床面が無くて当然 */ }
      else if (!cs.length) n.issues.push(['NO_FLOOR', 'warn']);
      else if (n.zSource === 'level') {
        const allAbove = cs.every((c) => c.z > lz + PARAMS.levelSnapTol);
        n.issues.push([allAbove ? 'NOT_MODELLED' : 'LEVEL_MISMATCH', allAbove ? 'info' : 'warn', { nearest: cs.map((c) => c.z) }]);
      }
      if (lv && lv.source === 'extrapolated') n.issues.push(['LEVEL_ESTIMATED', 'info']);
    }
    if (!n.level_id) n.issues = []; // 階の無いホーム (location_type 0) は下で乗降エリアから決める
    for (const [code, sev, extra] of n.issues) add('node', n.id, code, sev, extra);
    n.status = worst(n.issues.map(([, s]) => ({ severity: s })));
  }

  // 階の無いホームは、配下の乗降エリアの平均位置に置く (GTFS ではホーム自体にリンクは張られない)
  for (const n of nodes) {
    if (n.level_id || n.zManual != null) continue;
    const kids = nodes.filter((k) => k.parent === n.id);
    if (!kids.length) continue;
    if (!n.moved) {
      n.x = kids.reduce((s, k) => s + k.x, 0) / kids.length;
      n.y = kids.reduce((s, k) => s + k.y, 0) / kids.length;
    }
    n.z = kids.reduce((s, k) => s + k.z, 0) / kids.length;
    n.zSource = 'children';
  }

  for (const e of edges) {
    const a = byId.get(e.from), b = byId.get(e.to);
    e.issues = [];
    const dz = b.z - a.z;
    const hd = Math.hypot(b.x - a.x, b.y - a.y);
    e.length3d = Math.hypot(hd, dz);
    e.dz = dz;
    const m = Number(e.mode);
    if (inside(a) || inside(b)) {
      const h = PARAMS.eyeHeight;
      const walls = wallCrossings(idx.walls, [a.x, a.y, a.z + h], [b.x, b.y, b.z + h]);
      e.walls = walls;
      if (walls.length) e.issues.push(['WALL_CROSS', 'warn', { walls: walls.length }]);
    } else e.walls = [];
    if (m === 1 && Math.abs(dz) > PARAMS.walkwayMaxDz) e.issues.push(['DZ_WALKWAY', 'warn', { dz }]);
    if ((m === 2 || m === 4 || m === 3) && Math.abs(dz) < PARAMS.verticalMinDz && hd > 0.5)
      e.issues.push(['DZ_FLAT', 'warn', { dz }]);
    if (m === 5 && hd > 3) e.issues.push(['ELEVATOR_HORIZ', 'info', { hd }]);
    if (e.gtfsLength && Math.abs(e.length3d - e.gtfsLength) > 3 &&
        (e.length3d / e.gtfsLength > 1.5 || e.length3d / e.gtfsLength < 0.67))
      e.issues.push(['LENGTH_DIFF', 'info', { gtfs: e.gtfsLength, l3d: e.length3d }]);
    for (const [code, sev, extra] of e.issues) add('edge', e.id, code, sev, extra);
    e.status = worst(e.issues.map(([, s]) => ({ severity: s })));
  }

  return { levels, nodes, edges, issues };
}
