// data/osm-raw.json (Overpass 결과) → public/map/seoul.json (게임용 도로 그래프·건물·물·공원)
// 사용: node tools/build-map.mjs [in] [out]
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const IN = process.argv[2] ?? 'data/osm-raw.json';
const OUT = process.argv[3] ?? 'public/map/seoul.json';
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
/** 사각형으로 자르기 (Sutherland–Hodgman) */
function clipRing(r) {
  let poly = [];
  for (let i = 0; i < r.length; i += 2) poly.push([r[i], r[i + 1]]);
  const planes = [
    [(p) => p[0] >= minX, (p, q) => { const t = (minX - p[0]) / (q[0] - p[0]); return [minX, p[1] + t * (q[1] - p[1])]; }],
    [(p) => p[0] <= maxX, (p, q) => { const t = (maxX - p[0]) / (q[0] - p[0]); return [maxX, p[1] + t * (q[1] - p[1])]; }],
    [(p) => p[1] >= minZ, (p, q) => { const t = (minZ - p[1]) / (q[1] - p[1]); return [p[0] + t * (q[0] - p[0]), minZ]; }],
    [(p) => p[1] <= maxZ, (p, q) => { const t = (maxZ - p[1]) / (q[1] - p[1]); return [p[0] + t * (q[0] - p[0]), maxZ]; }],
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

// ----- 건물 -----
const buildings = [];
let seed = 1;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
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
      for (let k = 0; k < r.length && !intrudes; k += 2) {
        const road = nearestRoad(r[k], r[k + 1], 20);
        if (road && road.d < -0.2) intrudes = true;
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
  for (let gx = minX + 8; gx < maxX - 8; gx += STEP) {
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

const map = {
  origin: { lat: lat0, lon: lon0 },
  bbox: { minX: Math.round(minX), maxX: Math.round(maxX), minZ: Math.round(minZ), maxZ: Math.round(maxZ) },
  start,
  nodes,
  edges: edges.map((e) => ({ a: e.a, b: e.b, pts: e.pts, len: Math.round(e.len * 10) / 10, lf: e.lf, lb: e.lb, cls: e.cls, link: e.link, bridge: e.bridge, tunnel: e.tunnel, name: e.name })),
  buildings,
  water,
  parks,
  rails,
  places: [...new Map(places.map((p) => [p.name, p])).values()],
  signals: [...signals],
};
mkdirSync(OUT.replace(/[\\/][^\\/]+$/, ''), { recursive: true });
writeFileSync(OUT, JSON.stringify(map));
const classes = {};
for (const e of edges) classes[e.cls] = (classes[e.cls] ?? 0) + 1;
console.log(`[build] ${OUT}`);
console.log(`  영역 ${Math.round(maxX - minX)} × ${Math.round(maxZ - minZ)} m, 노드 ${nodes.length}, 간선 ${edges.length}`, classes);
console.log(`  건물 ${buildings.length}, 물 ${water.length}, 공원 ${parks.length}, 철도 ${rails.length}, 지명 ${map.places.length}, 신호등 ${map.signals.length}, 시작 노드 ${start}`);
console.log(`  파일 크기 ${(JSON.stringify(map).length / 1024 / 1024).toFixed(1)} MB`);
