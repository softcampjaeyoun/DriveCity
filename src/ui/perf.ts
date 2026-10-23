import type * as THREE from 'three';

/**
 * 성능 진단 오버레이 (P 키). 멈칫거림의 원인을 찾으려고 긴 프레임마다 "그때 무엇이 돌았는지"를 적어 둔다:
 * 타일 생성 단계(tiles.profile), 셰이더 프로그램 수 변화(= 그 프레임에 셰이더를 새로 컴파일함), 받는 중인 타일 수, JS 힙.
 * 콘솔에도 같은 줄을 남긴다 (console.warn '[perf]')
 */
export interface PerfInfo {
  tilesLoaded: number;
  tilesLoading: number;
  building: string | null;
  detailed: number;
  /** 최근 타일 단계 기록 (라벨, ms) */
  profile: ReadonlyArray<[string, number]>;
  npcs: number;
  peds: number;
}
export interface Perf {
  toggle(): void;
  /** 매 프레임 끝에서. dt 는 초 */
  frame(now: number, dt: number, info: PerfInfo): void;
  readonly visible: boolean;
}

const HITCH_MS = 70;

export function createPerf(renderer: THREE.WebGLRenderer): Perf {
  const el = document.createElement('pre');
  el.id = 'perf';
  el.style.cssText = 'position:fixed;left:8px;top:8px;z-index:50;margin:0;padding:8px 10px;font:11px/1.45 ui-monospace,Consolas,monospace;color:#dfe6f0;background:rgba(8,10,16,.72);border:1px solid rgba(255,255,255,.12);border-radius:6px;white-space:pre;pointer-events:none;max-width:70vw;display:none';
  document.body.appendChild(el);
  let visible = false;
  const times: number[] = [];
  let lastProfileLen = 0;
  let lastPrograms = 0;
  let worst = 0;
  let worstAt = 0;
  const hitches: string[] = [];
  let lastDraw = 0;
  const mem = () => {
    const m = (performance as unknown as { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    return m ? `${(m.usedJSHeapSize / 1048576).toFixed(0)}/${(m.totalJSHeapSize / 1048576).toFixed(0)}MB` : 'n/a';
  };
  const fmt = (n: number) => n.toFixed(1).padStart(6);

  return {
    get visible() {
      return visible;
    },
    toggle() {
      visible = !visible;
      el.style.display = visible ? 'block' : 'none';
    },
    frame(now, dt, info) {
      const ms = dt * 1000;
      times.push(ms);
      if (times.length > 120) times.shift();
      const programs = renderer.info.programs?.length ?? 0;
      const newPrograms = programs - lastPrograms;
      lastPrograms = programs;
      // 이번 프레임에 돌았던 타일 단계 (profile 은 2ms 넘는 것만 쌓인다)
      const steps = info.profile.slice(lastProfileLen).map(([l, t]) => `${l} ${t}ms`);
      lastProfileLen = info.profile.length;
      if (ms > worst || now - worstAt > 5000) {
        worst = ms;
        worstAt = now;
      }
      if (ms > HITCH_MS) {
        const cause = [
          newPrograms > 0 ? `셰이더 컴파일 ${newPrograms}개` : '',
          steps.length ? `타일 단계: ${steps.join(', ')}` : '',
          info.tilesLoading ? `타일 받는 중 ${info.tilesLoading}` : '',
          !newPrograms && !steps.length ? '(타일·셰이더 아님 → GC 또는 GPU 대기 의심)' : '',
        ]
          .filter(Boolean)
          .join(' | ');
        const line = `${(now / 1000).toFixed(1)}s ${ms.toFixed(0)}ms ${cause} heap ${mem()}`;
        hitches.push(line);
        if (hitches.length > 12) hitches.shift();
        console.warn('[perf] 긴 프레임', line);
      }
      if (!visible || now - lastDraw < 250) return;
      lastDraw = now;
      const avg = times.reduce((a, b) => a + b, 0) / times.length;
      const sorted = [...times].sort((a, b) => a - b);
      const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
      const r = renderer.info.render;
      el.textContent = [
        `프레임 ${fmt(ms)}ms  평균 ${fmt(avg)}  p95 ${fmt(p95)}  최악(5s) ${fmt(worst)}   fps ${(1000 / avg).toFixed(0)}`,
        `그리기 호출 ${r.calls}  삼각형 ${(r.triangles / 1000).toFixed(0)}k  프로그램 ${programs}  지오메트리 ${renderer.info.memory.geometries}  텍스처 ${renderer.info.memory.textures}`,
        `타일 ${info.tilesLoaded} (상세 ${info.detailed}, 받는 중 ${info.tilesLoading}, 만드는 중 ${info.building ?? '-'})  NPC ${info.npcs}  보행자 ${info.peds}  힙 ${mem()}`,
        '',
        `긴 프레임(>${HITCH_MS}ms) 최근:`,
        ...(hitches.length ? hitches.slice(-8) : ['  없음']),
      ].join('\n');
    },
  };
}
