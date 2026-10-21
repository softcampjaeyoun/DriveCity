import { N, roadAt } from '../config.ts';
import type { Npc, Traffic } from '../ai/traffic.ts';
import type { PlayerState } from '../vehicle/player.ts';
import { routeTo } from '../world/roads.ts';
import { clamp, josa, rint } from '../util/math.ts';
import { addCredits } from './save.ts';

export interface BattleEvents {
  toast(big: string, sub: string, secs?: number): void;
  /** 배틀 시작/종료 시 타임어택 타이머를 멈추고 다시 재개 */
  pauseRun(): void;
  resumeRun(): void;
}

export interface Battle {
  readonly active: boolean;
  readonly rival: Npc | null;
  readonly tx: number;
  readonly tz: number;
  challenge(S: PlayerState): boolean;
  /** 매 프레임. 플레이어/라이벌 결승 거리 반환 */
  update(S: PlayerState): { pd: number; rd: number } | null;
  racePace(n: Npc, S: PlayerState): number;
}

export function createBattle(traffic: Traffic, ev: BattleEvents): Battle {
  let active = false;
  let rival: Npc | null = null;
  let tx = 0;
  let tz = 0;

  function end(win: boolean): void {
    if (!rival?.rival) return;
    const spec = rival.rival;
    if (win) {
      addCredits(spec.reward);
      ev.toast('배틀 승리', `${spec.name}${josa(spec.name, '을', '를')} 이겼어요 · +${spec.reward.toLocaleString('ko-KR')} 크레딧`, 2.8);
    } else {
      ev.toast('배틀 패배', `${spec.name}${josa(spec.name, '이', '가')} 먼저 도착했어요`, 2.8);
    }
    rival.racing = false;
    rival.route = [];
    rival.cool = 15;
    active = false;
    rival = null;
    ev.resumeRun();
  }

  return {
    get active() {
      return active;
    },
    get rival() {
      return rival;
    },
    get tx() {
      return tx;
    },
    get tz() {
      return tz;
    },

    challenge(S) {
      if (active) return false;
      const r = traffic.nearbyRival(S);
      if (!r?.rival) return false;
      let i = 0;
      let j = 0;
      let d = 0;
      let tries = 0;
      do {
        i = rint(N + 1);
        j = rint(N + 1);
        d = Math.hypot(roadAt(i) - S.x, roadAt(j) - S.z);
        tries++;
      } while ((d < 260 || d > 480) && tries < 80);
      active = true;
      rival = r;
      tx = roadAt(i);
      tz = roadAt(j);
      r.racing = true;
      r.route = routeTo(r.to, [i, j]);
      ev.pauseRun();
      ev.toast(`VS ${r.rival.name} Lv${r.rival.level}`, '주황 기둥에 먼저 도착하면 이겨요', 2.2);
      return true;
    },

    update(S) {
      if (!active || !rival) return null;
      const pd = Math.hypot(tx - S.x, tz - S.z);
      const rd = Math.hypot(tx - rival.x, tz - rival.z);
      if (pd < 10) end(true);
      else if (rd < 10) end(false);
      return { pd, rd };
    },

    // 고무줄: 플레이어가 뒤처지면 늦추고 앞서면 빨라진다
    racePace(n, S) {
      if (!n.rival) return 0;
      const pd = Math.hypot(tx - S.x, tz - S.z);
      const rd = Math.hypot(tx - n.x, tz - n.z);
      const base = n.rival.pace;
      return clamp(base - (pd - rd) * 0.06, base * 0.72, base * 1.25);
    },
  };
}
