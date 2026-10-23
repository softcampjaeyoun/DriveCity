import * as THREE from 'three';
import { mulberry32 } from '../util/math.ts';
import { SIGN_WORDS } from './assets.ts';

/**
 * 사진 파사드 합성기. 벡터로 그리던 상가·아파트 외벽 대신, CC0 사진 질감(타일·벽돌·화강석·플라스터·금속)을 캔버스에
 * 층별로 합성해 서울 근린상가·오피스·아파트 외벽을 만든다. 창문은 하늘 반사 그라데이션 + 알루미늄 창틀, 실외기·배관·오염 줄무늬를 얹는다.
 * 한 장이 가로 16m × 세로 13.2m(4개 층)를 덮고 세로로 반복된다 (wallRepeat 과 같은 규칙: u = m/32, v = m/48).
 * 낮용(map)과 밤 발광용(emissive) 두 장을 만든다
 */
export interface FacadeTex {
  map: THREE.CanvasTexture;
  emissive: THREE.CanvasTexture;
  /** 한 장이 덮는 실제 크기 (m) */
  tileW: number;
  tileH: number;
}
export interface FacadeLib {
  /** 근린상가·저층 (2~5층 타일·벽돌·플라스터) */
  low: FacadeTex[];
  /** 중층 오피스·블록 */
  block: FacadeTex[];
  /** 판상형 아파트 */
  apt: FacadeTex[];
  /** 1층 상가 띠 (가로 12m × 세로 3.6m) */
  store: FacadeTex[];
}

const KFONT = '"IBM Plex Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
const BOLD = '"Black Han Sans", "IBM Plex Sans KR", "Malgun Gothic", sans-serif';
const BASE = `${import.meta.env.BASE_URL}textures/`;

/** 사진 재료 (public/textures, 768px). 벽 재료는 실제 크기 scale (m / 한 장) 를 가진다 */
const WALLS: Array<{ id: string; m: number; tint: string[]; kind: 'tile' | 'brick' | 'granite' | 'plaster' | 'concrete' }> = [
  { id: 'Tiles107', m: 2.0, tint: ['#e8dfcf', '#d9cdb6', '#e3e0d6', '#cfc3ad'], kind: 'tile' },
  { id: 'Tiles133A', m: 1.5, tint: ['#e6e1d4', '#d8d4c8', '#cdd3d6'], kind: 'tile' },
  { id: 'Tiles040', m: 2.5, tint: ['#d7cfbf', '#c9bfae', '#dcd6c8'], kind: 'tile' },
  { id: 'Bricks059', m: 2.2, tint: ['#ffffff', '#e8d8cc', '#d8c8bc'], kind: 'brick' },
  { id: 'Bricks105', m: 2.2, tint: ['#ffffff', '#e0d2b8', '#d2c4a8'], kind: 'brick' },
  { id: 'Bricks106A', m: 2.2, tint: ['#ffffff', '#e6dcc8'], kind: 'brick' },
  { id: 'Bricks107A', m: 2.2, tint: ['#ffffff', '#ddd0bc'], kind: 'brick' },
  { id: 'Granite001A', m: 2.0, tint: ['#e6ddd0', '#d9cfc2'], kind: 'granite' },
  { id: 'Granite002A', m: 2.0, tint: ['#e2e2e0', '#d0d2d4'], kind: 'granite' },
  { id: 'Granite005A', m: 2.0, tint: ['#cfc8c4', '#bcb8b6'], kind: 'granite' },
  { id: 'Plaster001', m: 3.0, tint: ['#efe9dc', '#e2d9c6', '#d8d9d2', '#e5dccb'], kind: 'plaster' },
  { id: 'Plaster002', m: 3.0, tint: ['#e9e2d2', '#d9cfbf', '#e4e4de'], kind: 'plaster' },
  { id: 'PaintedPlaster017', m: 3.0, tint: ['#e8e4da', '#dcd6c8', '#d4dcdc'], kind: 'plaster' },
  { id: 'PaintedPlaster006', m: 3.0, tint: ['#e3d9c8', '#d6cab8'], kind: 'plaster' },
  { id: 'Concrete030', m: 3.0, tint: ['#bdbdb8', '#c8c6c0'], kind: 'concrete' },
  { id: 'Concrete036', m: 3.0, tint: ['#cfcdc8', '#d8d6d0'], kind: 'concrete' },
];
const EXTRA = ['Granite002A', 'Granite005A', 'Metal048A', 'CorrugatedSteel009', 'Metal032', 'Concrete031'];

const images = new Map<string, HTMLImageElement>();
function loadImage(id: string): Promise<void> {
  return new Promise((resolve) => {
    const im = new Image();
    im.onload = () => {
      images.set(id, im);
      resolve();
    };
    im.onerror = () => {
      console.warn('[facades] 질감 로드 실패', id);
      resolve();
    };
    im.src = `${BASE}${id}_Color.jpg`;
  });
}

type Ctx = CanvasRenderingContext2D;
function canvas(w: number, h: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}
function toTex(c: HTMLCanvasElement, repeatX = 1, repeatY = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** 사진을 실제 크기에 맞춰 영역에 깔고 틴트를 곱한다. ppm = 픽셀/m */
function photoFill(g: Ctx, id: string, x: number, y: number, w: number, h: number, ppm: number, mPerTile: number, tint: string, offX = 0, offY = 0): void {
  const im = images.get(id);
  g.save();
  g.beginPath();
  g.rect(x, y, w, h);
  g.clip();
  if (im) {
    const px = mPerTile * ppm;
    for (let yy = y - ((y - offY) % px) - px; yy < y + h; yy += px) for (let xx = x - ((x - offX) % px) - px; xx < x + w; xx += px) g.drawImage(im, xx, yy, px, px);
  } else {
    g.fillStyle = '#c8c2b6';
    g.fillRect(x, y, w, h);
  }
  if (tint !== '#ffffff') {
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = tint;
    g.fillRect(x, y, w, h);
    g.globalCompositeOperation = 'source-over';
  }
  g.restore();
}

/** 창문 한 짝: 하늘 반사 유리 + 알루미늄 틀 + 창턱 그림자. lit 이면 밤 발광용 ge 에 불빛 */
function windowRect(g: Ctx, ge: Ctx, x: number, y: number, w: number, h: number, r: () => number, frame: string, lit: number, dark = false): void {
  // 유리: 위는 하늘 반사(밝은 청회색), 아래는 실내(어두움)
  const gr = g.createLinearGradient(0, y, 0, y + h);
  const sky = dark ? 0 : 1;
  gr.addColorStop(0, `hsl(${206 + r() * 10}, ${20 + sky * 15}%, ${dark ? 22 : 58 + r() * 10}%)`);
  gr.addColorStop(0.45, `hsl(${210 + r() * 10}, 18%, ${dark ? 16 : 40 + r() * 8}%)`);
  gr.addColorStop(1, `hsl(${215 + r() * 10}, 14%, ${dark ? 12 : 24 + r() * 8}%)`);
  g.fillStyle = gr;
  g.fillRect(x, y, w, h);
  // 커튼·블라인드가 보이는 창 (안쪽 밝은 띠)
  if (r() < 0.35) {
    g.fillStyle = `rgba(${225 + r() * 25}, ${220 + r() * 20}, ${200 + r() * 30}, ${0.35 + r() * 0.3})`;
    const bh = h * (0.3 + r() * 0.5);
    g.fillRect(x + 2, y + h - bh, w - 4, bh);
  }
  // 반사 하이라이트 사선
  g.fillStyle = 'rgba(255,255,255,0.14)';
  g.beginPath();
  g.moveTo(x + w * 0.1, y);
  g.lineTo(x + w * 0.35, y);
  g.lineTo(x + w * 0.05, y + h);
  g.lineTo(x, y + h * 0.8);
  g.closePath();
  g.fill();
  // 틀: 바깥 프레임 + 가운데 세로 분할
  g.strokeStyle = frame;
  g.lineWidth = Math.max(2, w * 0.035);
  g.strokeRect(x, y, w, h);
  g.beginPath();
  g.moveTo(x + w / 2, y);
  g.lineTo(x + w / 2, y + h);
  if (h > w * 0.9) {
    g.moveTo(x, y + h * 0.42);
    g.lineTo(x + w, y + h * 0.42);
  }
  g.stroke();
  // 창턱 그림자 (창 위쪽 벽에 짙게)
  g.fillStyle = 'rgba(0,0,0,0.22)';
  g.fillRect(x - 1, y - 3, w + 2, 3);
  // 밤 불빛
  if (lit > 0) {
    ge.fillStyle = `hsl(${36 + r() * 16}, 85%, ${55 + lit * 20}%)`;
    ge.fillRect(x + 2, y + 2, w - 4, h - 4);
  }
}

/** 실외기: 회색 상자 + 그릴 + 그림자 */
function acUnit(g: Ctx, x: number, y: number, w: number, h: number, r: () => number): void {
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(x + 2, y + 3, w, h);
  g.fillStyle = `hsl(0, 0%, ${72 + r() * 14}%)`;
  g.fillRect(x, y, w, h);
  g.fillStyle = 'rgba(0,0,0,0.35)';
  for (let yy = y + 3; yy < y + h - 3; yy += 3) g.fillRect(x + w * 0.45, yy, w * 0.5, 1);
  g.beginPath();
  g.arc(x + w * 0.24, y + h / 2, h * 0.34, 0, Math.PI * 2);
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.fill();
  // 받침대
  g.fillStyle = 'rgba(40,40,40,0.8)';
  g.fillRect(x - 1, y + h, w + 2, 2);
}

/** 오염 줄무늬: 창턱·돌출부 아래로 흘러내린 때 */
function streaks(g: Ctx, x: number, y: number, w: number, len: number, r: () => number, strength = 0.18): void {
  const n = 2 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    const sx = x + r() * w;
    const sw = 2 + r() * 5;
    const gr = g.createLinearGradient(0, y, 0, y + len);
    gr.addColorStop(0, `rgba(30,25,20,${strength})`);
    gr.addColorStop(1, 'rgba(30,25,20,0)');
    g.fillStyle = gr;
    g.fillRect(sx, y, sw, len * (0.5 + r() * 0.5));
  }
}

/** 수직 배관 */
function pipe(g: Ctx, x: number, y0: number, y1: number, w: number, color: string): void {
  g.fillStyle = 'rgba(0,0,0,0.3)';
  g.fillRect(x + w * 0.6, y0, w, y1 - y0);
  g.fillStyle = color;
  g.fillRect(x, y0, w, y1 - y0);
  g.fillStyle = 'rgba(255,255,255,0.25)';
  g.fillRect(x + 1, y0, Math.max(1, w * 0.3), y1 - y0);
}

/** 근린상가·오피스 외벽 (16m × 13.2m, 4층) */
function commercialFacade(seed: number, office: boolean): FacadeTex {
  const r = mulberry32(seed * 101 + 7);
  const W = 1024;
  const TILE_W = 16;
  const TILE_H = 13.2;
  const ppm = W / TILE_W;
  const H = Math.round(TILE_H * ppm);
  const [c, g] = canvas(W, H);
  const [e, ge] = canvas(W, H);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  const wall = WALLS[Math.floor(r() * WALLS.length)];
  const tint = wall.tint[Math.floor(r() * wall.tint.length)];
  photoFill(g, wall.id, 0, 0, W, H, ppm, wall.m, tint);
  const FLOORS = 4;
  const fh = H / FLOORS;
  const frame = ['#2b2f36', '#3a3d42', '#c9ccd0', '#6b5a3c', '#1f2a3a'][Math.floor(r() * 5)];
  const style = office ? (r() < 0.5 ? 'ribbon' : 'grid') : r() < 0.6 ? 'punched' : 'ribbon';
  const bays = style === 'punched' ? 3 + Math.floor(r() * 3) : 4 + Math.floor(r() * 3);
  const bw = W / bays;
  const hasBand = r() < 0.7;
  const bandTex = ['Granite002A', 'Granite005A', 'Granite001A'][Math.floor(r() * 3)];
  for (let f = 0; f < FLOORS; f++) {
    const y0 = H - (f + 1) * fh;
    // 층 띠 (화강석 띠 또는 슬래브 선)
    if (hasBand) photoFill(g, bandTex, 0, y0 + fh - 18, W, 18, ppm, 2, '#ffffff');
    else {
      g.fillStyle = 'rgba(0,0,0,0.18)';
      g.fillRect(0, y0 + fh - 6, W, 6);
    }
    for (let b = 0; b < bays; b++) {
      const x0 = b * bw;
      const lit = r() < 0.4 ? 0.5 + r() * 0.5 : 0;
      if (style === 'ribbon') {
        windowRect(g, ge, x0 + bw * 0.06, y0 + fh * 0.2, bw * 0.88, fh * 0.55, r, frame, lit);
      } else if (style === 'grid') {
        windowRect(g, ge, x0 + bw * 0.1, y0 + fh * 0.14, bw * 0.8, fh * 0.64, r, frame, lit);
      } else {
        const ww = bw * (0.42 + r() * 0.2);
        const wh = fh * (0.45 + r() * 0.12);
        windowRect(g, ge, x0 + (bw - ww) / 2, y0 + fh * 0.22, ww, wh, r, frame, lit);
        // 창 아래 실외기
        if (r() < 0.45) acUnit(g, x0 + (bw - ww) / 2 + ww * (r() < 0.5 ? 0.05 : 0.5), y0 + fh * 0.22 + wh + 6, ww * 0.42, fh * 0.17, r);
      }
      if (r() < 0.5) streaks(g, x0 + bw * 0.1, y0 + fh * 0.78, bw * 0.8, fh * 0.3, r, 0.14);
    }
  }
  // 배관 1~2개
  const pipes = Math.floor(r() * 3);
  for (let i = 0; i < pipes; i++) pipe(g, W * (0.02 + r() * 0.96), 0, H, 4 + r() * 4, ['#8a8d90', '#5c5f63', '#7a6a55'][Math.floor(r() * 3)]);
  // 전체 때: 아래로 갈수록 살짝 어둡게 + 약한 노이즈
  const vg = g.createLinearGradient(0, 0, 0, H);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(20,15,10,0.12)');
  g.fillStyle = vg;
  g.fillRect(0, 0, W, H);
  return { map: toTex(c), emissive: toTex(e), tileW: TILE_W, tileH: TILE_H };
}

/** 판상형 아파트 (16m × 24m, 8층): 플라스터 사진 + 발코니 창 + 측면 강조색 */
function aptFacade(seed: number): FacadeTex {
  const r = mulberry32(seed * 71 + 3);
  const W = 768;
  const TILE_W = 16;
  const TILE_H = 24;
  const ppm = W / TILE_W;
  const H = Math.round(TILE_H * ppm);
  const [c, g] = canvas(W, H);
  const [e, ge] = canvas(W, H);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  const base = ['Plaster001', 'Plaster002', 'PaintedPlaster017'][Math.floor(r() * 3)];
  const tint = ['#efeadf', '#eae6dc', '#e2e3df', '#ece5d2', '#e6ebe6'][Math.floor(r() * 5)];
  photoFill(g, base, 0, 0, W, H, ppm, 3, tint);
  const accent = ['#2f6b9a', '#3a8a5a', '#b55a3a', '#5a6a9a', '#8a6a3a', '#c2473f'][Math.floor(r() * 6)];
  g.fillStyle = accent;
  g.globalAlpha = 0.85;
  g.fillRect(0, 0, 26, H);
  g.fillRect(W - 26, 0, 26, H);
  g.globalAlpha = 1;
  const FLOORS = 8;
  const fh = H / FLOORS;
  const units = 4;
  const uw = W / units;
  for (let f = 0; f < FLOORS; f++) {
    const y0 = H - (f + 1) * fh;
    g.fillStyle = 'rgba(0,0,0,0.14)';
    g.fillRect(0, y0 + fh - 7, W, 7);
    for (let u = 0; u < units; u++) {
      const x0 = u * uw + 30;
      const lit = r() < 0.35 ? 0.5 + r() * 0.5 : 0;
      // 거실 창(넓음) + 방 창(좁음)
      const w1 = uw * 0.5;
      const w2 = uw * 0.22;
      windowRect(g, ge, x0, y0 + fh * 0.16, w1, fh * 0.5, r, '#d8dbe0', lit);
      windowRect(g, ge, x0 + w1 + 10, y0 + fh * 0.16, w2, fh * 0.5, r, '#d8dbe0', r() < 0.3 ? 0.6 : 0);
      // 발코니 난간 선
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fillRect(x0 - 4, y0 + fh * 0.66, w1 + w2 + 18, 3);
      g.fillStyle = 'rgba(0,0,0,0.2)';
      g.fillRect(x0 - 4, y0 + fh * 0.69, w1 + w2 + 18, 2);
      if (r() < 0.25) streaks(g, x0, y0 + fh * 0.7, w1, fh * 0.3, r, 0.1);
    }
  }
  const vg = g.createLinearGradient(0, 0, 0, H);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(20,15,10,0.1)');
  g.fillStyle = vg;
  g.fillRect(0, 0, W, H);
  return { map: toTex(c), emissive: toTex(e), tileW: TILE_W, tileH: TILE_H };
}

const SIGN_PALETTE: Array<[string, string]> = [
  ['#d93025', '#ffffff'], ['#1e3a8a', '#ffffff'], ['#0f766e', '#ffffff'], ['#f59e0b', '#1f1300'], ['#ffffff', '#1f2937'], ['#111827', '#fbbf24'],
  ['#7c3aed', '#ffffff'], ['#16a34a', '#ffffff'], ['#f3f4f6', '#b91c1c'], ['#0ea5e9', '#ffffff'], ['#fde68a', '#7c2d12'], ['#be185d', '#ffffff'],
  ['#ffffff', '#d93025'], ['#ffffff', '#1e3a8a'], ['#2b2b2b', '#ffffff'],
];

/** 1층 상가 띠 (12m × 3.6m): 화강석 기단 + 유리 매장(또는 셔터) + 간판 패널. 낮·밤 */
function storeFacade(seed: number): FacadeTex {
  const r = mulberry32(seed * 23 + 11);
  const W = 1024;
  const TILE_W = 12;
  const TILE_H = 3.6;
  const ppm = W / TILE_W;
  const H = Math.round(TILE_H * ppm);
  const [c, g] = canvas(W, H);
  const [e, ge] = canvas(W, H);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  const shops = 2 + Math.floor(r() * 2);
  const sw = W / shops;
  const bandH = H * 0.26;
  const baseH = H * 0.08;
  for (let s = 0; s < shops; s++) {
    const x0 = s * sw;
    // 벽체: 화강석 또는 타일 기둥
    photoFill(g, ['Granite005A', 'Granite001A', 'Tiles107'][Math.floor(r() * 3)], x0, 0, sw, H, ppm, 2, '#ffffff');
    // 기단 (어두운 화강석)
    photoFill(g, 'Granite005A', x0, H - baseH, sw, baseH, ppm, 2, '#8f8a86');
    const gx = x0 + sw * 0.05;
    const gw = sw * 0.9;
    const gy = bandH + 8;
    const gh = H - gy - baseH;
    const shutter = r() < 0.18;
    if (shutter) {
      photoFill(g, 'CorrugatedSteel009', gx, gy, gw, gh, ppm, 1.2, ['#cfcfcf', '#b9bdc2', '#c9c2b4'][Math.floor(r() * 3)]);
      g.fillStyle = 'rgba(0,0,0,0.25)';
      for (let yy = gy; yy < gy + gh; yy += 11) g.fillRect(gx, yy, gw, 2);
    } else {
      // 유리: 바깥 반사(위 하늘, 가운데 거리) + 안쪽 진열(따뜻한 빛, 선반)
      const gr = g.createLinearGradient(0, gy, 0, gy + gh);
      gr.addColorStop(0, `hsl(${205 + r() * 10}, 28%, ${62 + r() * 8}%)`);
      gr.addColorStop(0.35, `hsl(${210 + r() * 10}, 16%, ${44 + r() * 8}%)`);
      gr.addColorStop(1, `hsl(${30 + r() * 20}, 25%, ${30 + r() * 10}%)`);
      g.fillStyle = gr;
      g.fillRect(gx, gy, gw, gh);
      // 안쪽 진열: 밝은 사각형 몇 개 (선반·조명)
      const interior = r() < 0.8;
      if (interior) {
        for (let k = 0; k < 3 + Math.floor(r() * 4); k++) {
          g.fillStyle = `hsla(${30 + r() * 40}, 60%, ${55 + r() * 25}%, ${0.25 + r() * 0.3})`;
          const rw = gw * (0.08 + r() * 0.2);
          const rh = gh * (0.15 + r() * 0.4);
          g.fillRect(gx + r() * (gw - rw), gy + gh * 0.25 + r() * (gh * 0.6 - rh), rw, rh);
        }
        // 천장 조명 줄
        g.fillStyle = 'rgba(255,245,220,0.5)';
        for (let k = 0; k < 3; k++) g.fillRect(gx + gw * (0.15 + k * 0.3), gy + gh * 0.08, gw * 0.12, 4);
      }
      // 반사 하이라이트
      g.fillStyle = 'rgba(255,255,255,0.12)';
      g.beginPath();
      g.moveTo(gx + gw * 0.05, gy);
      g.lineTo(gx + gw * 0.3, gy);
      g.lineTo(gx + gw * 0.1, gy + gh);
      g.lineTo(gx, gy + gh * 0.7);
      g.closePath();
      g.fill();
      // 문: 오른쪽 또는 왼쪽
      const doorW = gw * 0.2;
      const dx = r() < 0.5 ? gx + gw - doorW - 10 : gx + 10;
      g.fillStyle = 'rgba(30,38,48,0.55)';
      g.fillRect(dx, gy + gh * 0.08, doorW, gh * 0.92);
      g.fillStyle = '#d6d9de';
      g.fillRect(dx + doorW / 2 - 2, gy + gh * 0.08, 4, gh * 0.92);
      g.fillStyle = '#b8bcc2';
      g.fillRect(dx + doorW * 0.72, gy + gh * 0.5, 4, gh * 0.12);
      // 틀
      g.strokeStyle = '#2b3542';
      g.lineWidth = 7;
      g.strokeRect(gx, gy, gw, gh);
      g.beginPath();
      for (let k = 1; k < 3; k++) {
        g.moveTo(gx + (gw * k) / 3, gy);
        g.lineTo(gx + (gw * k) / 3, gy + gh);
      }
      g.stroke();
      // 밤: 매장 안 불빛
      ge.fillStyle = interior && r() < 0.8 ? `hsl(${40 + r() * 20}, 80%, ${66 + r() * 10}%)` : '#141418';
      ge.fillRect(gx + 4, gy + 4, gw - 8, gh - 8);
      ge.fillStyle = 'rgba(0,0,0,0.4)';
      ge.fillRect(dx, gy + gh * 0.08, doorW, gh * 0.92);
    }
    // 간판 패널: 라이트박스(흰 바탕) 또는 색 패널, 테두리 프레임, 아래 그림자
    const [bg, fg] = SIGN_PALETTE[Math.floor(r() * SIGN_PALETTE.length)];
    const sx = x0 + 6;
    const sy = 6;
    const sW = sw - 12;
    const sH = bandH - 8;
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.fillRect(sx, sy + sH, sW, 6);
    const pg = g.createLinearGradient(0, sy, 0, sy + sH);
    pg.addColorStop(0, bg);
    pg.addColorStop(1, shade(bg, -0.18));
    g.fillStyle = pg;
    g.fillRect(sx, sy, sW, sH);
    g.strokeStyle = 'rgba(0,0,0,0.45)';
    g.lineWidth = 4;
    g.strokeRect(sx + 2, sy + 2, sW - 4, sH - 4);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.fillRect(sx, sy, sW, sH * 0.12);
    const word = SIGN_WORDS[Math.floor(r() * SIGN_WORDS.length)];
    const prefix = r() < 0.45 ? ['우리', '행복', '서울', '한강', '명품', '으뜸', '24시', '신사', '현대', '미래', '하나', '참'][Math.floor(r() * 12)] : '';
    const text = prefix ? `${prefix}${word}` : word;
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.font = `${text.length > 5 ? 50 : 62}px ${BOLD}`;
    g.fillText(text, sx + sW / 2, sy + sH * 0.5);
    if (r() < 0.5) {
      g.font = `20px ${KFONT}`;
      g.fillStyle = fg + 'bb';
      g.fillText(`${['02-', '']}${Math.floor(r() * 900) + 100}-${Math.floor(r() * 9000) + 1000}`, sx + sW * 0.8, sy + sH * 0.8);
    }
    // 밤 발광 (라이트박스)
    ge.fillStyle = bg;
    ge.fillRect(sx, sy, sW, sH);
    ge.fillStyle = fg;
    ge.font = g.font;
    ge.textAlign = 'center';
    ge.textBaseline = 'middle';
    ge.font = `${text.length > 5 ? 50 : 62}px ${BOLD}`;
    ge.fillText(text, sx + sW / 2, sy + sH * 0.5);
  }
  return { map: toTex(c), emissive: toTex(e), tileW: TILE_W, tileH: TILE_H };
}

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (v: number) => Math.max(0, Math.min(255, Math.round(v * (1 + k))));
  return `rgb(${f(n >> 16)}, ${f((n >> 8) & 255)}, ${f(n & 255)})`;
}

/** 사진 재료를 읽고 파사드 라이브러리를 만든다. 캔버스 수십 장이라 시작 화면에서 한 번 */
export async function buildFacadeLib(): Promise<FacadeLib> {
  const ids = new Set<string>([...WALLS.map((w) => w.id), ...EXTRA]);
  await Promise.all([...ids].map(loadImage));
  const low = Array.from({ length: 14 }, (_, i) => commercialFacade(i + 1, false));
  const block = Array.from({ length: 8 }, (_, i) => commercialFacade(i + 101, true));
  const apt = Array.from({ length: 6 }, (_, i) => aptFacade(i + 1));
  const store = Array.from({ length: 8 }, (_, i) => storeFacade(i + 1));
  return { low, block, apt, store };
}

/** 돌출 간판(세로, 1:4): 벽에서 직각으로 튀어나온 양면 간판. 글자를 위에서 아래로 */
export function vSignTexture(seed: number): THREE.CanvasTexture {
  const r = mulberry32(seed * 37 + 5);
  const W = 128;
  const H = 512;
  const [c, g] = canvas(W, H);
  const [bg, fg] = SIGN_PALETTE[Math.floor(r() * SIGN_PALETTE.length)];
  const pg = g.createLinearGradient(0, 0, W, 0);
  pg.addColorStop(0, shade(bg, -0.12));
  pg.addColorStop(0.5, bg);
  pg.addColorStop(1, shade(bg, -0.2));
  g.fillStyle = pg;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = 'rgba(0,0,0,0.45)';
  g.lineWidth = 6;
  g.strokeRect(3, 3, W - 6, H - 6);
  const word = SIGN_WORDS[Math.floor(r() * SIGN_WORDS.length)].replace(/\s/g, '').slice(0, 5);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const size = Math.min(78, Math.floor((H - 60) / word.length) - 6);
  g.font = `${size}px ${BOLD}`;
  const total = word.length * (size + 6);
  for (let i = 0; i < word.length; i++) g.fillText(word[i], W / 2, (H - total) / 2 + i * (size + 6) + size / 2);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}
