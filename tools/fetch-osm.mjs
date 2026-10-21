// Overpass API 에서 서울 일부 지역의 도로·건물·물·공원·지명을 받아 data/osm-raw.json 에 저장
// 사용: node tools/fetch-osm.mjs [south west north east]
// 넓은 영역은 약 2km 타일로 나눠 차례로 받고 합친다. 사내망처럼 인증서 폐기 확인이 막힌 환경을 위해 curl --ssl-no-revoke 로 받는다
// 주의: 이미 public/map/seoul.json 이 있으면 게임 실행에는 이 스크립트가 필요 없다. 다른 지역으로 바꿀 때만 쓴다
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const [south, west, north, east] = process.argv.slice(2).length === 4 ? process.argv.slice(2).map(Number) : [37.517, 126.998, 37.539, 127.028];
const kmLat = 110.574;
const kmLon = 111.32 * Math.cos((south * Math.PI) / 180);
const areaKm2 = ((north - south) * kmLat * (east - west) * kmLon).toFixed(1);

const HIGHWAY = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
const queryFor = (s, w, n, e) => `[out:json][timeout:180][bbox:${s},${w},${n},${e}];
(
  way[highway~"^(${HIGHWAY})$"];
  way[building];
  relation[building];
  way[natural=water];
  way[waterway=riverbank];
  relation[natural=water];
  relation[waterway=riverbank];
  way[leisure~"^(park|garden)$"];
  relation[leisure~"^(park|garden)$"];
  way[landuse~"^(grass|recreation_ground)$"];
  way[railway=rail];
  node[place];
  node[highway=traffic_signals];
);
out body;
>;
out skel qt;`;

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const ATTEMPT_TIMEOUT = 240;
const TILE_KM = 2.2;

mkdirSync('data', { recursive: true });
mkdirSync('data/tiles', { recursive: true });
writeFileSync('data/bbox.json', JSON.stringify({ south, west, north, east }));

// 타일 나누기
const nx = Math.max(1, Math.ceil(((east - west) * kmLon) / TILE_KM));
const nz = Math.max(1, Math.ceil(((north - south) * kmLat) / TILE_KM));
const tiles = [];
for (let i = 0; i < nx; i++) {
  for (let j = 0; j < nz; j++) {
    tiles.push({
      id: `${i}_${j}`,
      s: south + ((north - south) * j) / nz,
      n: south + ((north - south) * (j + 1)) / nz,
      w: west + ((east - west) * i) / nx,
      e: west + ((east - west) * (i + 1)) / nx,
    });
  }
}
console.log(`[fetch] 영역 ${south},${west} ~ ${north},${east} (약 ${areaKm2} km², 타일 ${tiles.length}개)`);
console.log('[fetch] Overpass 서버가 혼잡하면 타일마다 몇 분 걸릴 수 있어요. 받은 타일은 data/tiles/ 에 남겨 두고 다시 실행하면 이어서 받아요.');

function attempt(url, tile) {
  return new Promise((resolve, reject) => {
    const tmp = `data/tiles/${tile.id}.tmp`;
    const qf = `data/tiles/${tile.id}.overpassql`;
    writeFileSync(qf, queryFor(tile.s, tile.w, tile.n, tile.e));
    if (existsSync(tmp)) unlinkSync(tmp);
    const t0 = Date.now();
    const short = url.replace('https://', '').replace('/api/interpreter', '');
    process.stdout.write(`[fetch] 타일 ${tile.id} ← ${short}`);
    const child = spawn('curl', ['-sS', '--ssl-no-revoke', '-m', String(ATTEMPT_TIMEOUT), '-A', 'driveCity/1.0 (personal game project)', '-H', 'Accept: application/json', '-o', tmp, '--data-urlencode', `data@${qf}`, url]);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const tick = setInterval(() => process.stdout.write(` ${Math.round((Date.now() - t0) / 1000)}s`), 10_000);
    child.on('error', (e) => {
      clearInterval(tick);
      reject(new Error(`curl 실행 실패: ${e.message}`));
    });
    child.on('close', (code) => {
      clearInterval(tick);
      const secs = ((Date.now() - t0) / 1000).toFixed(0);
      try {
        if (code === 28) throw new Error(`${ATTEMPT_TIMEOUT}초 안에 응답이 없었어요 (서버 큐 대기)`);
        if (code !== 0) throw new Error(`curl ${code}: ${stderr.trim().slice(0, 120)}`);
        const text = readFileSync(tmp, 'utf8');
        if (!text.startsWith('{')) throw new Error(text.slice(0, 120).replace(/\s+/g, ' '));
        const json = JSON.parse(text);
        if (!json.elements) throw new Error('elements 없음');
        console.log(` ok (${secs}s, ${json.elements.length} 요소)`);
        resolve(json);
      } catch (e) {
        console.log(` 실패 (${secs}s): ${String(e.message ?? e).slice(0, 140)}`);
        reject(e);
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchTile(tile) {
  const out = `data/tiles/${tile.id}.json`;
  if (existsSync(out)) {
    console.log(`[fetch] 타일 ${tile.id} 이미 있음`);
    return JSON.parse(readFileSync(out, 'utf8'));
  }
  let delay = 20_000;
  for (let round = 0; round < 10; round++) {
    for (const url of MIRRORS) {
      try {
        const json = await attempt(url, tile);
        writeFileSync(out, JSON.stringify(json));
        return json;
      } catch {
        /* 다음 미러 */
      }
    }
    console.log(`[fetch] 모든 미러 실패. ${delay / 1000}초 뒤 다시 시도해요 (Ctrl+C 로 중단)`);
    await sleep(delay);
    delay = Math.min(delay * 2, 120_000);
  }
  throw new Error(`타일 ${tile.id} 수집 실패`);
}

// 타일을 모아 하나로 (같은 요소는 한 번만)
const seen = new Set();
const elements = [];
for (const tile of tiles) {
  const json = await fetchTile(tile);
  for (const el of json.elements) {
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) {
      // 태그 있는 버전이 나중에 오면 태그를 보탠다
      if (el.tags) {
        const prev = elements.find((p) => p.type === el.type && p.id === el.id);
        if (prev && !prev.tags) prev.tags = el.tags;
      }
      continue;
    }
    seen.add(key);
    elements.push(el);
  }
  // 타일 사이에 잠깐 쉬어 서버를 배려
  if (tiles.length > 1) await sleep(3000);
}
writeFileSync('data/osm-raw.json', JSON.stringify({ version: 0.6, elements }));
const kinds = {};
for (const e of elements) kinds[e.type] = (kinds[e.type] ?? 0) + 1;
console.log('[fetch] 저장: data/osm-raw.json', kinds);
console.log('[fetch] 다음: npm run map:build');
