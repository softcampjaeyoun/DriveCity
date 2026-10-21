# 미드나잇 시티 (driveCity)

실제 서울(OpenStreetMap) 도로 위를 달리는 싱글플레이 웹 레이싱 게임이에요. Three.js + TypeScript + Vite 로 만들어요.

| 한남대교 | 도산대로 골목 |
| --- | --- |
| ![한남대교](docs/screenshots/hannam-bridge.png) | ![도산대로](docs/screenshots/dosan-alley.png) |
| ![항공](docs/screenshots/aerial-hannam.png) | ![횡단보도](docs/screenshots/crosswalk.png) |

## 실행

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # 타입 검사 + 번들 (dist/)
npm run preview  # 빌드 결과 확인
```

## 조작

| 키 | 동작 |
| --- | --- |
| W / ↑, S / ↓ | 가속, 브레이크·후진 |
| A D / ← → | 조향 |
| Space | 핸드브레이크 (드리프트, 부스트 충전) |
| Shift | 부스트 |
| F | 상향등. 근처 라이벌에게 배틀 신청 |
| G | 차고 (정차 중, 수배·미션·배틀 중이 아닐 때) |
| X | 미션 포기 |
| N / V / K / T | 라디오 방송국 전환 / 화면 효과(블룸) / 날씨 전환 / 시간 4시간 넘기기 |
| Tab 또는 미니맵 클릭 | 전체 지도. 우클릭 드래그로 이동, 휠로 확대, 더블클릭 원위치, 좌클릭으로 닫기 |
| R / C / M | 리셋 / 카메라 전환 / 소리 |

## 도시: 실제 서울 (OpenStreetMap)

- 기본 지도는 **강남구·서초구 핵심(한남대교~강남역~테헤란로~반포)** 약 6.2km × 5.5km 예요. 도로 546km, 건물 약 3만 동. 도로망·차선 수·일방통행·다리·건물 높이·한강·공원·동네 이름·신호등 위치를 OSM 에서 가져와요.
- 외벽은 ambientCG CC0 사진 질감(유리·오피스·벽돌)과 절차 생성(한국식 아파트, 1층 상가, 한글 간판, 옥상 광고판), 나무는 Kenney 모델이에요. 햇빛 그림자와 필름 톤매핑을 써요.
- 7개 구 전체로 넓히는 계획은 `docs/streaming-plan.md` 에 있어요 (타일 스트리밍 필요).
- 중앙 황색 실선, 차선 점선, 신호 교차로의 정지선·횡단보도·신호등. 신호 없는 골목 교차로는 먼저 온 차가 지나가요.
- 저층 건물엔 네온 간판, 55m 넘는 건물엔 항공 장애등.
- 하루가 14분에 한 바퀴 돌아요(16시 시작). 낮엔 햇빛과 외벽, 노을엔 주황 하늘, 밤엔 창문·가로등·네온이 켜져요. T 로 시간을 넘길 수 있어요.
- 날씨가 2~3분마다 바뀌어요. 비가 오면 안개가 짙어지고 노면이 젖어요.

### 다른 지역으로 바꾸기

```bash
npm run map:fetch -- 37.490 127.000 37.540 127.070   # south west north east. 2.2km 타일로 나눠 받고, Overpass 가 바쁘면 알아서 재시도해요
npm run map:build                                     # data/osm-raw.json → public/map/seoul.json
```

영역이 넓을수록 건물과 교통량이 늘어 무거워져요. 3km × 3km 안쪽을 권해요. 사내망처럼 인증서 폐기 확인이 막힌 곳을 위해 `curl --ssl-no-revoke` 로 받아요.

## 교통

- 승용차 20, 택시 7, 간선·지선·마을·광역버스 7, 경찰 4, 라이벌 3.
- 신호를 지키고, 느린 차는 옆 차선이 비었을 때 추월하고, 우회전 전에는 바깥 차선으로 옮겨요. 버스는 바깥 차선을 선호해요.
- 라이벌과 추격 중인 경찰은 신호를 무시해요.

## 게임 루프

1. 파란 기둥 5곳 타임어택 → 완주 500 크레딧 (최고 기록 +300)
2. 초록 기둥(미션 거점 4곳)에서 미션: 퀵 배달, 택시 손님(충돌하면 만족도 하락), 스프린트 3구간. 거리에 따라 보상
3. 라이벌(Lv1~3) 배틀 승리 → 800 / 1,600 / 3,200 크레딧
4. 신호 위반·사고를 내면 수배 ★ 가 오르고 경찰이 쫓아와요. 경찰 옆에 멈추면 검거(벌금), 150m 이상 떨어져 10초 버티면 도주 성공(보너스)
5. 차고에서 차량 구매, 엔진·타이어·서스펜션·부스터 튜닝, 도색·언더글로우
6. 미션·배틀·도주로 XP 를 모아 레벨 업

진행 상황은 브라우저 `localStorage` (`dc-save`) 에 저장돼요.

## 구조

```
src/
  config.ts          도로 폭·차선, 보상 상수
  main.ts            초기화와 게임 루프, 신호 위반 감지
  input.ts           키보드·터치 입력
  audio.ts           합성 엔진음·사이렌
  radio.ts           WebAudio 로 만드는 라디오 두 방송국
  camera.ts          추적 카메라
  render/            렌더러(블룸), 캔버스 텍스처, 비
  world/             맵 파일 로더, 도로 그래프(다익스트라·공간 색인), 차선 경로·교차로 곡선, 건물 폴리곤 충돌, 도시 생성, 신호등, 마커
tools/
  fetch-osm.mjs      Overpass 에서 OSM 원본 받기
  build-map.mjs      원본 → 게임 맵 (도로 그래프 분할, 차선 추정, 건물 높이, 한강·공원 폴리곤 자르기)
  vehicle/           플레이어 물리·모델, 차종, 상자 모델, 외부 모델 로더, 차량 카탈로그·튜닝 스탯
  ai/                일반 교통·버스·라이벌·경찰 AI (차선 변경, 신호 준수, 추격)
  game/              저장(XP·설정), 타임어택, 배틀, 수배, 미션, 지명
  ui/                HUD, 미니맵, 차고
```

밸런스는 `src/vehicle/stats.ts` (차량·부품), `src/vehicle/kinds.ts` (교통 차종·대수), `src/ai/traffic.ts` (라이벌 속도·보상), `src/game/wanted.ts` (수배 열·벌금), `src/game/missions.ts` (미션 보상), `src/config.ts` (보상) 에서 조정해요.

## 3D 모델

교통 차량·경찰·라이벌은 `public/models/` 의 외부 모델(glb/fbx)로 그리고, 파일이 없으면 상자 모델로 돌아가요. 모델을 추가·교체하는 방법은 `public/models/README.md` 를 보세요.

- 승용차·택시·경찰·라이벌: [Kenney Car Kit](https://kenney.nl/assets/car-kit) (CC0)
- 버스: [Free Low Poly Vehicles Pack by Rgsdev](https://opengameart.org/content/free-low-poly-vehicles-pack) (CC0)

## 다음 후보

- 현대·기아 실제 차종 모델 (Sketchfab 등에서 받아 `public/models/` 에 넣기)
- 지하차도·고가(터널·bridge 레이어)의 높이 표현, 더 넓은 지역(강남 전체) 스트리밍
