import * as THREE from 'three/webgpu';
import { float, length, luminance, mix, normalize, pass, positionLocal, renderOutput, screenUV, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { bloom } from 'three/examples/jsm/tsl/display/BloomNode.js';
import { ao } from 'three/examples/jsm/tsl/display/GTAONode.js';
import { SkyMesh } from 'three/examples/jsm/objects/SkyMesh.js';
import { useNodeMaterials } from './materials.ts';
import { nodeMaterialHooks } from './materials-node.ts';
import { QUALITY, type Quality, type Stage } from './scene.ts';
import { glowTexture } from './textures.ts';

/**
 * WebGPU 렌더 파이프라인. scene.ts(WebGL)와 같은 Stage 를 돌려준다.
 * 장면 한 번 → 깊이로 AO(법선도 깊이에서 복원, 반해상도) → 톤매핑·sRGB → 블룸 → 컬러 그레이딩.
 * 하늘은 SkyMesh(대기 산란 + 절차 구름, TSL), 같은 하늘을 PMREM 으로 구워 환경맵으로 쓴다
 */
export async function createStageGPU(canvas: HTMLCanvasElement): Promise<Stage> {
  // stencil: 지하차도 트인 구간이 바닥 평면에 구멍을 내는 데 쓴다 (city.ts 의 maskMat/groundMat)
  const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, stencil: true });
  await renderer.init();
  if (!(renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend) throw new Error('WebGPU 백엔드가 아님');
  useNodeMaterials(nodeMaterialHooks);
  let quality: Quality = 'high';
  let pixelRatio = Math.min(devicePixelRatio || 1, QUALITY[quality].pixelRatio);
  renderer.setPixelRatio(pixelRatio);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.9;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;

  const scene = new THREE.Scene();
  const HORIZON = 0x2b2650;
  scene.background = new THREE.Color(HORIZON);
  scene.fog = new THREE.FogExp2(HORIZON, 0.0045);

  // ----- 낮 하늘: 대기 산란 + 절차 구름 -----
  const sky = new SkyMesh();
  sky.name = 'sky';
  sky.scale.setScalar(2000);
  // 불투명한 것들 다음에 그린다 (깊이 검사로 건물에 가린 하늘 픽셀은 구름을 계산하지 않는다)
  sky.renderOrder = 50;
  sky.frustumCulled = false;
  // 하늘 밝기: 대기 산란 출력이 노출에 비해 너무 밝아 하얗게 날아가므로 끝에서 skyGain 을 곱한다 (환경맵도 같은 재질이라 같이 줄어든다)
  const skyGain = uniform(0.12);
  const skyMat = sky.material as THREE.MeshBasicNodeMaterial;
  skyMat.colorNode = vec4((skyMat.colorNode as ReturnType<typeof vec4>).rgb.mul(skyGain), 1);
  sky.turbidity.value = 2.2;
  sky.rayleigh.value = 2.0;
  sky.mieCoefficient.value = 0.004;
  sky.mieDirectionalG.value = 0.86;
  sky.cloudCoverage.value = 0.5;
  sky.cloudDensity.value = 0.6;
  sky.cloudScale.value = 0.00025;
  sky.cloudElevation.value = 0.45;
  scene.add(sky);

  // ----- 밤 하늘 덮개: 지평선은 도시 불빛이 번진 보랏빛, 위로 갈수록 어두운 남색. 낮엔 투명 -----
  const nightTop = uniform(new THREE.Color(0x0c1024));
  const nightHorizon = uniform(new THREE.Color(HORIZON));
  const nightOpacity = uniform(1);
  const nightMat = new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, depthWrite: false, transparent: true, fog: false });
  nightMat.colorNode = mix(nightHorizon, nightTop, smoothstep(-0.05, 0.45, normalize(positionLocal).y));
  nightMat.opacityNode = nightOpacity;
  const nightSky = new THREE.Mesh(new THREE.SphereGeometry(1900, 24, 12), nightMat);
  nightSky.name = 'nightSky';
  nightSky.renderOrder = 51;
  nightSky.frustumCulled = false;
  scene.add(nightSky);

  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2600);

  // 햇빛 글레어: 해 방향 멀리 두는 가산 스프라이트. 밤·비엔 사라진다
  const glareMat = new THREE.SpriteMaterial({ map: glowTexture('rgba(255,244,220,1)', 256), color: 0xfff0d0, transparent: true, opacity: 0, depthTest: false, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const glare = new THREE.Sprite(glareMat);
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
  const envSky = new SkyMesh();
  envSky.material = sky.material;
  envSky.scale.setScalar(800);
  envScene.add(envSky);
  let envTarget: THREE.RenderTarget | null = null;
  const updateEnvironment = () => {
    // 태양 원반은 빼고 굽는다. 원반(밝기 수천)이 들어가면 간접광이 폭주해 화면이 하얗게 날아간다
    sky.showSunDisc.value = 0;
    const next = pmrem.fromScene(envScene, 0, 0.5, 900);
    sky.showSunDisc.value = 1;
    scene.environment = next.texture;
    envTarget?.dispose();
    envTarget = next;
  };
  let envSunY = 99;
  let envRain = false;

  // ----- 후처리 -----
  const pipeline = new THREE.RenderPipeline(renderer);
  pipeline.outputColorTransform = false;
  // 깊이 텍스처를 깊이+스텐실 형식으로 직접 준다 (PassNode 기본은 깊이만이라 스텐실 재질의 파이프라인이 실패한다)
  const passDepth = new THREE.DepthTexture(1, 1, THREE.UnsignedInt248Type);
  passDepth.format = THREE.DepthStencilFormat;
  const scenePass = pass(scene, camera, { stencilBuffer: true, depthTexture: passDepth });
  const sceneColor = scenePass.getTextureNode('output');
  const sceneDepth = scenePass.getTextureNode('depth');
  // AO: 법선 패스 없이 깊이에서 법선을 복원한다 (장면을 한 번만 그린다). 반해상도
  // 법선 노드 자리에 null 을 주면 깊이에서 복원한다 (타입 선언은 null 을 막아 둔다)
  const aoNode = ao(sceneDepth, null as unknown as Parameters<typeof ao>[1], camera);
  aoNode.resolutionScale = 0.5;
  aoNode.radius.value = 2.5;
  aoNode.thickness.value = 4;
  aoNode.distanceExponent.value = 1;
  aoNode.distanceFallOff.value = 0;
  aoNode.scale.value = 2;
  aoNode.samples.value = 16;
  const contrast = uniform(1.03);
  const saturation = uniform(1.0);
  const vignette = uniform(0.16);
  let bloomNode: ReturnType<typeof bloom> | null = null;
  let bloomStrength = 0.55;
  let bloom_ = true;
  let aoDebug = false;
  // Stage.passes(디버그)로 끈 효과
  let aoForced = true;
  let bloomForced = true;

  const rebuild = () => {
    const cfg = QUALITY[quality];
    const useAo = bloom_ && cfg.gtao && aoForced;
    const useBloom = bloom_ && cfg.bloom && bloomForced;
    const aoTex = aoNode.getTextureNode();
    if (aoDebug) {
      pipeline.outputNode = vec4(vec3(aoTex.r), 1);
      pipeline.needsUpdate = true;
      return;
    }
    // AO 는 GTAOPass 의 blendIntensity 0.9 와 같게
    const lit = useAo ? sceneColor.rgb.mul(mix(float(1), aoTex.r, 0.9)) : sceneColor.rgb;
    const toned = renderOutput(vec4(lit, 1));
    let col = toned.rgb;
    if (useBloom) {
      // 톤매핑 뒤(0..1)에서 창문·네온·가로등처럼 밝은 것만 번지게 문턱을 높게 둔다
      bloomNode = bloom(toned, bloomStrength, 0.45, 0.92);
      col = col.add(bloomNode.rgb);
    } else bloomNode = null;
    // 컬러 그레이딩: 채도·대비·비네트
    const l = luminance(col);
    col = mix(vec3(l), col, saturation);
    col = col.sub(0.5).mul(contrast).add(0.5);
    const d = screenUV.sub(0.5).mul(vec2(1.15, 1.0));
    col = col.mul(float(1).sub(vignette.mul(smoothstep(0.42, 0.95, length(d).mul(1.25)))));
    pipeline.outputNode = vec4(col, 1);
    pipeline.needsUpdate = true;
  };
  rebuild();

  const resize = () => {
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  // Stage.passes 는 디버그용: enabled 를 바꾸면 파이프라인을 다시 짠다
  const passes = {
    gtao: {
      get enabled() {
        return aoForced;
      },
      set enabled(v: boolean) {
        aoForced = v;
        rebuild();
      },
    },
    bloom: {
      get enabled() {
        return bloomForced;
      },
      set enabled(v: boolean) {
        bloomForced = v;
        rebuild();
      },
    },
  };

  const stage: Stage = {
    backend: 'webgpu',
    renderer,
    scene,
    camera,
    hemi,
    moon,
    get bloom() {
      return bloom_;
    },
    render() {
      sky.position.copy(camera.position);
      nightSky.position.copy(camera.position);
      glare.position.copy(camera.position).addScaledVector(sunDir, 1500);
      pipeline.render();
    },
    setBloom(on) {
      if (bloom_ === on) return;
      bloom_ = on;
      rebuild();
    },
    setBloomStrength(v) {
      bloomStrength = v;
      if (bloomNode) bloomNode.strength.value = v;
    },
    setSky(top, horizon) {
      nightTop.value.copy(top);
      nightHorizon.value.copy(horizon);
    },
    setSun(dir, raining) {
      sky.sunPosition.value.copy(dir);
      sunDir.copy(dir);
      glareMat.opacity = raining ? 0 : Math.max(0, Math.min(1, (dir.y - 0.05) / 0.3)) * 0.55;
      if (raining !== envRain) {
        envRain = raining;
        sky.turbidity.value = raining ? 14 : 3;
        sky.rayleigh.value = raining ? 0.6 : 1.4;
        sky.mieCoefficient.value = raining ? 0.02 : 0.004;
        sky.cloudCoverage.value = raining ? 0.95 : 0.42;
        sky.cloudDensity.value = raining ? 0.8 : 0.45;
        envSunY = 99;
      }
      // 해 높이가 조금 바뀔 때마다 환경맵을 다시 굽는다 (낮엔 30초쯤에 한 번)
      if (Math.abs(dir.y - envSunY) > 0.05) {
        envSunY = dir.y;
        updateEnvironment();
      }
    },
    setNight(night) {
      nightOpacity.value = Math.min(1, Math.max(0, (night - 0.15) / 0.7));
      nightSky.visible = night > 0.15;
      // 하늘 게인(0.12)으로 줄어든 환경맵 밝기를 되돌린다
      scene.environmentIntensity = 3.0 - 2.8 * night;
    },
    setExposure(v) {
      renderer.toneMappingExposure = v;
    },
    updateEnvironment,
    setAoDebug(mode) {
      aoDebug = mode !== 'off';
      rebuild();
    },
    passes,
    get quality() {
      return quality;
    },
    setQuality(q) {
      quality = q;
      const cfg = QUALITY[q];
      pixelRatio = Math.min(devicePixelRatio || 1, cfg.pixelRatio);
      aoNode.samples.value = cfg.gtaoSamples;
      this.onShadowSize?.(cfg.shadow);
      rebuild();
      resize();
    },
  };
  return stage;
}
