import * as THREE from 'three';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import type { WebGPURenderer } from 'three/webgpu';
import { glowTexture } from './textures.ts';

export type Backend = 'webgl' | 'webgpu';
/**
 * 설정이 'auto' 일 때 쓸 렌더러. three r0.186 WebGPU 경로는 실측(인텔 내장 GPU)에서 WebGL 보다 수십 배 느리고
 * (그림자 재질을 매 프레임 다시 빌드, 재질마다 노드 빌드) 타일이 들어올 때 몇 초씩 멈춰 아직은 WebGL 이 기본. ?renderer=webgpu 로 시험
 */
export const AUTO_BACKEND: Backend = 'webgl';
/** 두 렌더러 다. 공통으로 쓰는 건 setPixelRatio·initTexture·compileAsync·info 정도라 쓰는 쪽에서 좁혀 쓴다 */
export type AnyRenderer = THREE.WebGLRenderer | WebGPURenderer;

/**
 * 렌더 파이프라인: 장면 → GTAO(주변광 차폐, 반해상도) → 블룸 → 톤매핑·sRGB(OutputPass) → 컬러 그레이딩.
 * 하늘은 대기 산란 모델(Sky)이고, 같은 하늘을 PMREM 으로 구워 scene.environment(유리·도장 반사, 하늘빛 간접광)로 쓴다.
 * 밤에는 도시 불빛이 번진 그라데이션 구를 하늘 위에 덮는다
 */
export interface Stage {
  /** 실제로 쓰는 렌더러 (WebGPU 를 원해도 안 되면 webgl) */
  readonly backend: Backend;
  renderer: AnyRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  hemi: THREE.HemisphereLight;
  moon: THREE.DirectionalLight;
  render(dt: number): void;
  /** 화면 효과(블룸·AO) 켜고 끄기 */
  setBloom(on: boolean): void;
  setBloomStrength(v: number): void;
  /** 밤 하늘 그라데이션 색 */
  setSky(top: THREE.Color, horizon: THREE.Color): void;
  /** 해 방향(단위 벡터, y 가 높이)과 날씨. 하늘·환경맵이 바뀐다 */
  setSun(dir: THREE.Vector3, raining: boolean): void;
  /** 0 낮 .. 1 밤: 밤 하늘 덮개 불투명도, 환경광 세기 */
  setNight(night: number): void;
  setExposure(v: number): void;
  /** 환경맵을 지금 다시 굽는다 (setSun 이 알아서 부르지만 테스트용) */
  updateEnvironment(): void;
  /** 디버그: AO 패스 출력 모드 ('off' 가 정상 합성) */
  setAoDebug(mode: 'off' | 'ao' | 'denoise' | 'normal' | 'depth'): void;
  /** 디버그: 패스 켜고 끄기 */
  passes: { gtao: { enabled: boolean }; bloom: { enabled: boolean } };
  /** 품질 단계: 픽셀 비율·AO·블룸·그림자 해상도 */
  setQuality(q: Quality): void;
  readonly quality: Quality;
  /** 그림자 해상도를 바꿀 때 daylight 가 등록해 둔 콜백 */
  onShadowSize?: (size: number) => void;
  readonly bloom: boolean;
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    contrast: { value: 1.03 },
    saturation: { value: 1.0 },
    vignette: { value: 0.16 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float contrast;
    uniform float saturation;
    uniform float vignette;
    varying vec2 vUv;
    void main() {
      vec4 c = texture2D( tDiffuse, vUv );
      vec3 col = c.rgb;
      float l = dot( col, vec3( 0.2126, 0.7152, 0.0722 ) );
      col = mix( vec3( l ), col, saturation );
      col = ( col - 0.5 ) * contrast + 0.5;
      vec2 d = ( vUv - 0.5 ) * vec2( 1.15, 1.0 );
      col *= 1.0 - vignette * smoothstep( 0.42, 0.95, length( d ) * 1.25 );
      gl_FragColor = vec4( col, c.a );
    }`,
};

export type Quality = 'high' | 'medium' | 'low';
/** 단계별 설정. medium 이 1080p 내장 GPU 기준, low 는 노트북·구형 */
export const QUALITY: Record<Quality, { pixelRatio: number; shadow: number; gtao: boolean; gtaoSamples: number; bloom: boolean; label: string }> = {
  high: { pixelRatio: 2, shadow: 4096, gtao: true, gtaoSamples: 16, bloom: true, label: '높음' },
  medium: { pixelRatio: 1.25, shadow: 2048, gtao: true, gtaoSamples: 8, bloom: true, label: '중간' },
  low: { pixelRatio: 1, shadow: 1024, gtao: false, gtaoSamples: 8, bloom: false, label: '낮음' },
};

/**
 * 렌더러를 골라 무대를 만든다. want 가 webgpu 여도 브라우저가 WebGPU 어댑터를 못 주면 WebGL 로 간다.
 * WebGPU 코드(three/webgpu)는 이때만 불러온다
 */
export async function createStage(canvas: HTMLCanvasElement, want: Backend): Promise<Stage> {
  if (want === 'webgpu') {
    try {
      const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
      if (!gpu || !(await gpu.requestAdapter())) throw new Error('WebGPU 어댑터 없음');
      const { createStageGPU } = await import('./scene-gpu.ts');
      const stage = await createStageGPU(canvas);
      console.info('[gpu] WebGPU 렌더러');
      return stage;
    } catch (e) {
      console.warn('[gpu] WebGPU 를 못 써서 WebGL 로 그려요:', e);
    }
  }
  return createStageGL(canvas);
}

function createStageGL(canvas: HTMLCanvasElement): Stage {
  // stencil: 지하차도 트인 구간이 바닥 평면에 구멍을 내는 데 쓴다 (city.ts 의 maskMat/groundMat)
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, stencil: true });
  let quality: Quality = 'high';
  let pixelRatio = Math.min(devicePixelRatio || 1, QUALITY[quality].pixelRatio);
  renderer.setPixelRatio(pixelRatio);
  // 필름 톤매핑은 OutputPass 에서 적용된다 (렌더타깃에 그릴 땐 재질 셰이더가 톤매핑을 하지 않는다)
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const HORIZON = 0x2b2650;
  scene.background = new THREE.Color(HORIZON);
  scene.fog = new THREE.FogExp2(HORIZON, 0.0045);

  // ----- 낮 하늘: 대기 산란 + 절차 구름 -----
  const sky = new Sky();
  sky.name = 'sky';
  sky.scale.setScalar(2000);
  // 불투명한 것들 다음에 그린다 (깊이 검사로 건물에 가린 하늘 픽셀은 구름 fbm 을 돌리지 않는다)
  sky.renderOrder = 50;
  sky.frustumCulled = false;
  const su = sky.material.uniforms;
  // 하늘 밝기: 대기 산란 출력이 노출에 비해 너무 밝아 하얗게 날아가므로 셰이더 끝에서 skyGain 을 곱한다 (환경맵도 같은 재질이라 같이 줄어든다)
  sky.material.uniforms.skyGain = { value: 0.12 };
  sky.material.fragmentShader = sky.material.fragmentShader.replace('uniform float time;', 'uniform float time; uniform float skyGain;').replace('gl_FragColor = vec4( texColor, 1.0 );', 'gl_FragColor = vec4( texColor * skyGain, 1.0 );');
  su.turbidity.value = 2.2;
  su.rayleigh.value = 2.0;
  su.mieCoefficient.value = 0.004;
  su.mieDirectionalG.value = 0.86;
  su.cloudCoverage.value = 0.5;
  su.cloudDensity.value = 0.6;
  su.cloudScale.value = 0.00025;
  su.cloudElevation.value = 0.45;
  scene.add(sky);

  // ----- 밤 하늘 덮개: 지평선은 도시 불빛이 번진 보랏빛, 위로 갈수록 어두운 남색. 낮엔 투명 -----
  const nightMat = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    transparent: true,
    fog: false,
    uniforms: { top: { value: new THREE.Color(0x0c1024) }, horizon: { value: new THREE.Color(HORIZON) }, opacity: { value: 1 } },
    vertexShader: 'varying float vy; void main(){ vy = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform vec3 top; uniform vec3 horizon; uniform float opacity; varying float vy; void main(){ float t = smoothstep(-0.05, 0.45, vy); gl_FragColor = vec4(mix(horizon, top, t), opacity); }',
  });
  const nightSky = new THREE.Mesh(new THREE.SphereGeometry(1900, 24, 12), nightMat);
  nightSky.name = 'nightSky';
  nightSky.renderOrder = 51;
  nightSky.frustumCulled = false;
  scene.add(nightSky);

  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2600);

  // 햇빛 글레어: 해 방향 멀리 두는 가산 스프라이트 (레이시티식 하이키 낮 느낌). 밤·비엔 사라진다
  const glare = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture('rgba(255,244,220,1)', 256), color: 0xfff0d0, transparent: true, opacity: 0, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, fog: false }));
  glare.scale.set(900, 900, 1);
  glare.renderOrder = -5;
  glare.frustumCulled = false;
  scene.add(glare);
  const sunDir = new THREE.Vector3(0, 1, 0);

  const hemi = new THREE.HemisphereLight(0x5a6cc8, 0x1a1208, 0.75);
  scene.add(hemi);
  const moon = new THREE.DirectionalLight(0x9fb4ff, 0.4);
  moon.position.set(-120, 200, 80);
  scene.add(moon);

  // ----- 환경맵: 같은 하늘을 작은 장면에서 PMREM 으로 -----
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envScene = new THREE.Scene();
  const envSky = new Sky();
  envSky.material = sky.material;
  envSky.scale.setScalar(800);
  envScene.add(envSky);
  let envTarget: THREE.WebGLRenderTarget | null = null;
  const updateEnvironment = () => {
    // 태양 원반은 빼고 굽는다. 원반(밝기 수천)이 들어가면 흐려진 뒤에도 간접광이 폭주해 화면이 하얗게 날아간다
    su.showSunDisc.value = 0;
    const next = pmrem.fromScene(envScene, 0, 0.5, 900);
    su.showSunDisc.value = 1;
    scene.environment = next.texture;
    envTarget?.dispose();
    envTarget = next;
  };
  let envSunY = 99;
  let envRain = false;

  // ----- 후처리 -----
  // 장면 깊이(+스텐실)를 텍스처로 받아 AO 가 법선을 깊이에서 복원하게 한다.
  // 넘기지 않으면 GTAOPass 가 법선을 얻으려고 장면 전체를 한 번 더 그린다 (그리기 호출·삼각형이 두 배)
  const sceneDepth = new THREE.DepthTexture(innerWidth, innerHeight, THREE.UnsignedInt248Type);
  sceneDepth.format = THREE.DepthStencilFormat;
  const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(innerWidth, innerHeight, { type: THREE.HalfFloatType, stencilBuffer: true, depthTexture: sceneDepth }));
  // 핑퐁 버퍼 둘이 같은 깊이를 쓰게 해, 어느 쪽에 장면을 그렸든 AO 가 같은 텍스처를 읽는다
  composer.renderTarget2.depthTexture?.dispose();
  composer.renderTarget2.depthTexture = sceneDepth;
  composer.addPass(new RenderPass(scene, camera));
  // 주변광 차폐: 건물 밑동·연석·차 밑에 접촉 그림자. 반해상도로 돌려 비용을 줄인다
  const gtao = new GTAOPass(scene, camera, Math.floor((innerWidth * pixelRatio) / 2), Math.floor((innerHeight * pixelRatio) / 2));
  // 생성자에 depthTexture 를 넘기면 r0.186 GTAOPass 가 만들기 전의 normalRenderTarget 을 읽어 죽는다. 만든 뒤에 바꿔 끼운다
  gtao.setGBuffer(sceneDepth);
  gtao.output = GTAOPass.OUTPUT.Default;
  gtao.blendIntensity = 0.9;
  gtao.updateGtaoMaterial({ radius: 2.5, distanceExponent: 1.0, thickness: 4.0, scale: 2.0, samples: 16, distanceFallOff: 0, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, radiusExponent: 1, rings: 2, samples: 12 });
  composer.addPass(gtao);
  composer.addPass(new OutputPass());
  // 블룸: 톤매핑 뒤(0..1)에서 창문·네온·가로등처럼 밝은 것만 번지게 문턱을 높게 둔다.
  // 톤매핑 전에 두면 햇빛 받은 면(1 넘는 값) 전부에 번져 화면이 뿌옇게 된다
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 0.92);
  composer.addPass(bloomPass);
  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);
  let bloom = true;

  const resize = () => {
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(innerWidth, innerHeight, false);
    composer.setSize(innerWidth, innerHeight);
    bloomPass.setSize(innerWidth, innerHeight);
    gtao.setSize(Math.max(1, Math.floor((innerWidth * pixelRatio) / 2)), Math.max(1, Math.floor((innerHeight * pixelRatio) / 2)));
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  let time = 0;
  return {
    backend: 'webgl',
    renderer,
    scene,
    camera,
    hemi,
    moon,
    get bloom() {
      return bloom;
    },
    render(dt) {
      time += dt;
      sky.position.copy(camera.position);
      nightSky.position.copy(camera.position);
      glare.position.copy(camera.position).addScaledVector(sunDir, 1500);
      su.time.value = time;
      composer.render();
    },
    setBloom(on) {
      bloom = on;
      bloomPass.enabled = on && QUALITY[quality].bloom;
      gtao.enabled = on && QUALITY[quality].gtao;
    },
    setBloomStrength(v) {
      bloomPass.strength = v;
    },
    setSky(top, horizon) {
      (nightMat.uniforms.top.value as THREE.Color).copy(top);
      (nightMat.uniforms.horizon.value as THREE.Color).copy(horizon);
    },
    setSun(dir, raining) {
      su.sunPosition.value.copy(dir);
      sunDir.copy(dir);
      (glare.material as THREE.SpriteMaterial).opacity = raining ? 0 : Math.max(0, Math.min(1, (dir.y - 0.05) / 0.3)) * 0.55;
      if (raining !== envRain) {
        envRain = raining;
        su.turbidity.value = raining ? 14 : 3;
        su.rayleigh.value = raining ? 0.6 : 1.4;
        su.mieCoefficient.value = raining ? 0.02 : 0.004;
        su.cloudCoverage.value = raining ? 0.95 : 0.42;
        su.cloudDensity.value = raining ? 0.8 : 0.45;
        envSunY = 99;
      }
      // 해 높이가 조금 바뀔 때마다 환경맵을 다시 굽는다 (낮엔 30초쯤에 한 번)
      if (Math.abs(dir.y - envSunY) > 0.05) {
        envSunY = dir.y;
        updateEnvironment();
      }
    },
    setNight(night) {
      nightMat.uniforms.opacity.value = Math.min(1, Math.max(0, (night - 0.15) / 0.7));
      nightSky.visible = night > 0.15;
      // 하늘 게인(0.12)으로 줄어든 환경맵 밝기를 되돌린다
      scene.environmentIntensity = 3.0 - 2.8 * night;
    },
    setExposure(v) {
      renderer.toneMappingExposure = v;
    },
    updateEnvironment,
    setAoDebug(mode) {
      gtao.output = { off: GTAOPass.OUTPUT.Default, ao: GTAOPass.OUTPUT.AO, denoise: GTAOPass.OUTPUT.Denoise, normal: GTAOPass.OUTPUT.Normal, depth: GTAOPass.OUTPUT.Depth }[mode];
    },
    passes: { gtao, bloom: bloomPass },
    get quality() {
      return quality;
    },
    setQuality(q) {
      quality = q;
      const cfg = QUALITY[q];
      pixelRatio = Math.min(devicePixelRatio || 1, cfg.pixelRatio);
      gtao.enabled = bloom && cfg.gtao;
      bloomPass.enabled = bloom && cfg.bloom;
      gtao.updateGtaoMaterial({ samples: cfg.gtaoSamples });
      gtao.updatePdMaterial({ samples: cfg.gtaoSamples });
      this.onShadowSize?.(cfg.shadow);
      resize();
    },
  };
}
