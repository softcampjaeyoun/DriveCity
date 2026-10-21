import type { Node, RoadGraph } from './graph.ts';
import { loadTile, tileKey, type MapIndex, type TileData, type TileInfo } from './mapdata.ts';

export interface TileHandlers {
  /** 그래프에 타일이 들어간 뒤 호출. 반환 순서대로 removed 때도 호출된다 */
  onAdd(key: string, tile: TileData): void;
  onRemove(key: string): void;
}

/** 플레이어 주변 (2R+1)² 타일만 유지하며 받아오고 지운다 */
export interface TileManager {
  readonly loaded: ReadonlySet<string>;
  readonly loading: number;
  /** 플레이어 위치 기준으로 필요한 타일을 맞춘다. 한 프레임에 하나씩 처리 */
  update(x: number, z: number): void;
  /** 시작 시 주변 타일이 다 들어올 때까지 */
  warmup(x: number, z: number): Promise<void>;
  isReady(x: number, z: number): boolean;
  tileAt(x: number, z: number): [number, number];
  /** 로드된 타일의 데이터 */
  tileData(key: string): TileData | undefined;
}

export function createTileManager(index: MapIndex, g: RoadGraph, handlers: TileHandlers, radius = 1): TileManager {
  const infos = new Map<string, TileInfo>();
  for (const t of index.tiles) infos.set(tileKey(t.i, t.j), t);
  const loaded = new Set<string>();
  const data = new Map<string, TileData>();
  const pending = new Map<string, Promise<void>>();
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

  function activate(key: string): void {
    const tile = data.get(key);
    if (!tile || loaded.has(key)) return;
    g.addTile(key, tile);
    handlers.onAdd(key, tile);
    loaded.add(key);
  }
  function deactivate(key: string): void {
    if (!loaded.has(key)) return;
    handlers.onRemove(key);
    g.removeTile(key);
    loaded.delete(key);
    data.delete(key);
  }

  return {
    loaded,
    get loading() {
      return pending.size;
    },
    tileAt,
    tileData: (key) => data.get(key),
    update(x, z) {
      const want = wanted(x, z, radius);
      const wantSet = new Set(want);
      // 멀어진 타일은 한 번에 하나씩 정리 (여유 반경 +1 까지는 유지)
      const keep = new Set(wanted(x, z, radius + 1));
      for (const k of loaded) {
        if (!keep.has(k)) {
          deactivate(k);
          break;
        }
      }
      // 필요한 타일: 데이터가 있으면 활성화(프레임당 하나), 없으면 받기 시작
      for (const k of want) {
        if (loaded.has(k)) continue;
        if (data.has(k)) {
          activate(k);
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
      for (const k of want) activate(k);
    },
    isReady(x, z) {
      return wanted(x, z, radius).every((k) => loaded.has(k));
    },
  };
}

/** 로드된 영역 안에서 노드가 아직 있는지 */
export const nodeLoaded = (g: RoadGraph, n: Node): boolean => g.has(n);
