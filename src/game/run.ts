import { BEST_BONUS, CHECKPOINTS, RUN_REWARD } from '../config.ts';
import type { PlayerState } from '../vehicle/player.ts';
import type { RoadGraph } from '../world/graph.ts';
import { fmtTime } from '../util/math.ts';
import { addCredits, addXp, persist, save } from './save.ts';

export interface RunEvents {
  toast(big: string, sub: string, secs?: number): void;
  onBest(time: number): void;
}

/** 체크포인트 5곳 타임어택. 자유 주행 중 항상 돌아간다 */
export interface Run {
  readonly active: boolean;
  readonly cp: number;
  readonly time: number;
  readonly tx: number;
  readonly tz: number;
  start(S: PlayerState): void;
  update(now: number, S: PlayerState): void;
  pause(): void;
  resume(): void;
}

export function createRun(g: RoadGraph, ev: RunEvents): Run {
  let active = false;
  let cp = 0;
  let startAt = 0;
  let time = 0;
  let tx = 0;
  let tz = 0;
  let pausedAt = 0;

  function pickTarget(S: PlayerState): void {
    let tries = 0;
    let n = g.randomNode();
    const far = () => Math.hypot(g.pos(n)[0] - S.x, g.pos(n)[1] - S.z);
    while ((far() < 220 || far() > 900) && tries++ < 60) n = g.randomNode();
    [tx, tz] = g.pos(n);
  }

  return {
    get active() {
      return active;
    },
    get cp() {
      return cp;
    },
    get time() {
      return time;
    },
    get tx() {
      return tx;
    },
    get tz() {
      return tz;
    },

    start(S) {
      active = true;
      cp = 0;
      startAt = performance.now();
      time = 0;
      pausedAt = 0;
      pickTarget(S);
    },

    update(now, S) {
      if (!active || pausedAt) return;
      time = (now - startAt) / 1000;
      if (Math.hypot(tx - S.x, tz - S.z) >= 10) return;
      cp++;
      if (cp < CHECKPOINTS) {
        ev.toast(`체크포인트 ${cp} / ${CHECKPOINTS}`, fmtTime(time), 1.2);
        pickTarget(S);
        return;
      }
      active = false;
      const isBest = !save.best || time < save.best;
      const reward = RUN_REWARD + (isBest ? BEST_BONUS : 0);
      if (isBest) {
        save.best = time;
        persist();
        ev.onBest(time);
      }
      addCredits(reward);
      addXp(30);
      ev.toast(
        fmtTime(time),
        `${isBest ? '최고 기록이에요' : `최고 기록 ${fmtTime(save.best)}`} · +${reward.toLocaleString('ko-KR')} 크레딧 · 3초 뒤 다시 시작해요`,
        3,
      );
      setTimeout(() => this.start(S), 3000);
    },

    pause() {
      if (!pausedAt) pausedAt = performance.now();
    },
    resume() {
      if (!pausedAt) return;
      startAt += performance.now() - pausedAt;
      pausedAt = 0;
    },
  };
}
