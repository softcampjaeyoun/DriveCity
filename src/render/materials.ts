import * as THREE from 'three';
import { mulberry32 } from '../util/math.ts';

/**
 * 재질 공통 셰이더 보강.
 * - 월드 좌표 얼룩(grime): 도로·보도·잔디처럼 같은 질감이 수백 m 반복되는 면에 큰 주기의 노이즈를 곱해 단조로움을 깬다
 * - 밑동 때(base): 건물 벽이 바닥에 닿는 몇 m 를 어둡게 해 접지감을 준다
 * 둘 다 onBeforeCompile 로 끼워 넣으니 어떤 메시(인스턴스 포함)에도 같은 재질을 그대로 쓸 수 있다
 */
export interface GrimeOptions {
  /** 큰 얼룩 한 주기 (m). 기본 40 */
  scale?: number;
  /** 어둡게 하는 세기 0..1. 기본 0.3 */
  strength?: number;
  /** 작은 얼룩 주기 (m). 0 이면 없음. 기본 7 */
  detail?: number;
  /** 바닥(y=0)에서 이 높이(m)까지 때가 탄다. 0 이면 없음 */
  baseHeight?: number;
  /** 밑동 때 세기 0..1 */
  baseStrength?: number;
}

let grimeTex: THREE.CanvasTexture | null = null;
/** 회색 값 노이즈 3옥타브 (반복). 평균이 0.65 쯤이라 곱해도 전체가 많이 어두워지지 않는다 */
export function grimeTexture(): THREE.CanvasTexture {
  if (grimeTex) return grimeTex;
  const S = 256;
  const r = mulberry32(31337);
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const grid = (n: number) => {
    const a = new Float32Array(n * n);
    for (let i = 0; i < a.length; i++) a[i] = r();
    return a;
  };
  const octs = [4, 8, 16, 32].map((n) => ({ n, a: grid(n) }));
  const sample = (a: Float32Array, n: number, x: number, y: number) => {
    const fx = (x / S) * n;
    const fy = (y / S) * n;
    const x0 = Math.floor(fx) % n;
    const y0 = Math.floor(fy) % n;
    const x1 = (x0 + 1) % n;
    const y1 = (y0 + 1) % n;
    const tx = fx - Math.floor(fx);
    const ty = fy - Math.floor(fy);
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    return (a[y0 * n + x0] * (1 - sx) + a[y0 * n + x1] * sx) * (1 - sy) + (a[y1 * n + x0] * (1 - sx) + a[y1 * n + x1] * sx) * sy;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0;
      let amp = 0.5;
      let tot = 0;
      for (const o of octs) {
        v += sample(o.a, o.n, x, y) * amp;
        tot += amp;
        amp *= 0.55;
      }
      v /= tot;
      // 0.5 근처에 몰린 값을 펴고 평균을 0.65 로
      const k = Math.max(0, Math.min(1, 0.65 + (v - 0.5) * 1.8));
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = Math.round(k * 255);
      img.data[i + 3] = 255;
    }
  }
  g.putImageData(img, 0, 0);
  grimeTex = new THREE.CanvasTexture(c);
  grimeTex.wrapS = grimeTex.wrapT = THREE.RepeatWrapping;
  return grimeTex;
}

/** 재질에 월드 좌표 얼룩(과 밑동 때)을 끼워 넣는다. 같은 재질 객체를 돌려준다 */
export function withGrime<T extends THREE.Material>(mat: T, opt: GrimeOptions = {}): T {
  const scale = opt.scale ?? 40;
  const strength = opt.strength ?? 0.3;
  const detail = opt.detail ?? 7;
  const baseHeight = opt.baseHeight ?? 0;
  const baseStrength = opt.baseStrength ?? 0;
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    shader.uniforms.grimeMap = { value: grimeTexture() };
    shader.uniforms.grimeParams = { value: new THREE.Vector4(1 / scale, strength, detail > 0 ? 1 / detail : 0, 0) };
    shader.uniforms.grimeBase = { value: new THREE.Vector2(baseHeight, baseStrength) };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrimeWorld;')
      .replace(
        '#include <worldpos_vertex>',
        `#include <worldpos_vertex>
{
  vec4 gp = vec4( transformed, 1.0 );
  #ifdef USE_INSTANCING
    gp = instanceMatrix * gp;
  #endif
  vGrimeWorld = ( modelMatrix * gp ).xyz;
}`,
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGrimeWorld;\nuniform sampler2D grimeMap;\nuniform vec4 grimeParams;\nuniform vec2 grimeBase;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
{
  float g = texture2D( grimeMap, vGrimeWorld.xz * grimeParams.x ).r;
  if ( grimeParams.z > 0.0 ) g = g * 0.6 + texture2D( grimeMap, vGrimeWorld.xz * grimeParams.z + vec2( 0.37, 0.61 ) ).r * 0.4;
  diffuseColor.rgb *= 1.0 - grimeParams.y * ( 1.0 - g );
  if ( grimeBase.x > 0.0 ) {
    float base = 1.0 - smoothstep( 0.0, grimeBase.x, vGrimeWorld.y );
    diffuseColor.rgb *= 1.0 - grimeBase.y * base * ( 0.55 + 0.45 * g );
  }
}`,
      );
  };
  mat.customProgramCacheKey = () => `${prevKey ? prevKey.call(mat) : ''}|grime`;
  return mat;
}

/**
 * 지형 재질: 꼭짓점 속성 park(0..1) 가 1 인 곳은 잔디 질감으로 섞는다 (공원을 지형에 그린다).
 * withGrime 과 함께 쓸 수 있다 (onBeforeCompile 이 이어진다)
 */
export function withParkMask<T extends THREE.Material>(mat: T, grass: THREE.Texture, grassRepeat = 4, grassTint = new THREE.Color(0x9aa684)): T {
  const prev = mat.onBeforeCompile;
  const prevKey = mat.customProgramCacheKey;
  mat.onBeforeCompile = (shader, renderer) => {
    prev?.(shader, renderer);
    shader.uniforms.parkMap = { value: grass };
    shader.uniforms.parkRepeat = { value: grassRepeat };
    shader.uniforms.parkTint = { value: grassTint };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float park;\nvarying float vPark;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvPark = park;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vPark;\nuniform sampler2D parkMap;\nuniform float parkRepeat;\nuniform vec3 parkTint;')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
{
  #ifdef USE_MAP
  vec4 pk = texture2D( parkMap, vMapUv * parkRepeat );
  diffuseColor.rgb = mix( diffuseColor.rgb, pk.rgb * parkTint, smoothstep( 0.15, 0.85, vPark ) );
  #endif
}`,
      );
  };
  mat.customProgramCacheKey = () => `${prevKey ? prevKey.call(mat) : ''}|park`;
  return mat;
}
