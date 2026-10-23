// 타일 JSON 에서 전역 내비 그래프(간선 등급 4 이하: 고속화도로~동네 간선)를 뽑아 public/map/seoul/nav.json 에 쓴다.
// 목적지 길안내는 타일이 로드되지 않은 먼 곳까지 경로를 찾아야 하므로 작은 전역 그래프가 필요하다.
//   node tools/build-nav.mjs public/map/seoul
import fs from 'node:fs';
import path from 'node:path';

const mapDir = process.argv[2] ?? 'public/map/seoul';
const index = JSON.parse(fs.readFileSync(path.join(mapDir, 'index.json'), 'utf8'));
const CLASS_RANK = { motorway: 0, trunk: 1, primary: 2, secondary: 3, tertiary: 4, unclassified: 5, residential: 6, living_street: 7 };
const MAX_RANK = 4;

const nodes = new Map(); // id → [x, z]
const edges = new Map(); // id → { a, b, len, oneway, pts }
for (const info of index.tiles) {
  const t = JSON.parse(fs.readFileSync(path.join(mapDir, info.file), 'utf8'));
  for (const [id, x, z] of t.nodes) if (!nodes.has(id)) nodes.set(id, [x, z]);
  for (const e of t.edges) {
    if ((CLASS_RANK[e.cls] ?? 9) > MAX_RANK || edges.has(e.id)) continue;
    // 꼭짓점은 8m 보다 촘촘하면 솎는다 (지도에 그릴 경로선용)
    const pts = [];
    for (let i = 0; i < e.pts.length; i += 2) {
      const n = pts.length;
      if (n >= 2 && i + 2 < e.pts.length && Math.hypot(e.pts[i] - pts[n - 2], e.pts[i + 1] - pts[n - 1]) < 8) continue;
      pts.push(Math.round(e.pts[i] * 10) / 10, Math.round(e.pts[i + 1] * 10) / 10);
    }
    edges.set(e.id, { a: e.a, b: e.b, len: Math.round(e.len * 10) / 10, oneway: e.lb === 0 ? 1 : 0, pts });
  }
}
// 쓰이는 노드만, 번호를 0.. 으로 다시 매긴다
const used = new Map();
const nodeOut = [];
const nodeIndex = (id) => {
  let k = used.get(id);
  if (k === undefined) {
    k = nodeOut.length / 2;
    used.set(id, k);
    const p = nodes.get(id);
    nodeOut.push(Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10);
  }
  return k;
};
const edgeOut = [];
for (const e of edges.values()) {
  if (!nodes.has(e.a) || !nodes.has(e.b)) continue;
  edgeOut.push({ a: nodeIndex(e.a), b: nodeIndex(e.b), len: e.len, oneway: e.oneway, pts: e.pts });
}
const out = { nodes: nodeOut, edges: edgeOut };
const file = path.join(mapDir, 'nav.json');
fs.writeFileSync(file, JSON.stringify(out));
console.log(`nav.json: 노드 ${nodeOut.length / 2}, 간선 ${edgeOut.length}, ${(fs.statSync(file).size / 1024 / 1024).toFixed(1)} MB`);
