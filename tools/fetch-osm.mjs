// Overpass API 에서 서울 일부 지역의 도로·건물·물·공원·지명을 받아 data/osm-raw.json 에 저장
// 사용: node tools/fetch-osm.mjs [south west north east]
// 사내망처럼 인증서 폐기 확인이 막힌 환경을 위해 curl --ssl-no-revoke 로 받는다
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

// 기본 영역: 한남대교 남단 ~ 신사·압구정·논현 (약 2.6km × 2.4km)
const [south, west, north, east] = process.argv.slice(2).length === 4 ? process.argv.slice(2).map(Number) : [37.517, 126.998, 37.539, 127.028];

const HIGHWAY = 'motorway|trunk|primary|secondary|tertiary|unclassified|residential|living_street|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link';
const query = `[out:json][timeout:240][bbox:${south},${west},${north},${east}];
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

mkdirSync('data', { recursive: true });
writeFileSync('data/query.overpassql', query);
writeFileSync('data/bbox.json', JSON.stringify({ south, west, north, east }));
const TMP = 'data/osm-raw.tmp';

function attempt(url) {
  if (existsSync(TMP)) unlinkSync(TMP);
  const r = spawnSync(
    'curl',
    ['-sS', '--ssl-no-revoke', '-m', '420', '-A', 'driveCity/1.0 (personal game project)', '-H', 'Accept: application/json', '-o', TMP, '--data-urlencode', 'data@data/query.overpassql', url],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`curl ${r.status}: ${(r.stderr || '').trim().slice(0, 120)}`);
  const text = readFileSync(TMP, 'utf8');
  if (!text.startsWith('{')) throw new Error(text.slice(0, 120).replace(/\s+/g, ' '));
  const json = JSON.parse(text);
  if (!json.elements?.length) throw new Error('elements 비어 있음');
  return json;
}

let delay = 20_000;
for (let round = 0; round < 15; round++) {
  for (const url of MIRRORS) {
    const t0 = Date.now();
    try {
      process.stdout.write(`[fetch] ${url} ... `);
      const json = attempt(url);
      writeFileSync('data/osm-raw.json', JSON.stringify(json));
      unlinkSync(TMP);
      const kinds = {};
      for (const e of json.elements) kinds[e.type] = (kinds[e.type] ?? 0) + 1;
      console.log(`ok ${((Date.now() - t0) / 1000).toFixed(0)}s`, kinds, `bbox ${south},${west},${north},${east}`);
      process.exit(0);
    } catch (e) {
      console.log(`실패 (${((Date.now() - t0) / 1000).toFixed(0)}s): ${String(e.message ?? e).slice(0, 140)}`);
    }
  }
  console.log(`[fetch] ${delay / 1000}s 뒤 재시도`);
  const until = Date.now() + delay;
  while (Date.now() < until) spawnSync('node', ['-e', 'setTimeout(()=>{}, 5000)']);
  delay = Math.min(delay * 2, 120_000);
}
console.error('[fetch] 모든 시도 실패');
process.exit(1);
