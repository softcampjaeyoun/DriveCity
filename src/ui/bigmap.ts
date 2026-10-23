import type { Npc } from '../ai/traffic.ts';
import type { RoadGraph } from '../world/graph.ts';
import { MAP_BASE } from '../world/mapdata.ts';
import type { PlayerState } from '../vehicle/player.ts';
import type { MapPoint } from './minimap.ts';

/** 미니맵을 누르거나 Tab 을 누르면 화면 가득 펼쳐지는 지도. 우클릭(또는 가운데 버튼) 드래그로 이동, 휠로 확대·축소, 더블클릭으로 원위치 */
export interface BigMap {
  readonly open: boolean;
  toggle(): void;
  draw(t: number, S: PlayerState, npcs: Npc[], target: MapPoint | null, extra: MapPoint[], route?: number[]): void;
}

/** onDestination: 우클릭(드래그 아님)한 지점의 월드 좌표 */
export function createBigMap(root: HTMLElement, g: RoadGraph, placeOf: (x: number, z: number) => string, onDestination?: (x: number, z: number) => void): BigMap {
  // 전체 지도는 빌드 때 만든 overview.png 를 배경으로 쓴다
  const overview = new Image();
  overview.src = `${MAP_BASE}${g.index.overview.file}`;
  const canvas = document.createElement('canvas');
  const label = document.createElement('div');
  label.className = 'bigmap-label';
  const zoomBox = document.createElement('div');
  zoomBox.className = 'bigmap-zoom';
  const btnIn = document.createElement('button');
  btnIn.textContent = '+';
  btnIn.title = '확대';
  const btnOut = document.createElement('button');
  btnOut.textContent = '−';
  btnOut.title = '축소';
  const btnFit = document.createElement('button');
  btnFit.textContent = '전체';
  btnFit.title = '전체 보기';
  const btnMe = document.createElement('button');
  btnMe.textContent = '내 위치';
  zoomBox.append(btnIn, btnOut, btnFit, btnMe);
  root.append(canvas, zoomBox, label);
  const ctx = canvas.getContext('2d')!;
  let open = false;
  const { minX, maxX, minZ, maxZ } = g.bbox;
  // 보기 상태: 중심(월드 좌표)과 배율(화면 px / m)
  const OPEN_VIEW_M = 2600; // 열었을 때 가로로 보이는 거리. 지도가 아무리 커도 같은 축척으로 시작
  const MAX_ZOOM = 40;
  /** 가로 OPEN_VIEW_M 가 화면에 들어오는 배율 */
  const openZoom = () => Math.max(1, root.clientWidth / (fitScale() * OPEN_VIEW_M));
  let zoom = 1; // 전체가 들어오는 배율에 곱하는 값. 1 = 전체 보기
  let panX = 0;
  let panZ = 0;
  let dragging = false;
  let dragMoved = false;
  let lastX = 0;
  let lastY = 0;
  let playerX = (minX + maxX) / 2;
  let playerZ = (minZ + maxZ) / 2;

  function fitScale(): number {
    const w = root.clientWidth;
    const h = root.clientHeight;
    return Math.min((w - 32) / (maxX - minX), (h - 70) / (maxZ - minZ));
  }
  /** 플레이어를 가운데에 두고 zoom 배율로 */
  function centerOnPlayer(z: number): void {
    zoom = z;
    panX = playerX - (minX + maxX) / 2;
    panZ = playerZ - (minZ + maxZ) / 2;
  }
  /** 화면 중앙 기준으로 배율 변경 */
  function zoomBy(k: number): void {
    zoom = Math.min(MAX_ZOOM, Math.max(1, zoom * k));
    if (zoom === 1) panX = panZ = 0;
  }
  function layout(): { scale: number; ox: number; oz: number } {
    const w = root.clientWidth;
    const h = root.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const scale = fitScale() * zoom;
    const cx = (minX + maxX) / 2 + panX;
    const cz = (minZ + maxZ) / 2 + panZ;
    return { scale, ox: w / 2 - (cx - minX) * scale, oz: h / 2 + 10 - (cz - minZ) * scale };
  }

  root.addEventListener('contextmenu', (e) => e.preventDefault());
  root.addEventListener('pointerdown', (e) => {
    if (e.button !== 2 && e.button !== 1) return;
    dragging = true;
    dragMoved = false;
    lastX = e.clientX;
    lastY = e.clientY;
    root.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  root.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const scale = fitScale() * zoom;
    panX -= (e.clientX - lastX) / scale;
    panZ -= (e.clientY - lastY) / scale;
    lastX = e.clientX;
    lastY = e.clientY;
    dragMoved = true;
  });
  const endDrag = (e: PointerEvent) => {
    if (!dragging) return;
    dragging = false;
    if (root.hasPointerCapture(e.pointerId)) root.releasePointerCapture(e.pointerId);
    // 우클릭(움직이지 않음) = 목적지 설정
    if (e.type === 'pointerup' && e.button === 2 && !dragMoved && onDestination) {
      const { scale, ox, oz } = layout();
      onDestination((e.clientX - ox) / scale + minX, (e.clientY - oz) / scale + minZ);
    }
    // 우클릭 드래그는 click 이벤트가 안 오므로, 다음 틱에 플래그를 풀어 좌클릭 닫기가 막히지 않게
    setTimeout(() => (dragMoved = false), 0);
  };
  root.addEventListener('pointerup', endDrag);
  root.addEventListener('pointercancel', endDrag);
  root.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const { scale, ox, oz } = layout();
      // 커서 아래 지점이 제자리에 있도록 확대
      const wx = (e.clientX - ox) / scale + minX;
      const wz = (e.clientY - oz) / scale + minZ;
      const next = Math.min(MAX_ZOOM, Math.max(1, zoom * (e.deltaY < 0 ? 1.25 : 1 / 1.25)));
      const k = next / zoom;
      zoom = next;
      const cx = (minX + maxX) / 2 + panX;
      const cz = (minZ + maxZ) / 2 + panZ;
      panX = wx - (wx - cx) / k - (minX + maxX) / 2;
      panZ = wz - (wz - cz) / k - (minZ + maxZ) / 2;
      if (zoom === 1) panX = panZ = 0;
    },
    { passive: false },
  );
  root.addEventListener('dblclick', () => centerOnPlayer(openZoom()));
  const stop = (e: Event) => e.stopPropagation();
  for (const b of [btnIn, btnOut, btnFit, btnMe]) {
    b.addEventListener('pointerdown', stop);
    b.addEventListener('dblclick', stop);
  }
  btnIn.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomBy(1.5);
  });
  btnOut.addEventListener('click', (e) => {
    e.stopPropagation();
    zoomBy(1 / 1.5);
  });
  btnFit.addEventListener('click', (e) => {
    e.stopPropagation();
    zoom = 1;
    panX = panZ = 0;
  });
  btnMe.addEventListener('click', (e) => {
    e.stopPropagation();
    centerOnPlayer(Math.max(zoom, openZoom()));
  });
  // 좌클릭은 닫기. 드래그 직후의 클릭은 무시
  root.addEventListener('click', (e) => {
    if (e.button !== 0 || dragMoved) {
      dragMoved = false;
      return;
    }
    api.toggle();
  });

  const api: BigMap = {
    get open() {
      return open;
    },
    toggle() {
      open = !open;
      root.hidden = !open;
      if (open) centerOnPlayer(openZoom());
    },
    draw(t, S, npcs, target, extra, route) {
      playerX = S.x;
      playerZ = S.z;
      if (!open) return;
      const { scale, ox, oz } = layout();
      const toView = (x: number, z: number): [number, number] => [ox + (x - minX) * scale, oz + (z - minZ) * scale];
      ctx.fillStyle = '#0b0e16';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      const [vx, vz] = toView(minX, minZ);
      ctx.imageSmoothingEnabled = true;
      if (overview.complete && overview.naturalWidth) ctx.drawImage(overview, vx, vz, (maxX - minX) * scale, (maxZ - minZ) * scale);
      const dot = (x: number, z: number, r: number, color: string) => {
        const [px, pz] = toView(x, z);
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(px, pz, r, 0, Math.PI * 2);
        ctx.fill();
      };
      if (route && route.length >= 4) {
        ctx.strokeStyle = 'rgba(255,95,168,0.9)';
        ctx.lineWidth = Math.max(3, Math.min(8, scale * 14));
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        for (let i = 0; i < route.length; i += 2) {
          const [x, z] = toView(route[i], route[i + 1]);
          if (i === 0) ctx.moveTo(x, z);
          else ctx.lineTo(x, z);
        }
        ctx.stroke();
      }
      for (const p of extra) dot(p.x, p.z, (p.r ?? 4) + 2, p.color);
      for (const n of npcs) {
        if (n.police?.chasing) dot(n.x, n.z, 5, Math.floor(t * 6) % 2 ? '#ff3a3a' : '#3a6bff');
        else if (n.rival) dot(n.x, n.z, 5, n.rival.hex);
        else if (zoom >= 2.5) dot(n.x, n.z, 2, 'rgba(200,206,220,0.6)');
      }
      if (target) dot(target.x, target.z, 8 + Math.sin(t * 6) * 2, target.color);
      const [px, pz] = toView(S.x, S.z);
      ctx.save();
      ctx.translate(px, pz);
      ctx.rotate(Math.atan2(Math.sin(S.h), -Math.cos(S.h)));
      ctx.fillStyle = '#ffae4a';
      ctx.beginPath();
      ctx.moveTo(0, -12);
      ctx.lineTo(9, 10);
      ctx.lineTo(-9, 10);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
      ctx.font = '600 13px "IBM Plex Sans KR", sans-serif';
      ctx.fillStyle = 'rgba(233,237,246,0.85)';
      ctx.textAlign = 'center';
      // 지명이 겹치면 먼저 그린 것만 남긴다 (전체 보기에서 동 이름이 뭉치지 않게)
      const drawn: { x: number; z: number; w: number }[] = [];
      for (const p of g.index.places) {
        const [x, z] = toView(p.x, p.z);
        if (x < -40 || z < -10 || x > canvas.width + 40 || z > canvas.height + 10) continue;
        const w = ctx.measureText(p.name).width + 8;
        if (drawn.some((d) => Math.abs(d.z - z) < 15 && Math.abs(d.x - x) < (d.w + w) / 2)) continue;
        drawn.push({ x, z, w });
        ctx.fillText(p.name, x, z);
      }
      // 확대 시 도로 이름
      if (zoom >= 3) {
        ctx.font = '11px "IBM Plex Sans KR", sans-serif';
        ctx.fillStyle = 'rgba(200,206,220,0.75)';
        const seen = new Set<string>();
        for (const e of g.edges) {
          if (!e.name || e.rank > 4 || seen.has(e.name)) continue;
          const p = g.pointAt(e, 1, e.len / 2);
          const [x, z] = toView(p.x, p.z);
          if (x < 0 || z < 0 || x > canvas.width || z > canvas.height) continue;
          seen.add(e.name);
          ctx.fillText(e.name, x, z - 4);
        }
      }
      label.textContent = `${placeOf(S.x, S.z)} · ${zoom.toFixed(1)}배 · 우클릭: 목적지 설정 · 우클릭 드래그 이동 · 휠 또는 + − 확대 · 좌클릭/Tab 닫기`;
    },
  };
  return api;
}
