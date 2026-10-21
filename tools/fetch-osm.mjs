// Overpass API 에서 서울 일부 지역의 도로·건물·물·공원·지명을 받아 data/osm-raw.json 에 저장
// 사용: node tools/fetch-osm.mjs [south west north east]
// 사내망처럼 인증서 폐기 확인이 막힌 환경을 위해 curl --ssl-no-revoke 로 받는다
// 주의: 이미 public/map/seoul.json 이 있으면 게임 실행에는 이 스크립트가 필요 없다. 다른 지역으로 바꿀 때만 쓴다
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';

// 기본 영역: 한남대교 남단 ~ 신사·압구정·논현 (약 2.6km × 2.4km)
const [south, west, north, east] = process.argv.slice(2).length === 4 ? process.argv.slice(2).map(Number) : [37.517, 126.998, 37.539, 127.028];
const areaKm2 = ((north - south) * 110.574 * (east - west) * 111.32 * Math.cos((south * Math.PI) / 180)).toFixed(1);

const HIGHWAY = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
const query = `[out:json][timeout:180][bbox:${south},${west},${north},${east}];
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

const MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
];
const ATTEMPT_TIMEOUT = 240; // 초. Overpass 큐가 길면 몇 분씩 기다리게 된다

mkdirSync('data', { recursive: true });
writeFileSync('data/query.overpassql', query);
writeFileSync('data/bbox.json', JSON.stringify({ south, west, north, east }));
const TMP = 'data/osm-raw.tmp';

console.log(`[fetch] 영역 ${south},${west} ~ ${north},${east} (약 ${areaKm2} km²)`);
console.log('[fetch] Overpass 서버가 혼잡하면 응답까지 몇 분 걸릴 수 있어요. 경과 시간을 10초마다 표시해요.');

function attempt(url) {
  return new Promise((resolve, reject) => {
    if (existsSync(TMP)) unlinkSync(TMP);
    const t0 = Date.now();
    const short = url.replace('https://', '').replace('/api/interpreter', '');
    process.stdout.write(`[fetch] ${short} 요청 중`);
    const child = spawn('curl', [
      '-sS', '--ssl-no-revoke', '-m', String(ATTEMPT_TIMEOUT), '-A', 'driveCity/1.0 (personal game project)', '-H', 'Accept: application/json',
      '-o', TMP, '--data-urlencode', 'data@data/query.overpassql', url,
    ]);
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
        const text = readFileSync(TMP, 'utf8');
        if (!text.startsWith('{')) throw new Error(text.slice(0, 120).replace(/\s+/g, ' '));
        const json = JSON.parse(text);
        if (!json.elements?.length) throw new Error('elements 비어 있음');
        console.log(` ok (${secs}s)`);
        resolve(json);
      } catch (e) {
        console.log(` 실패 (${secs}s): ${String(e.message ?? e).slice(0, 140)}`);
        reject(e);
      }
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let delay = 20_000;
for (let round = 0; round < 12; round++) {
  for (const url of MIRRORS) {
    try {
      const json = await attempt(url);
      writeFileSync('data/osm-raw.json', JSON.stringify(json));
      if (existsSync(TMP)) unlinkSync(TMP);
      const kinds = {};
      for (const e of json.elements) kinds[e.type] = (kinds[e.type] ?? 0) + 1;
      console.log('[fetch] 저장: data/osm-raw.json', kinds);
      console.log('[fetch] 다음: npm run map:build');
      process.exit(0);
    } catch {
      /* 다음 미러 */
    }
  }
  console.log(`[fetch] 모든 미러 실패. ${delay / 1000}초 뒤 다시 시도해요 (Ctrl+C 로 중단)`);
  await sleep(delay);
  delay = Math.min(delay * 2, 120_000);
}
console.error('[fetch] 모든 시도 실패. 잠시 뒤 다시 실행해 보세요.');
process.exit(1);
