export const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));
export const rint = (k: number): number => Math.floor(Math.random() * k);

/** 시드 고정 난수. 도시를 매번 같은 모양으로 만들기 위해 사용 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Vec2 = readonly [number, number];

/** 2차 베지어 곡선 위의 점 */
export function bez(p0: Vec2, c: Vec2, p1: Vec2, t: number): [number, number] {
  const u = 1 - t;
  return [
    u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0],
    u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1],
  ];
}

/** 한국어 조사 선택. 받침이 있으면 withBatchim */
export const josa = (word: string, withBatchim: string, without: string): string =>
  (word.charCodeAt(word.length - 1) - 0xac00) % 28 ? withBatchim : without;

export function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${String(m).padStart(2, '0')}:${r.toFixed(2).padStart(5, '0')}`;
}
