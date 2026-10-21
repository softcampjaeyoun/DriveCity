// 차량 카탈로그와 튜닝 부품. 여기 숫자만 바꾸면 운전감과 밸런스가 바뀐다

export type PartKey = 'engine' | 'tires' | 'suspension' | 'booster';
export const PART_KEYS: readonly PartKey[] = ['engine', 'tires', 'suspension', 'booster'];
export const MAX_LEVEL = 5;

export const PART_INFO: Record<PartKey, { name: string; desc: string }> = {
  engine: { name: '엔진', desc: '최고 속도와 가속이 올라가요.' },
  tires: { name: '타이어', desc: '접지력과 제동력이 올라가요. 드리프트는 조금 짧아져요.' },
  suspension: { name: '서스펜션', desc: '핸들 반응이 빨라져 코너를 더 날카롭게 돌아요.' },
  booster: { name: '부스터', desc: '부스트가 더 빨리 차고 더 오래 가요.' },
};

export interface CarSpec {
  id: string;
  name: string;
  cls: string;
  price: number;
  /** 튜닝 부품 가격 배수 */
  tier: number;
  base: {
    /** m/s. ×3.6 하면 km/h */
    vmax: number;
    accel: number;
    grip: number;
    yaw: number;
  };
  /** 기본 도색 */
  paint: string;
}

export const CARS: readonly CarSpec[] = [
  { id: 'city', name: '시티', cls: '경차', price: 0, tier: 1, base: { vmax: 44, accel: 13, grip: 8.5, yaw: 2.2 }, paint: '#f1f3f7' },
  { id: 'sprinter', name: '스프린터', cls: '핫해치', price: 12000, tier: 1.6, base: { vmax: 54, accel: 17, grip: 9, yaw: 2.3 }, paint: '#3a7bff' },
  { id: 'vista', name: '비스타 GT', cls: '스포츠', price: 38000, tier: 2.6, base: { vmax: 64, accel: 22, grip: 9.5, yaw: 2.4 }, paint: '#e8394a' },
  { id: 'phantom', name: '팬텀', cls: '슈퍼카', price: 95000, tier: 4, base: { vmax: 76, accel: 28, grip: 10, yaw: 2.5 }, paint: '#1d1f26' },
];

export const carById = (id: string): CarSpec => CARS.find((c) => c.id === id) ?? CARS[0];

export type Parts = Record<PartKey, number>;
export const emptyParts = (): Parts => ({ engine: 0, tires: 0, suspension: 0, booster: 0 });
export const partsLevel = (p: Parts): number => PART_KEYS.reduce((s, k) => s + p[k], 0);

/** 다음 레벨(1..MAX_LEVEL)로 올리는 비용 */
export function partCost(car: CarSpec, next: number): number {
  return Math.round((400 * next * next + 400 * next) * car.tier / 100) * 100;
}

/** 물리에서 실제로 쓰는 값 */
export interface CarStats {
  vmax: number;
  nitroVmax: number;
  accel: number;
  nitroAccel: number;
  brake: number;
  revMax: number;
  grip: number;
  hbGrip: number;
  maxYaw: number;
  nitroGain: number;
  nitroDrain: number;
}

export function computeStats(car: CarSpec, p: Parts): CarStats {
  const vmax = car.base.vmax * (1 + 0.06 * p.engine);
  return {
    vmax,
    nitroVmax: vmax * 1.35 * (1 + 0.03 * p.booster),
    accel: car.base.accel * (1 + 0.1 * p.engine),
    nitroAccel: 10 + 2 * p.booster,
    brake: 30 + 2.5 * p.tires,
    revMax: 14,
    grip: car.base.grip * (1 + 0.1 * p.tires),
    hbGrip: 1.4 + 0.06 * p.tires,
    maxYaw: car.base.yaw * (1 + 0.07 * p.suspension),
    nitroGain: 0.22 * (1 + 0.12 * p.booster),
    nitroDrain: 0.28 * (1 - 0.05 * p.booster),
  };
}

/** 차고 화면 표시용 0..1 스탯. 최고 슈퍼카 풀튜닝을 1 로 둔다 */
export function displayStats(s: CarStats): Array<{ key: string; name: string; value: number; text: string }> {
  return [
    { key: 'speed', name: '최고 속도', value: s.vmax / 100, text: `${Math.round(s.vmax * 3.6)} km/h` },
    { key: 'accel', name: '가속', value: s.accel / 42, text: s.accel.toFixed(1) },
    { key: 'grip', name: '접지력', value: s.grip / 15, text: s.grip.toFixed(1) },
    { key: 'handling', name: '핸들링', value: s.maxYaw / 3.4, text: s.maxYaw.toFixed(2) },
    { key: 'boost', name: '부스트', value: s.nitroGain / 0.36, text: `${Math.round(s.nitroVmax * 3.6)} km/h` },
  ];
}
