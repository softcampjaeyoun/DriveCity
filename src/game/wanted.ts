import type { Npc } from '../ai/traffic.ts';
import type { PlayerState } from '../vehicle/player.ts';

export type Violation = 'redlight' | 'hit_traffic' | 'hit_police' | 'speeding';

export interface WantedEvents {
  toast(big: string, sub: string, secs?: number): void;
  onBusted(fine: number): void;
  onEscaped(stars: number): void;
}

/** 수배 등급. 위반이 쌓이면 ★ 가 오르고 경찰이 쫓아온다 */
export interface Wanted {
  readonly heat: number;
  readonly stars: number;
  /** 검거 진행도 0..1 */
  readonly bustProgress: number;
  /** 도주 진행도 0..1 */
  readonly escapeProgress: number;
  add(v: Violation): void;
  update(dt: number, S: PlayerState, police: Npc[]): void;
  clear(): void;
}

const HEAT: Record<Violation, number> = { redlight: 42, hit_traffic: 22, hit_police: 40, speeding: 0 };
const LABEL: Record<Violation, string> = { redlight: '신호 위반', hit_traffic: '교통사고', hit_police: '공무집행 방해', speeding: '과속' };
export const MAX_STARS = 3;
export const CHASE_PACE = [0, 27, 35, 44];

export function createWanted(ev: WantedEvents): Wanted {
  let heat = 0;
  let stars = 0;
  let calm = 0; // 마지막 위반 후 지난 시간
  let bust = 0;
  let escape = 0;
  let starToast = 0;

  const starsOf = (h: number) => Math.min(MAX_STARS, Math.floor(h / 40));

  return {
    get heat() {
      return heat;
    },
    get stars() {
      return stars;
    },
    get bustProgress() {
      return bust / 2.5;
    },
    get escapeProgress() {
      return escape / 10;
    },

    add(v) {
      heat = Math.min(MAX_STARS * 40 + 39, heat + HEAT[v]);
      calm = 0;
      escape = 0;
      const s = starsOf(heat);
      if (s > stars) {
        stars = s;
        starToast = 1.5;
        ev.toast(`수배 ${'★'.repeat(stars)}${'☆'.repeat(MAX_STARS - stars)}`, `${LABEL[v]} · 경찰이 쫓아와요`, 2);
      }
    },

    update(dt, S, police) {
      calm += dt;
      if (starToast > 0) starToast -= dt;
      if (stars === 0) {
        heat = Math.max(0, heat - dt * 6);
        return;
      }
      const speed = Math.hypot(S.vx, S.vz);
      let nearest = Infinity;
      for (const p of police) if (p.police?.chasing) nearest = Math.min(nearest, Math.hypot(p.x - S.x, p.z - S.z));
      // 과속: 경찰 근처에서 150km/h 넘게 달리면 열이 오른다
      if (nearest < 50 && speed * 3.6 > 150) heat = Math.min(MAX_STARS * 40 + 39, heat + dt * 4);

      // 검거: 경찰이 바짝 붙고 내가 거의 멈춰 있으면
      if (nearest < 6.5 && speed < 5) bust += dt;
      else bust = Math.max(0, bust - dt * 0.8);
      if (bust >= 2.5) {
        const fine = Math.max(200, Math.round(stars * 150));
        ev.toast('검거됐어요', `벌금 ${fine.toLocaleString('ko-KR')} 크레딧`, 3);
        ev.onBusted(fine);
        heat = 0;
        stars = 0;
        bust = 0;
        escape = 0;
        return;
      }
      // 도주: 경찰과 150m 넘게 떨어진 채 10초
      if (nearest > 150 && calm > 4) escape += dt;
      else escape = Math.max(0, escape - dt * 0.5);
      if (escape >= 10) {
        ev.toast('추격을 따돌렸어요', `수배 해제 · 보너스 ${(stars * 200).toLocaleString('ko-KR')} 크레딧`, 3);
        ev.onEscaped(stars);
        heat = 0;
        stars = 0;
        escape = 0;
        bust = 0;
        return;
      }
      // 조용히 지내면 열이 천천히 내려 별이 줄어든다
      if (calm > 12) {
        heat = Math.max(0, heat - dt * 3);
        const s = starsOf(heat);
        if (s < stars) stars = s;
      }
    },

    clear() {
      heat = 0;
      stars = 0;
      bust = 0;
      escape = 0;
    },
  };
}
