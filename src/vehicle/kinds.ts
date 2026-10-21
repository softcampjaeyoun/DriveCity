// 교통 차량 종류. 길이·폭은 충돌과 차간 거리 계산에 쓰인다

export type KindId = 'sedan' | 'taxi' | 'bus_trunk' | 'bus_branch' | 'bus_village' | 'bus_express' | 'rival' | 'police';

export interface VehicleKind {
  id: KindId;
  name: string;
  length: number;
  width: number;
  /** 일반 주행 속도 범위 m/s */
  cruise: [number, number];
  /** 교차로 회전 속도 m/s */
  turnSpeed: number;
  /** 차체 색 후보. 비어 있으면 호출 쪽에서 정한다 */
  colors: readonly number[];
  /** models.ts 의 MODELS 키 후보. 등록된 게 있으면 순서대로 돌아가며 외부 모델로 그린다 */
  models?: readonly string[];
  /** 외부 모델의 차체 재질에 colors 를 입힐지. 텍스처 기반 모델(Kenney)에는 효과가 없다 */
  tintModel?: boolean;
  /** 선호 차선. 0 = 안쪽(1차로), 1 = 바깥쪽(2차로) */
  lane?: 0 | 1;
}

export const KINDS: Record<KindId, VehicleKind> = {
  // 흰색·은색·검정 승용차가 대부분
  sedan: { id: 'sedan', name: '승용차', length: 4.1, width: 1.9, cruise: [8, 14], turnSpeed: 7, colors: [0xd9dce3, 0x9aa1ad, 0x23252c, 0x2c3e66, 0x6b1f24, 0xe7e2d6], models: ['sedan', 'suv', 'sedan_sports', 'van', 'hatchback', 'delivery'] },
  // 서울 해치택시 주황 + 은색 일반 택시
  taxi: { id: 'taxi', name: '택시', length: 4.4, width: 1.9, cruise: [10, 15], turnSpeed: 8, colors: [0xf08a24, 0xf08a24, 0xc9ccd3], models: ['taxi'] },
  // 시내버스: 파란 간선, 초록 지선
  bus_trunk: { id: 'bus_trunk', name: '간선버스', length: 11, width: 2.5, cruise: [7, 9], turnSpeed: 4.5, colors: [0x1f5fc8], models: ['city_bus'], tintModel: true, lane: 1 },
  bus_branch: { id: 'bus_branch', name: '지선버스', length: 11, width: 2.5, cruise: [7, 9], turnSpeed: 4.5, colors: [0x3faa4a], models: ['city_bus'], tintModel: true, lane: 1 },
  // 마을버스 (카운티급 소형)
  bus_village: { id: 'bus_village', name: '마을버스', length: 7, width: 2.2, cruise: [7, 10], turnSpeed: 5.5, colors: [0x2f9e44], models: ['village_bus'], tintModel: true, lane: 1 },
  // 빨간 광역버스
  bus_express: { id: 'bus_express', name: '광역버스', length: 12, width: 2.5, cruise: [9, 12], turnSpeed: 4.5, colors: [0xc8202c], models: ['express_bus'], tintModel: true, lane: 1 },
  rival: { id: 'rival', name: '라이벌', length: 4.3, width: 1.9, cruise: [13, 13], turnSpeed: 15, colors: [] },
  police: { id: 'police', name: '경찰', length: 4.4, width: 1.9, cruise: [10, 14], turnSpeed: 8, colors: [0xf1f3f7], models: ['police'] },
};
export const POLICE_COUNT = 3;

/** 교통 차량 구성. 합계가 전체 대수 */
export const TRAFFIC_MIX: ReadonlyArray<[KindId, number]> = [
  ['sedan', 20],
  ['taxi', 7],
  ['bus_trunk', 2],
  ['bus_branch', 2],
  ['bus_village', 2],
  ['bus_express', 1],
];

/** 길이에 맞춰 차체를 덮는 충돌 원들의 중심 오프셋 */
export function probesFor(length: number): number[] {
  const inset = 1.1;
  const span = Math.max(0, length / 2 - inset);
  const count = Math.max(2, Math.ceil(length / 2.6));
  const out: number[] = [];
  for (let i = 0; i < count; i++) out.push(-span + (2 * span * i) / (count - 1));
  return out;
}
