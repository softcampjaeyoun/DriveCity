// Copernicus GLO-30 DEM(30m) 에서 타일별 높이맵(hm)을 만들어 타일 JSON 에 써 넣는다.
//   node tools/add-dem.mjs public/map/seoul data/dem
// - 높이 기준: 한강 수면(물 폴리곤 꼭짓점의 DEM 중앙값) = 0
// - 물 폴리곤 안은 -1.5m (물 평면 0.04m 아래)
// - 도로 스탬핑: 지상 간선(lv 0) 을 따라 DEM 을 매끄럽게 고른 노면 높이를 만들고, 그 폭(+4m)안의 격자값을 노면 높이로,
//   +16m 까지는 섞어서 지형이 도로를 뚫거나 도로가 뜨지 않게 한다. 고가·지하(lv≠0)는 스탬핑하지 않는다
// - 숲 마스크(gm): 도로에서 45m 넘게 떨어지고 건물에서 20m 안에 없는 격자점 = 1 (산지·공터를 잔디·나무로 덮는다)
// - 결과: tile.hm = 41×41 (25m 간격, 데시미터 정수, 행 = z 방향), tile.gm = 같은 격자 0/1, index.hm = { n, step }, index.demRef
import { fromFile } from 'geotiff';
import fs from 'node:fs';
import path from 'node:path';

const mapDir = process.argv[2] ?? 'public/map/seoul';
const demDir = process.argv[3] ?? 'data/dem';
const N = 41;
const STEP = 25;

const index = JSON.parse(fs.readFileSync(path.join(mapDir, 'index.json'), 'utf8'));
const { lat: lat0, lon: lon0 } = index.origin;
const KX = 111320 * Math.cos((lat0 * Math.PI) / 180);
const KZ = 110574;
const toLonLat = (x, z) => [lon0 + x / KX, lat0 - z / KZ];
const TILE = index.tile;
const { minX, minZ } = index.bbox;

// ----- DEM 읽기 -----
const dems = [];
for (const f of fs.readdirSync(demDir).filter((f) => /\.tif$/i.test(f))) {
  const tiff = await fromFile(path.join(demDir, f));
  const img = await tiff.getImage();
  const w = img.getWidth();
  const h = img.getHeight();
  const [west, south, east, north] = img.getBoundingBox();
  const data = (await img.readRasters({ interleave: true }));
  dems.push({ w, h, west, south, east, north, data, rx: (east - west) / w, ry: (north - south) / h });
  console.log(`DEM ${f}: ${w}x${h} lon ${west.toFixed(2)}..${east.toFixed(2)} lat ${south.toFixed(2)}..${north.toFixed(2)}`);
}
function demAtLonLat(lon, lat) {
  for (const d of dems) {
    if (lon < d.west || lon >= d.east || lat <= d.south || lat > d.north) continue;
    const fx = (lon - d.west) / d.rx - 0.5;
    const fy = (d.north - lat) / d.ry - 0.5;
    const x0 = Math.max(0, Math.min(d.w - 2, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(d.h - 2, Math.floor(fy)));
    const tx = Math.min(1, Math.max(0, fx - x0));
    const ty = Math.min(1, Math.max(0, fy - y0));
    const v = (x, y) => d.data[y * d.w + x];
    return (v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx) * (1 - ty) + (v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx) * ty;
  }
  return 0;
}
const demAt = (x, z) => demAtLonLat(...toLonLat(x, z));
/** 30m 안팎을 평균해 DEM 잡음을 누른 값 */
const smoothAt = (x, z) => (demAt(x, z) * 2 + demAt(x + 30, z) + demAt(x - 30, z) + demAt(x, z + 30) + demAt(x, z - 30)) / 6;

// ----- 타일 전부 읽기 -----
const tiles = new Map();
for (const info of index.tiles) {
  const t = JSON.parse(fs.readFileSync(path.join(mapDir, info.file), 'utf8'));
  tiles.set(`${t.i}_${t.j}`, { info, t });
}
console.log(`tiles ${tiles.size}`);

// ----- 기준 높이: 물 꼭짓점 DEM 중앙값 -----
const waterSamples = [];
for (const { t } of tiles.values()) for (const ring of t.water) for (let i = 0; i < ring.length; i += 2) waterSamples.push(demAt(ring[i], ring[i + 1]));
waterSamples.sort((a, b) => a - b);
const ref = waterSamples.length ? waterSamples[Math.floor(waterSamples.length / 2)] : 0;
console.log(`water samples ${waterSamples.length}, ref elevation ${ref.toFixed(1)}m`);

// ----- 도로 노면 높이: 노드 높이 + 간선을 따라 매끄럽게 -----
const nodeH = new Map();
for (const { t } of tiles.values()) for (const [id, x, z] of t.nodes) if (!nodeH.has(id)) nodeH.set(id, Math.max(0, smoothAt(x, z) - ref));
/** 스탬핑용 구간 목록: 셀 25m 해시 */
const segGrid = new Map();
const cellOf = (x, z) => `${Math.floor(x / STEP)},${Math.floor(z / STEP)}`;
let segCount = 0;
function addSeg(seg) {
  const x0 = Math.min(seg.x0, seg.x1) - seg.half - 30;
  const x1 = Math.max(seg.x0, seg.x1) + seg.half + 30;
  const z0 = Math.min(seg.z0, seg.z1) - seg.half - 30;
  const z1 = Math.max(seg.z0, seg.z1) + seg.half + 30;
  for (let cx = Math.floor(x0 / STEP); cx <= Math.floor(x1 / STEP); cx++) {
    for (let cz = Math.floor(z0 / STEP); cz <= Math.floor(z1 / STEP); cz++) {
      const k = `${cx},${cz}`;
      let l = segGrid.get(k);
      if (!l) {
        l = [];
        segGrid.set(k, l);
      }
      l.push(seg);
    }
  }
  segCount++;
}
const CLASS_RANK = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 6, living_street: 7 };
const LANE_W = 3.3;
for (const { t } of tiles.values()) {
  for (const e of t.edges) {
    if ((e.lv ?? 0) !== 0) continue;
    const rank = CLASS_RANK[e.cls] ?? 6;
    const lanes = e.lb === 0 ? e.lf : e.lf + e.lb;
    const half = (lanes * (rank >= 6 ? 2.6 : LANE_W)) / 2;
    // 10m 간격 샘플
    const pts = e.pts;
    const cum = [0];
    for (let i = 2; i < pts.length; i += 2) cum.push(cum[cum.length - 1] + Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]));
    const len = cum[cum.length - 1];
    if (len < 1) continue;
    const ss = [];
    for (let s = 0; s < len; s += 10) ss.push(s);
    ss.push(len);
    const at = (s) => {
      let lo = 0;
      while (lo < cum.length - 2 && cum[lo + 1] <= s) lo++;
      const l = cum[lo + 1] - cum[lo] || 1;
      const tt = Math.min(1, Math.max(0, (s - cum[lo]) / l));
      return [pts[lo * 2] + (pts[lo * 2 + 2] - pts[lo * 2]) * tt, pts[lo * 2 + 1] + (pts[lo * 2 + 3] - pts[lo * 2 + 1]) * tt];
    };
    const xz = ss.map(at);
    const raw = xz.map(([x, z]) => Math.max(0, smoothAt(x, z) - ref));
    // 100m 이동 평균
    const sm = raw.map((_, i) => {
      let sum = 0;
      let n = 0;
      for (let k = -5; k <= 5; k++) {
        const j = i + k;
        if (j < 0 || j >= raw.length) continue;
        sum += raw[j];
        n++;
      }
      return sum / n;
    });
    // 양끝을 노드 높이에 맞춘다 (60m 안에서 섞어서)
    const ha = nodeH.get(e.a) ?? sm[0];
    const hb = nodeH.get(e.b) ?? sm[sm.length - 1];
    const prof = sm.map((h, i) => {
      const s = ss[i];
      const wa = Math.max(0, 1 - s / 60);
      const wb = Math.max(0, 1 - (len - s) / 60);
      if (len <= 120) {
        const tt = s / len;
        return h + (ha - sm[0]) * (1 - tt) + (hb - sm[sm.length - 1]) * tt;
      }
      return h + (ha - sm[0]) * wa + (hb - sm[sm.length - 1]) * wb;
    });
    for (let i = 0; i + 1 < xz.length; i++) addSeg({ x0: xz[i][0], z0: xz[i][1], x1: xz[i + 1][0], z1: xz[i + 1][1], h0: prof[i], h1: prof[i + 1], half });
  }
}
console.log(`road segments ${segCount}`);

/** (x,z) 에서 가장 가까운 도로 구간: 거리, 그 지점 노면 높이, 반폭 */
function nearestRoad(x, z) {
  let best = null;
  const l = segGrid.get(cellOf(x, z));
  if (!l) return null;
  for (const s of l) {
    const dx = s.x1 - s.x0;
    const dz = s.z1 - s.z0;
    const l2 = dx * dx + dz * dz || 1;
    const t = Math.min(1, Math.max(0, ((x - s.x0) * dx + (z - s.z0) * dz) / l2));
    const d = Math.hypot(x - (s.x0 + dx * t), z - (s.z0 + dz * t)) - s.half;
    if (!best || d < best.d) best = { d, h: s.h0 + (s.h1 - s.h0) * t };
  }
  return best;
}

function pointInRing(ring, x, z) {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2];
    const zi = ring[i * 2 + 1];
    const xj = ring[j * 2];
    const zj = ring[j * 2 + 1];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
}

// ----- 타일별 높이맵 -----
let minH = Infinity;
let maxH = -Infinity;
let done = 0;
for (const { info, t } of tiles.values()) {
  const x0 = minX + t.i * TILE;
  const z0 = minZ + t.j * TILE;
  // 물 폴리곤: 이 타일과 이웃 타일 것
  const waters = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const r of tiles.get(`${t.i + di}_${t.j + dj}`)?.t.water ?? []) waters.push(r);
  // 건물 AABB (이 타일 + 이웃), 20m 여유
  const bboxes = [];
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) for (const b of tiles.get(`${t.i + di}_${t.j + dj}`)?.t.buildings ?? []) {
    let bx0 = Infinity, bx1 = -Infinity, bz0 = Infinity, bz1 = -Infinity;
    for (let k = 0; k < b.ring.length; k += 2) { const bx = b.ring[k], bz = b.ring[k + 1]; if (bx < bx0) bx0 = bx; if (bx > bx1) bx1 = bx; if (bz < bz0) bz0 = bz; if (bz > bz1) bz1 = bz; }
    if (bx1 < x0 - 30 || bx0 > x0 + TILE + 30 || bz1 < z0 - 30 || bz0 > z0 + TILE + 30) continue;
    bboxes.push([bx0 - 20, bx1 + 20, bz0 - 20, bz1 + 20]);
  }
  const nearBuilding = (x, z) => bboxes.some((b) => x >= b[0] && x <= b[1] && z >= b[2] && z <= b[3]);
  const hm = new Array(N * N);
  const gm = new Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const x = x0 + i * STEP;
      const z = z0 + j * STEP;
      let h = demAt(x, z) - ref;
      let green = 0;
      if (waters.some((r) => pointInRing(r, x, z))) h = -1.5;
      else {
        h = Math.max(-0.5, h);
        const near = nearestRoad(x, z);
        if (near) {
          // 차도 안쪽(가장자리 1m 안)은 노면보다 8cm 낮게 — 도로 띠(3m 간격 직선)와 지형 삼각형의 차이로 지형이 노면을 뚫지 않게.
          // 가장자리~+4m 는 노면 높이 그대로 (연석·인도가 여기서 시작한다)
          // 가장자리 +14m 까지는 노면 높이 그대로 (25m 격자라 띠가 좁으면 양옆 격자점 경사가 도로를 가로질러 올라온다), +30m 까지 섞는다
          if (near.d <= -1) h = near.h - 0.08;
          else if (near.d <= 14) h = near.h;
          else if (near.d < 30) {
            const k = (near.d - 14) / 16;
            h = near.h * (1 - k) + h * k;
          }
        }
        if ((!near || near.d > 45) && !nearBuilding(x, z)) green = 1;
      }
      gm[j * N + i] = green;
      hm[j * N + i] = Math.round(h * 10);
      if (h < minH) minH = h;
      if (h > maxH) maxH = h;
    }
  }
  t.hm = hm;
  t.gm = gm;
  fs.writeFileSync(path.join(mapDir, info.file), JSON.stringify(t));
  if (++done % 50 === 0) console.log(`  ${done}/${tiles.size}`);
}
index.hm = { n: N, step: STEP };
index.demRef = Math.round(ref * 10) / 10;
fs.writeFileSync(path.join(mapDir, 'index.json'), JSON.stringify(index));
console.log(`done. height range ${minH.toFixed(1)} .. ${maxH.toFixed(1)} m (ref ${ref.toFixed(1)})`);
