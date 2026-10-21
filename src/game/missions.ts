import type { PlayerState } from '../vehicle/player.ts';
import type { Node, RoadGraph } from '../world/graph.ts';
import { placeName } from './places.ts';
import { addCredits, addXp } from './save.ts';

export type MissionType = 'delivery' | 'taxi' | 'sprint';

export interface MissionDef {
  type: MissionType;
  title: string;
  targets: Node[];
  timeLimit: number;
  reward: number;
  xp: number;
}

export interface MissionEvents {
  toast(big: string, sub: string, secs?: number): void;
  onStart(): void;
  onEnd(): void;
}

export interface MissionSpot {
  node: Node;
  x: number;
  z: number;
  /** 0 이면 열려 있음. 양수면 다시 열릴 때까지 남은 초 */
  cool: number;
}

export interface Missions {
  readonly spots: MissionSpot[];
  readonly active: MissionDef | null;
  readonly target: { x: number; z: number } | null;
  readonly timeLeft: number;
  /** 택시 미션 손님 만족도 0..100. 다른 미션은 null */
  readonly satisfaction: number | null;
  readonly objective: string;
  update(dt: number, S: PlayerState, crash: number, hit: number): void;
  cancel(): void;
}

const TYPE_NAME: Record<MissionType, string> = { delivery: '퀵 배달', taxi: '택시 손님', sprint: '스프린트' };

export function createMissions(g: RoadGraph, ev: MissionEvents): Missions {
  // 미션 거점 4곳: 강 남북 각 2곳, 서로 멀리
  const spots: MissionSpot[] = [];
  const candidates: Node[] = [
    [2, 1],
    [g.nx - 3, 2],
    [1, g.nz - 2],
    [g.nx - 2, g.nz - 3],
  ];
  for (const n of candidates) {
    const [x, z] = g.pos(n);
    spots.push({ node: n, x, z, cool: 0 });
  }

  let active: MissionDef | null = null;
  let idx = 0;
  let timeLeft = 0;
  let satisfaction: number | null = null;
  let lastSpot: MissionSpot | null = null;
  let typeCursor = 0;

  function farNode(from: Node, min: number, max: number): Node {
    let best = g.randomNode();
    for (let tries = 0; tries < 60; tries++) {
      const n = g.randomNode();
      const d = g.dist(from, n);
      if (d >= min && d <= max) return n;
      if (Math.abs(g.dist(from, best) - (min + max) / 2) > Math.abs(d - (min + max) / 2)) best = n;
    }
    return best;
  }

  function make(spot: MissionSpot): MissionDef {
    const type: MissionType = (['delivery', 'taxi', 'sprint'] as const)[typeCursor++ % 3];
    if (type === 'sprint') {
      const targets: Node[] = [];
      let from = spot.node;
      let total = 0;
      for (let k = 0; k < 3; k++) {
        const n = farNode(from, 160, 360);
        total += g.dist(from, n);
        targets.push(n);
        from = n;
      }
      return { type, title: '스프린트 3구간', targets, timeLimit: Math.round(total / 17 + 12), reward: Math.round(total * 1.6), xp: Math.round(total / 8) };
    }
    const n = farNode(spot.node, 260, 650);
    const d = g.dist(spot.node, n);
    const dest = placeName(g, n);
    if (type === 'taxi') {
      return { type, title: `손님: ${dest}까지`, targets: [n], timeLimit: Math.round(d / 13 + 20), reward: Math.round(d * 1.8 + 200), xp: Math.round(d / 6) };
    }
    return { type, title: `퀵 배달: ${dest}`, targets: [n], timeLimit: Math.round(d / 15 + 15), reward: Math.round(d * 1.4 + 200), xp: Math.round(d / 7) };
  }

  function finish(success: boolean, why: string): void {
    if (!active) return;
    const def = active;
    if (success) {
      const ratio = satisfaction === null ? 1 : Math.max(0.3, satisfaction / 100);
      const reward = Math.round((def.reward * ratio) / 10) * 10;
      const bonus = satisfaction !== null && satisfaction >= 90 ? Math.round(def.reward * 0.25) : 0;
      addCredits(reward + bonus);
      const lv = addXp(def.xp);
      ev.toast(
        `${TYPE_NAME[def.type]} 완료`,
        `+${(reward + bonus).toLocaleString('ko-KR')} 크레딧${bonus ? ' (팁 포함)' : ''} · +${def.xp} XP${lv ? ` · 레벨 ${lv} 달성!` : ''}`,
        3,
      );
    } else {
      ev.toast(`${TYPE_NAME[def.type]} 실패`, why, 2.6);
    }
    if (lastSpot) lastSpot.cool = 25;
    active = null;
    satisfaction = null;
    ev.onEnd();
  }

  return {
    spots,
    get active() {
      return active;
    },
    get target() {
      if (!active) return null;
      const [x, z] = g.pos(active.targets[idx]);
      return { x, z };
    },
    get timeLeft() {
      return timeLeft;
    },
    get satisfaction() {
      return satisfaction;
    },
    get objective() {
      if (!active) return '';
      const dest = placeName(g, active.targets[idx]);
      if (active.type === 'sprint') return `${idx + 1} / ${active.targets.length} 구간 · ${dest} 방면`;
      if (active.type === 'taxi') return `${dest}까지 손님을 안전하게`;
      return `${dest}에 물건 전달`;
    },

    update(dt, S, crash, hit) {
      for (const sp of spots) if (sp.cool > 0) sp.cool -= dt;
      if (!active) {
        const speed = Math.hypot(S.vx, S.vz);
        for (const sp of spots) {
          if (sp.cool > 0 || Math.hypot(sp.x - S.x, sp.z - S.z) > 8 || speed > 14) continue;
          active = make(sp);
          idx = 0;
          timeLeft = active.timeLimit;
          satisfaction = active.type === 'taxi' ? 100 : null;
          lastSpot = sp;
          ev.toast(active.title, `제한 ${active.timeLimit}초 · 보상 ${active.reward.toLocaleString('ko-KR')} 크레딧`, 2.6);
          ev.onStart();
          break;
        }
        return;
      }
      timeLeft -= dt;
      if (satisfaction !== null) {
        const impact = Math.max(crash, hit);
        if (impact > 3) satisfaction = Math.max(0, satisfaction - Math.min(25, impact * 1.2));
      }
      if (timeLeft <= 0) {
        finish(false, '시간이 다 됐어요');
        return;
      }
      const [tx, tz] = g.pos(active.targets[idx]);
      if (Math.hypot(tx - S.x, tz - S.z) < 9) {
        idx++;
        if (idx >= active.targets.length) finish(true, '');
        else ev.toast(`${idx} / ${active.targets.length} 구간 통과`, `${Math.ceil(timeLeft)}초 남음`, 1.2);
      }
    },

    cancel() {
      if (active) finish(false, '미션을 포기했어요');
    },
  };
}
