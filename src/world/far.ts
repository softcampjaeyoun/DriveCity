import * as THREE from 'three';
import { CLASS_RANK, levelHeight } from './graph.ts';
import type { MapIndex, TileData } from './mapdata.ts';
import type { Terrain } from './terrain.ts';

/**
 * 멀리 있는(아직 자세히 만들지 않은) 타일의 저해상도 모습: 건물은 단색 상자, 큰길은 어두운 띠, 물은 평면.
 * 안개 너머에서 타일이 갑자기 나타나는 팝인을 가린다. 그림자·창문·간판은 없다
 */
export interface FarTiles {
  add(key: string, tile: TileData): void;
  remove(key: string): void;
  setNight(night: number): void;
  readonly count: number;
}

const KIND_COLOR: Record<string, number> = { tower: 0x7d8794, block: 0x8b8a86, low: 0x948d84, apt: 0xb6b9bf };

export function createFarTiles(scene: THREE.Scene, index: MapIndex, terrain: Terrain): FarTiles {
  const bldMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
  void index;
  const roadMat = new THREE.MeshBasicMaterial({ color: 0x45484f });
  const waterMat = new THREE.MeshBasicMaterial({ color: 0x3d7bb5 });
  const groups = new Map<string, THREE.Group>();
  const col = new THREE.Color();

  const build = (tile: TileData): THREE.Group => {
    const group = new THREE.Group();
    group.name = `far:${tile.i}_${tile.j}`;
    const gAt = (x: number, z: number) => terrain.at(x, z);
    // ----- 지형 (공원은 초록) -----
    const tg = terrain.geometry(tile, true);
    if (tg) {
      const cnt = tg.attributes.position.count;
      const pk = tg.attributes.park as THREE.BufferAttribute;
      const tc = new Float32Array(cnt * 3);
      for (let k = 0; k < cnt; k++) {
        const p = pk.getX(k);
        tc[k * 3] = 0.52 - 0.2 * p;
        tc[k * 3 + 1] = 0.53 - 0.06 * p;
        tc[k * 3 + 2] = 0.55 - 0.3 * p;
      }
      tg.setAttribute('color', new THREE.BufferAttribute(tc, 3));
      const tm = new THREE.Mesh(tg, terrainMat);
      tm.renderOrder = -1;
      group.add(tm);
    }
    // ----- 건물 상자 -----
    const pos: number[] = [];
    const nrm: number[] = [];
    const colors: number[] = [];
    const idx: number[] = [];
    for (const b of tile.buildings) {
      const ring = b.ring;
      const n = ring.length / 2;
      if (n < 3) continue;
      let cx = 0;
      let cz = 0;
      for (let i = 0; i < n; i++) {
        cx += ring[i * 2];
        cz += ring[i * 2 + 1];
      }
      cx /= n;
      cz /= n;
      const gy = gAt(cx, cz);
      // 종류별 색에 약간의 편차. 윗면은 조금 어둡게
      col.setHex(KIND_COLOR[b.kind] ?? 0x8a8a8a).multiplyScalar(0.9 + ((Math.abs(ring[0] * 7 + ring[1] * 13) % 17) / 17) * 0.18);
      const r = col.r;
      const gc = col.g;
      const bl = col.b;
      for (let i = 0; i < n; i++) {
        const j = (i + 1) % n;
        const x0 = ring[i * 2];
        const z0 = ring[i * 2 + 1];
        const x1 = ring[j * 2];
        const z1 = ring[j * 2 + 1];
        const len = Math.hypot(x1 - x0, z1 - z0);
        if (len < 0.2) continue;
        let nx = (z1 - z0) / len;
        let nz = -(x1 - x0) / len;
        if (nx * ((x0 + x1) / 2 - cx) + nz * ((z0 + z1) / 2 - cz) < 0) {
          nx = -nx;
          nz = -nz;
        }
        const base = pos.length / 3;
        pos.push(x0, gy - 1, z0, x1, gy - 1, z1, x1, gy + b.h, z1, x0, gy + b.h, z0);
        for (let k = 0; k < 4; k++) {
          nrm.push(nx, 0, nz);
          colors.push(r, gc, bl);
        }
        // 바깥을 보게 (법선 방향과 맞춘다)
        const cross = (x1 - x0) * nz - (z1 - z0) * nx;
        if (cross > 0) idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
        else idx.push(base + 1, base, base + 3, base + 1, base + 3, base + 2);
      }
      // 지붕: 무게중심 부채꼴 (멀리서 보니 오목한 건물도 그냥 덮는다)
      if (n <= 48) {
        const base = pos.length / 3;
        pos.push(cx, gy + b.h, cz);
        nrm.push(0, 1, 0);
        colors.push(r * 0.85, gc * 0.85, bl * 0.85);
        for (let i = 0; i < n; i++) {
          pos.push(ring[i * 2], gy + b.h, ring[i * 2 + 1]);
          nrm.push(0, 1, 0);
          colors.push(r * 0.85, gc * 0.85, bl * 0.85);
        }
        // 고리 방향에 따라 삼각형 방향을 맞춘다
        let area = 0;
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
        }
        for (let i = 0; i < n; i++) {
          const j = (i + 1) % n;
          if (area < 0) idx.push(base, base + 1 + i, base + 1 + j);
          else idx.push(base, base + 1 + j, base + 1 + i);
        }
      }
    }
    if (idx.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
      geo.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
      geo.setIndex(idx);
      group.add(new THREE.Mesh(geo, bldMat));
    }
    // ----- 큰길 띠 (4등급 이하), 고가는 레벨 높이에 -----
    const rp: number[] = [];
    const ri: number[] = [];
    for (const e of tile.edges) {
      const rank = CLASS_RANK[e.cls] ?? 6;
      if (rank > 4) continue;
      const lanes = e.lb === 0 ? e.lf : e.lf + e.lb;
      const half = (lanes * 3.3) / 2 + 0.3;
      const lvY = 0.05 + levelHeight(e.lv ?? 0);
      // 고가·지하는 양끝 지형을 직선 보간한 바닥 위 (graph.heightAt 과 같은 규칙), 지상은 25m 마다 지형을 따라간다
      const na = e.pts.length / 2;
      const ga = gAt(e.pts[0], e.pts[1]);
      const gb = gAt(e.pts[na * 2 - 2], e.pts[na * 2 - 1]);
      let cum = 0;
      let total = 0;
      for (let i = 0; i < e.pts.length - 2; i += 2) total += Math.hypot(e.pts[i + 2] - e.pts[i], e.pts[i + 3] - e.pts[i + 1]);
      const yAt = (x: number, z: number, s: number) => (e.lv ? ga + (gb - ga) * (total ? s / total : 0) + lvY : gAt(x, z) + lvY);
      for (let i = 0; i < e.pts.length - 2; i += 2) {
        const x0 = e.pts[i];
        const z0 = e.pts[i + 1];
        const x1 = e.pts[i + 2];
        const z1 = e.pts[i + 3];
        const l = Math.hypot(x1 - x0, z1 - z0) || 1;
        const nx = (-(z1 - z0) / l) * half;
        const nz = ((x1 - x0) / l) * half;
        const parts = e.lv ? 1 : Math.max(1, Math.ceil(l / 25));
        for (let p = 0; p < parts; p++) {
          const t0 = p / parts;
          const t1 = (p + 1) / parts;
          const ax = x0 + (x1 - x0) * t0;
          const az = z0 + (z1 - z0) * t0;
          const bx = x0 + (x1 - x0) * t1;
          const bz = z0 + (z1 - z0) * t1;
          const ya = yAt(ax, az, cum + l * t0);
          const yb = yAt(bx, bz, cum + l * t1);
          const base = rp.length / 3;
          rp.push(ax - nx, ya, az - nz, ax + nx, ya, az + nz, bx + nx, yb, bz + nz, bx - nx, yb, bz - nz);
          ri.push(base, base + 1, base + 2, base, base + 2, base + 3);
        }
        cum += l;
      }
    }
    if (ri.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(rp, 3));
      geo.setIndex(ri);
      group.add(new THREE.Mesh(geo, roadMat));
    }
    // ----- 물 -----
    const wp: number[] = [];
    const wi: number[] = [];
    for (const ring of tile.water) {
      const contour: THREE.Vector2[] = [];
      for (let i = 0; i < ring.length; i += 2) contour.push(new THREE.Vector2(ring[i], ring[i + 1]));
      let faces: number[][];
      try {
        faces = THREE.ShapeUtils.triangulateShape(contour, []);
      } catch {
        continue;
      }
      const base = wp.length / 3;
      for (const p of contour) wp.push(p.x, 0.04, p.y);
      for (const f of faces) {
        const a = contour[f[0]];
        const c = contour[f[1]];
        const d = contour[f[2]];
        const up = (c.x - a.x) * (d.y - a.y) - (d.x - a.x) * (c.y - a.y) < 0;
        if (up) wi.push(base + f[0], base + f[1], base + f[2]);
        else wi.push(base + f[0], base + f[2], base + f[1]);
      }
    }
    if (wi.length) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
      geo.setIndex(wi);
      group.add(new THREE.Mesh(geo, waterMat));
    }
    return group;
  };

  return {
    get count() {
      return groups.size;
    },
    add(key, tile) {
      if (groups.has(key)) return;
      const group = build(tile);
      groups.set(key, group);
      scene.add(group);
    },
    remove(key) {
      const group = groups.get(key);
      if (!group) return;
      groups.delete(key);
      scene.remove(group);
      group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) m.geometry.dispose();
      });
    },
    setNight(night) {
      // 밤엔 어두운 실루엣에 창문빛처럼 은은한 발광
      bldMat.color.setHex(0xffffff).lerp(new THREE.Color(0x404654), night);
      bldMat.emissive.setHex(0x000000).lerp(new THREE.Color(0x2a2418), night);
      roadMat.color.setHex(0x45484f).lerp(new THREE.Color(0x1d1f26), night);
      terrainMat.color.setHex(0xffffff).lerp(new THREE.Color(0x3a3d48), night);
      waterMat.color.setHex(0x3d7bb5).lerp(new THREE.Color(0x1a3a66), night);
    },
  };
}
