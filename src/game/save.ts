import { storage } from '../util/storage.ts';
import { CARS, carById, emptyParts, type Parts } from '../vehicle/stats.ts';

export interface CarSave {
  parts: Parts;
  paint: string;
  glow: string;
}

export interface Settings {
  /** 블룸 등 화면 효과 */
  fx: boolean;
  /** 'auto' 면 프레임 시간을 보고 자동으로 낮춘다 */
  quality?: 'auto' | 'high' | 'medium' | 'low';
  /** 0 = 끔, 1.. = 방송국 */
  radio: number;
}

export interface SaveData {
  credits: number;
  current: string;
  cars: Record<string, CarSave>;
  best: number;
  xp: number;
  settings: Settings;
}

const KEY = 'dc-save';
export const DEFAULT_GLOW = '#4fd1ff';

function fresh(): SaveData {
  return {
    credits: 0,
    current: CARS[0].id,
    cars: { [CARS[0].id]: { parts: emptyParts(), paint: CARS[0].paint, glow: DEFAULT_GLOW } },
    best: 0,
    xp: 0,
    settings: { fx: true, radio: 1 },
  };
}

function load(): SaveData {
  const d = storage.getJSON<Partial<SaveData>>(KEY);
  const base = fresh();
  if (!d) return base;
  const cars: Record<string, CarSave> = {};
  for (const [id, c] of Object.entries(d.cars ?? {})) {
    if (!CARS.some((s) => s.id === id)) continue;
    cars[id] = { parts: { ...emptyParts(), ...c.parts }, paint: c.paint ?? carById(id).paint, glow: c.glow ?? DEFAULT_GLOW };
  }
  if (!cars[CARS[0].id]) cars[CARS[0].id] = base.cars[CARS[0].id];
  return {
    credits: Math.max(0, Number(d.credits) || 0),
    current: d.current && cars[d.current] ? d.current : CARS[0].id,
    cars,
    best: Number(d.best) || 0,
    xp: Math.max(0, Number(d.xp) || 0),
    settings: { ...base.settings, ...d.settings },
  };
}

export const save: SaveData = load();

export function persist(): void {
  storage.setJSON(KEY, save);
}

export function currentCar(): CarSave {
  return save.cars[save.current];
}

export function addCredits(n: number): void {
  save.credits = Math.max(0, save.credits + n);
  persist();
}

/** 레벨 = 1 + floor(sqrt(xp / 100)). Lv2 100xp, Lv3 400xp, Lv4 900xp ... */
export const levelOf = (xp: number): number => 1 + Math.floor(Math.sqrt(xp / 100));
export const xpForLevel = (lv: number): number => (lv - 1) * (lv - 1) * 100;

export function addXp(n: number): number {
  const before = levelOf(save.xp);
  save.xp += n;
  persist();
  const after = levelOf(save.xp);
  return after > before ? after : 0;
}

export function levelInfo(): { lv: number; xp: number; next: number } {
  const lv = levelOf(save.xp);
  return { lv, xp: save.xp - xpForLevel(lv), next: xpForLevel(lv + 1) - xpForLevel(lv) };
}
