// data/osm-raw.json (Overpass 결과) → 게임용 도로 그래프·건물·물·공원
// 사용: node tools/build-map.mjs [in] [out]
//   out 이 .json 으로 끝나면 한 파일, 아니면 폴더로 보고 타일(1km)·index.json·overview.png 를 쓴다 (스트리밍용)
import { mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const IN = process.argv[2] ?? 'data/osm-raw.json';
const OUT = process.argv[3] ?? 'public/map/seoul';
const TILE = 1000;
const raw = JSON.parse(readFileSync(IN, 'utf8'));

// ----- 좌표: x = 동쪽(m), z = 남쪽(m). 화면에서 북쪽이 위로 오게 -----
const osmNodes = new Map();
const ways = new Map();
const relations = [];
for (const e of raw.elements) {
  if (e.type === 'node') {
    // 같은 노드가 태그 있는 버전(out body)과 없는 버전(out skel)으로 두 번 올 수 있다. 태그를 합친다
    const prev = osmNodes.get(e.id);
    if (prev?.tags && !e.tags) e.tags = prev.tags;
    osmNodes.set(e.id, e);
  } else if (e.type === 'way') ways.set(e.id, e);
  else if (e.type === 'relation') relations.push(e);
}
let lat0 = 0;
let lon0 = 0;
let cnt = 0;
for (const n of osmNodes.values()) {
  if (n.lat === undefined) continue;
  lat0 += n.lat;
  lon0 += n.lon;
  cnt++;
}
lat0 /= cnt;
lon0 /= cnt;
const KX = 111320 * Math.cos((lat0 * Math.PI) / 180);
const KZ = 110574;
const proj = (n) => [Math.round((n.lon - lon0) * KX * 100) / 100, Math.round(-(n.lat - lat0) * KZ * 100) / 100];
const nodeXY = new Map();
for (const n of osmNodes.values()) if (n.lat !== undefined) nodeXY.set(n.id, proj(n));

// 질의 bbox 를 로컬 좌표로 (osm 응답은 bbox 밖 노드도 포함하므로 자른다). fetch-osm 이 data/bbox.json 에 적어 둔다
let argBox = null;
try {
  argBox = JSON.parse(readFileSync(IN.replace(/[^\\/]+$/, 'bbox.json'), 'utf8'));
} catch {
  argBox = null;
}
const lats = [...osmNodes.values()].filter((n) => n.lat !== undefined).map((n) => n.lat);
const lons = [...osmNodes.values()].filter((n) => n.lat !== undefined).map((n) => n.lon);
// 응답에 bbox 가 없으니 노드 분포의 중심 95% 를 영역으로 잡는다
const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor(arr.length * p)];
const box = argBox ?? { south: pct(lats, 0.01), north: pct(lats, 0.99), west: pct(lons, 0.01), east: pct(lons, 0.99) };
const [minX, maxZ] = proj({ lat: box.south, lon: box.west });
const [maxX, minZ] = proj({ lat: box.north, lon: box.east });
const inBox = ([x, z], m = 0) => x >= minX - m && x <= maxX + m && z >= minZ - m && z <= maxZ + m;

const tagName = (t) => (t && (t['name:ko'] || t.name)) || '';
const num = (v) => {
  if (v === undefined) return NaN;
  const m = String(v).match(/-?\d+(\.\d+)?/);
  return m ? parseFloat(m[0]) : NaN;
};

// ----- 도로 -----
const CLASS_RANK = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 6, living_street: 7 };
const DEFAULT_LANES = { motorway: 3, trunk: 3, primary: 3, secondary: 2, tertiary: 2, unclassified: 1, residential: 1, living_street: 1 };
const classOf = (hw) => hw.replace(/_link$/, '');
const highwayWays = [...ways.values()].filter((w) => w.tags?.highway && CLASS_RANK[classOf(w.tags.highway)] !== undefined && w.nodes?.length >= 2);

const usage = new Map();
for (const w of highwayWays) for (const id of w.nodes) usage.set(id, (usage.get(id) ?? 0) + 1);

const graphIndex = new Map(); // osm node id → graph node index
const nodes = [];
const edges = [];
const nodeIdx = (id) => {
  let i = graphIndex.get(id);
  if (i === undefined) {
    i = nodes.length;
    graphIndex.set(id, i);
    nodes.push(nodeXY.get(id));
  }
  return i;
};
const polyLen = (pts) => {
  let s = 0;
  for (let i = 2; i < pts.length; i += 2) s += Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
  return s;
};

for (const w of highwayWays) {
  const t = w.tags;
  const cls = classOf(t.highway);
  const link = /_link$/.test(t.highway);
  let oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || cls === 'motorway' || t.junction === 'roundabout';
  const reverse = t.oneway === '-1';
  if (reverse) oneway = true;
  const total = num(t.lanes);
  const lfTag = num(t['lanes:forward']);
  const lbTag = num(t['lanes:backward']);
  let lf;
  let lb;
  const def = link ? 1 : DEFAULT_LANES[cls];
  if (oneway) {
    lf = Number.isFinite(total) ? total : def;
    lb = 0;
  } else if (Number.isFinite(lfTag) || Number.isFinite(lbTag)) {
    lf = Number.isFinite(lfTag) ? lfTag : def;
    lb = Number.isFinite(lbTag) ? lbTag : def;
  } else if (Number.isFinite(total)) {
    lf = Math.ceil(total / 2);
    lb = Math.floor(total / 2);
  } else {
    lf = def;
    lb = def;
  }
  lf = Math.max(1, Math.min(4, Math.round(lf)));
  lb = Math.max(0, Math.min(4, Math.round(lb)));
  const ids = reverse ? w.nodes.slice().reverse() : w.nodes;
  const base = { cls, link, lf, lb, bridge: t.bridge === 'yes' || t.bridge === 'viaduct', tunnel: t.tunnel === 'yes', name: tagName(t), maxspeed: num(t.maxspeed) };

  // 교차로(다른 길과 공유) 또는 끝점에서 끊어 간선으로
  let run = [ids[0]];
  for (let k = 1; k < ids.length; k++) {
    run.push(ids[k]);
    const last = k === ids.length - 1;
    if ((usage.get(ids[k]) ?? 0) >= 2 || last) {
      const coords = run.map((id) => nodeXY.get(id)).filter(Boolean);
      if (coords.length >= 2 && coords.every((c) => inBox(c, 25))) {
        const pts = coords.flat();
        const len = polyLen(pts);
        if (len > 1.5) edges.push({ a: nodeIdx(run[0]), b: nodeIdx(run[run.length - 1]), pts, len, ...base });
      }
      run = [ids[k]];
    }
  }
}

// 중복 간선 제거 (같은 두 노드, 비슷한 길이)
{
  const seen = new Set();
  const uniq = [];
  for (const e of edges) {
    const key = `${Math.min(e.a, e.b)}-${Math.max(e.a, e.b)}-${Math.round(e.len / 3)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(e);
  }
  edges.length = 0;
  edges.push(...uniq);
}

// 가장 큰 연결 성분만 남긴다
{
  const adj = nodes.map(() => []);
  edges.forEach((e, i) => {
    adj[e.a].push([e.b, i]);
    adj[e.b].push([e.a, i]);
  });
  const comp = new Int32Array(nodes.length).fill(-1);
  let best = -1;
  let bestSize = 0;
  let c = 0;
  for (let s = 0; s < nodes.length; s++) {
    if (comp[s] !== -1) continue;
    const stack = [s];
    comp[s] = c;
    let size = 0;
    while (stack.length) {
      const n = stack.pop();
      size++;
      for (const [m] of adj[n]) if (comp[m] === -1) { comp[m] = c; stack.push(m); }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }
  const keepEdges = edges.filter((e) => comp[e.a] === best);
  const remap = new Map();
  const newNodes = [];
  for (const e of keepEdges) {
    for (const k of ['a', 'b']) {
      if (!remap.has(e[k])) { remap.set(e[k], newNodes.length); newNodes.push(nodes[e[k]]); }
      e[k] = remap.get(e[k]);
    }
  }
  nodes.length = 0;
  nodes.push(...newNodes);
  edges.length = 0;
  edges.push(...keepEdges);
  // osm id → new index 로 갱신 (신호등 매핑용)
  for (const [id, old] of [...graphIndex]) {
    if (remap.has(old)) graphIndex.set(id, remap.get(old));
    else graphIndex.delete(id);
  }
}

// ----- 폴리곤 유틸 -----
function ringArea(r) {
  let a = 0;
  for (let i = 0, n = r.length / 2; i < n; i++) {
    const j = (i + 1) % n;
    a += r[i * 2] * r[j * 2 + 1] - r[j * 2] * r[i * 2 + 1];
  }
  return a / 2;
}
function simplifyRing(r, eps = 0.4) {
  const out = [];
  for (let i = 0; i < r.length; i += 2) {
    const n = out.length;
    if (n >= 2 && Math.hypot(r[i] - out[n - 2], r[i + 1] - out[n - 1]) < eps) continue;
    out.push(r[i], r[i + 1]);
  }
  if (out.length >= 4 && Math.hypot(out[0] - out[out.length - 2], out[1] - out[out.length - 1]) < eps) out.splice(out.length - 2, 2);
  return out;
}
/** 사각형으로 자르기 (Sutherland–Hodgman). 기본은 전체 영역 */
function clipRing(r, x0 = minX, x1 = maxX, z0 = minZ, z1 = maxZ) {
  let poly = [];
  for (let i = 0; i < r.length; i += 2) poly.push([r[i], r[i + 1]]);
  const planes = [
    [(p) => p[0] >= x0, (p, q) => { const t = (x0 - p[0]) / (q[0] - p[0]); return [x0, p[1] + t * (q[1] - p[1])]; }],
    [(p) => p[0] <= x1, (p, q) => { const t = (x1 - p[0]) / (q[0] - p[0]); return [x1, p[1] + t * (q[1] - p[1])]; }],
    [(p) => p[1] >= z0, (p, q) => { const t = (z0 - p[1]) / (q[1] - p[1]); return [p[0] + t * (q[0] - p[0]), z0]; }],
    [(p) => p[1] <= z1, (p, q) => { const t = (z1 - p[1]) / (q[1] - p[1]); return [p[0] + t * (q[0] - p[0]), z1]; }],
  ];
  for (const [inside, cross] of planes) {
    const out = [];
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % poly.length];
      const pi = inside(p);
      const qi = inside(q);
      if (pi) out.push(p);
      if (pi !== qi) out.push(cross(p, q));
    }
    poly = out;
    if (!poly.length) return [];
  }
  return poly.flat();
}
/** 릴레이션 멤버 길들을 끝점으로 이어 고리로 만든다 */
function assembleRings(memberWays) {
  const segs = memberWays.map((w) => w.nodes.slice()).filter((n) => n.length >= 2);
  const rings = [];
  while (segs.length) {
    let ring = segs.shift();
    let guard = 0;
    while (ring[0] !== ring[ring.length - 1] && guard++ < 5000) {
      const end = ring[ring.length - 1];
      let found = -1;
      let flip = false;
      for (let i = 0; i < segs.length; i++) {
        if (segs[i][0] === end) { found = i; break; }
        if (segs[i][segs[i].length - 1] === end) { found = i; flip = true; break; }
      }
      if (found < 0) break;
      const s = segs.splice(found, 1)[0];
      if (flip) s.reverse();
      ring = ring.concat(s.slice(1));
    }
    rings.push(ring);
  }
  return rings.map((ids) => ids.map((id) => nodeXY.get(id)).filter(Boolean).flat()).filter((r) => r.length >= 6);
}
function closedWayRing(w) {
  if (!w.nodes || w.nodes.length < 4 || w.nodes[0] !== w.nodes[w.nodes.length - 1]) return null;
  return w.nodes.slice(0, -1).map((id) => nodeXY.get(id)).filter(Boolean).flat();
}
function ringCentroid(r) {
  let x = 0;
  let z = 0;
  for (let i = 0; i < r.length; i += 2) { x += r[i]; z += r[i + 1]; }
  return [x / (r.length / 2), z / (r.length / 2)];
}

// ----- 부가 데이터: POI(정류장·상점), V-World 건물 (같은 bbox 로 받아 둔 파일이 있으면 쓴다) -----
const bboxTag = argBox ? `${argBox.south}_${argBox.west}_${argBox.north}_${argBox.east}` : '';
const dataDir = IN.replace(/[^\\/]+$/, '');
const optional = (file) => { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return null; } };
const poisRaw = bboxTag ? optional(`${dataDir}pois-${bboxTag}.json`) : null;
const vworldRaw = bboxTag ? optional(`${dataDir}vworld-${bboxTag}.json`) : null;
const pois = [];
if (poisRaw) {
  for (const p of poisRaw) {
    const [x, z] = proj({ lat: p.lat, lon: p.lon });
    if (!inBox([x, z])) continue;
    pois.push({ x, z, kind: p.kind, sub: p.sub, name: p.name, brand: p.brand });
  }
  console.log(`  POI ${pois.length}개 (정류장 ${pois.filter((p) => p.kind === 'bus_stop').length}, 상점·시설 ${pois.filter((p) => p.kind === 'shop' || p.kind === 'amenity').length}, 역 ${pois.filter((p) => p.kind === 'station' || p.kind === 'subway_entrance').length})`);
}

// ----- 건물 -----
const buildings = [];
let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
const APT_RE = /아파트|APT|힐스테이트|자이\b|래미안|푸르지오|e편한세상|롯데캐슬|아이파크|더샵|위브|센트럴|주공|빌라|타운|맨션/i;
function buildingHeight(t) {
  const h = num(t.height);
  if (Number.isFinite(h) && h > 2) return Math.min(h, 300);
  const lv = num(t['building:levels']);
  if (Number.isFinite(lv) && lv > 0) return Math.min(lv * 3.2 + 1.5, 300);
  const b = t.building;
  if (b === 'apartments') return 36 + rnd() * 24;
  if (b === 'commercial' || b === 'office' || b === 'retail' || b === 'hotel') return 12 + rnd() * 14;
  if (b === 'house' || b === 'detached' || b === 'terrace') return 6 + rnd() * 3;
  if (b === 'residential' || b === 'dormitory') return 9 + rnd() * 8;
  if (b === 'school' || b === 'university' || b === 'hospital' || b === 'public') return 12 + rnd() * 6;
  if (b === 'church' || b === 'temple') return 10 + rnd() * 6;
  if (b === 'garage' || b === 'shed' || b === 'roof' || b === 'hut') return 3;
  return 8 + rnd() * 8;
}
function pushBuilding(ring, t) {
  const r = simplifyRing(ring);
  if (r.length < 6) return;
  const area = Math.abs(ringArea(r));
  if (area < 14) return;
  const c = ringCentroid(r);
  if (!inBox(c)) return;
  const h = Math.round(buildingHeight(t) * 10) / 10;
  const apt = t.building === 'apartments' || t.building === 'dormitory' || (t.building === 'residential' && h > 20);
  buildings.push({ ring: r, h, kind: apt ? 'apt' : h > 30 ? 'tower' : area > 600 ? 'block' : 'low', name: tagName(t) });
}
if (vworldRaw) {
  // 국토부 건물통합정보가 있으면 그것을 건물의 기준으로 쓴다 (전수 조사라 빈 땅이 거의 없고 층수·이름이 있다)
  let noFloor = 0;
  for (const b of vworldRaw) {
    const ring = simplifyRing(b.ring.map(([lon, lat]) => proj({ lat, lon })).flat());
    if (ring.length < 6) continue;
    const area = Math.abs(ringArea(ring));
    if (area < 12) continue;
    const c = ringCentroid(ring);
    if (!inBox(c)) continue;
    let h;
    if (b.floors > 0) h = b.floors * 3.1 + 1.2;
    else if (b.height > 2) h = b.height;
    else { h = area > 300 ? 9 + rnd() * 6 : 5 + rnd() * 4; noFloor++; }
    h = Math.round(Math.min(h, 560) * 10) / 10;
    const apt = APT_RE.test(b.name) || /아파트|공동주택|연립|다세대|기숙사/.test(b.use ?? '') || (b.floors >= 12 && area > 350 && area < 2500);
    buildings.push({ ring, h, kind: apt ? 'apt' : h > 30 ? 'tower' : area > 600 ? 'block' : 'low', name: b.name || '' });
  }
  console.log(`  V-World 건물 ${buildings.length}동 (층수 없음 ${noFloor}동은 추정)`);
} else {
  for (const w of ways.values()) {
    if (!w.tags?.building || w.tags.building === 'no') continue;
    const ring = closedWayRing(w);
    if (ring) pushBuilding(ring, w.tags);
  }
  for (const rel of relations) {
    if (!rel.tags?.building || rel.tags.type !== 'multipolygon') continue;
    const outer = rel.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => ways.get(m.ref)).filter(Boolean);
    for (const ring of assembleRings(outer)) pushBuilding(ring, rel.tags);
  }
}
// OSM 건물 이름을 V-World 건물에 보태기 (V-World 이름이 비어 있을 때, 중심이 안에 들어오면)
if (vworldRaw) {
  const named = [];
  for (const w of ways.values()) {
    if (!w.tags?.building || !tagName(w.tags)) continue;
    const ring = closedWayRing(w);
    if (ring) named.push({ name: tagName(w.tags), c: ringCentroid(ring) });
  }
  const CELLN = 50;
  const grid = new Map();
  buildings.forEach((b, i) => { const c = ringCentroid(b.ring); const k = `${Math.floor(c[0] / CELLN)},${Math.floor(c[1] / CELLN)}`; (grid.get(k) ?? grid.set(k, []).get(k)).push(i); });
  const inRingPt = (ring, x, z) => { let inside = false; for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) { const xi = ring[i], zi = ring[i + 1], xj = ring[j], zj = ring[j + 1]; if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside; } return inside; };
  let filled = 0;
  for (const n of named) {
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      for (const i of grid.get(`${Math.floor(n.c[0] / CELLN) + di},${Math.floor(n.c[1] / CELLN) + dj}`) ?? []) {
        if (!buildings[i].name && inRingPt(buildings[i].ring, n.c[0], n.c[1])) { buildings[i].name = n.name; filled++; }
      }
    }
  }
  console.log(`  OSM 이름으로 보완 ${filled}동`);
}

// ----- 물, 공원, 철도 -----
function collectAreas(matchWay, matchRel) {
  const out = [];
  for (const w of ways.values()) {
    if (!w.tags || !matchWay(w.tags)) continue;
    const ring = closedWayRing(w);
    if (ring) out.push(ring);
  }
  for (const rel of relations) {
    if (!rel.tags || !matchRel(rel.tags)) continue;
    const outer = rel.members.filter((m) => m.type === 'way' && m.role !== 'inner').map((m) => ways.get(m.ref)).filter(Boolean);
    out.push(...assembleRings(outer));
  }
  return out.map((r) => simplifyRing(clipRing(r), 1)).filter((r) => r.length >= 6 && Math.abs(ringArea(r)) > 150);
}
const isWater = (t) => t.natural === 'water' || t.waterway === 'riverbank';
const isPark = (t) => t.leisure === 'park' || t.leisure === 'garden' || t.landuse === 'grass' || t.landuse === 'recreation_ground';
const water = collectAreas(isWater, isWater);
const parks = collectAreas(isPark, isPark);
const rails = [];
for (const w of ways.values()) {
  if (w.tags?.railway !== 'rail') continue;
  const pts = w.nodes.map((id) => nodeXY.get(id)).filter((c) => c && inBox(c, 10)).flat();
  if (pts.length >= 4) rails.push(pts);
}

// ----- 지명, 신호등 -----
const places = [];
for (const n of osmNodes.values()) {
  if (!n.tags?.place || !tagName(n.tags)) continue;
  const p = nodeXY.get(n.id);
  if (p && inBox(p)) places.push({ x: p[0], z: p[1], name: tagName(n.tags), rank: n.tags.place });
}
// 신호등은 한국 OSM 에서 교차로 노드가 아니라 정지선 위치에 찍힌 경우가 많아 좌표로 가까운 교차로를 찾는다
const degree = new Int32Array(nodes.length);
for (const e of edges) { degree[e.a]++; degree[e.b]++; }
const signals = new Set();
for (const n of osmNodes.values()) {
  if (n.tags?.highway !== 'traffic_signals') continue;
  const p = nodeXY.get(n.id);
  if (!p) continue;
  const gi = graphIndex.get(n.id);
  if (gi !== undefined && degree[gi] >= 3) { signals.add(gi); continue; }
  let best = -1;
  let bd = 45;
  for (let i = 0; i < nodes.length; i++) {
    if (degree[i] < 3) continue;
    const d = Math.hypot(nodes[i][0] - p[0], nodes[i][1] - p[1]);
    if (d < bd) { bd = d; best = i; }
  }
  if (best >= 0) signals.add(best);
}

// ----- 빈 땅 건물 보강: OSM 에 건물이 없는 블록을 도로 방향에 맞춘 건물로 채운다 -----
{
  const CELL = 40;
  const edgeCells = new Map();
  const put = (x, z, id) => { const k = `${Math.floor(x / CELL)},${Math.floor(z / CELL)}`; const s = edgeCells.get(k) ?? new Set(); s.add(id); edgeCells.set(k, s); };
  edges.forEach((e, id) => {
    for (let i = 0; i < e.pts.length - 2; i += 2) {
      const n = Math.max(1, Math.ceil(Math.hypot(e.pts[i + 2] - e.pts[i], e.pts[i + 3] - e.pts[i + 1]) / CELL));
      for (let k = 0; k <= n; k++) put(e.pts[i] + ((e.pts[i + 2] - e.pts[i]) * k) / n, e.pts[i + 1] + ((e.pts[i + 3] - e.pts[i + 1]) * k) / n, id);
    }
  });
  const halfOf = (e) => ((e.lb === 0 ? e.lf : e.lf + e.lb) * (CLASS_RANK[e.cls] >= 6 ? 2.6 : 3.3)) / 2;
  /** 가장 가까운 도로: 거리(도로 가장자리 기준), 방향 */
  function nearestRoad(x, z, maxD) {
    let best = null;
    const seen = new Set();
    const rc = Math.ceil(maxD / CELL) + 1;
    for (let i = -rc; i <= rc; i++) for (let j = -rc; j <= rc; j++) {
      for (const id of edgeCells.get(`${Math.floor(x / CELL) + i},${Math.floor(z / CELL) + j}`) ?? []) {
        if (seen.has(id)) continue;
        seen.add(id);
        const e = edges[id];
        for (let k = 0; k < e.pts.length - 2; k += 2) {
          const x0 = e.pts[k]; const z0 = e.pts[k + 1]; const dx = e.pts[k + 2] - x0; const dz = e.pts[k + 3] - z0;
          const l2 = dx * dx + dz * dz || 1;
          const t = Math.min(1, Math.max(0, ((x - x0) * dx + (z - z0) * dz) / l2));
          const d = Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t)) - halfOf(e);
          if (!best || d < best.d) best = { d, hx: dx / Math.sqrt(l2), hz: dz / Math.sqrt(l2), rank: CLASS_RANK[e.cls], elevated: e.bridge || e.tunnel };
        }
      }
    }
    return best;
  }
  const inRing = (ring, x, z) => {
    let inside = false;
    for (let i = 0, j = ring.length - 2; i < ring.length; j = i, i += 2) {
      const xi = ring[i]; const zi = ring[i + 1]; const xj = ring[j]; const zj = ring[j + 1];
      if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
    }
    return inside;
  };
  const bboxOf = (ring) => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (let i = 0; i < ring.length; i += 2) { a = Math.min(a, ring[i]); b = Math.max(b, ring[i]); c = Math.min(c, ring[i + 1]); d = Math.max(d, ring[i + 1]); } return [a, b, c, d]; };
  const blocked = [...water, ...parks].map((r) => ({ ring: r, bb: bboxOf(r) }));
  const bCells = new Map();
  const occupied = [];
  const addOcc = (ring) => { const bb = bboxOf(ring); const o = { ring, bb }; occupied.push(o); for (let i = Math.floor(bb[0] / CELL); i <= Math.floor(bb[1] / CELL); i++) for (let j = Math.floor(bb[2] / CELL); j <= Math.floor(bb[3] / CELL); j++) { const k = `${i},${j}`; const l = bCells.get(k) ?? []; l.push(o); bCells.set(k, l); } };
  for (const b of buildings) addOcc(b.ring);
  const overlaps = (ring, margin) => {
    const bb = bboxOf(ring);
    for (let i = Math.floor((bb[0] - margin) / CELL); i <= Math.floor((bb[1] + margin) / CELL); i++) for (let j = Math.floor((bb[2] - margin) / CELL); j <= Math.floor((bb[3] + margin) / CELL); j++) {
      for (const o of bCells.get(`${i},${j}`) ?? []) {
        if (bb[0] - margin > o.bb[1] || bb[1] + margin < o.bb[0] || bb[2] - margin > o.bb[3] || bb[3] + margin < o.bb[2]) continue;
        return true;
      }
    }
    return false;
  };
  // 고가·다리·터널 도로는 게임에서 지면 높이라, 그 위아래에 있는 실제 건물은 뺀다 (안 그러면 차가 건물 속을 달린다)
  {
    const elevated = edges.filter((e) => e.bridge || e.tunnel);
    const distToEdge = (e, x, z) => {
      let best = Infinity;
      for (let k = 0; k < e.pts.length - 2; k += 2) {
        const x0 = e.pts[k]; const z0 = e.pts[k + 1]; const dx = e.pts[k + 2] - x0; const dz = e.pts[k + 3] - z0;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.min(1, Math.max(0, ((x - x0) * dx + (z - z0) * dz) / l2));
        best = Math.min(best, Math.hypot(x - (x0 + dx * t), z - (z0 + dz * t)));
      }
      return best;
    };
    const before = buildings.length;
    for (let i = buildings.length - 1; i >= 0; i--) {
      const r = buildings[i].ring;
      const bb = bboxOf(r);
      let hit = false;
      for (const e of elevated) {
        const margin = halfOf(e) + 3;
        // 간선 bbox 로 먼저 거른다
        let ex0 = Infinity, ex1 = -Infinity, ez0 = Infinity, ez1 = -Infinity;
        for (let k = 0; k < e.pts.length; k += 2) { ex0 = Math.min(ex0, e.pts[k]); ex1 = Math.max(ex1, e.pts[k]); ez0 = Math.min(ez0, e.pts[k + 1]); ez1 = Math.max(ez1, e.pts[k + 1]); }
        if (bb[0] > ex1 + margin || bb[1] < ex0 - margin || bb[2] > ez1 + margin || bb[3] < ez0 - margin) continue;
        for (let k = 0; k < r.length && !hit; k += 2) if (distToEdge(e, r[k], r[k + 1]) < margin) hit = true;
        if (!hit) { const c = ringCentroid(r); if (distToEdge(e, c[0], c[1]) < margin) hit = true; }
        if (hit) break;
      }
      if (hit) buildings.splice(i, 1);
    }
    console.log(`  고가·터널과 겹치는 건물 ${before - buildings.length}동 제거`);
    // 도로 면(차선 폭) 안으로 들어온 OSM 건물도 뺀다. 좁은 골목 지도는 건물과 길이 조금씩 겹친다
    const before2 = buildings.length;
    for (let i = buildings.length - 1; i >= 0; i--) {
      const r = buildings[i].ring;
      let intrudes = false;
      // V-World 는 실측 폴리곤이라 OSM 도로 중심선과 1m 안팎 어긋날 수 있다. 깊이 들어온 것만 뺀다
      const limit = vworldRaw ? -1.6 : -0.2;
      for (let k = 0; k < r.length && !intrudes; k += 2) {
        const road = nearestRoad(r[k], r[k + 1], 20);
        if (road && road.d < limit) intrudes = true;
      }
      if (intrudes) buildings.splice(i, 1);
    }
    console.log(`  도로 면을 침범한 건물 ${before2 - buildings.length}동 제거`);
    // occupied 색인도 다시 만든다
    occupied.length = 0;
    bCells.clear();
    for (const b of buildings) addOcc(b.ring);
  }
  let added = 0;
  const STEP = 11;
  // V-World 가 있으면 전수 데이터라 보강이 필요 없다
  for (let gx = vworldRaw ? maxX : minX + 8; gx < maxX - 8; gx += STEP) {
    for (let gz = minZ + 8; gz < maxZ - 8; gz += STEP) {
      const x = gx + (rnd() - 0.5) * 6;
      const z = gz + (rnd() - 0.5) * 6;
      const road = nearestRoad(x, z, 70);
      if (!road || road.d < 3.5 || road.d > 55) continue; // 길에서 너무 멀면 빈 땅(산, 강변)으로 둔다
      if (road.elevated && road.d < 12) continue; // 고가 옆은 비워 둔다
      // 상·하행이 따로 그려진 대로의 중앙분리대 자리인지: 반대쪽 16m 안에 나란한 길이 또 있으면 건너뛴다
      {
        const px = -road.hz; const pz = road.hx;
        let median = false;
        for (const sgn of [1, -1]) {
          const other = nearestRoad(x + px * sgn * 16, z + pz * sgn * 16, 20);
          if (other && other.d < 6 && Math.abs(other.hx * road.hx + other.hz * road.hz) > 0.8 && road.d < 14) median = true;
        }
        if (median) continue;
      }
      if (blocked.some((b) => x >= b.bb[0] && x <= b.bb[1] && z >= b.bb[2] && z <= b.bb[3] && inRing(b.ring, x, z))) continue;
      // 도로와 나란한 직사각형
      const big = road.rank <= 2;
      const w = (big ? 12 : 7) + rnd() * (big ? 12 : 6);
      const d = (big ? 10 : 6) + rnd() * (big ? 10 : 6);
      const hx = road.hx; const hz = road.hz; const rx = -hz; const rz = hx;
      const ring = [];
      for (const [u, v] of [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]]) ring.push(Math.round((x + hx * u + rx * v) * 100) / 100, Math.round((z + hz * u + rz * v) * 100) / 100);
      // 네 모서리가 도로 안에 들어가면 안 된다
      let ok = true;
      for (let i = 0; i < 8; i += 2) { const r = nearestRoad(ring[i], ring[i + 1], 30); if (r && r.d < 1.5) { ok = false; break; } }
      if (!ok || overlaps(ring, 1.5)) continue;
      const h = big ? 18 + rnd() * 40 : road.rank <= 4 ? 10 + rnd() * 16 : 6 + rnd() * 8;
      const hh = Math.round(h * 10) / 10;
      // 골목 안쪽 중층은 빌라·소형 아파트 느낌으로
      const apt = road.rank >= 5 && hh > 12 && rnd() < 0.5;
      buildings.push({ ring, h: hh, kind: apt ? 'apt' : hh > 30 ? 'tower' : w * d > 400 ? 'block' : 'low', name: '' });
      addOcc(ring);
      added++;
    }
  }
  console.log(`  보강 건물 ${added}동`);
}

// 시작 지점: 중심에서 가까운 주요 도로 교차로
let start = 0;
let sd = Infinity;
for (const e of edges) {
  if (CLASS_RANK[e.cls] > 3) continue;
  for (const k of ['a', 'b']) {
    const d = Math.hypot(nodes[e[k]][0], nodes[e[k]][1]);
    if (d < sd && degree[e[k]] >= 3) { sd = d; start = e[k]; }
  }
}

const edgeOut = edges.map((e, id) => ({ id, a: e.a, b: e.b, pts: e.pts, len: Math.round(e.len * 10) / 10, lf: e.lf, lb: e.lb, cls: e.cls, link: e.link, bridge: e.bridge, tunnel: e.tunnel, name: e.name }));
const placesOut = [...new Map(places.map((p) => [p.name, p])).values()];
const bbox = { minX: Math.round(minX), maxX: Math.round(maxX), minZ: Math.round(minZ), maxZ: Math.round(maxZ) };
const classes = {};
for (const e of edges) classes[e.cls] = (classes[e.cls] ?? 0) + 1;
console.log(`  영역 ${Math.round(maxX - minX)} × ${Math.round(maxZ - minZ)} m, 노드 ${nodes.length}, 간선 ${edges.length}`, classes);
console.log(`  건물 ${buildings.length}, 물 ${water.length}, 공원 ${parks.length}, 철도 ${rails.length}, 지명 ${placesOut.length}, 신호등 ${signals.size}, 시작 노드 ${start}`);

if (/\.json$/i.test(OUT)) {
  const map = { origin: { lat: lat0, lon: lon0 }, bbox, start, nodes, edges: edgeOut, buildings, water, parks, rails, places: placesOut, signals: [...signals] };
  mkdirSync(OUT.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
  writeFileSync(OUT, JSON.stringify(map));
  console.log(`[build] ${OUT} (${(JSON.stringify(map).length / 1024 / 1024).toFixed(1)} MB)`);
} else {
  // ----- 타일 분할 -----
  if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
  mkdirSync(`${OUT}/t`, { recursive: true });
  const ti = (x) => Math.floor((x - minX) / TILE);
  const tj = (z) => Math.floor((z - minZ) / TILE);
  const tiles = new Map();
  const tileOf = (i, j) => {
    const k = `${i}_${j}`;
    let t = tiles.get(k);
    if (!t) {
      t = { i, j, nodes: new Map(), edges: [], buildings: [], water: [], parks: [], rails: [], signals: [] };
      tiles.set(k, t);
    }
    return t;
  };
  for (const e of edgeOut) {
    const mid = Math.floor(e.pts.length / 4) * 2;
    const t = tileOf(ti(e.pts[mid]), tj(e.pts[mid + 1]));
    t.edges.push(e);
    for (const n of [e.a, e.b]) t.nodes.set(n, nodes[n]);
  }
  for (const b of buildings) {
    const c = ringCentroid(b.ring);
    tileOf(ti(c[0]), tj(c[1])).buildings.push(b);
  }
  const ni = Math.ceil((maxX - minX) / TILE);
  const nj = Math.ceil((maxZ - minZ) / TILE);
  const bboxOfRing = (ring) => { let a = Infinity, b = -Infinity, c = Infinity, d = -Infinity; for (let i = 0; i < ring.length; i += 2) { a = Math.min(a, ring[i]); b = Math.max(b, ring[i]); c = Math.min(c, ring[i + 1]); d = Math.max(d, ring[i + 1]); } return [a, b, c, d]; };
  for (const [list, key] of [[water, 'water'], [parks, 'parks']]) {
    for (const ring of list) {
      const bb = bboxOfRing(ring);
      for (let i = Math.max(0, ti(bb[0])); i <= Math.min(ni - 1, ti(bb[1])); i++) {
        for (let j = Math.max(0, tj(bb[2])); j <= Math.min(nj - 1, tj(bb[3])); j++) {
          const x0 = minX + i * TILE; const z0 = minZ + j * TILE;
          const c = simplifyRing(clipRing(ring, x0, x0 + TILE, z0, z0 + TILE), 0.5);
          if (c.length >= 6 && Math.abs(ringArea(c)) > 20) tileOf(i, j)[key].push(c);
        }
      }
    }
  }
  for (const pts of rails) {
    const touched = new Set();
    for (let k = 0; k < pts.length; k += 2) touched.add(`${ti(pts[k])}_${tj(pts[k + 1])}`);
    for (const key of touched) {
      const [i, j] = key.split('_').map(Number);
      if (i < 0 || j < 0 || i >= ni || j >= nj) continue;
      tileOf(i, j).rails.push(pts);
    }
  }
  for (const n of signals) {
    const p = nodes[n];
    tileOf(ti(p[0]), tj(p[1])).signals.push(n);
  }
  for (const p of pois) {
    const t = tileOf(ti(p.x), tj(p.z));
    (t.pois ??= []).push({ x: Math.round(p.x * 10) / 10, z: Math.round(p.z * 10) / 10, kind: p.kind, sub: p.sub, name: p.name });
  }
  const index = {
    origin: { lat: lat0, lon: lon0 },
    bbox,
    tile: TILE,
    start: { node: start, x: nodes[start][0], z: nodes[start][1] },
    places: placesOut,
    tiles: [],
  };
  let total = 0;
  for (const t of tiles.values()) {
    if (t.i < 0 || t.j < 0 || t.i >= ni || t.j >= nj) continue;
    const data = { i: t.i, j: t.j, nodes: [...t.nodes].map(([id, p]) => [id, p[0], p[1]]), edges: t.edges, buildings: t.buildings, water: t.water, parks: t.parks, rails: t.rails, signals: t.signals, pois: t.pois ?? [] };
    const file = `t/${t.i}_${t.j}.json`;
    const text = JSON.stringify(data);
    writeFileSync(`${OUT}/${file}`, text);
    total += text.length;
    let roadLen = 0;
    for (const e of t.edges) roadLen += e.len;
    index.tiles.push({ i: t.i, j: t.j, file, edges: t.edges.length, buildings: t.buildings.length, roadLen: Math.round(roadLen) });
  }
  // ----- 전체 지도 오버뷰 PNG (큰 지도 배경) -----
  const SCALE = Math.min(0.2, 3600 / Math.max(maxX - minX, maxZ - minZ));
  const W = Math.ceil((maxX - minX) * SCALE);
  const H = Math.ceil((maxZ - minZ) * SCALE);
  const img = new Uint8Array(W * H * 3);
  const fill = (r, g, b) => { for (let i = 0; i < W * H; i++) { img[i * 3] = r; img[i * 3 + 1] = g; img[i * 3 + 2] = b; } };
  const px = (x, z, r, g, b) => { const ix = Math.floor((x - minX) * SCALE); const iz = Math.floor((z - minZ) * SCALE); if (ix < 0 || iz < 0 || ix >= W || iz >= H) return; const i = (iz * W + ix) * 3; img[i] = r; img[i + 1] = g; img[i + 2] = b; };
  const fillRing = (ring, r, g, b) => {
    const bb = bboxOfRing(ring);
    const n = ring.length / 2;
    for (let iz = Math.max(0, Math.floor((bb[2] - minZ) * SCALE)); iz <= Math.min(H - 1, Math.ceil((bb[3] - minZ) * SCALE)); iz++) {
      const z = minZ + (iz + 0.5) / SCALE;
      const xs = [];
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = ring[i * 2]; const zi = ring[i * 2 + 1]; const xj = ring[j * 2]; const zj = ring[j * 2 + 1];
        if (zi > z !== zj > z) xs.push(xi + ((z - zi) * (xj - xi)) / (zj - zi));
      }
      xs.sort((a, c) => a - c);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        for (let ix = Math.max(0, Math.floor((xs[k] - minX) * SCALE)); ix <= Math.min(W - 1, Math.floor((xs[k + 1] - minX) * SCALE)); ix++) { const i = (iz * W + ix) * 3; img[i] = r; img[i + 1] = g; img[i + 2] = b; }
      }
    }
  };
  const line = (x0, z0, x1, z1, width, r, g, b) => {
    const len = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(len * SCALE * 1.5));
    const wpx = Math.max(1, Math.round(width * SCALE));
    for (let s = 0; s <= steps; s++) {
      const x = x0 + ((x1 - x0) * s) / steps; const z = z0 + ((z1 - z0) * s) / steps;
      if (wpx <= 1) px(x, z, r, g, b);
      else for (let a = -wpx / 2; a < wpx / 2; a++) for (let c = -wpx / 2; c < wpx / 2; c++) px(x + a / SCALE, z + c / SCALE, r, g, b);
    }
  };
  fill(11, 14, 22);
  for (const ring of water) fillRing(ring, 14, 42, 82);
  for (const ring of parks) fillRing(ring, 28, 58, 40);
  for (const bd of buildings) fillRing(bd.ring, 26, 31, 46);
  const colorOf = (e) => (CLASS_RANK[e.cls] <= 2 ? [120, 128, 150] : CLASS_RANK[e.cls] <= 4 ? [84, 90, 110] : [56, 61, 78]);
  for (const e of edgeOut.slice().sort((a, b) => CLASS_RANK[b.cls] - CLASS_RANK[a.cls])) {
    const [r, g, b] = colorOf(e);
    const w = Math.max(2 / SCALE, (e.lb === 0 ? e.lf : e.lf + e.lb) * 3.3);
    for (let k = 0; k < e.pts.length - 2; k += 2) line(e.pts[k], e.pts[k + 1], e.pts[k + 2], e.pts[k + 3], w, r, g, b);
  }
  // PNG 인코딩
  const crcTable = new Int32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
  const crc = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type, 'ascii'); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const cc = Buffer.alloc(4); cc.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, cc]); };
  const rawPng = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { rawPng[y * (W * 3 + 1)] = 0; rawPng.set(img.subarray(y * W * 3, (y + 1) * W * 3), y * (W * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(rawPng, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
  writeFileSync(`${OUT}/overview.png`, png);
  index.overview = { file: 'overview.png', scale: SCALE, w: W, h: H };
  writeFileSync(`${OUT}/index.json`, JSON.stringify(index));
  console.log(`[build] ${OUT}/ 타일 ${index.tiles.length}개 (${(total / 1024 / 1024).toFixed(1)} MB), overview ${W}×${H} (${(png.length / 1024).toFixed(0)} KB)`);
}
