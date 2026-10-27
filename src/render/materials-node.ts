import * as THREE from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { attribute, float, instancedBufferAttribute, materialColor, mix, positionWorld, reference, smoothstep, texture, uniform, uv, vec2, vec4 } from 'three/tsl';
import { grimeTexture, type GrimeOptions, type NodeMaterialHooks } from './materials.ts';

/**
 * materials.ts 의 GLSL 주입(withGrime·withParkMask)을 TSL 노드로 옮긴 것. WebGPU 렌더러일 때만 쓴다.
 * 일반 재질(MeshStandardMaterial …)에 colorNode 속성을 붙이면 WebGPU 렌더러가 노드 재질로 바꿀 때 그대로 옮겨 간다
 * (NodeMaterialLibrary.fromMaterial 이 속성을 전부 복사한다). 그래서 city.ts 의 재질 코드는 그대로 둔다.
 * 색 = 기본색(맵 × color) → 공원 잔디 섞기 → 얼룩 곱하기. GLSL 쪽과 같은 순서
 */
interface NodeState {
  /** 공원 마스크가 섞인 rgb (없으면 기본색) */
  base?: Node<'vec3'>;
  /** 얼룩 배율 */
  grime?: Node<'float'>;
}
const states = new WeakMap<THREE.Material, NodeState>();
type Colored = THREE.Material & { map?: THREE.Texture | null; colorNode?: Node | null };

function apply(mat: THREE.Material): void {
  const st = states.get(mat) ?? {};
  const m = mat as Colored;
  // 맵이 있으면 materialColor 가 vec4(텍스처 알파 포함)라 알파는 그대로 두고 rgb 만 바꾼다
  const color = materialColor as unknown as Node<'vec4'>;
  const rgb = st.base ?? color.rgb;
  const lit = st.grime ? rgb.mul(st.grime) : rgb;
  m.colorNode = m.map ? vec4(lit, color.a) : lit;
  mat.needsUpdate = true;
}

function grimeFactor(o: Required<GrimeOptions>): Node<'float'> {
  const tex = grimeTexture();
  const xz = positionWorld.xz;
  let g: Node<'float'> = texture(tex, xz.mul(1 / o.scale)).r;
  if (o.detail > 0) g = g.mul(0.6).add(texture(tex, xz.mul(1 / o.detail).add(vec2(0.37, 0.61))).r.mul(0.4));
  let f: Node<'float'> = float(1).sub(float(o.strength).mul(float(1).sub(g)));
  if (o.baseHeight > 0) {
    const base = float(1).sub(smoothstep(0, o.baseHeight, positionWorld.y));
    f = f.mul(float(1).sub(float(o.baseStrength).mul(base).mul(g.mul(0.45).add(0.55))));
  }
  return f;
}

const spriteMats = new WeakMap<THREE.PointsMaterial, THREE.PointsNodeMaterial>();
/** 원래 PointsMaterial 의 색·투명도를 매 프레임 그대로 읽는 스프라이트 재질 (밤에 바뀌는 값이 따라온다) */
function spriteMaterial(src: THREE.PointsMaterial): THREE.PointsNodeMaterial {
  let m = spriteMats.get(src);
  if (m) return m;
  m = new THREE.PointsNodeMaterial({ transparent: src.transparent, depthWrite: src.depthWrite, blending: src.blending, sizeAttenuation: src.sizeAttenuation, fog: src.fog });
  m.size = src.size;
  const tint = vec4(reference('color', 'color', src), 1);
  m.colorNode = src.map ? texture(src.map, uv()).mul(tint) : tint;
  m.opacityNode = reference('opacity', 'float', src);
  spriteMats.set(src, m);
  return m;
}

export const nodeMaterialHooks: NodeMaterialHooks = {
  points(geo, mat) {
    const pos = geo.getAttribute('position');
    const m = spriteMaterial(mat).clone();
    m.positionNode = instancedBufferAttribute(new THREE.InstancedBufferAttribute(pos.array as Float32Array, 3));
    const sprite = new THREE.Sprite(m);
    sprite.count = pos.count;
    sprite.frustumCulled = false;
    return sprite;
  },
  grime(mat, opt) {
    const st = states.get(mat) ?? {};
    st.grime = grimeFactor(opt);
    states.set(mat, st);
    apply(mat);
  },
  park(mat, grass, repeat, tint) {
    // GLSL 쪽도 맵이 있는 재질에만 섞는다
    if (!(mat as Colored).map) return;
    const st = states.get(mat) ?? {};
    const pk = texture(grass, uv().mul(repeat)).rgb.mul(uniform(tint));
    const color = materialColor as unknown as Node<'vec4'>;
    st.base = mix(color.rgb, pk, smoothstep(0.15, 0.85, attribute<'float'>('park', 'float')));
    states.set(mat, st);
    apply(mat);
  },
};
