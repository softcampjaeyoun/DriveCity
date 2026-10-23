import * as THREE from 'three';
import type { Stage } from './scene.ts';
import type { WarmMaterial } from '../world/city.ts';

/**
 * 셰이더 미리 컴파일. WebGL 은 재질·지오메트리 조합(인스턴스 여부, 인스턴스 색, 꼭짓점 색, 그림자 깊이 재질, AO 의 법선 재질 …)마다
 * 처음 그릴 때 프로그램을 동기로 컴파일해 수십~수백 ms 멈춘다. 게임 중 처음 나타나는 것(물리 도장 차, 경기장, 지하철 표지 …)마다
 * 멈칫거리지 않게, 시작 화면에서 모든 조합을 작은 메시로 한 번 그려 둔다.
 * 1) compileAsync: KHR_parallel_shader_compile 이 있으면 병렬로 컴파일 2) 실제 한 프레임 렌더: 그림자 깊이·AO 법선 변형까지 컴파일
 */
export async function warmShaders(stage: Stage, mats: WarmMaterial[], models: THREE.Object3D[] = []): Promise<number> {
  const { renderer, scene, camera } = stage;
  const group = new THREE.Group();
  group.name = 'warmup';
  const box = new THREE.BoxGeometry(0.5, 0.5, 0.5);
  const colored = box.clone();
  colored.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(colored.attributes.position.count * 3).fill(1), 3));
  colored.setAttribute('park', new THREE.Float32BufferAttribute(new Float32Array(colored.attributes.position.count), 1));
  const pts = new THREE.BufferGeometry();
  pts.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0], 3));
  const col = new THREE.Color(1, 1, 1);
  let i = 0;
  for (const w of mats) {
    const geo = colored;
    let o: THREE.Object3D;
    if (w.points) o = new THREE.Points(pts, w.mat);
    else if (w.inst) {
      const im = new THREE.InstancedMesh(geo, w.mat, 1);
      im.setMatrixAt(0, new THREE.Matrix4());
      if (w.instColor) im.setColorAt(0, col);
      o = im;
    } else o = new THREE.Mesh(geo, w.mat);
    (o as THREE.Mesh).castShadow = true;
    (o as THREE.Mesh).receiveShadow = true;
    o.frustumCulled = false;
    o.position.set((i % 20) * 0.8, 0.3, Math.floor(i / 20) * 0.8);
    group.add(o);
    i++;
  }
  for (const m of models) {
    const c = m.clone(true);
    c.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) mesh.castShadow = true;
      o.frustumCulled = false;
    });
    c.position.set((i % 20) * 0.8, 0.3, Math.floor(i / 20) * 0.8);
    group.add(c);
    i++;
  }
  // 카메라 바로 앞 깊은 땅속에 두고 한 번 그린다 (플레이어·도시와 겹치지 않게)
  group.position.set(camera.position.x, camera.position.y - 400, camera.position.z);
  scene.add(group);
  const before = renderer.info.programs?.length ?? 0;
  try {
    await renderer.compileAsync(group, camera, scene);
    const saveX = camera.position.x;
    const saveY = camera.position.y;
    const saveZ = camera.position.z;
    camera.position.set(group.position.x + 8, group.position.y + 6, group.position.z + 8);
    camera.lookAt(group.position.x + 8, group.position.y, group.position.z + 8);
    camera.updateMatrixWorld();
    stage.render(0.016);
    camera.position.set(saveX, saveY, saveZ);
  } catch (e) {
    console.warn('[warmup] 셰이더 미리 컴파일 실패', e);
  } finally {
    scene.remove(group);
    box.dispose();
    colored.dispose();
    pts.dispose();
  }
  const n = (renderer.info.programs?.length ?? 0) - before;
  console.info(`[warmup] 셰이더 프로그램 ${n}개 미리 컴파일`);
  return n;
}
