import * as THREE from 'three';

const COUNT = 900;

/** 드리프트 중 바닥에 남는 스키드 마크. 링 버퍼로 오래된 것부터 덮어쓴다 */
export function createSkids(scene: THREE.Scene): { add(x: number, z: number, h: number): void } {
  const mesh = new THREE.InstancedMesh(
    new THREE.PlaneGeometry(0.3, 0.75).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.55, depthWrite: false }),
    COUNT,
  );
  const dummy = new THREE.Object3D();
  dummy.scale.set(0, 0, 0);
  dummy.updateMatrix();
  for (let i = 0; i < COUNT; i++) mesh.setMatrixAt(i, dummy.matrix);
  dummy.scale.set(1, 1, 1);
  scene.add(mesh);

  let idx = 0;
  return {
    add(x, z, h) {
      dummy.position.set(x, 0.022, z);
      dummy.rotation.set(0, h, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(idx, dummy.matrix);
      idx = (idx + 1) % COUNT;
      mesh.instanceMatrix.needsUpdate = true;
    },
  };
}
