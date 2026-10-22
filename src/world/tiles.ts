import type { Node, RoadGraph } from './graph.ts';
import { loadTile, tileKey, type MapIndex, type TileData, type TileInfo } from './mapdata.ts';

export interface TileHandlers {
  /**
   * 그래프에 타일이 들어간 뒤 호출. 제너레이터를 돌려주면 yield 마다 끊어 여러 프레임에 나눠 실행한다
   * (타일 하나를 한 프레임에 다 만들면 50~200ms 멈칫한다)
   */
  onAdd(key: string, tile: TileData): Generator<string, void> | void;
  onRemove(key: string): void;
  /** 자세히 만들지 않은 바깥 고리(반경 +2 까지) 타일의 저해상도 모습을 보이고 치운다 */
  onFar?(key: string, tile: TileData): void;
  onFarRemove?(key: string): void;
  /** 플레이어와 가까운(DETAIL_NEAR 안) 타일에 상세(주차 차량·간판)를 더한다. 제너레이터면 나눠 돌린다 */
  onDetail?(key: string, tile: TileData): Generator<string, void> | void;
  onDetailRemove?(key: string): void;
}

/** 타일 사각형까지의 거리가 이 안이면 상세를 올리고, 이보다 멀어지면 내린다 (이력 현상) */
const DETAIL_NEAR = 350;
const DETAIL_FAR = 650;

/** 플레이어 주변 (2R+1)² 타일만 유지하며 받아오고 지운다. 그 바깥 두 고리는 데이터만 받아 저해상도로 보인다 */
export interface TileManager {
  readonly loaded: ReadonlySet<string>;
  readonly loading: number;
  /** 저해상도로 보이는 타일 수 */
  readonly farCount: number;
  /** 상세(주차·간판)가 올라온 타일 */
  readonly detailed: ReadonlySet<string>;
  /** 지금 여러 프레임에 걸쳐 만드는 중인 타일 */
  readonly building: string | null;
  /** 플레이어 위치 기준으로 필요한 타일을 맞춘다. 프레임당 budgetMs 만큼만 일한다 */
  update(x: number, z: number, budgetMs?: number): void;
  /** 시작 시 주변 타일이 다 들어올 때까지 */
  warmup(x: number, z: number): Promise<void>;
  isReady(x: number, z: number): boolean;
  tileAt(x: number, z: number): [number, number];
  /** 로드된 타일의 데이터 */
  tileData(key: string): TileData | undefined;
  /** 최근 생성·정리 단계별 소요(ms), 2ms 넘는 것만 */
  readonly profile: ReadonlyArray<[string, number]>;
}

export function createTileManager(index: MapIndex, g: RoadGraph, handlers: TileHandlers, radius = 1): TileManager {
  const infos = new Map<string, TileInfo>();
  for (const t of index.tiles) infos.set(tileKey(t.i, t.j), t);
  const loaded = new Set<string>();
  /** 저해상도로 보이는 중인 타일 */
  const far = new Set<string>();
  const data = new Map<string, TileData>();
  const pending = new Map<string, Promise<void>>();
  let job: { key: string; it: Iterator<string, void>; step: number; detail?: boolean } | null = null;
  const detailed = new Set<string>();
  /** (x,z) 에서 타일 사각형까지의 거리 */
  const rectDist = (key: string, x: number, z: number): number => {
    const [i, j] = key.split('_').map(Number);
    const x0 = index.bbox.minX + i * T;
    const z0 = index.bbox.minZ + j * T;
    const dx = Math.max(x0 - x, 0, x - (x0 + T));
    const dz = Math.max(z0 - z, 0, z - (z0 + T));
    return Math.hypot(dx, dz);
  };
  const T = index.tile;
  const tileAt = (x: number, z: number): [number, number] => [Math.floor((x - index.bbox.minX) / T), Math.floor((z - index.bbox.minZ) / T)];

  function wanted(x: number, z: number, r: number): string[] {
    const [ci, cj] = tileAt(x, z);
    const out: string[] = [];
    // 가까운 타일부터
    for (let d = 0; d <= r; d++) {
      for (let i = ci - d; i <= ci + d; i++) {
        for (let j = cj - d; j <= cj + d; j++) {
          if (Math.max(Math.abs(i - ci), Math.abs(j - cj)) !== d) continue;
          const k = tileKey(i, j);
          if (infos.has(k)) out.push(k);
        }
      }
    }
    return out;
  }

  function fetchTile(key: string): Promise<void> {
    let p = pending.get(key);
    if (p) return p;
    p = loadTile(infos.get(key)!)
      .then((tile) => {
        data.set(key, tile);
      })
      .catch((e) => console.warn('[tiles] 로드 실패', key, e))
      .finally(() => pending.delete(key));
    pending.set(key, p);
    return p;
  }

  /** 최근 타일 생성·정리의 단계별 소요(ms). 개발 중 멈칫거림을 찾을 때 본다 */
  const profile: Array<[string, number]> = [];
  const mark = (label: string, t0: number) => {
    const ms = performance.now() - t0;
    if (ms > 2) profile.push([label, Math.round(ms * 10) / 10]);
    if (profile.length > 200) profile.splice(0, 100);
  };

  /** 만드는 중인 타일 키 (함수로 두어 타입 좁히기를 피한다) */
  const buildingKey = (): string | null => job?.key ?? null;
  function showFar(key: string): void {
    const tile = data.get(key);
    if (!tile || far.has(key) || loaded.has(key) || job?.key === key) return;
    const t0 = performance.now();
    handlers.onFar?.(key, tile);
    far.add(key);
    mark(`${key} far`, t0);
  }
  function hideFar(key: string): void {
    if (!far.has(key)) return;
    handlers.onFarRemove?.(key);
    far.delete(key);
  }

  /** 타일을 그래프에 넣고 생성 작업을 시작한다. 제너레이터가 아니면 그 자리에서 끝난다. 저해상도 모습은 다 만들어진 뒤에 치운다 */
  function activate(key: string): void {
    const tile = data.get(key);
    if (!tile || loaded.has(key) || job) return;
    const t0 = performance.now();
    g.addTile(key, tile);
    mark(`${key} graph`, t0);
    const r = handlers.onAdd(key, tile);
    if (r && typeof r.next === 'function') job = { key, it: r, step: 0 };
    else {
      loaded.add(key);
      hideFar(key);
    }
  }
  /** 진행 중인 생성 작업을 budgetMs 동안 돌린다 */
  function pump(budgetMs: number): void {
    if (!job) return;
    const t0 = performance.now();
    do {
      const ts = performance.now();
      const r = job.it.next();
      const done = r.done;
      mark(`${job.key} ${done ? '끝' : (r.value ?? `step${job.step}`)}`, ts);
      job.step++;
      if (done) {
        const key = job.key;
        if (job.detail) detailed.add(key);
        else loaded.add(key);
        job = null;
        if (!detailed.has(key)) hideFar(key);
        return;
      }
    } while (performance.now() - t0 < budgetMs);
  }
  /** 자세한 타일을 치운다. 아직 바깥 고리 안이면 저해상도로 돌아간다 */
  function deactivate(key: string, stillFar: boolean): void {
    if (!loaded.has(key)) return;
    const t0 = performance.now();
    if (detailed.has(key)) {
      handlers.onDetailRemove?.(key);
      detailed.delete(key);
    }
    handlers.onRemove(key);
    g.removeTile(key);
    loaded.delete(key);
    mark(`${key} remove`, t0);
    if (stillFar) showFar(key);
    else data.delete(key);
  }

  return {
    loaded,
    get loading() {
      return pending.size;
    },
    get farCount() {
      return far.size;
    },
    detailed,
    get building() {
      return job?.key ?? null;
    },
    tileAt,
    tileData: (key) => data.get(key),
    profile,
    update(x, z, budgetMs = 4) {
      if (job) {
        pump(budgetMs);
        if (job) return;
      }
      const want = wanted(x, z, radius);
      const wantSet = new Set(want);
      // 자세한 타일은 여유 반경 +1 까지 유지, 데이터·저해상도는 +2 까지
      const keep = new Set(wanted(x, z, radius + 1));
      const ring = wanted(x, z, radius + 2);
      const ringSet = new Set(ring);
      // 바깥으로 벗어난 저해상도 타일과 데이터는 버린다
      for (const k of [...far]) {
        if (!ringSet.has(k)) {
          hideFar(k);
          data.delete(k);
        }
      }
      for (const k of [...data.keys()]) if (!ringSet.has(k) && !loaded.has(k) && buildingKey() !== k) data.delete(k);
      // 멀어진 타일은 한 번에 하나씩 정리
      let removed = false;
      for (const k of loaded) {
        if (!keep.has(k)) {
          deactivate(k, ringSet.has(k));
          removed = true;
          break;
        }
      }
      // 필요한 타일: 데이터가 있으면 생성 시작(한 번에 하나, 정리한 프레임엔 쉰다), 없으면 받기 시작
      for (const k of want) {
        if (loaded.has(k)) continue;
        if (data.has(k)) {
          if (removed) continue;
          activate(k);
          pump(budgetMs);
          return;
        }
        if (!pending.has(k)) void fetchTile(k);
      }
      // 바깥 고리: 데이터를 미리 받아 두고(한 번에 둘), 받아진 것은 저해상도로 보인다 (프레임당 하나)
      for (const k of ring) {
        if (wantSet.has(k) || loaded.has(k)) continue;
        if (data.has(k)) {
          if (!far.has(k)) {
            showFar(k);
            return;
          }
        } else if (!pending.has(k) && pending.size < 2) void fetchTile(k);
      }
      // 상세 승격·강등: 가까운 타일에만 주차 차량·간판. 프레임당 하나
      for (const k of detailed) {
        if (loaded.has(k) && rectDist(k, x, z) <= DETAIL_FAR) continue;
        handlers.onDetailRemove?.(k);
        detailed.delete(k);
        return;
      }
      for (const k of loaded) {
        if (detailed.has(k) || rectDist(k, x, z) > DETAIL_NEAR) continue;
        const tile = data.get(k);
        if (!tile) continue;
        const r = handlers.onDetail?.(k, tile);
        if (r && typeof r.next === 'function') {
          job = { key: k, it: r, step: 0, detail: true };
          pump(budgetMs);
        } else detailed.add(k);
        return;
      }
    },
    async warmup(x, z) {
      const want = wanted(x, z, radius);
      await Promise.all(want.map((k) => fetchTile(k)));
      for (const k of want) {
        activate(k);
        while (job) pump(1000);
      }
    },
    isReady(x, z) {
      return wanted(x, z, radius).every((k) => loaded.has(k));
    },
  };
}

/** 로드된 영역 안에서 노드가 아직 있는지 */
export const nodeLoaded = (g: RoadGraph, n: Node): boolean => g.has(n);
