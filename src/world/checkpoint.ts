import * as THREE from 'three';

/** 체크포인트 / 배틀 결승 지점을 표시하는 빛기둥과 링 */
export interface Marker {
  setPosition(x: number, z: number): void;
  setColor(hex: number): void;
  update(t: number): void;
}

export function createMarker(scene: THREE.Scene): Marker {
  const group = new THREE.Group();
  const beamMat = new THREE.MeshBasicMaterial({
    color: 0x4fd1ff,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(4, 4, 90, 28, 1, true), beamMat);
  beam.position.y = 45;
  const ringMat = new THREE.MeshBasicMaterial({ color: 0x4fd1ff, transparent: true, opacity: 0.85, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(6, 7, 48).rotateX(-Math.PI / 2), ringMat);
  ring.position.y = 0.05;
  group.add(beam, ring);
  scene.add(group);

  return {
    setPosition(x, z) {
      group.position.set(x, 0, z);
    },
    setColor(hex) {
      beamMat.color.setHex(hex);
      ringMat.color.setHex(hex);
    },
    update(t) {
      beamMat.opacity = 0.13 + Math.sin(t * 3) * 0.04;
      ring.rotation.y = t;
    },
  };
}
