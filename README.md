# 미드나잇 시티 (driveCity)

격자형 도심 밤거리를 달리는 싱글플레이 웹 레이싱 프로토타입이에요. Three.js + TypeScript + Vite 로 만들어요.

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
| G | 차고 (정차 중에만) |
| R / C / M | 리셋 / 카메라 전환 / 소리 |

## 게임 루프

1. 파란 기둥 5곳 타임어택 → 완주 시 500 크레딧 (최고 기록 +300)
2. 라이벌(Lv1~3) 배틀 승리 → 800 / 1,600 / 3,200 크레딧
3. 차고에서 차량 구매, 엔진·타이어·서스펜션·부스터 튜닝, 도색·언더글로우 변경
4. 더 센 라이벌에게 도전

진행 상황은 브라우저 `localStorage` (`dc-save`) 에 저장돼요.

## 구조

```
src/
  config.ts          도시 격자, 보상 상수
  main.ts            초기화와 게임 루프
  input.ts           키보드·터치 입력
  audio.ts           합성 엔진음
  camera.ts          추적 카메라
  render/            렌더러, 캔버스 텍스처
  world/             도시 생성, 차선 경로, 체크포인트 마커
  vehicle/           플레이어 물리·모델, 차량 카탈로그·튜닝 스탯, 스키드
  ai/                일반 교통과 라이벌 AI
  game/              저장, 타임어택, 배틀
  ui/                HUD, 미니맵, 차고
```

밸런스는 `src/vehicle/stats.ts` (차량·부품), `src/ai/traffic.ts` (라이벌 속도·보상), `src/config.ts` (보상) 에서 조정해요.
