// 도로: 폭 ROAD, 한 방향에 차선 2개 (도로 중앙에서 오른쪽으로 LANES 만큼)
export const ROAD = 18;
export const EDGE = ROAD / 2;
export const LANES: readonly number[] = [2.0, 5.6];
export const LANE_W = 3.6;

export const CHECKPOINTS = 5;
export const RUN_REWARD = 500;
export const BEST_BONUS = 300;

/** 방향 인덱스: 0 = +z, 1 = +x, 2 = -z, 3 = -x. 우회전은 (d+3)%4, 좌회전은 (d+1)%4 */
export const DIRS: ReadonlyArray<readonly [number, number]> = [
  [0, 1],
  [1, 0],
  [0, -1],
  [-1, 0],
];
export const rightTurn = (d: number): number => (d + 3) % 4;
export const leftTurn = (d: number): number => (d + 1) % 4;
export const backOf = (d: number): number => (d + 2) % 4;

export const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
export const coarse = matchMedia('(pointer: coarse)').matches;
