import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  render(): void;
  setBloom(on: boolean): void;
  readonly bloom: boolean;
}

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  // 지평선은 도시 불빛이 번진 보랏빛, 위로 갈수록 어두운 남색. 안개색은 지평선색과 맞춘다
  const HORIZON = 0x161528;
  scene.background = new THREE.Color(HORIZON);
  scene.fog = new THREE.FogExp2(HORIZON, 0.0045);
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(2400, 24, 12),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: { top: { value: new THREE.Color(0x05070f) }, horizon: { value: new THREE.Color(HORIZON) } },
      vertexShader: 'varying float vy; void main(){ vy = normalize(position).y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 horizon; varying float vy; void main(){ float t = smoothstep(-0.05, 0.45, vy); gl_FragColor = vec4(mix(horizon, top, t), 1.0); }',
    }),
  );
  sky.name = 'sky';
  scene.add(sky);

  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 2600);

  scene.add(new THREE.HemisphereLight(0x5a6cc8, 0x1a1208, 0.75));
  const moon = new THREE.DirectionalLight(0x9fb4ff, 0.4);
  moon.position.set(-120, 200, 80);
  scene.add(moon);

  // 블룸: 창문·네온·가로등처럼 밝은 것만 번지게 문턱을 높게 둔다
  const composer = new EffectComposer(renderer);
  composer.addPass(new RenderPass(scene, camera));
  const bloomPass = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.55, 0.45, 0.82);
  composer.addPass(bloomPass);
  let bloom = true;

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    composer.setSize(innerWidth, innerHeight);
    bloomPass.setSize(innerWidth, innerHeight);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  return {
    renderer,
    scene,
    camera,
    get bloom() {
      return bloom;
    },
    render() {
      sky.position.copy(camera.position);
      if (bloom) composer.render();
      else renderer.render(scene, camera);
    },
    setBloom(on) {
      bloom = on;
    },
  };
}
