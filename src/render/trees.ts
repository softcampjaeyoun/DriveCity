import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../util/math.ts';
import { loadTex, type MergedModel } from './assets.ts';

/**
 * 절차 생성 나무. 다면체 덩어리 대신 잎 뭉치 알파 카드 여러 장을 타원체 안에 흩어 놓고,
 * 카드 법선을 타원체 중심에서 바깥으로 향하게 해 전체가 한 덩어리 수관처럼 빛을 받는다.
 * 줄기는 수피 사진 질감, 아래쪽 잎은 어둡게(꼭짓점 색) 해 수관 안쪽 그늘을 낸다.
 * 결과는 city.ts 가 인스턴싱하는 MergedModel 꼴 (geometry + materials[수피, 잎])
 */
export interface TreeKindDef {
  name: string;
  /** 줄기 높이(m), 밑동·꼭대기 반지름 */
  trunk: [number, number, number];
  /** 수관 타원체 반지름 (가로, 세로) 과 중심 높이 */
  crown: [number, number, number];
  cards: number;
  /** 카드 가로·세로 (m) */
  card: [number, number];
  /** 잎 색: 색상(hue), 채도, 밝기 */
  hue: [number, number, number];
  /** 수관 아래쪽 어두움 (0 없음 .. 1 강함) */
  shade: number;
  /** 가지 수 */
  branches: number;
}

/** 서울 가로수·공원수 대표 수종 */
export const TREE_KINDS: TreeKindDef[] = [
  { name: '플라타너스', trunk: [3.2, 0.22, 0.16], crown: [2.7, 3.0, 5.6], cards: 24, card: [2.9, 2.5], hue: [96, 42, 34], shade: 0.5, branches: 3 },
  { name: '느티나무', trunk: [2.7, 0.24, 0.17], crown: [3.5, 2.5, 5.0], cards: 26, card: [3.1, 2.5], hue: [108, 40, 31], shade: 0.5, branches: 4 },
  { name: '은행나무', trunk: [2.9, 0.18, 0.13], crown: [1.7, 3.3, 5.6], cards: 20, card: [2.2, 2.8], hue: [84, 48, 40], shade: 0.4, branches: 2 },
  { name: '소나무', trunk: [3.6, 0.2, 0.14], crown: [2.3, 1.7, 5.3], cards: 18, card: [2.6, 2.1], hue: [138, 34, 24], shade: 0.55, branches: 3 },
  { name: '벚나무', trunk: [2.2, 0.17, 0.12], crown: [2.6, 2.1, 3.9], cards: 20, card: [2.5, 2.1], hue: [100, 38, 36], shade: 0.45, branches: 3 },
];

const texCache = new Map<string, THREE.CanvasTexture>();

/** 잎 뭉치 알파 텍스처: 작은 잎 수십 장을 겹쳐 그린다. 가장자리는 비워 카드 윤곽이 네모로 보이지 않게 */
export function leafClusterTexture(seed: number, hue: [number, number, number]): THREE.CanvasTexture {
  const key = `${seed}|${hue.join(',')}`;
  const cached = texCache.get(key);
  if (cached) return cached;
  const r = mulberry32(seed * 131 + 7);
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.clearRect(0, 0, S, S);
  const [h0, s0, l0] = hue;
  const leaves = 230;
  for (let i = 0; i < leaves; i++) {
    // 중심에 몰리게: 반지름을 제곱근으로
    const ang = r() * Math.PI * 2;
    const rad = Math.sqrt(r()) * 104;
    const x = S / 2 + Math.cos(ang) * rad;
    const y = S / 2 + Math.sin(ang) * rad * 0.9;
    const len = 13 + r() * 15;
    const wid = len * (0.45 + r() * 0.25);
    const rot = r() * Math.PI;
    // 안쪽 잎은 어둡게, 바깥 잎은 밝게 (덩어리 입체감)
    const depth = rad / 104;
    const light = l0 * (0.75 + depth * 0.45) + (r() - 0.5) * 8;
    g.save();
    g.translate(x, y);
    g.rotate(rot);
    g.fillStyle = `hsl(${h0 + (r() - 0.5) * 18}, ${s0 + (r() - 0.5) * 14}%, ${light}%)`;
    g.beginPath();
    g.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2);
    g.fill();
    // 잎맥: 가운데 밝은 선
    g.strokeStyle = `hsla(${h0}, ${s0}%, ${light + 12}%, 0.5)`;
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-len / 2 + 2, 0);
    g.lineTo(len / 2 - 2, 0);
    g.stroke();
    g.restore();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.anisotropy = 4;
  texCache.set(key, t);
  return t;
}

/** 화단(회양목) 빽빽한 잎 질감 (불투명, 반복) */
export function hedgeTexture(): THREE.CanvasTexture {
  const cached = texCache.get('hedge');
  if (cached) return cached;
  const r = mulberry32(2024);
  const S = 256;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  g.fillStyle = 'hsl(112, 34%, 17%)';
  g.fillRect(0, 0, S, S);
  for (let i = 0; i < 1400; i++) {
    const x = r() * S;
    const y = r() * S;
    const len = 6 + r() * 7;
    const wid = len * (0.5 + r() * 0.3);
    const light = 22 + r() * 22;
    g.fillStyle = `hsl(${104 + r() * 22}, ${36 + r() * 16}%, ${light}%)`;
    // 반복 이음새가 보이지 않게 가장자리 잎은 반대쪽에도 찍는다
    for (const [ox, oy] of [[0, 0], [-S, 0], [S, 0], [0, -S], [0, S]]) {
      if ((ox !== 0 && Math.abs(x - (ox < 0 ? S : 0)) > 16) || (oy !== 0 && Math.abs(y - (oy < 0 ? S : 0)) > 16)) continue;
      g.save();
      g.translate(x + ox, y + oy);
      g.rotate(r() * Math.PI);
      g.beginPath();
      g.ellipse(0, 0, len / 2, wid / 2, 0, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(2, 2);
  t.anisotropy = 4;
  texCache.set('hedge', t);
  return t;
}

function withColor(geo: THREE.BufferGeometry, r: number, g: number, b: number): THREE.BufferGeometry {
  const n = geo.attributes.position.count;
  const col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    col[i * 3] = r;
    col[i * 3 + 1] = g;
    col[i * 3 + 2] = b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

/** 수종 하나의 지오메트리(줄기+가지+잎 카드)와 재질 두 개 */
export function buildTree(def: TreeKindDef, seed: number, barkMat: THREE.Material, leafMat: THREE.Material): MergedModel & { height: number } {
  const r = mulberry32(seed * 977 + 13);
  const [trunkH, rBot, rTop] = def.trunk;
  const [crx, cry, cy] = def.crown;
  const parts: THREE.BufferGeometry[] = [];
  // 줄기: 살짝 휘게 두 토막
  const trunk = new THREE.CylinderGeometry(rTop, rBot, trunkH * 1.08, 7, 1).translate(0, trunkH * 0.54, 0);
  const tuv = trunk.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < tuv.count; i++) tuv.setXY(i, tuv.getX(i) * 1.2, tuv.getY(i) * (trunkH / 1.6));
  parts.push(withColor(trunk.toNonIndexed(), 1, 1, 1));
  // 가지: 수관 중심을 향해 비스듬히
  for (let i = 0; i < def.branches; i++) {
    const ang = (i / def.branches) * Math.PI * 2 + r() * 0.8;
    const len = crx * (0.55 + r() * 0.35);
    const br = new THREE.CylinderGeometry(rTop * 0.35, rTop * 0.7, len, 5, 1)
      .translate(0, len / 2, 0)
      .rotateZ(0.6 + r() * 0.5)
      .rotateY(ang)
      .translate(0, trunkH * (0.8 + r() * 0.15), 0);
    parts.push(withColor(br.toNonIndexed(), 0.9, 0.9, 0.9));
  }
  const trunkParts = parts.length;
  // 잎 카드: 타원체 안 임의 위치, 임의 방향. 법선은 중심에서 바깥으로
  const [cw, ch] = def.card;
  const center = new THREE.Vector3(0, cy, 0);
  const p = new THREE.Vector3();
  const nrm = new THREE.Vector3();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler();
  for (let i = 0; i < def.cards; i++) {
    // 표면 가까이 더 많이
    const u = r() * 2 - 1;
    const phi = r() * Math.PI * 2;
    const rad = 0.35 + Math.pow(r(), 0.6) * 0.5;
    const sx = Math.sqrt(1 - u * u) * Math.cos(phi) * crx * rad;
    const sz = Math.sqrt(1 - u * u) * Math.sin(phi) * crx * rad;
    const sy = u * cry * rad;
    const scale = 0.85 + r() * 0.35;
    const card = new THREE.PlaneGeometry(cw * scale, ch * scale);
    e.set((r() - 0.5) * 1.2, r() * Math.PI * 2, (r() - 0.5) * 0.8);
    q.setFromEuler(e);
    card.applyQuaternion(q);
    card.translate(sx, cy + sy, sz);
    const pos = card.attributes.position as THREE.BufferAttribute;
    const nr = card.attributes.normal as THREE.BufferAttribute;
    const col = new Float32Array(pos.count * 3);
    const bright = 0.9 + r() * 0.2;
    for (let k = 0; k < pos.count; k++) {
      p.set(pos.getX(k), pos.getY(k), pos.getZ(k));
      nrm.copy(p).sub(center);
      nrm.y /= cry / crx; // 타원체 → 구 법선
      if (nrm.lengthSq() < 1e-6) nrm.set(0, 1, 0);
      nrm.normalize();
      nr.setXYZ(k, nrm.x, nrm.y, nrm.z);
      // 아래쪽일수록 어둡게
      const t = (p.y - (cy - cry)) / (2 * cry);
      const shade = (1 - def.shade) + def.shade * Math.min(1, Math.max(0, t));
      col[k * 3] = col[k * 3 + 1] = col[k * 3 + 2] = shade * bright;
    }
    card.setAttribute('color', new THREE.BufferAttribute(col, 3));
    // 앞·뒤 양쪽에서 보이게 뒤집은 복사본도 (DoubleSide 는 뒷면 법선을 뒤집어 어두워진다)
    const front = card.toNonIndexed();
    const back = front.clone();
    const bp = back.attributes.position as THREE.BufferAttribute;
    const bn = back.attributes.normal as THREE.BufferAttribute;
    const buv = back.attributes.uv as THREE.BufferAttribute;
    const bc = back.attributes.color as THREE.BufferAttribute;
    for (let k = 0; k + 2 < bp.count; k += 3) {
      for (const a of [bp, bn, buv, bc]) {
        const size = a.itemSize;
        for (let s = 0; s < size; s++) {
          const tmp = a.array[(k + 1) * size + s];
          (a.array as Float32Array)[(k + 1) * size + s] = a.array[(k + 2) * size + s];
          (a.array as Float32Array)[(k + 2) * size + s] = tmp;
        }
      }
    }
    parts.push(front, back);
  }
  const merged = mergeGeometries(parts, true)!;
  // 그룹: 앞쪽 trunkParts 개는 수피, 나머지는 잎
  const groups = merged.groups;
  let trunkCount = 0;
  for (let i = 0; i < trunkParts; i++) trunkCount += groups[i].count;
  merged.clearGroups();
  merged.addGroup(0, trunkCount, 0);
  merged.addGroup(trunkCount, merged.attributes.position.count - trunkCount, 1);
  merged.computeBoundingBox();
  const height = cy + cry;
  return { geometry: merged, materials: [barkMat, leafMat], height };
}

export interface TreeSet {
  /** 가로수용 (플라타너스·느티나무·은행나무) */
  street: Array<MergedModel & { height: number }>;
  /** 공원용 (전 수종) */
  park: Array<MergedModel & { height: number }>;
  leafMats: THREE.MeshStandardMaterial[];
  barkMat: THREE.MeshStandardMaterial;
}

/** 수종별 모델을 한 번 만든다. 같은 수종도 seed 를 달리해 2개씩 */
export function buildTreeSet(): TreeSet {
  const barkMat = new THREE.MeshStandardMaterial({ map: loadTex('Bark012_Color.jpg', true, 1, 1), normalMap: loadTex('Bark012_NormalGL.jpg', false, 1, 1), roughness: 0.95, color: 0xb9b2a6, vertexColors: true });
  const leafMats: THREE.MeshStandardMaterial[] = [];
  const all: Array<MergedModel & { height: number; name: string }> = [];
  TREE_KINDS.forEach((def, k) => {
    const leafMat = new THREE.MeshStandardMaterial({ map: leafClusterTexture(k, def.hue), alphaTest: 0.45, side: THREE.FrontSide, roughness: 0.9, vertexColors: true, color: 0xffffff });
    leafMats.push(leafMat);
    for (let v = 0; v < 2; v++) all.push({ ...buildTree(def, k * 10 + v, barkMat, leafMat), name: def.name });
  });
  return {
    street: all.filter((t) => t.name !== '소나무' && t.name !== '벚나무'),
    park: all,
    leafMats,
    barkMat,
  };
}
