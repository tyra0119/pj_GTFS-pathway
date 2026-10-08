// 書き出すファイルの中身を作る (依存なし)。ブラウザ (公開版の ZIP) と server.mjs (out/ への書き出し) の両方で使う。
//
// GTFS 本体に標高の項目は無い (levels.txt にも elevation は無い) ので、
// 標高と PLATEAU との対応は x_ で始まる拡張ファイルに出す。

const r6 = (v) => (Math.round(v * 1e6) / 1e6).toFixed(6);
const r2 = (v) => (v == null || Number.isNaN(v) ? '' : (Math.round(v * 100) / 100).toFixed(2));

const esc = (v) => {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function toCsv(header, rows, eol = '\n') {
  const out = [header.join(',')];
  for (const r of rows) out.push(header.map((h) => esc(r[h])).join(','));
  return out.join(eol) + eol;
}

/** 元の stops の行を、編集結果で差し替える (駅の配下だけ。駅そのものはそのまま) */
export function patchStopRow(row, n) {
  return { ...row, stop_lat: n.moved ? r6(n.lat) : row.stop_lat, stop_lon: n.moved ? r6(n.lon) : row.stop_lon, level_id: n.level_id ?? row.level_id };
}
export function newStopRow(n, station) {
  return { stop_id: n.id, stop_name: n.name || '', stop_lat: r6(n.lat), stop_lon: r6(n.lon), location_type: n.location_type || '3', parent_station: station, level_id: n.level_id || '' };
}
export function patchPathwayRow(row, e) {
  return { ...row, pathway_mode: e.mode, is_bidirectional: e.bidir };
}
export function newPathwayRow(e) {
  return { pathway_id: e.id, from_stop_id: e.from, to_stop_id: e.to, pathway_mode: e.mode, is_bidirectional: e.bidir, length: (Math.round(e.length3d * 10) / 10).toFixed(1) };
}

/**
 * 1 駅分の GTFS (stops / pathways / levels) を作る。公開版の ZIP 用。
 * gtfs = prep/build-gtfs.mjs の出力, body = app.js の buildExportBody()
 */
export function stationGtfsFiles(gtfs, body) {
  const nodeById = new Map(body.nodes.map((n) => [n.id, n]));
  const edgeById = new Map(body.edges.map((e) => [e.id, e]));
  const H = gtfs.headers;
  const stops = [];
  for (const s of gtfs.stops) {
    const row = Object.fromEntries(H.stops.map((h) => [h, s[h] ?? '']));
    if (s.stop_id === gtfs.station) { stops.push(row); continue; }
    const n = nodeById.get(s.stop_id);
    if (n) stops.push(patchStopRow(row, n));
  }
  for (const n of body.nodes) if (n.added) stops.push(newStopRow(n, gtfs.station));
  const pws = [];
  for (const p of gtfs.pathways) {
    const e = edgeById.get(p.pathway_id);
    if (e) pws.push(patchPathwayRow(Object.fromEntries(H.pathways.map((h) => [h, p[h] ?? ''])), e));
  }
  for (const e of body.edges) if (e.added) pws.push(newPathwayRow(e));
  return {
    'stops.txt': toCsv(H.stops, stops),
    'pathways.txt': toCsv(H.pathways, pws),
    'levels.txt': toCsv(H.levels, gtfs.levels),
  };
}

/** 標高・PLATEAU 対応・指摘・3D 線 (GeoJSON) */
export function extraFiles(station, body) {
  const nodeById = new Map(body.nodes.map((n) => [n.id, n]));
  const features = [];
  for (const n of body.nodes)
    features.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [Number(r6(n.lon)), Number(r6(n.lat)), Number(r2(n.z))] },
      properties: { stop_id: n.id, name: n.name, location_type: n.location_type, level_id: n.level_id, z_source: n.zSource, status: n.status },
    });
  for (const e of body.edges) {
    const a = nodeById.get(e.from), b = nodeById.get(e.to);
    features.push({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: [a, b].map((n) => [Number(r6(n.lon)), Number(r6(n.lat)), Number(r2(n.z))]) },
      properties: { pathway_id: e.id, pathway_mode: Number(e.mode), is_bidirectional: Number(e.bidir), length_3d: Number(r2(e.length3d)), status: e.status },
    });
  }
  return {
    'x_stop_elevations.csv': toCsv(['stop_id', 'level_id', 'elevation_tp_m', 'z_source', 'plateau_floor_gml_id'],
      body.nodes.map((n) => ({ stop_id: n.id, level_id: n.level_id, elevation_tp_m: r2(n.z), z_source: n.zSource, plateau_floor_gml_id: n.floorSurfId || '' }))),
    'x_level_elevations.csv': toCsv(['parent_station', 'level_id', 'level_index', 'elevation_tp_m', 'source'],
      Object.entries(body.levels).map(([id, l]) => ({ parent_station: station, level_id: id, level_index: l.level_index, elevation_tp_m: r2(l.z), source: l.source }))),
    'x_plateau_links.csv': toCsv(['stop_id', 'plateau_gml_id', 'plateau_type'],
      body.nodes.filter((n) => n.link).map((n) => ({ stop_id: n.id, plateau_gml_id: n.link, plateau_type: n.linkType || '' }))),
    'x_issues.csv': toCsv(['kind', 'id', 'severity', 'code', 'text', 'reviewed'],
      body.issues.map((i) => ({ ...i, reviewed: i.reviewed ? '1' : '0' }))),
    'x_pathways_3d.geojson': JSON.stringify({ type: 'FeatureCollection', features }),
  };
}
