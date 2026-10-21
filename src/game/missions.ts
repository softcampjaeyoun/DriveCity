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
  // 미션 거점: 지도 네 구역의 중심에 가까운 큰 교차로
  const { minX, maxX, minZ, maxZ } = g.bbox;
  const spots: MissionSpot[] = [];
  for (const [fx, fz] of [
    [0.28, 0.28],
    [0.72, 0.3],
    [0.3, 0.72],
    [0.7, 0.7],
  ]) {
    const cx = minX + (maxX - minX) * fx;
    const cz = minZ + (maxZ - minZ) * fz;
    let best = g.majorNodes[0];
    let bd = Infinity;
    for (const n of g.majorNodes) {
      const [x, z] = g.pos(n);
      const d = Math.hypot(x - cx, z - cz);
      if (d < bd && spots.every((s) => Math.hypot(s.x - x, s.z - z) > 300)) {
        bd = d;
        best = n;
      }
    }
    const [x, z] = g.pos(best);
    spots.push({ node: best, x, z, cool: 0 });
  }

  let active: MissionDef | null = null;
  let idx = 0;
  let timeLeft = 0;
  let satisfaction: number | null = null;
  let lastSpot: MissionSpot | null = null;
  let typeCursor = 0;

  /** 직선 거리로 후보를 추리고 그래프 거리로 확정 */
  function farNode(from: Node, min: number, max: number): { node: Node; d: number } {
    const [fx, fz] = g.pos(from);
    const cands: Node[] = [];
    for (let tries = 0; tries < 80 && cands.length < 6; tries++) {
      const n = g.randomNode();
      const d = Math.hypot(g.pos(n)[0] - fx, g.pos(n)[1] - fz);
      if (d >= min * 0.7 && d <= max * 0.95 && n !== from) cands.push(n);
    }
    let best: { node: Node; d: number } | null = null;
    for (const n of cands) {
      const d = g.dist(from, n);
      if (!Number.isFinite(d)) continue;
      const ok = d >= min && d <= max;
      if (!best || (ok && !(best.d >= min && best.d <= max)) || (ok === (best.d >= min && best.d <= max) && Math.abs(d - (min + max) / 2) < Math.abs(best.d - (min + max) / 2))) best = { node: n, d };
    }
    if (best) return best;
    const n = g.randomNode();
    return { node: n, d: Math.hypot(g.pos(n)[0] - fx, g.pos(n)[1] - fz) * 1.3 };
  }

  function make(spot: MissionSpot): MissionDef {
    const type: MissionType = (['delivery', 'taxi', 'sprint'] as const)[typeCursor++ % 3];
    if (type === 'sprint') {
      const targets: Node[] = [];
      let from = spot.node;
      let total = 0;
      for (let k = 0; k < 3; k++) {
        const { node, d } = farNode(from, 200, 450);
        total += d;
        targets.push(node);
        from = node;
      }
      return { type, title: '스프린트 3구간', targets, timeLimit: Math.round(total / 16 + 15), reward: Math.round(total * 1.6), xp: Math.round(total / 8) };
    }
    const { node, d } = farNode(spot.node, 350, 900);
    const dest = placeName(g, node);
    if (type === 'taxi') {
      return { type, title: `손님: ${dest}까지`, targets: [node], timeLimit: Math.round(d / 12 + 25), reward: Math.round(d * 1.8 + 200), xp: Math.round(d / 6) };
    }
    return { type, title: `퀵 배달: ${dest}`, targets: [node], timeLimit: Math.round(d / 14 + 20), reward: Math.round(d * 1.4 + 200), xp: Math.round(d / 7) };
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
          if (sp.cool > 0 || Math.hypot(sp.x - S.x, sp.z - S.z) > 9 || speed > 14) continue;
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
      if (Math.hypot(tx - S.x, tz - S.z) < 10) {
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
