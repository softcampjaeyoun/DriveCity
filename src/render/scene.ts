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
  scene.background = new THREE.Color(0x0a0d16);
  scene.fog = new THREE.FogExp2(0x0a0d16, 0.0062);

  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 1100);

  scene.add(new THREE.HemisphereLight(0x5a6cc8, 0x1a1208, 0.6));
  const moon = new THREE.DirectionalLight(0x9fb4ff, 0.35);
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
      if (bloom) composer.render();
      else renderer.render(scene, camera);
    },
    setBloom(on) {
      bloom = on;
    },
  };
}
