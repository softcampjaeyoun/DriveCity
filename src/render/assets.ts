import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { mulberry32 } from '../util/math.ts';

// ----- 외부 텍스처 (public/textures, ambientCG CC0) -----
const loader = new THREE.TextureLoader();
const texCache = new Map<string, THREE.Texture>();
const BASE = `${import.meta.env.BASE_URL}textures/`;

export function loadTex(file: string, srgb: boolean, repeatX = 1, repeatY = 1): THREE.Texture {
  const key = `${file}|${repeatX}|${repeatY}`;
  let t = texCache.get(key);
  if (t) return t;
  t = loader.load(BASE + file);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  texCache.set(key, t);
  return t;
}

/** 벽 UV 는 u = m/32, v = m/48. 타일 한 장이 가로 tileW m, 세로 tileH m 를 덮게 반복값을 정한다 */
export function wallRepeat(tileW: number, tileH: number): [number, number] {
  return [32 / tileW, 48 / tileH];
}

export interface FacadeSet {
  map: THREE.Texture;
  normalMap?: THREE.Texture;
  emissiveMap?: THREE.Texture;
}
export function facadeSet(id: string, tileW: number, tileH: number, hasEmission: boolean): FacadeSet {
  const [rx, ry] = wallRepeat(tileW, tileH);
  return {
    map: loadTex(`${id}_Color.jpg`, true, rx, ry),
    normalMap: loadTex(`${id}_NormalGL.jpg`, false, rx, ry),
    emissiveMap: hasEmission ? loadTex(`${id}_Emission.jpg`, true, rx, ry) : undefined,
  };
}

// ----- 절차 생성 캔버스 텍스처 -----
function canvas(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return [c, c.getContext('2d')!];
}
function toTex(c: HTMLCanvasElement, srgb = true, repeatX = 1, repeatY = 1): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.repeat.set(repeatX, repeatY);
  t.anisotropy = 8;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const KFONT = '"IBM Plex Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", sans-serif';
const BOLD = '"Black Han Sans", "IBM Plex Sans KR", "Malgun Gothic", sans-serif';

/** 상가 간판에 흔한 업종. 실제 상호는 쓰지 않는다 */
export const SIGN_WORDS = [
  '커피', '치킨', 'PC방', '노래방', '부동산', '학원', '약국', '편의점', '마트', '김밥천국', '피자', '호프', '정형외과', '치과', '네일', '헤어', '미용실',
  '세탁', '분식', '삼겹살', '국밥', '족발', '빵집', '꽃집', '안경', '휴대폰', '공인중개사', '태권도', '필라테스', '헬스', '당구장', '스크린골프', '떡볶이', '카페',
  '맥주', '곱창', '냉면', '칼국수', '순대국', '수학학원', '영어학원', '피부과', '내과', '한의원', '동물병원', '세차', '정비', '문구', '서점',
];
const SIGN_PALETTE: Array<[string, string]> = [
  ['#d93025', '#ffffff'], ['#1e3a8a', '#ffffff'], ['#0f766e', '#ffffff'], ['#f59e0b', '#1f1300'], ['#ffffff', '#1f2937'], ['#111827', '#fbbf24'],
  ['#7c3aed', '#ffffff'], ['#16a34a', '#ffffff'], ['#f3f4f6', '#b91c1c'], ['#0ea5e9', '#ffffff'], ['#fde68a', '#7c2d12'], ['#be185d', '#ffffff'],
];

/** 한글 간판 (가로 4:1). 낮엔 색판, 밤엔 같은 그림이 발광 */
export function signTexture(seed: number): THREE.CanvasTexture {
  const r = mulberry32(seed);
  const [c, g] = canvas(512, 128);
  const [bg, fg] = SIGN_PALETTE[Math.floor(r() * SIGN_PALETTE.length)];
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 506, 122);
  const word = SIGN_WORDS[Math.floor(r() * SIGN_WORDS.length)];
  const prefix = r() < 0.5 ? ['우리', '행복', '서울', '한강', '신사', '압구정', '논현', '미소', '해피', '명품', '으뜸', '24시'][Math.floor(r() * 12)] : '';
  const text = prefix ? `${prefix} ${word}` : word;
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${text.length > 6 ? 54 : 66}px ${BOLD}`;
  g.fillText(text, 256, 66);
  if (r() < 0.5) {
    g.font = `22px ${KFONT}`;
    g.fillText(`${Math.floor(r() * 5) + 2}층 · ${String(Math.floor(r() * 9000) + 1000)}-${String(Math.floor(r() * 9000) + 1000)}`, 256, 112);
  }
  return toTex(c);
}

/** 옥상 광고판 (5:2) */
export function billboardTexture(seed: number): THREE.CanvasTexture {
  const r = mulberry32(seed * 31 + 5);
  const [c, g] = canvas(640, 256);
  const [bg, fg] = SIGN_PALETTE[Math.floor(r() * SIGN_PALETTE.length)];
  const grd = g.createLinearGradient(0, 0, 640, 256);
  grd.addColorStop(0, bg);
  grd.addColorStop(1, '#00000055');
  g.fillStyle = bg;
  g.fillRect(0, 0, 640, 256);
  g.fillStyle = grd;
  g.fillRect(0, 0, 640, 256);
  const brands = ['미드나잇', '한강', '서울', '강남', '아리랑', '청운', '하나로', '새벽', '별빛', '달빛', '푸른', '태양'];
  const kinds = ['모터스', '증권', '아파트', '건설', '통신', '화장품', '보험', '전자', '제약', '커피', '맥주', '항공'];
  g.fillStyle = fg;
  g.textAlign = 'left';
  g.textBaseline = 'middle';
  g.font = `88px ${BOLD}`;
  g.fillText(`${brands[Math.floor(r() * brands.length)]} ${kinds[Math.floor(r() * kinds.length)]}`, 40, 110);
  g.font = `34px ${KFONT}`;
  g.fillStyle = fg + 'cc';
  g.fillText(['당신의 밤을 밝힙니다', '새로운 시작, 새로운 도시', '지금 분양 중', '더 빠르게, 더 멀리', '오늘도 안전운전'][Math.floor(r() * 5)], 44, 190);
  g.fillStyle = '#ffffff33';
  g.fillRect(0, 232, 640, 24);
  return toTex(c);
}

/** 아파트 동 번호판 */
export function dongTexture(n: number): THREE.CanvasTexture {
  const [c, g] = canvas(256, 256);
  g.fillStyle = 'rgba(0,0,0,0)';
  g.clearRect(0, 0, 256, 256);
  g.fillStyle = '#1f3a8a';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `150px ${BOLD}`;
  g.fillText(String(n), 128, 128);
  const t = toTex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** 한국식 판상형 아파트 외벽. 타일 = 가로 16m × 세로 24m (8층). 낮용과 밤 발광용 두 장 */
export function aptTextures(seed: number): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const r = mulberry32(seed * 17 + 3);
  const W = 512;
  const H = 768;
  const [c, g] = canvas(W, H);
  const [e, ge] = canvas(W, H);
  const base = ['#e9e4d8', '#ece8e0', '#dcd8cc', '#e6e2d4', '#d9d3c4'][Math.floor(r() * 5)];
  const accent = ['#2f6b9a', '#3a8a5a', '#b55a3a', '#5a6a9a', '#8a6a3a'][Math.floor(r() * 5)];
  g.fillStyle = base;
  g.fillRect(0, 0, W, H);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  const floorH = H / 8; // 3m
  const unitW = W / 4; // 4m: 거실창 + 방창 한 세대 절반
  // 측면 강조 띠
  g.fillStyle = accent;
  g.fillRect(0, 0, 22, H);
  g.fillRect(W - 22, 0, 22, H);
  for (let f = 0; f < 8; f++) {
    const y0 = H - (f + 1) * floorH;
    // 발코니 난간 띠
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(0, y0 + floorH - 10, W, 10);
    g.fillStyle = '#c9c4b6';
    g.fillRect(24, y0 + floorH * 0.62, W - 48, 6);
    for (let u = 0; u < 4; u++) {
      const x0 = u * unitW + 30;
      const lit = r() < 0.35;
      // 거실 창(넓음)과 방 창(좁음)
      const w1 = unitW * 0.55;
      const w2 = unitW * 0.22;
      const wy = y0 + floorH * 0.18;
      const wh = floorH * 0.42;
      g.fillStyle = `hsl(${205 + r() * 15}, 25%, ${30 + r() * 10}%)`;
      g.fillRect(x0, wy, w1, wh);
      g.fillRect(x0 + w1 + 10, wy, w2, wh);
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fillRect(x0 + w1 / 2 - 1, wy, 2, wh);
      ge.fillStyle = lit ? `hsl(${35 + r() * 15}, 90%, ${60 + r() * 15}%)` : '#000';
      ge.fillRect(x0, wy, w1, wh);
      ge.fillStyle = r() < 0.3 ? `hsl(${35 + r() * 15}, 90%, 65%)` : '#000';
      ge.fillRect(x0 + w1 + 10, wy, w2, wh);
    }
  }
  // 때 탄 느낌
  g.fillStyle = 'rgba(0,0,0,0.05)';
  for (let i = 0; i < 24; i++) g.fillRect(r() * W, r() * H, 2 + r() * 40, 1 + r() * 3);
  return { map: toTex(c, true, 2, 2), emissive: toTex(e, true, 2, 2) };
}

/** 1층 상가: 유리 매장 + 간판 띠. 타일 = 가로 12m × 세로 3.6m. 낮용과 밤 발광용 */
export function storefrontTextures(seed: number): { map: THREE.CanvasTexture; emissive: THREE.CanvasTexture } {
  const r = mulberry32(seed * 23 + 11);
  const W = 1024;
  const H = 308;
  const [c, g] = canvas(W, H);
  const [e, ge] = canvas(W, H);
  ge.fillStyle = '#000';
  ge.fillRect(0, 0, W, H);
  const shops = 3;
  const sw = W / shops;
  for (let s = 0; s < shops; s++) {
    const x0 = s * sw;
    const [bg, fg] = SIGN_PALETTE[Math.floor(r() * SIGN_PALETTE.length)];
    // 벽체(콘크리트 톤)
    g.fillStyle = '#9a948a';
    g.fillRect(x0, 0, sw, H);
    // 간판 띠 (위 0.8m)
    const bandH = H * 0.24;
    g.fillStyle = bg;
    g.fillRect(x0 + 4, 4, sw - 8, bandH);
    g.fillStyle = fg;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    const word = SIGN_WORDS[Math.floor(r() * SIGN_WORDS.length)];
    g.font = `${word.length > 4 ? 44 : 54}px ${BOLD}`;
    g.fillText(word, x0 + sw / 2, 4 + bandH / 2);
    ge.fillStyle = bg;
    ge.fillRect(x0 + 4, 4, sw - 8, bandH);
    ge.fillStyle = fg;
    ge.font = g.font;
    ge.textAlign = 'center';
    ge.textBaseline = 'middle';
    ge.fillText(word, x0 + sw / 2, 4 + bandH / 2);
    // 유리창
    const gy = bandH + 12;
    const gh = H - gy - 6;
    const glass = g.createLinearGradient(x0, gy, x0 + sw, gy + gh);
    glass.addColorStop(0, '#5f7a94');
    glass.addColorStop(0.5, '#9fb6cc');
    glass.addColorStop(1, '#4a5f78');
    g.fillStyle = glass;
    g.fillRect(x0 + 10, gy, sw - 20, gh);
    // 문
    g.fillStyle = '#3a4a5c';
    g.fillRect(x0 + sw * 0.62, gy + gh * 0.15, sw * 0.22, gh * 0.85);
    g.fillStyle = '#c9ced6';
    g.fillRect(x0 + sw * 0.62 + sw * 0.11 - 2, gy + gh * 0.15, 4, gh * 0.85);
    // 창문 프레임
    g.strokeStyle = '#2b3542';
    g.lineWidth = 6;
    g.strokeRect(x0 + 10, gy, sw - 20, gh);
    g.beginPath();
    g.moveTo(x0 + sw * 0.35, gy);
    g.lineTo(x0 + sw * 0.35, gy + gh);
    g.stroke();
    // 밤: 매장 안 불빛
    ge.fillStyle = r() < 0.75 ? `hsl(${40 + r() * 20}, 80%, 72%)` : '#1a1a22';
    ge.fillRect(x0 + 10, gy, sw - 20, gh);
    ge.fillStyle = 'rgba(0,0,0,0.35)';
    ge.fillRect(x0 + sw * 0.62, gy + gh * 0.15, sw * 0.22, gh * 0.85);
  }
  return { map: toTex(c), emissive: toTex(e) };
}

/** 차선 바닥 화살표 (직진 / 좌회전 / 우회전 / 직진+우회전). 세로로 긴 1:2.5 */
export function arrowTexture(kind: 'straight' | 'left' | 'right' | 'straightRight'): THREE.CanvasTexture {
  const [c, g] = canvas(128, 320);
  g.clearRect(0, 0, 128, 320);
  g.fillStyle = '#f0f2f6';
  const shaft = (x: number, y0: number, y1: number, w: number) => g.fillRect(x - w / 2, y0, w, y1 - y0);
  const head = (x: number, y: number, dirx: number, diry: number, size: number) => {
    g.beginPath();
    g.moveTo(x + dirx * size, y + diry * size);
    g.lineTo(x - diry * size * 0.75, y + dirx * size * 0.75);
    g.lineTo(x + diry * size * 0.75, y - dirx * size * 0.75);
    g.closePath();
    g.fill();
  };
  if (kind === 'straight' || kind === 'straightRight') {
    shaft(64, 70, 300, 18);
    head(64, 70, 0, -1, 44);
  }
  if (kind === 'left') {
    shaft(64, 120, 300, 18);
    g.fillRect(24, 111, 50, 18);
    head(24, 120, -1, 0, 40);
  }
  if (kind === 'right' || kind === 'straightRight') {
    const y = kind === 'right' ? 120 : 170;
    if (kind === 'right') shaft(64, y, 300, 18);
    g.fillRect(55, y - 9, 50, 18);
    head(104, y, 1, 0, 40);
  }
  const t = toTex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** 상호 간판 한 장을 512×128 기준 좌표로 그린다. 이름 해시로 색을 정해 같은 가게는 늘 같은 색 */
function drawShopName(g: CanvasRenderingContext2D, name: string, sub: string): void {
  let h = 7;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [bg, fg] = SIGN_PALETTE[h % SIGN_PALETTE.length];
  g.fillStyle = bg;
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = 'rgba(0,0,0,0.25)';
  g.lineWidth = 6;
  g.strokeRect(3, 3, 506, 122);
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const text = name.length > 12 ? name.slice(0, 12) : name;
  g.font = `${text.length > 8 ? 44 : text.length > 5 ? 56 : 66}px ${BOLD}`;
  g.fillText(text, 256, sub ? 54 : 64);
  if (sub) {
    g.font = `22px ${KFONT}`;
    g.fillStyle = fg + 'cc';
    g.fillText(sub, 256, 104);
  }
}

/** 실제 상호 간판 (4:1) 낱장 */
export function shopNameTexture(name: string, sub = ''): THREE.CanvasTexture {
  const [c, g] = canvas(512, 128);
  drawShopName(g, name, sub);
  const t = toTex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

export interface SignAtlas {
  /** i 번째 칸에 간판 하나를 그린다. 칸 수백 개를 한 번에 그리면 수십 ms 라 호출 쪽에서 나눠 부른다 */
  draw(i: number, name: string, sub: string): void;
  /** 다 그린 뒤 텍스처로. 한 번만 */
  finish(): THREE.CanvasTexture;
  /** i 번째 칸의 [u0, v0, u1, v1] (v0 아래, v1 위) */
  uv(i: number): [number, number, number, number];
}
/** 타일 하나의 상호 간판을 192×48 칸 count 개(최대 256)로 한 장에 모은다 (가게마다 텍스처를 따로 올리면 첫 프레임이 멈칫한다). 1536² 까지 */
export function shopNameAtlas(count: number): SignAtlas {
  const COLS = 8;
  const CW = 192;
  const CH = 48;
  const rows = Math.max(1, Math.ceil(Math.min(count, 256) / COLS));
  const H = rows * CH;
  const [c, g] = canvas(COLS * CW, H);
  return {
    draw(i, name, sub) {
      g.save();
      g.translate((i % COLS) * CW, Math.floor(i / COLS) * CH);
      g.scale(CW / 512, CH / 128);
      drawShopName(g, name, sub);
      g.restore();
    },
    finish() {
      const texture = toTex(c);
      texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
      return texture;
    },
    uv(i) {
      const col = i % COLS;
      const row = Math.floor(i / COLS);
      // 캔버스는 위가 0 이지만 텍스처(flipY)는 아래가 0. 칸 테두리가 섞이지 않게 2px 안쪽을 쓴다
      const u0 = (col * CW + 2) / (COLS * CW);
      const u1 = ((col + 1) * CW - 2) / (COLS * CW);
      const v1 = 1 - (row * CH + 2) / H;
      const v0 = 1 - ((row + 1) * CH - 2) / H;
      return [u0, v0, u1, v1];
    },
  };
}

/** 지하철 출입구·역 표지 (초록 바탕, 2:1) */
export function subwaySignTexture(name: string): THREE.CanvasTexture {
  const [c, g] = canvas(256, 128);
  g.fillStyle = '#1b7f4a';
  g.fillRect(0, 0, 256, 128);
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.arc(40, 64, 24, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#1b7f4a';
  g.font = `bold 30px ${KFONT}`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('M', 40, 65);
  g.fillStyle = '#ffffff';
  g.textAlign = 'left';
  g.font = `${name.length > 5 ? 30 : 38}px ${BOLD}`;
  g.fillText(name || '지하철', 76, 64);
  const t = toTex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** 업종 영문 태그 → 한글 */
export const SUB_KO: Record<string, string> = {
  convenience: '편의점', supermarket: '마트', bakery: '베이커리', clothes: '의류', hairdresser: '미용실', beauty: '뷰티', cafe: '카페', restaurant: '음식점', fast_food: '패스트푸드',
  pharmacy: '약국', bank: '은행', hospital: '병원', clinic: '의원', dentist: '치과', school: '학교', kindergarten: '유치원', university: '대학교', library: '도서관', police: '경찰서',
  fire_station: '소방서', post_office: '우체국', cinema: '영화관', theatre: '극장', pub: '호프', bar: '바', fuel: '주유소', parking: '주차장', bus_station: '버스터미널', marketplace: '시장',
  community_centre: '주민센터', townhall: '구청', place_of_worship: '교회', veterinary: '동물병원', mobile_phone: '휴대폰', electronics: '전자제품', jewelry: '보석', optician: '안경',
  books: '서점', stationery: '문구', furniture: '가구', car: '자동차', car_repair: '정비', florist: '꽃집', butcher: '정육점', alcohol: '주류', chemist: '드러그스토어', cosmetics: '화장품',
  department_store: '백화점', mall: '쇼핑몰', hotel: '호텔', museum: '박물관', attraction: '명소', gym: '헬스', fitness_centre: '헬스', laundry: '세탁', travel_agency: '여행사',
};

/** 도로명 표지판 (초록 바탕 흰 글씨, 4:1) */
export function streetSignTexture(name: string): THREE.CanvasTexture {
  const [c, g] = canvas(512, 128);
  g.fillStyle = '#2c7a3c';
  g.fillRect(0, 0, 512, 128);
  g.strokeStyle = '#ffffff';
  g.lineWidth = 6;
  g.strokeRect(6, 6, 500, 116);
  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `${name.length > 7 ? 52 : 64}px ${BOLD}`;
  g.fillText(name, 256, 60);
  const t = toTex(c);
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

/** 구름 레이어 (알파) */
export function cloudTexture(): THREE.CanvasTexture {
  const r = mulberry32(777);
  const S = 512;
  const [c, g] = canvas(S, S);
  const img = g.createImageData(S, S);
  // 값 노이즈 몇 옥타브
  const grid = (n: number) => {
    const a = new Float32Array(n * n);
    for (let i = 0; i < a.length; i++) a[i] = r();
    return a;
  };
  const octs = [8, 16, 32, 64].map((n) => ({ n, a: grid(n) }));
  const sample = (a: Float32Array, n: number, x: number, y: number) => {
    const fx = (x / S) * n;
    const fy = (y / S) * n;
    const x0 = Math.floor(fx) % n;
    const y0 = Math.floor(fy) % n;
    const x1 = (x0 + 1) % n;
    const y1 = (y0 + 1) % n;
    const tx = fx - Math.floor(fx);
    const ty = fy - Math.floor(fy);
    const sx = tx * tx * (3 - 2 * tx);
    const sy = ty * ty * (3 - 2 * ty);
    const v00 = a[y0 * n + x0];
    const v10 = a[y0 * n + x1];
    const v01 = a[y1 * n + x0];
    const v11 = a[y1 * n + x1];
    return (v00 * (1 - sx) + v10 * sx) * (1 - sy) + (v01 * (1 - sx) + v11 * sx) * sy;
  };
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      let v = 0;
      let amp = 0.5;
      let tot = 0;
      for (const o of octs) {
        v += sample(o.a, o.n, x, y) * amp;
        tot += amp;
        amp *= 0.5;
      }
      v /= tot;
      const alpha = Math.max(0, Math.min(1, (v - 0.5) * 3.2));
      const i = (y * S + x) * 4;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 255;
      img.data[i + 3] = alpha * 255;
    }
  }
  g.putImageData(img, 0, 0);
  return toTex(c, true, 4, 4);
}

// ----- glb 를 인스턴싱용 단일 지오메트리로 -----
const gltf = new GLTFLoader();
export interface MergedModel {
  geometry: THREE.BufferGeometry;
  materials: THREE.Material[];
}
/** glb 의 모든 메시를 월드 변환까지 구워 하나로 합친다. 재질은 그룹으로 유지 */
export async function loadMerged(url: string, recolor?: (m: THREE.MeshStandardMaterial) => void): Promise<MergedModel | null> {
  try {
    const g = await gltf.loadAsync(url);
    return mergeObject(g.scene, recolor);
  } catch (e) {
    console.warn('[assets] 모델 로드 실패', url, e);
    return null;
  }
}

/** 오브젝트 트리의 모든 메시를 월드 변환 기준으로 하나의 지오메트리로. 그리기 호출을 줄인다 */
export function mergeObject(root: THREE.Object3D, recolor?: (m: THREE.MeshStandardMaterial) => void): MergedModel | null {
  {
    root.updateMatrixWorld(true);
    const geos: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const geo = mesh.geometry.clone().applyMatrix4(mesh.matrixWorld);
      // 합치기 위해 속성을 position/normal/uv 로 맞춘다
      for (const name of Object.keys(geo.attributes)) if (!['position', 'normal', 'uv'].includes(name)) geo.deleteAttribute(name);
      if (!geo.attributes.uv) geo.setAttribute('uv', new THREE.Float32BufferAttribute(new Float32Array((geo.attributes.position.count) * 2), 2));
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (mats.length > 1 && geo.groups.length) {
        // 그룹별로 쪼갠다
        for (const grp of geo.groups) {
          const sub = new THREE.BufferGeometry();
          const idx = geo.index!;
          const arr = idx.array.slice(grp.start, grp.start + grp.count) as unknown as number[];
          sub.setAttribute('position', geo.attributes.position);
          sub.setAttribute('normal', geo.attributes.normal);
          sub.setAttribute('uv', geo.attributes.uv);
          sub.setIndex(Array.from(arr));
          geos.push(sub.toNonIndexed());
          materials.push(mats[grp.materialIndex ?? 0]);
        }
      } else {
        geos.push(geo.index ? geo.toNonIndexed() : geo);
        materials.push(mats[0]);
      }
    });
    if (!geos.length) return null;
    const merged = mergeGeometries(geos, true);
    if (!merged) return null;
    const unique = [...new Set(materials)];
    for (const m of unique) if ((m as THREE.MeshStandardMaterial).isMeshStandardMaterial && recolor) recolor(m as THREE.MeshStandardMaterial);
    // 그룹의 materialIndex 를 고유 재질 배열 기준으로
    merged.groups.forEach((grp, i) => (grp.materialIndex = unique.indexOf(materials[i])));
    return { geometry: merged, materials: unique };
  }
}
