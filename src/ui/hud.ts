import { CHECKPOINTS } from '../config.ts';
import { MAX_STARS } from '../game/wanted.ts';
import { fmtTime } from '../util/math.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} 가 없어요`);
  return el as T;
};

export interface HudFrame {
  time: number;
  cp: number;
  credits: number;
  level: { lv: number; xp: number; next: number };
  kmh: number;
  reverse: boolean;
  /** 0..1 현재 기어 안에서의 회전수 비율 */
  within: number;
  gear: number;
  nitro: number;
  dist: number;
  /** 차 기준 목표 방향 (rad) */
  angle: number;
  navLabel: string;
  navColor: string;
  battle: { name: string; pd: number; rd: number } | null;
  wanted: { stars: number; bust: number; escape: number } | null;
  mission: { title: string; objective: string; time: number; sat: number | null } | null;
  promptName: string | null;
  garageHint: boolean;
  drift: number | null;
  carName: string;
  carLv: number;
  status: string;
}

export interface Hud {
  frame(f: HudFrame): void;
  toast(big: string, sub: string, secs?: number): void;
  tick(dt: number): void;
  setBest(time: number): void;
}

export function createHud(): Hud {
  const el = {
    time: $('time'),
    cp: $('cp'),
    best: $('best'),
    credits: $('credits'),
    level: $('level'),
    xpBar: $('xpBar').firstElementChild as HTMLElement,
    navLabel: $('navLabel'),
    arrow: $('arrow'),
    arrowPath: $('arrowPath'),
    dist: $('dist'),
    battle: $('battle'),
    bName: $('bName'),
    bPlayer: $('bPlayer'),
    bRival: $('bRival'),
    wanted: $('wanted'),
    stars: $('stars'),
    wantedSub: $('wantedSub'),
    wantedBar: $('wantedBar').firstElementChild as HTMLElement,
    mission: $('mission'),
    mTitle: $('mTitle'),
    mObjective: $('mObjective'),
    mTime: $('mTime'),
    mSat: $('mSat'),
    prompt: $('prompt'),
    promptName: $('promptName'),
    garageHint: $('garageHint'),
    status: $('status'),
    speed: $('speed'),
    gear: $('gear'),
    rpm: $('rpm').firstElementChild as HTMLElement,
    nitro: $('nitro').firstElementChild as HTMLElement,
    nitroPct: $('nitroPct'),
    carName: $('carName'),
    carLv: $('carLv'),
    drift: $('drift'),
    toast: $('toast'),
    toastBig: $('toastBig'),
    toastSub: $('toastSub'),
  };
  let toastTimer = 0;

  return {
    frame(f) {
      el.time.textContent = fmtTime(f.time);
      el.cp.textContent = `${f.cp} / ${CHECKPOINTS}`;
      el.credits.textContent = f.credits.toLocaleString('ko-KR');
      el.level.textContent = `Lv ${f.level.lv}`;
      el.xpBar.style.width = `${(f.level.xp / f.level.next) * 100}%`;

      el.arrow.style.transform = `rotate(${f.angle}rad)`;
      el.arrowPath.setAttribute('fill', f.navColor);
      el.dist.style.color = f.navColor;
      el.navLabel.textContent = f.navLabel;
      el.dist.textContent = `${Math.round(f.dist)} m`;

      el.battle.classList.toggle('on', !!f.battle);
      if (f.battle) {
        el.bName.textContent = `VS ${f.battle.name}`;
        el.bPlayer.textContent = `${Math.round(f.battle.pd)} m`;
        el.bRival.textContent = `${Math.round(f.battle.rd)} m`;
      }

      el.wanted.classList.toggle('on', !!f.wanted);
      if (f.wanted) {
        el.stars.textContent = '★'.repeat(f.wanted.stars) + '☆'.repeat(MAX_STARS - f.wanted.stars);
        if (f.wanted.bust > 0.05) {
          el.wantedSub.textContent = '검거 중…';
          el.wantedBar.style.width = `${f.wanted.bust * 100}%`;
          el.wantedBar.style.background = 'var(--warn)';
        } else {
          el.wantedSub.textContent = f.wanted.escape > 0.05 ? '따돌리는 중' : '경찰 추격';
          el.wantedBar.style.width = `${f.wanted.escape * 100}%`;
          el.wantedBar.style.background = 'var(--ok)';
        }
      }

      el.mission.classList.toggle('on', !!f.mission);
      if (f.mission) {
        el.mTitle.textContent = f.mission.title;
        el.mObjective.textContent = f.mission.objective;
        el.mTime.textContent = `${Math.max(0, Math.ceil(f.mission.time))}초`;
        el.mTime.classList.toggle('low', f.mission.time < 10);
        el.mSat.hidden = f.mission.sat === null;
        if (f.mission.sat !== null) el.mSat.textContent = `만족도 ${Math.round(f.mission.sat)}%`;
      }

      el.prompt.classList.toggle('on', !!f.promptName);
      if (f.promptName) el.promptName.textContent = f.promptName;
      el.garageHint.classList.toggle('on', f.garageHint && !f.promptName);
      el.status.textContent = f.status;

      el.speed.textContent = String(Math.round(f.kmh));
      el.gear.textContent = f.reverse ? 'R' : String(f.gear + 1);
      el.rpm.style.width = `${(0.15 + f.within * 0.85) * 100}%`;
      el.nitro.style.width = `${f.nitro * 100}%`;
      el.nitroPct.textContent = `${Math.round(f.nitro * 100)}%`;
      el.carName.textContent = f.carName;
      el.carLv.textContent = `Lv ${f.carLv}`;

      if (f.drift !== null) {
        el.drift.textContent = `DRIFT +${Math.round(f.drift)}`;
        el.drift.classList.add('on');
      } else el.drift.classList.remove('on');
    },

    toast(big, sub, secs = 2.2) {
      el.toastBig.textContent = big;
      el.toastSub.textContent = sub;
      el.toast.classList.add('on');
      toastTimer = secs;
    },

    tick(dt) {
      if (toastTimer <= 0) return;
      toastTimer -= dt;
      if (toastTimer <= 0) el.toast.classList.remove('on');
    },

    setBest(time) {
      el.best.textContent = time ? fmtTime(time) : '--:--.--';
    },
  };
}
