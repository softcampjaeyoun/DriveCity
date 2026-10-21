// OSM 에서 버스 정류장·지하철역·상점·편의시설(POI) 만 따로 받아 data/pois-<bbox>.json 에 저장
// 사용: node tools/fetch-pois.mjs [south west north east]   (fetch-osm 과 같은 bbox 를 주면 build-map 이 알아서 읽는다)
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

const [south, west, north, east] = process.argv.slice(2).length === 4 ? process.argv.slice(2).map(Number) : [37.517, 126.998, 37.539, 127.028];
const kmLat = 110.574;
const kmLon = 111.32 * Math.cos((south * Math.PI) / 180);
const AMENITY = 'cafe|restaurant|fast_food|pharmacy|bank|hospital|clinic|dentist|school|kindergarten|university|library|police|fire_station|post_office|cinema|theatre|pub|bar|fuel|parking|bus_station|marketplace|community_centre|townhall|place_of_worship|veterinary';
const queryFor = (s, w, n, e) => `[out:json][timeout:120][bbox:${s},${w},${n},${e}];
(
  node[highway=bus_stop];
  node[railway=station];
  node[railway=subway_entrance];
  node[public_transport=station];
  node[shop];
  way[shop];
  node[amenity~"^(${AMENITY})$"];
  way[amenity~"^(${AMENITY})$"];
  node[tourism~"^(attraction|museum|hotel|viewpoint)$"];
  way[tourism~"^(attraction|museum|hotel)$"];
);
out center tags;`;

const MIRRORS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const TILE_KM = 4.4; // POI 는 가벼워서 큰 타일로
mkdirSync('data', { recursive: true });
const DIR = `data/pois/${south}_${west}_${north}_${east}`;
mkdirSync(DIR, { recursive: true });

const nx = Math.max(1, Math.ceil(((east - west) * kmLon) / TILE_KM));
const nz = Math.max(1, Math.ceil(((north - south) * kmLat) / TILE_KM));
const tiles = [];
for (let i = 0; i < nx; i++) for (let j = 0; j < nz; j++) tiles.push({ id: `${i}_${j}`, s: south + ((north - south) * j) / nz, n: south + ((north - south) * (j + 1)) / nz, w: west + ((east - west) * i) / nx, e: west + ((east - west) * (i + 1)) / nx });
console.log(`[pois] 영역 ${south},${west} ~ ${north},${east}, 타일 ${tiles.length}개`);

function attempt(url, tile) {
  return new Promise((resolve, reject) => {
    const tmp = `${DIR}/${tile.id}.tmp`;
    const qf = `${DIR}/${tile.id}.overpassql`;
    writeFileSync(qf, queryFor(tile.s, tile.w, tile.n, tile.e));
    if (existsSync(tmp)) unlinkSync(tmp);
    const t0 = Date.now();
    process.stdout.write(`[pois] 타일 ${tile.id} ← ${url.replace('https://', '').replace('/api/interpreter', '')}`);
    const child = spawn('curl', ['-sS', '--ssl-no-revoke', '-m', '180', '-A', 'driveCity/1.0 (personal game project)', '-H', 'Accept: application/json', '-o', tmp, '--data-urlencode', `data@${qf}`, url]);
    let stderr = '';
    child.stderr.on('data', (d) => (stderr += d));
    const tick = setInterval(() => process.stdout.write(` ${Math.round((Date.now() - t0) / 1000)}s`), 10_000);
    child.on('close', (code) => {
      clearInterval(tick);
      try {
        if (code !== 0) throw new Error(`curl ${code}: ${stderr.trim().slice(0, 100)}`);
        const text = readFileSync(tmp, 'utf8');
        if (!text.startsWith('{')) throw new Error(text.slice(0, 100).replace(/\s+/g, ' '));
        const json = JSON.parse(text);
        if (!json.elements) throw new Error('elements 없음');
        console.log(` ok (${json.elements.length} 개)`);
        resolve(json);
      } catch (e) {
        console.log(` 실패: ${String(e.message ?? e).slice(0, 120)}`);
        reject(e);
      }
    });
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchTile(tile) {
  const out = `${DIR}/${tile.id}.json`;
  if (existsSync(out)) return JSON.parse(readFileSync(out, 'utf8'));
  let delay = 15_000;
  for (let round = 0; round < 8; round++) {
    for (const url of MIRRORS) {
      try {
        const json = await attempt(url, tile);
        writeFileSync(out, JSON.stringify(json));
        return json;
      } catch {
        /* 다음 */
      }
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 90_000);
  }
  throw new Error(`타일 ${tile.id} 실패`);
}

const seen = new Set();
const pois = [];
const name = (t) => (t && (t['name:ko'] || t.name)) || '';
for (const tile of tiles) {
  const json = await fetchTile(tile);
  for (const el of json.elements) {
    const key = `${el.type}/${el.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = el.tags ?? {};
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat === undefined) continue;
    let kind = null;
    if (t.highway === 'bus_stop') kind = 'bus_stop';
    else if (t.railway === 'subway_entrance') kind = 'subway_entrance';
    else if (t.railway === 'station' || t.public_transport === 'station') kind = 'station';
    else if (t.shop) kind = 'shop';
    else if (t.amenity) kind = 'amenity';
    else if (t.tourism) kind = 'tourism';
    if (!kind) continue;
    pois.push({ kind, sub: t.shop || t.amenity || t.tourism || t.station || '', name: name(t), lat, lon, brand: t.brand || '' });
  }
}
writeFileSync(`data/pois-${south}_${west}_${north}_${east}.json`, JSON.stringify(pois));
const kinds = {};
for (const p of pois) kinds[p.kind] = (kinds[p.kind] ?? 0) + 1;
console.log(`[pois] 저장: data/pois-${south}_${west}_${north}_${east}.json`, kinds);
