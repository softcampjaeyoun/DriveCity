// tools/build-map.mjs 가 만드는 맵 파일 형식. 좌표는 미터, x = 동쪽, z = 남쪽

export type RoadClass = 'motorway' | 'trunk' | 'primary' | 'secondary' | 'tertiary' | 'unclassified' | 'residential' | 'living_street';

export interface EdgeData {
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

export interface MapData {
  origin: { lat: number; lon: number };
  bbox: { minX: number; maxX: number; minZ: number; maxZ: number };
  start: number;
  nodes: Array<[number, number]>;
  edges: EdgeData[];
  buildings: BuildingData[];
  water: number[][];
  parks: number[][];
  rails: number[][];
  places: PlaceData[];
  signals: number[];
}

export async function loadMap(url = `${import.meta.env.BASE_URL}map/seoul.json`): Promise<MapData> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`맵 파일을 못 읽었어요: ${res.status}`);
  return (await res.json()) as MapData;
}
