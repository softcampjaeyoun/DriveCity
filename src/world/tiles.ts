import type { Node, RoadGraph } from './graph.ts';
import { loadTile, tileKey, type MapIndex, type TileData, type TileInfo } from './mapdata.ts';

export interface TileHandlers {
  /**
   * 그래프에 타일이 들어간 뒤 호출. 제너레이터를 돌려주면 yield 마다 끊어 여러 프레임에 나눠 실행한다
   * (타일 하나를 한 프레임에 다 만들면 50~200ms 멈칫한다)
   */
  onAdd(key: string, tile: TileData): Generator<string, void> | void;
  onRemove(key: string): void;
}

/** 플레이어 주변 (2R+1)² 타일만 유지하며 받아오고 지운다 */
export interface TileManager {
  readonly loaded: ReadonlySet<string>;
  readonly loading: number;
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
  const data = new Map<string, TileData>();
  const pending = new Map<string, Promise<void>>();
  let job: { key: string; it: Iterator<string, void>; step: number } | null = null;
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

  /** 타일을 그래프에 넣고 생성 작업을 시작한다. 제너레이터가 아니면 그 자리에서 끝난다 */
  function activate(key: string): void {
    const tile = data.get(key);
    if (!tile || loaded.has(key) || job) return;
    const t0 = performance.now();
    g.addTile(key, tile);
    mark(`${key} graph`, t0);
    const r = handlers.onAdd(key, tile);
    if (r && typeof r.next === 'function') job = { key, it: r, step: 0 };
    else loaded.add(key);
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
        loaded.add(job.key);
        job = null;
        return;
      }
    } while (performance.now() - t0 < budgetMs);
  }
  function deactivate(key: string): void {
    if (!loaded.has(key)) return;
    const t0 = performance.now();
    handlers.onRemove(key);
    g.removeTile(key);
    loaded.delete(key);
    data.delete(key);
    mark(`${key} remove`, t0);
  }

  return {
    loaded,
    get loading() {
      return pending.size;
    },
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
      // 멀어진 타일은 한 번에 하나씩 정리 (여유 반경 +1 까지는 유지)
      const keep = new Set(wanted(x, z, radius + 1));
      let removed = false;
      for (const k of loaded) {
        if (!keep.has(k)) {
          deactivate(k);
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
      // 미리 받기: 한 칸 더 바깥 타일 데이터를 받아 둔다 (활성화는 안 함)
      for (const k of keep) if (!wantSet.has(k) && !data.has(k) && !pending.has(k) && pending.size < 2) void fetchTile(k);
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
