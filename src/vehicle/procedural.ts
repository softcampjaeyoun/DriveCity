import * as THREE from 'three';
import type { VehicleKind } from './kinds.ts';

// 외부 모델이 없을 때 쓰는 상자 조합 차량. 같은 재질은 공유한다
const dark = new THREE.MeshPhongMaterial({ color: 0x0c0e14, shininess: 120, specular: 0x8899bb });
const glass = new THREE.MeshPhongMaterial({ color: 0x1a2130, shininess: 140, specular: 0x9ab0d0 });
const wheelMat = new THREE.MeshLambertMaterial({ color: 0x111216 });
const headMat = new THREE.MeshBasicMaterial({ color: 0xfff6dc });
const tailMat = new THREE.MeshBasicMaterial({ color: 0x8a0f18 });
const signMat = new THREE.MeshBasicMaterial({ color: 0xfff1a8 });
const ledMat = new THREE.MeshBasicMaterial({ color: 0xff9a2e });
const stripeMat = new THREE.MeshLambertMaterial({ color: 0xf2f4f7 });
const bodyMats = new Map<number, THREE.Material>();
export function bodyMat(hex: number): THREE.Material {
  let m = bodyMats.get(hex);
  if (!m) {
    m = new THREE.MeshPhongMaterial({ color: hex, shininess: 60, specular: 0x333333 });
    bodyMats.set(hex, m);
  }
  return m;
}

function lights(g: THREE.Group, width: number, length: number, y: number): void {
  const geo = new THREE.BoxGeometry(0.45, 0.13, 0.05);
  for (const x of [-width * 0.32, width * 0.32]) {
    const h = new THREE.Mesh(geo, headMat);
    h.position.set(x, y, length / 2 + 0.01);
    const t = new THREE.Mesh(geo, tailMat);
    t.position.set(x, y + 0.05, -length / 2 - 0.01);
    g.add(h, t);
  }
}

function wheelsAt(g: THREE.Group, width: number, zs: number[], r = 0.36): void {
  const geo = new THREE.BoxGeometry(width + 0.14, r * 1.4, r * 2);
  for (const z of zs) {
    const w = new THREE.Mesh(geo, wheelMat);
    w.position.set(0, r, z);
    g.add(w);
  }
}

export function buildSedan(hex: number, length = 4.1, width = 1.9): THREE.Group {
  const g = new THREE.Group();
  const b = new THREE.Mesh(new THREE.BoxGeometry(width, 0.6, length), bodyMat(hex));
  b.position.y = 0.72;
  const c = new THREE.Mesh(new THREE.BoxGeometry(width - 0.3, 0.5, length * 0.48), glass);
  c.position.set(0, 1.27, -length * 0.05);
  g.add(b, c);
  wheelsAt(g, width, [length * 0.32, -length * 0.32]);
  lights(g, width, length, 0.8);
  return g;
}

/** 갓등 달린 택시 */
export function buildTaxi(hex: number, length = 4.4, width = 1.9): THREE.Group {
  const g = buildSedan(hex, length, width);
  const sign = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.2, 0.28), signMat);
  sign.position.set(0, 1.62, -0.1);
  const base = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.2), dark);
  base.position.set(0, 1.52, -0.1);
  // 갓등은 발광 재질만 (점광원을 달면 조명 개수가 바뀔 때마다 모든 셰이더가 재컴파일된다)
  g.add(sign, base);
  return g;
}

/** 시내·광역·마을버스. 길이에 따라 창문 칸 수가 달라진다 */
export function buildBus(hex: number, length: number, width: number): THREE.Group {
  const g = new THREE.Group();
  const height = length > 8 ? 3.1 : 2.6;
  const body = new THREE.Mesh(new THREE.BoxGeometry(width, height - 0.5, length), bodyMat(hex));
  body.position.y = 0.5 + (height - 0.5) / 2;
  g.add(body);
  // 측면 창문 띠
  const band = new THREE.Mesh(new THREE.BoxGeometry(width + 0.04, height * 0.32, length - 1.2), glass);
  band.position.set(0, height * 0.66, -0.2);
  g.add(band);
  // 앞 유리와 노선 LED
  const wind = new THREE.Mesh(new THREE.BoxGeometry(width - 0.3, height * 0.4, 0.06), glass);
  wind.position.set(0, height * 0.6, length / 2 + 0.02);
  const led = new THREE.Mesh(new THREE.BoxGeometry(width * 0.7, 0.22, 0.05), ledMat);
  led.position.set(0, height - 0.28, length / 2 + 0.03);
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(width + 0.02, 0.12, length), stripeMat);
  stripe.position.y = height * 0.42;
  g.add(wind, led, stripe);
  const r = length > 8 ? 0.5 : 0.42;
  wheelsAt(g, width, length > 8 ? [length * 0.32, -length * 0.3] : [length * 0.3, -length * 0.3], r);
  lights(g, width, length, 0.75);
  return g;
}

export function buildForKind(kind: VehicleKind, hex: number): THREE.Group {
  switch (kind.id) {
    case 'taxi':
      return buildTaxi(hex, kind.length, kind.width);
    case 'bus_trunk':
    case 'bus_branch':
    case 'bus_village':
    case 'bus_express':
      return buildBus(hex, kind.length, kind.width);
    default:
      return buildSedan(hex, kind.length, kind.width);
  }
}

export { dark as darkMat, wheelMat, headMat, tailMat };
