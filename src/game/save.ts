import { storage } from '../util/storage.ts';
import { CARS, carById, emptyParts, type Parts } from '../vehicle/stats.ts';

export interface CarSave {
  parts: Parts;
  paint: string;
  glow: string;
}

export interface SaveData {
  credits: number;
  current: string;
  cars: Record<string, CarSave>;
  best: number;
}

const KEY = 'dc-save';
export const DEFAULT_GLOW = '#4fd1ff';

function fresh(): SaveData {
  return {
    credits: 0,
    current: CARS[0].id,
    cars: { [CARS[0].id]: { parts: emptyParts(), paint: CARS[0].paint, glow: DEFAULT_GLOW } },
    best: 0,
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
  save.credits += n;
  persist();
}
