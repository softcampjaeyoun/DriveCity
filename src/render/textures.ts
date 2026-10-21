import * as THREE from 'three';
import { mulberry32 } from '../util/math.ts';

/** 중심에서 바깥으로 흐려지는 원형 텍스처. 가로등 빛 번짐, 언더글로우에 사용 */
export function glowTexture(inner: string, size = 128): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, inner);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return new THREE.CanvasTexture(c);
}

/** 빌딩 창문 불빛. emissiveMap 으로 사용 */
export function windowTexture(seed: number): THREE.CanvasTexture {
  const r = mulberry32(seed);
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, 128, 256);
  for (let row = 0; row < 16; row++) {
    for (let col = 0; col < 8; col++) {
      if (r() > 0.36) continue;
      const warm = r() < 0.78;
      g.globalAlpha = 0.45 + r() * 0.55;
      g.fillStyle = warm
        ? `hsl(${32 + r() * 16}, 90%, ${52 + r() * 22}%)`
        : `hsl(${190 + r() * 25}, 70%, ${58 + r() * 15}%)`;
      g.fillRect(col * 16 + 3, row * 16 + 4, 10, 9);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** 라이벌 머리 위 이름표 스프라이트 */
export function nameTag(text: string, color: string): THREE.Sprite {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = 'rgba(10,13,22,0.75)';
  g.fillRect(8, 8, 240, 48);
  g.fillStyle = color;
  g.fillRect(8, 52, 240, 4);
  g.font = '600 28px "IBM Plex Sans KR", "Malgun Gothic", sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 32);
  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }),
  );
  sprite.scale.set(5.6, 1.4, 1);
  sprite.position.y = 3.4;
  return sprite;
}
