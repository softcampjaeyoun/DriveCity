import * as THREE from 'three';
import './style.css';
import { createTraffic } from './ai/traffic.ts';
import { createAudio, type EngineAudio } from './audio.ts';
import { createChaseCamera } from './camera.ts';
import { coarse } from './config.ts';
import { createBattle } from './game/battle.ts';
import { createMissions, SPOTS } from './game/missions.ts';
import { createPedestrians } from './ai/pedestrians.ts';
import { createRun } from './game/run.ts';
import { addCredits, addXp, levelInfo, persist, save } from './game/save.ts';
import { CHASE_PACE, createWanted } from './game/wanted.ts';
import { IDLE, createInput } from './input.ts';
import { createRadio, type Radio } from './radio.ts';
import { createDaylight } from './render/daylight.ts';
import { createStage } from './render/scene.ts';
import { createWeather } from './render/weather.ts';
import { createBigMap } from './ui/bigmap.ts';
import { createGarage } from './ui/garage.ts';
import { placeName } from './game/places.ts';
import { createHud } from './ui/hud.ts';
import { createMinimap, type MapPoint } from './ui/minimap.ts';
import { createPerf } from './ui/perf.ts';
import { buildFacadeLib } from './render/facades.ts';
import { warmShaders } from './render/warmup.ts';
import { loadModel, MODELS } from './vehicle/models.ts';
import { createPlayer } from './vehicle/player.ts';
import { CARS, computeStats, emptyParts, partsLevel, type CarSpec, type CarStats } from './vehicle/stats.ts';
import { createCity, type TileScene } from './world/city.ts';
import { createCollisionWorld } from './world/collision.ts';
import { createFarTiles } from './world/far.ts';
import { createGraph, type Edge } from './world/graph.ts';
import { loadIndex, type TileData } from './world/mapdata.ts';
import { createMarker } from './world/markers.ts';
import { createSignals } from './world/signals.ts';
import { createTerrain } from './world/terrain.ts';
import { createTileManager } from './world/tiles.ts';

if (coarse) document.documentElement.classList.add('coarse');

const COLOR = { run: 0x4fd1ff, battle: 0xffae4a, mission: 0x5ce09a };
const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
const goBtn = document.getElementById('go') as HTMLButtonElement;
goBtn.disabled = true;
goBtn.textContent = '서울 지도를 불러오는 중…';

const canvas = document.getElementById('view') as HTMLCanvasElement;
const stage = createStage(canvas);
const { scene, camera } = stage;
const hud = createHud();
// 간판·광고판 글씨를 캔버스에 그리니 한글 웹폰트를 먼저 기다린다
await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 2500))]);
const index = await loadIndex();
const terrain = createTerrain(index);
const graph = createGraph(index, terrain);
const signals = createSignals(scene, graph);
goBtn.textContent = '건물 외벽을 만드는 중…';
const facadeLib = await buildFacadeLib();
const city = createCity(scene, index, stage.renderer, terrain, facadeLib);
const farTiles = createFarTiles(scene, index, terrain);
const world = createCollisionWorld(graph);
const minimap = createMinimap(document.getElementById('minimap') as HTMLCanvasElement, graph);
const pedestrians = createPedestrians(scene, {
  has: (n) => signals.has(n),
  walkState: (n, edgeId) => {
    const e = graph.edge(edgeId);
    return e ? signals.walkState(n, e) : 'green';
  },
  terrainAt: (x, z) => terrain.at(x, z),
});
// 타일이 들어오고 나갈 때 각 시스템에 알린다. traffic 은 아래에서 만들어지므로 늦게 묶는다.
// onTileAdd 는 제너레이터라 타일 관리자가 프레임마다 조금씩 돌린다
let onTileAdd: (key: string, tile: TileData) => Generator<string, void> = function* () {};
let onTileRemove: (key: string) => void = () => {};
const tiles = createTileManager(index, graph, {
  onAdd: (k, t) => onTileAdd(k, t),
  onRemove: (k) => onTileRemove(k),
  onFar: (k, t) => {
    terrain.add(k, t);
    farTiles.add(k, t);
  },
  onFarRemove: (k) => {
    farTiles.remove(k);
    terrain.remove(k);
  },
  onDetail: (k) =>
    (function* () {
      const obs = yield* city.buildExtras(k);
      if (obs) world.addExtras(`${k}#x`, obs);
    })(),
  onDetailRemove: (k) => {
    world.removeTile(`${k}#x`);
    city.removeExtras(k);
  },
});
goBtn.textContent = '주변 거리를 만드는 중…';
await tiles.warmup(index.start.x, index.start.z);
const player = createPlayer(scene, graph);
const perf = createPerf(stage.renderer);
const bigmap = createBigMap(document.getElementById('bigmap') as HTMLElement, graph, (x, z) => placeName(graph, graph.nearestNode(x, z)));
document.getElementById('mapwrap')!.addEventListener('click', () => bigmap.toggle());
const chase = createChaseCamera(camera, (x, z, r, y) => world.push({ x, z, r, y }, false));
const input = createInput();
const marker = createMarker(scene, COLOR.run);
const weather = createWeather(scene, city, (b, s) => hud.toast(b, s, 2.4));
const daylight = createDaylight(stage, (n) => {
  city.setNight(n);
  farTiles.setNight(n);
  pedestrians.setNight(n);
  traffic.setNight(n);
});
stage.setBloom(save.settings.fx);

let started = false;
let audio: EngineAudio | null = null;
let radio: Radio | null = null;
let flash = 0;
let carSpec: CarSpec = CARS[0];
let carStats: CarStats = computeStats(CARS[0], emptyParts());
let carLv = 0;
let lastModelCar = '';
let lastHit = 0;
let whereTimer = 0;
let roadName = '';
let placeLabel = '';

const toast = (b: string, s: string, secs?: number) => hud.toast(b, s, secs);
const run = createRun(graph, { toast, onBest: (t) => hud.setBest(t) });
const wanted = createWanted({
  toast,
  onBusted: (fine) => addCredits(-fine),
  onEscaped: (stars) => {
    addCredits(stars * 200);
    addXp(40 * stars);
  },
});
const traffic = createTraffic(scene, graph, signals, {
  onHit(n, impact) {
    lastHit = impact;
    // 내가 속도를 내고 들이받았을 때만 위반. 경찰이 나를 박은 건 세지 않는다
    if (impact < 4 || n.racing || Math.hypot(player.S.vx, player.S.vz) < 7) return;
    wanted.add(n.kind.id === 'police' ? 'hit_police' : 'hit_traffic');
  },
  onHorn(n, atPlayer) {
    const S = player.S;
    const d = Math.hypot(n.x - S.x, n.z - S.z);
    if (d > 90) return;
    // 내 차 기준 왼쪽·오른쪽으로 패닝
    const pan = ((n.x - S.x) * Math.cos(S.h) - (n.z - S.z) * Math.sin(S.h)) / Math.max(8, d);
    audio?.horn((atPlayer ? 1 : 0.7) / (1 + d / 25), pan);
  },
  onBusStop(n, stop) {
    // 정류장 대기소 ↔ 버스 문(차 오른쪽 가운데) 사이로 타고 내리는 사람
    const rx = Math.cos(n.h);
    const rz = -Math.sin(n.h);
    const doorX = n.x + rx * (n.kind.width / 2 + 0.7);
    const doorZ = n.z + rz * (n.kind.width / 2 + 0.7);
    const boarding = 1 + Math.floor(Math.random() * 3);
    const alighting = Math.floor(Math.random() * 3);
    pedestrians.transit(stop.x, stop.z, doorX, doorZ, boarding);
    pedestrians.transit(doorX, doorZ, stop.x + (stop.x - doorX) * 0.5, stop.z + (stop.z - doorZ) * 0.5, alighting);
  },
});
const battle = createBattle(graph, traffic, { toast, pauseRun: () => run.pause(), resumeRun: () => run.resume() });
const missions = createMissions(graph, { toast, onStart: () => run.pause(), onEnd: () => run.resume() });
const spotMarkers = Array.from({ length: SPOTS }, () => createMarker(scene, COLOR.mission, 2.5));

// 타일 ↔ 시스템 연결. 순서: 그래프(이미 들어감) → 신호 → 도시 → 충돌 → 미니맵 → 교통 → 보행자
const tileScenes = new Map<string, TileScene>();
onTileAdd = function* (key, tile) {
  // 지형은 그래프(노면 높이)보다 먼저 알아야 한다
  terrain.add(key, tile);
  const poles = signals.addTile(key, tile);
  yield 'signals';
  const ts = yield* city.buildTile(key, tile, graph, signals.has);
  tileScenes.set(key, ts);
  yield 'city-end';
  world.addTile(key, tile, [...ts.obstacles, ...poles.map(([x, z]) => ({ x, z, r: 0.16 }))]);
  yield 'collision';
  minimap.addTile(key, tile);
  const info = index.tiles.find((t) => t.i === tile.i && t.j === tile.j);
  traffic.addTile(key, info?.roadLen ?? 0, index.bbox.minX + (tile.i + 0.5) * index.tile, index.bbox.minZ + (tile.j + 0.5) * index.tile, ts.stops);
  pedestrians.addTile(key, ts);
};
onTileRemove = (key) => {
  pedestrians.removeTile(key);
  traffic.removeTile(key);
  minimap.removeTile(key);
  world.removeTile(key);
  city.removeTile(key);
  tileScenes.delete(key);
  signals.removeTile(key);
  terrain.remove(key);
};
// warmup 때 들어온 타일은 traffic 이 없어서 못 받았으니 지금 연결한다
for (const key of tiles.loaded) {
  const tile = tiles.tileData(key);
  if (tile) for (const _ of onTileAdd(key, tile)) void _;
}
const garage = createGarage(document.getElementById('garage') as HTMLElement, {
  onChange(spec, stats, car) {
    carSpec = spec;
    carStats = stats;
    carLv = partsLevel(car.parts);
    player.setPaint(car.paint);
    player.setGlow(car.glow);
    if (spec.id !== lastModelCar) {
      lastModelCar = spec.id;
      player.setModel(spec.model);
    }
  },
  onOpen: () => run.pause(),
  onClose: () => run.resume(),
});
hud.setBest(save.best);
// 셰이더 미리 컴파일: 처음 나타나는 재질(물리 도장 차, 지하철 표지, 경기장 …)마다 수십~수백 ms 멈추는 것을 시작 화면에서 미리 치른다
goBtn.textContent = '그래픽 준비 중…';
{
  const models = (await Promise.all(Object.keys(MODELS).map((id) => loadModel(id)))).filter((m): m is THREE.Group => !!m);
  await warmShaders(stage, [...city.warmMaterials(), { mat: pedestrians.material, inst: true, instColor: true }], models);
}
goBtn.disabled = false;
goBtn.textContent = '출발';

// ----- 입력 액션 -----
const canOpenGarage = () => started && !battle.active && !missions.active && wanted.stars === 0 && Math.hypot(player.S.vx, player.S.vz) < 1.5;
input.on('reset', () => {
  if (!garage.open) player.reset();
});
input.on('camera', () => chase.cycle());
input.on('mute', () => {
  const m = audio?.toggleMute();
  if (m !== undefined) toast(m ? '소리 끔' : '소리 켬', '', 1);
});
input.on('battle', () => {
  if (!started || garage.open || missions.active) return;
  flash = 1;
  battle.challenge(player.S);
});
input.on('garage', () => {
  if (garage.open) garage.hide();
  else if (canOpenGarage()) garage.show();
});
input.on('escape', () => garage.hide());
input.on('start', begin);
input.on('radio', () => radio?.next());
input.on('fx', () => {
  save.settings.fx = !save.settings.fx;
  persist();
  stage.setBloom(save.settings.fx);
  toast(save.settings.fx ? '화면 효과 켬' : '화면 효과 끔', '블룸(빛 번짐)·주변광 차폐', 1.2);
});
input.on('cancel', () => missions.cancel());
input.on('weather', () => weather.toggle());
input.on('map', () => bigmap.toggle());
input.on('perf', () => perf.toggle());
input.on('time', () => {
  daylight.skip(4);
  toast(`시간 ${daylight.label}`, '', 1);
});
goBtn.addEventListener('click', begin);

function begin(): void {
  if (started) return;
  started = true;
  document.getElementById('intro')!.hidden = true;
  chase.snap(player.S);
  audio ??= createAudio();
  audio?.resume();
  if (audio && !radio) {
    radio = createRadio(audio.ctx, audio.master, save.settings.radio, (name, station) => {
      save.settings.radio = station;
      persist();
      if (radio) toast(`라디오: ${name}`, '', 1.2);
    });
  }
  run.start(player.S);
}

// ----- 신호 위반 감지: 빨간불일 때 교차로 안으로 들어서면 -----
let insideNode = -1;
function checkRedLight(): void {
  const S = player.S;
  const n = graph.nearestNode(S.x, S.z);
  const [nx, nz] = graph.pos(n);
  let zone = 6;
  for (const e of graph.edgesAt(n)) zone = Math.max(zone, graph.cut(e, n));
  const inside = Math.hypot(S.x - nx, S.z - nz) < zone;
  if (!inside) {
    if (insideNode === n) insideNode = -1;
    return;
  }
  if (insideNode === n) return;
  insideNode = n;
  const speed = Math.hypot(S.vx, S.vz);
  if (speed < 4 || !signals.has(n)) return;
  // 진입한 길: 내 진행 방향과 가장 나란한 접근 간선
  let best = null as null | { e: Edge; dir: 1 | -1 };
  let bd = 0.5;
  for (const e of graph.edgesAt(n)) {
    const dir = graph.dirInto(e, n);
    if (!graph.canTravel(e, dir)) continue;
    const p = graph.pointAt(e, dir, e.len - 0.5);
    const dot = (p.hx * S.vx + p.hz * S.vz) / speed;
    if (dot > bd) {
      bd = dot;
      best = { e, dir };
    }
  }
  if (best && signals.state(n, best.e, best.dir) === 'red') wanted.add('redlight');
}

// 개발 모드 디버그 훅. 브라우저 콘솔이나 자동 테스트에서 상태를 들여다볼 때 쓴다
// debugCam 을 채우면 추적 카메라 대신 그 위치에서 본다 (항공 샷)
const dbg = { debugCam: null as null | { x: number; y: number; z: number; lx: number; ly?: number; lz: number } };
if (import.meta.env.DEV) {
  (window as unknown as { __dc: unknown }).__dc = { player, traffic, battle, run, garage, save, graph, signals, wanted, missions, weather, index, tiles, dbg, scene, world, camera, daylight, chase, city, tileScenes, pedestrians, stage, terrain };
}

// ----- 루프 -----
let last = performance.now();
function frame(now: number): void {
  const rawDt = (now - last) / 1000;
  const dt = Math.min(0.05, rawDt);
  last = now;
  const t = now / 1000;
  const S = player.S;
  const inp = started && !garage.open && !bigmap.open ? input.read() : IDLE;

  lastHit = 0;
  tiles.update(S.x, S.z);
  const r = player.step(dt, inp, carStats, world, () => traffic.collidePlayer(S));
  if (player.fell) {
    player.reset();
    toast('한강에 빠졌어요', '가까운 길로 돌아왔어요', 2);
  }
  player.applyVisual(r, inp, dt, camera);
  signals.update(t);
  const playerNode = graph.nearestNode(S.x, S.z);
  traffic.update(dt, S, (n) => battle.racePace(n, S), CHASE_PACE[wanted.stars]);
  pedestrians.update(dt, S);
  if (started) {
    checkRedLight();
    wanted.update(dt, S, traffic.police);
    traffic.setChase(wanted.stars ? Math.min(wanted.stars + 1, traffic.police.length) : 0, playerNode);
    missions.update(dt, S, player.crash, lastHit);
  }
  const bt = battle.update(S);
  run.update(now, S);
  weather.update(dt, camera);
  daylight.follow(S.x, S.z);
  daylight.update(dt, weather.raining);

  // 목표 지점: 미션 > 배틀 결승 > 타임어택 체크포인트
  const mt = missions.target;
  const target = mt ? { ...mt, color: COLOR.mission, label: '미션 목표' }
    : battle.active ? { x: battle.tx, z: battle.tz, color: COLOR.battle, label: '결승 지점' }
      : { x: run.tx, z: run.tz, color: COLOR.run, label: '다음 지점' };
  marker.setPosition(target.x, target.z, graph.posY(graph.nearestNode(target.x, target.z)));
  marker.setColor(target.color);
  marker.update(t);
  spotMarkers.forEach((m, i) => {
    const sp = missions.spots[i];
    if (sp) m.setPosition(sp.x, sp.z);
    m.setVisible(!!sp && !missions.active && sp.cool <= 0);
    m.update(t);
  });
  city.update(t);
  player.setFlash(flash);
  flash = Math.max(0, flash - dt * 3);

  // 지금 달리는 길·동네 (0.4초마다)
  whereTimer -= dt;
  if (whereTimer <= 0) {
    whereTimer = 0.4;
    const hit = graph.nearestEdge(S.x, S.z, 30);
    roadName = hit ? hit.e.name : '';
    placeLabel = placeName(graph, playerNode);
    if (placeLabel === roadName) placeLabel = '';
  }

  const dx = target.x - S.x;
  const dz = target.z - S.z;
  const fx = Math.sin(S.h);
  const fz = Math.cos(S.h);
  const span = carStats.vmax / 5;
  const gear = Math.min(5, Math.floor(Math.abs(r.vf) / span));
  const within = Math.min(1, (Math.abs(r.vf) - gear * span) / span);
  const cand = started && !battle.active && !missions.active ? traffic.nearbyRival(S) : null;
  const rivalSpec = battle.rival?.rival ?? null;
  let nearestPolice = Infinity;
  for (const p of traffic.police) if (p.police?.chasing) nearestPolice = Math.min(nearestPolice, Math.hypot(p.x - S.x, p.z - S.z));

  hud.frame({
    time: run.time,
    cp: run.cp,
    credits: save.credits,
    level: levelInfo(),
    kmh: Math.abs(r.vf) * 3.6,
    reverse: r.vf < -0.5,
    within,
    gear,
    nitro: S.nitro,
    dist: Math.hypot(dx, dz),
    angle: Math.atan2(-(dx * Math.cos(S.h) - dz * Math.sin(S.h)), dx * fx + dz * fz),
    navLabel: target.label,
    navColor: hex(target.color),
    battle: bt && rivalSpec ? { name: `${rivalSpec.name} Lv${rivalSpec.level}`, ...bt } : null,
    wanted: wanted.stars ? { stars: wanted.stars, bust: wanted.bustProgress, escape: wanted.escapeProgress } : null,
    mission: missions.active ? { title: missions.active.title, objective: missions.objective, time: missions.timeLeft, sat: missions.satisfaction } : null,
    promptName: cand?.rival ? cand.rival.name : null,
    garageHint: canOpenGarage() && !garage.open,
    drift: player.driftTimer > 0 && player.driftScore > 5 ? player.driftScore : null,
    carName: carSpec.name,
    carLv,
    maxKmh: carStats.nitroVmax * 3.6,
    rush: Math.max(0, Math.min(1, (Math.abs(r.vf) / carStats.vmax - 0.55) / 0.45)) * (r.boosting ? 1 : 0.6),
    road: roadName,
    place: placeLabel,
    status: started ? `${daylight.label} · ${weather.raining ? '비' : '맑음'} · 라디오 ${radio?.name ?? '꺼짐'} · 효과 ${stage.bloom ? '켬' : '끔'} · 타일 ${tiles.loaded.size}(상세 ${tiles.detailed.size})${tiles.loading ? ` (+${tiles.loading} 받는 중)` : ''}` : '',
  });
  hud.tick(dt);
  const extra: MapPoint[] = missions.spots.filter((sp) => sp.cool <= 0 && !missions.active).map((sp) => ({ x: sp.x, z: sp.z, color: hex(COLOR.mission), r: 3.5 }));
  const targetPoint = { x: target.x, z: target.z, color: hex(target.color) };
  minimap.draw(t, S, traffic.npcs, targetPoint, extra);
  bigmap.draw(t, S, traffic.npcs, targetPoint, extra);

  audio?.update(dt, 48 + within * 85 + gear * 9 + (inp.up ? 8 : 0), inp.up, r.drifting, wanted.stars > 0 && nearestPolice < 140);

  chase.update(dt, t, S, r.vf, carStats.vmax, started);
  if (dbg.debugCam) {
    const c = dbg.debugCam;
    camera.position.set(c.x, c.y, c.z);
    camera.lookAt(c.lx, c.ly ?? 0, c.lz);
    camera.fov = 55;
    camera.updateProjectionMatrix();
  }
  stage.render(dt);
  perf.frame(now, rawDt, { tilesLoaded: tiles.loaded.size, tilesLoading: tiles.loading, building: tiles.building, detailed: tiles.detailed.size, profile: tiles.profile, npcs: traffic.npcs.length, peds: pedestrians.stats().total });
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
