import * as THREE from 'three';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeObject } from '../render/assets.ts';

/**
 * 외부 3D 모델 등록부. glb 와 fbx 를 지원한다.
 * public/models/ 에 파일을 넣고 여기에 한 줄 추가하면 해당 차량이 상자 모델 대신 그 모델로 그려진다.
 * 파일이 없거나 로드에 실패하면 상자 모델을 그대로 쓴다.
 */
export interface ModelDef {
  /** public/models/ 아래 경로 */
  file: string;
  /** 차 길이(m). 모델의 바운딩 박스를 이 길이에 맞춰 자동으로 키우거나 줄인다 */
  length: number;
  /** 모델 앞머리가 +Z 를 보지 않을 때 보정 (rad). 예: +X 를 보면 -Math.PI / 2 */
  yaw?: number;
  /** 바닥 높이 미세 조정 */
  yOffset?: number;
  /** 출처와 라이선스. 공개할 때 README 에 옮겨 적는다 */
  attribution?: string;
}

const KENNEY = 'Kenney Car Kit 3.1, CC0, kenney.nl';
const RGSDEV = 'Free Low Poly Vehicles Pack by Rgsdev, CC0, opengameart.org';
// Kenney 차 모델은 앞바퀴가 +Z 에 있어 우리 진행 방향(+Z)과 같다. 돌리면 뒤로 달리는 것처럼 보인다
const kenney = (name: string, length: number): ModelDef => ({ file: `kenney/${name}.glb`, length, attribution: KENNEY });

export const MODELS: Record<string, ModelDef> = {
  // 교통 (src/vehicle/kinds.ts 의 models 배열에서 고른다)
  sedan: kenney('sedan', 4.2),
  sedan_sports: kenney('sedan-sports', 4.3),
  suv: kenney('suv', 4.4),
  van: kenney('van', 4.6),
  hatchback: kenney('hatchback-sports', 3.9),
  delivery: kenney('delivery', 5.0),
  taxi: kenney('taxi', 4.3),
  police: kenney('police', 4.4),
  city_bus: { file: 'rgsdev/Bus.fbx', length: 11, attribution: RGSDEV },
  village_bus: { file: 'rgsdev/Bus.fbx', length: 7.5, attribution: RGSDEV },
  express_bus: { file: 'rgsdev/Bus.fbx', length: 12, attribution: RGSDEV },
  // 라이벌
  rival_1: kenney('suv-luxury', 4.6),
  rival_2: kenney('sedan-sports', 4.3),
  rival_3: kenney('race', 4.4),
  // 플레이어 차량은 도색과 바퀴 애니메이션이 되는 상자 모델을 기본으로 쓴다.
  // 외부 모델로 바꾸려면 주석을 풀고 stats.ts 의 model 키와 맞추면 된다.
  // car_city: kenney('hatchback-sports', 3.9),
  // car_sprinter: kenney('sedan-sports', 4.3),
  // car_vista: kenney('race', 4.4),
  // car_phantom: kenney('race-future', 4.6),
};

const upgraded = new Map<THREE.Material, THREE.Material>();
/** 모델에 들어 있는 재질(Lambert/Phong/Standard)을 같은 색·텍스처의 클리어코트 도장 재질로. 같은 원본은 한 번만 */
export function upgradeCarMaterial(m: THREE.Material): THREE.Material {
  let u = upgraded.get(m);
  if (u) return u;
  const src = m as THREE.MeshStandardMaterial;
  const color = src.color ? src.color.clone() : new THREE.Color(0x888888);
  u = new THREE.MeshPhysicalMaterial({ color, map: src.map ?? null, roughness: 0.42, metalness: 0.2, clearcoat: 0.7, clearcoatRoughness: 0.18, envMapIntensity: 1.1 });
  u.name = m.name;
  upgraded.set(m, u);
  return u;
}

const gltfLoader = new GLTFLoader();
const fbxLoader = new FBXLoader();
const cache = new Map<string, Promise<THREE.Group | null>>();

async function loadRaw(url: string): Promise<THREE.Object3D> {
  if (/\.fbx$/i.test(url)) return fbxLoader.loadAsync(url);
  return (await gltfLoader.loadAsync(url)).scene;
}

/** 모델을 읽어 길이·방향·바닥을 맞춘 원본을 돌려준다. 같은 id 는 한 번만 읽는다 */
export function loadModel(id: string): Promise<THREE.Group | null> {
  const def = MODELS[id];
  if (!def) return Promise.resolve(null);
  let p = cache.get(id);
  if (p) return p;
  p = loadRaw(`${import.meta.env.BASE_URL}models/${def.file}`)
    .then((obj) => normalize(obj, def))
    .catch((e: unknown) => {
      console.warn(`[models] ${id} 로드 실패, 상자 모델을 유지해요`, e);
      return null;
    });
  cache.set(id, p);
  return p;
}

function normalize(obj: THREE.Object3D, def: ModelDef): THREE.Group {
  const root = new THREE.Group();
  const inner = new THREE.Group();
  inner.add(obj);
  inner.rotation.y = def.yaw ?? 0;
  root.add(inner);
  root.updateMatrixWorld(true);

  const box = new THREE.Box3().setFromObject(inner);
  const size = box.getSize(new THREE.Vector3());
  const s = size.z > 0 ? def.length / size.z : 1;
  inner.scale.setScalar(s);
  inner.updateMatrixWorld(true);
  box.setFromObject(inner);
  const center = box.getCenter(new THREE.Vector3());
  inner.position.set(-center.x, -box.min.y + (def.yOffset ?? 0), -center.z);

  obj.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    // 차체 도장 재질로 통일: 클리어코트가 하늘 환경맵을 비춰 플라스틱 느낌을 없앤다
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const converted = mats.map((m) => upgradeCarMaterial(m));
    mesh.material = Array.isArray(mesh.material) ? converted : converted[0];
  });
  // 차체·바퀴 여러 메시를 하나로 합쳐 차 한 대당 그리기 호출을 1번으로
  const merged = mergeObject(root);
  if (merged) {
    const single = new THREE.Group();
    const mesh = new THREE.Mesh(merged.geometry, merged.materials.length === 1 ? merged.materials[0] : merged.materials);
    mesh.castShadow = true;
    single.add(mesh);
    return single;
  }
  return root;
}

/**
 * group 안의 상자 모델(fallback)을 외부 모델로 바꿔 끼운다.
 * 등록되지 않은 id 거나 로드 실패면 아무것도 하지 않는다.
 */
export function swapModel(group: THREE.Object3D, fallback: THREE.Object3D, id: string | undefined, tint?: number): void {
  if (!id || !MODELS[id]) return;
  void loadModel(id).then((template) => {
    if (!template || !fallback.parent) return;
    fallback.visible = false;
    const clone = template.clone(true);
    clone.name = 'model';
    if (tint !== undefined) tintBody(clone, tint);
    group.add(clone);
  });
}

/**
 * 차체로 보이는 재질(삼각형이 가장 많고, 텍스처가 없고, 검정이 아닌 것)의 색을 바꾼다.
 * clone 은 재질을 공유하므로 바꿀 재질만 복제한다.
 */
function tintBody(root: THREE.Object3D, hex: number): void {
  const tris = new Map<THREE.Material, number>();
  const owners = new Map<THREE.Material, Array<{ mesh: THREE.Mesh; index: number }>>();
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geo = mesh.geometry;
    const count = (geo.index ? geo.index.count : geo.attributes.position.count) / 3;
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mats.forEach((m, index) => {
      tris.set(m, (tris.get(m) ?? 0) + count / mats.length);
      const list = owners.get(m) ?? [];
      list.push({ mesh, index });
      owners.set(m, list);
    });
  });
  let best: THREE.Material | null = null;
  let bestTris = 0;
  for (const [m, n] of tris) {
    const lm = m as THREE.MeshLambertMaterial;
    if (lm.map || !lm.color) continue;
    const { r, g, b } = lm.color;
    if (Math.max(r, g, b) < 0.15) continue; // 타이어, 창틀
    if (n > bestTris) {
      best = m;
      bestTris = n;
    }
  }
  if (!best) return;
  const painted = (best as THREE.MeshLambertMaterial).clone();
  painted.color.setHex(hex);
  for (const { mesh, index } of owners.get(best) ?? []) {
    if (Array.isArray(mesh.material)) {
      const arr = mesh.material.slice();
      arr[index] = painted;
      mesh.material = arr;
    } else mesh.material = painted;
  }
}

export function hasModel(id: string | undefined): boolean {
  return !!id && id in MODELS;
}
