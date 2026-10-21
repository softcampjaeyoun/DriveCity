// 도시 격자: N×N 블록, 블록 사이에 폭 ROAD 의 도로
export const N = 8;
export const BLOCK = 56;
export const ROAD = 18;
export const CELL = BLOCK + ROAD;
export const HALF = (N * CELL) / 2;
export const LIMIT = HALF + ROAD / 2 - 1.3;
export const roadAt = (i: number): number => -HALF + i * CELL;

export const CHECKPOINTS = 5;
export const RUN_REWARD = 500;
export const BEST_BONUS = 300;

// 차선: 우측 통행, 도로 중앙에서 LANE 만큼 오른쪽
export const LANE = 3.2;
export const EDGE = ROAD / 2;
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];

export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const coarse = matchMedia('(pointer: coarse)').matches;
