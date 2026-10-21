import * as THREE from 'three';

export interface Stage {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
}

export function createStage(canvas: HTMLCanvasElement): Stage {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0a0d16);
  scene.fog = new THREE.FogExp2(0x0a0d16, 0.0062);

  const camera = new THREE.PerspectiveCamera(62, 1, 0.1, 900);

  scene.add(new THREE.HemisphereLight(0x5a6cc8, 0x1a1208, 0.6));
  const moon = new THREE.DirectionalLight(0x9fb4ff, 0.35);
  moon.position.set(-120, 200, 80);
  scene.add(moon);

  const resize = () => {
    renderer.setSize(innerWidth, innerHeight, false);
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
  };
  addEventListener('resize', resize);
  resize();

  return { renderer, scene, camera };
}
