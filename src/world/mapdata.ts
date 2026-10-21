// tools/build-map.mjs 가 만드는 타일 맵 형식. 좌표는 미터, x = 동쪽, z = 남쪽

export type RoadClass = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'unclassified' | 'residential' | 'living_street';

export interface EdgeData {
  /** 전역 간선 번호 */
  id: number;
  /** 전역 노드 번호 */
  a: number;
  b: number;
  /** [x0, z0, x1, z1, ...] a 에서 b 로 */
  pts: number[];
  len: number;
  /** a→b 방향 차선 수 */
  lf: number;
  /** b→a 방향 차선 수. 0 이면 일방통행 */
  lb: number;
  cls: RoadClass;
  link: boolean;
  bridge: boolean;
  tunnel: boolean;
  name: string;
}

export interface BuildingData {
  ring: number[];
  h: number;
  kind: 'tower' | 'block' | 'low' | 'apt';
  name: string;
}

export interface PlaceData {
  x: number;
  z: number;
  name: string;
  rank: string;
}

export interface TileInfo {
  i: number;
  j: number;
  file: string;
  edges: number;
  buildings: number;
  roadLen: number;
}

export interface MapIndex {
  origin: { lat: number; lon: number };
  bbox: { minX: number; maxX: number; minZ: number; maxZ: number };
  tile: number;
  start: { node: number; x: number; z: number };
  places: PlaceData[];
  tiles: TileInfo[];
  overview: { file: string; scale: number; w: number; h: number };
}

export interface TileData {
  i: number;
  j: number;
  /** [전역 번호, x, z] */
  nodes: Array<[number, number, number]>;
  edges: EdgeData[];
  buildings: BuildingData[];
  water: number[][];
  parks: number[][];
  rails: number[][];
  /** 신호등이 있는 노드 번호 */
  signals: number[];
}

export const MAP_BASE = `${import.meta.env.BASE_URL}map/seoul/`;

export async function loadIndex(): Promise<MapIndex> {
  const res = await fetch(`${MAP_BASE}index.json`);
  if (!res.ok) throw new Error(`맵 index 를 못 읽었어요: ${res.status}`);
  return (await res.json()) as MapIndex;
}

export async function loadTile(info: TileInfo): Promise<TileData> {
  const res = await fetch(`${MAP_BASE}${info.file}`);
  if (!res.ok) throw new Error(`타일을 못 읽었어요: ${info.file} ${res.status}`);
  return (await res.json()) as TileData;
}

export const tileKey = (i: number, j: number): string => `${i}_${j}`;
