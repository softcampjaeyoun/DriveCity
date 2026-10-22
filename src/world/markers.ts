import * as THREE from 'three';

/** 체크포인트·결승·미션 지점을 표시하는 빛기둥과 링 */
export interface Marker {
  setPosition(x: number, z: number, y?: number): void;
  setColor(hex: number): void;
  setVisible(v: boolean): void;
  update(t: number): void;
}

export function createMarker(scene: THREE.Scene, color: number, radius = 4): Marker {
  const group = new THREE.Group();
  const beamMat = new THREE.MeshBasicMaterial({
    color,
    transparent: true,
    opacity: 0.16,
    side: THREE.DoubleSide,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    fog: false,
  });
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, 90, 28, 1, true), beamMat);
  beam.position.y = 45;
  const ringMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85, depthWrite: false });
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius + 2, radius + 3, 48).rotateX(-Math.PI / 2), ringMat);
  ring.position.y = 0.05;
  group.add(beam, ring);
  scene.add(group);

  return {
    setPosition(x, z, y = 0) {
      group.position.set(x, y, z);
    },
    setColor(hex) {
      beamMat.color.setHex(hex);
      ringMat.color.setHex(hex);
    },
    setVisible(v) {
      group.visible = v;
    },
    update(t) {
      beamMat.opacity = 0.13 + Math.sin(t * 3) * 0.04;
      ring.rotation.y = t;
    },
  };
}
