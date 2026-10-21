import type { Node, RoadGraph } from '../world/graph.ts';

/** 교차로 위치를 서울 동네 이름으로. 미션 안내와 토스트에 쓴다 */
export function placeName(g: RoadGraph, n: Node): string {
  const [x, z] = g.pos(n);
  const south = z > (g.river.z0 + g.river.z1) / 2;
  const col = (x - g.minX) / (g.maxX - g.minX); // 0 서쪽 .. 1 동쪽
  const riverSide = Math.abs(n[1] - g.river.row) <= 1 && (n[1] === g.river.row || n[1] === g.river.row + 1);
  if (riverSide) return south ? (col < 0.5 ? '반포 한강공원' : '잠원 한강공원') : col < 0.5 ? '여의도 한강공원' : '뚝섬 한강공원';
  if (south) {
    if (col < 0.33) return '여의도';
    if (col < 0.66) return '강남역';
    return '잠실';
  }
  if (col < 0.25) return '홍대입구';
  if (col < 0.5) return '시청';
  if (col < 0.75) return '종로';
  return '성수동';
}
