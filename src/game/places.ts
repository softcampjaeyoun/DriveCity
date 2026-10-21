import type { Node, RoadGraph } from '../world/graph.ts';

const RANK_ORDER = ['neighbourhood', 'quarter', 'suburb', 'village', 'town', 'city', 'locality'];

/** 교차로 위치를 OSM 지명(동네) 또는 큰길 이름으로. 미션 안내와 토스트에 쓴다 */
export function placeName(g: RoadGraph, n: Node): string {
  const [x, z] = g.pos(n);
  let best = '';
  let bd = 650;
  for (const p of g.index.places) {
    const rank = RANK_ORDER.indexOf(p.rank);
    if (rank < 0) continue;
    const d = Math.hypot(p.x - x, p.z - z) * (1 + rank * 0.15);
    if (d < bd) {
      bd = d;
      best = p.name;
    }
  }
  if (best) return best;
  let road = '';
  let rr = 99;
  for (const e of g.edgesAt(n)) {
    if (e.name && e.rank < rr) {
      rr = e.rank;
      road = e.name;
    }
  }
  if (road) return road;
  const hit = g.nearestEdge(x, z, 150);
  return hit?.e.name || '강남';
}
