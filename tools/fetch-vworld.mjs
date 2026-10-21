// 국토부 V-World 건물통합정보(LT_C_SPBD)에서 건물 폴리곤·층수·이름을 받아 data/vworld-<bbox>.json 에 저장
// 사용: VWORLD_KEY=발급키 node tools/fetch-vworld.mjs [south west north east]
// 키 발급: https://www.vworld.kr → 회원가입 → 오픈API → 인증키 발급 (무료). 서버 요청이라 도메인은 아무거나 등록해도 된다
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const KEY = process.env.VWORLD_KEY;
// 개발키는 발급 때 등록한 서비스 URL 과 domain 이 같아야 통과한다 (예: www.drivecity.com)
const DOMAIN = process.env.VWORLD_DOMAIN ?? 'www.drivecity.com';
if (!KEY) {
  console.error('[vworld] VWORLD_KEY 환경변수가 필요해요. 예) $env:VWORLD_KEY="..."; $env:VWORLD_DOMAIN="www.drivecity.com"; node tools/fetch-vworld.mjs 37.44 126.95 37.575 127.18');
  process.exit(1);
}
const [south, west, north, east] = process.argv.slice(2).length === 4 ? process.argv.slice(2).map(Number) : [37.517, 126.998, 37.539, 127.028];
const kmLat = 110.574;
const kmLon = 111.32 * Math.cos((south * Math.PI) / 180);
const TILE_KM = 1.0; // 한 요청에 최대 1000건이라 작은 타일로 나누고 페이지를 넘긴다
const SIZE = 1000;
const DIR = `data/vworld/${south}_${west}_${north}_${east}`;
mkdirSync(DIR, { recursive: true });

const nx = Math.max(1, Math.ceil(((east - west) * kmLon) / TILE_KM));
const nz = Math.max(1, Math.ceil(((north - south) * kmLat) / TILE_KM));
const tiles = [];
for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) tiles.push({ id: `${i}_${j}`, s: south + ((north - south) * j) / nz, n: south + ((north - south) * (j + 1)) / nz, w: west + ((east - west) * i) / nx, e: west + ((east - west) * (i + 1)) / nx });
console.log(`[vworld] 영역 ${south},${west} ~ ${north},${east}, 타일 ${tiles.length}개 (타일당 최대 ${SIZE}건씩 페이지)`);

function get(url) {
  return new Promise((resolve, reject) => {
    const tmp = `${DIR}/_resp_${process.pid}.tmp`;
    if (existsSync(tmp)) unlinkSync(tmp);
    const child = spawn('curl', ['-sS', '--ssl-no-revoke', '-m', '120', '-A', 'driveCity/1.0', '-H', `Referer: http://${DOMAIN}/`, '-o', tmp, url]);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`curl ${code}: ${stderr.trim().slice(0, 120)}`));
      try {
        resolve(JSON.parse(readFileSync(tmp, 'utf8')));
      } catch (e) {
        reject(new Error(`JSON 아님: ${readFileSync(tmp, 'utf8').slice(0, 120)}`));
      }
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchTile(tile) {
  const out = `${DIR}/${tile.id}.json`;
  if (existsSync(out)) return JSON.parse(readFileSync(out, 'utf8'));
  const features = [];
  for (let page = 1; page <= 50; page++) {
    const params = new URLSearchParams({
      service: 'data',
      request: 'GetFeature',
      data: 'LT_C_SPBD',
      key: KEY,
      domain: DOMAIN,
      format: 'json',
      crs: 'EPSG:4326',
      geomFilter: `BOX(${tile.w},${tile.s},${tile.e},${tile.n})`,
      size: String(SIZE),
      page: String(page),
      geometry: 'true',
      attribute: 'true',
    });
    let json = null;
    for (let tries = 0; tries < 4 && !json; tries++) {
      try {
        json = await get(`https://api.vworld.kr/req/data?${params}`);
      } catch (e) {
        process.stdout.write(` (재시도: ${String(e.message).slice(0, 60)})`);
        await sleep(3000 * (tries + 1));
      }
    }
    if (!json) throw new Error(`타일 ${tile.id} 페이지 ${page} 실패`);
    const status = json.response?.status;
    if (status === 'NOT_FOUND') break;
    if (status !== 'OK') throw new Error(`응답 ${status}: ${JSON.stringify(json.response?.error ?? json).slice(0, 200)}`);
    const fc = json.response.result?.featureCollection;
    const feats = fc?.features ?? [];
    features.push(...feats);
    const total = Number(json.response.record?.total ?? 0);
    process.stdout.write(`[vworld] 타일 ${tile.id} 페이지 ${page}: ${feats.length} (누적 ${features.length}/${total})\n`);
    if (features.length >= total || feats.length < SIZE) break;
    await sleep(300);
  }
  writeFileSync(out, JSON.stringify(features));
  return features;
}

const pick = (props, re) => {
  for (const k of Object.keys(props)) if (re.test(k)) return props[k];
  return undefined;
};
const all = [];
for (const tile of tiles) {
  const feats = await fetchTile(tile);
  for (const f of feats) {
    const p = f.properties ?? {};
    const geom = f.geometry;
    if (!geom) continue;
    const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    for (const poly of polys) {
      const outer = poly[0];
      if (!outer || outer.length < 4) continue;
      all.push({
        ring: outer.map(([lon, lat]) => [lon, lat]),
        floors: Number(pick(p, /^(gro_flo_co|grnd_flr|ground_floor)/i) ?? 0) || 0,
        under: Number(pick(p, /^(und_flo_co|undgrnd_flr)/i) ?? 0) || 0,
        name: String(pick(p, /^(buld_nm|bld_nm)$/i) ?? '').trim(),
        // buld_nm_dc: "다가구용단독주택(9가구)", "아파트" 같은 용도 설명
        use: String(pick(p, /^(buld_nm_dc|bdtyp_cd|buld_use|bld_use)/i) ?? '').trim(),
        road: String(pick(p, /^rd_nm$/i) ?? '').trim(),
        height: Number(pick(p, /^(buld_hg|bld_hg|height)/i) ?? 0) || 0,
      });
    }
  }
  await sleep(200);
}
// 같은 건물이 타일 경계에서 두 번 나올 수 있어 첫 꼭짓점 기준으로 중복 제거
const seen = new Set();
const uniq = all.filter((b) => {
  const k = `${b.ring[0][0].toFixed(6)},${b.ring[0][1].toFixed(6)},${b.ring.length}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});
writeFileSync(`data/vworld-${south}_${west}_${north}_${east}.json`, JSON.stringify(uniq));
const withFloors = uniq.filter((b) => b.floors > 0).length;
const named = uniq.filter((b) => b.name).length;
console.log(`[vworld] 저장: data/vworld-${south}_${west}_${north}_${east}.json 건물 ${uniq.length} (층수 있음 ${withFloors}, 이름 있음 ${named})`);
