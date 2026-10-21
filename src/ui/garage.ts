import { currentCar, persist, save, type CarSave } from '../game/save.ts';
import {
  CARS,
  MAX_LEVEL,
  PART_INFO,
  PART_KEYS,
  carById,
  computeStats,
  displayStats,
  emptyParts,
  partCost,
  partsLevel,
  type CarSpec,
  type CarStats,
  type PartKey,
} from '../vehicle/stats.ts';

export const PAINTS: ReadonlyArray<[string, string]> = [
  ['#f1f3f7', '펄 화이트'],
  ['#e8394a', '레이싱 레드'],
  ['#3a7bff', '일렉트릭 블루'],
  ['#f5c542', '선셋 옐로'],
  ['#1d1f26', '미드나잇 블랙'],
  ['#9b5cff', '바이올렛'],
  ['#5ce09a', '민트'],
  ['#f08a24', '택시 오렌지'],
];
export const GLOWS: ReadonlyArray<[string, string]> = [
  ['#4fd1ff', '아이스 블루'],
  ['#9b5cff', '퍼플'],
  ['#ff5a6a', '핑크 레드'],
  ['#5ce09a', '그린'],
  ['#ffae4a', '앰버'],
  ['#ffffff', '화이트'],
];

type Tab = 'cars' | 'tune' | 'style';
const TABS: Array<[Tab, string]> = [
  ['cars', '차량'],
  ['tune', '튜닝'],
  ['style', '외형'],
];

export interface GarageEvents {
  /** 현재 차량이나 부품, 색이 바뀔 때 */
  onChange(spec: CarSpec, stats: CarStats, car: CarSave): void;
  onOpen(): void;
  onClose(): void;
}

export interface Garage {
  readonly open: boolean;
  show(): void;
  hide(): void;
  toggle(): void;
}

const h = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else el.setAttribute(k, v);
  }
  el.append(...children);
  return el;
};
const money = (n: number) => `${n.toLocaleString('ko-KR')} cr`;

export function createGarage(root: HTMLElement, ev: GarageEvents): Garage {
  let open = false;
  let tab: Tab = 'cars';
  /** 튜닝 탭에서 마우스를 올린 부품. 올렸을 때 스탯 바에 미리보기 표시 */
  let preview: PartKey | null = null;

  const emit = () => {
    const spec = carById(save.current);
    const car = currentCar();
    ev.onChange(spec, computeStats(spec, car.parts), car);
  };

  function renderStats(spec: CarSpec, car: CarSave): HTMLElement {
    const now = computeStats(spec, car.parts);
    let next = now;
    if (preview && car.parts[preview] < MAX_LEVEL) {
      next = computeStats(spec, { ...car.parts, [preview]: car.parts[preview] + 1 });
    }
    const box = h('div', { class: 'gstats' });
    const a = displayStats(now);
    const b = displayStats(next);
    a.forEach((s, i) => {
      const up = b[i].value > s.value + 1e-6;
      const bar = h('div', { class: 'bar' }, h('i', { class: up ? 'up' : '', style: `width:${Math.min(100, b[i].value * 100)}%` }));
      box.append(
        h('div', { class: 'gstat' }, h('div', { class: 'label' }, h('span', {}, s.name), h('b', {}, up ? b[i].text : s.text)), bar),
      );
    });
    return box;
  }

  function renderCars(): HTMLElement {
    const list = h('div', { class: 'glist' });
    for (const spec of CARS) {
      const owned = save.cars[spec.id];
      const isCurrent = save.current === spec.id;
      const st = computeStats(spec, owned?.parts ?? emptyParts());
      const chip = h('span', { class: `chip ${owned ? 'own' : ''}` }, owned ? (isCurrent ? '탑승 중' : '보유') : spec.cls);
      const name = h('div', { class: 'name' }, spec.name, chip);
      const desc = h(
        'div',
        { class: 'desc' },
        `${spec.cls} · 최고 ${Math.round(st.vmax * 3.6)} km/h · 가속 ${st.accel.toFixed(0)} · 접지 ${st.grip.toFixed(1)}` +
          (owned ? ` · 튜닝 Lv ${partsLevel(owned.parts)}` : ''),
      );
      let btn: HTMLButtonElement;
      if (isCurrent) {
        btn = h('button', { class: 'gbtn', disabled: '' }, '선택됨');
      } else if (owned) {
        btn = h('button', { class: 'gbtn' }, '타기');
        btn.addEventListener('click', () => {
          save.current = spec.id;
          persist();
          emit();
          render();
        });
      } else {
        const poor = save.credits < spec.price;
        btn = h('button', { class: `gbtn buy ${poor ? 'poor' : ''}` }, '구매', h('span', { class: 'num' }, money(spec.price)));
        btn.disabled = poor;
        btn.addEventListener('click', () => {
          if (save.credits < spec.price) return;
          save.credits -= spec.price;
          save.cars[spec.id] = { parts: emptyParts(), paint: spec.paint, glow: currentCar().glow };
          save.current = spec.id;
          persist();
          emit();
          render();
        });
      }
      list.append(h('div', { class: `gitem ${isCurrent ? 'current' : ''}` }, name, desc, btn));
    }
    return list;
  }

  function renderTune(spec: CarSpec, car: CarSave): HTMLElement {
    const list = h('div', { class: 'glist' });
    for (const key of PART_KEYS) {
      const lv = car.parts[key];
      const maxed = lv >= MAX_LEVEL;
      const cost = maxed ? 0 : partCost(spec, lv + 1);
      const pips = h('div', { class: 'lv' });
      for (let i = 0; i < MAX_LEVEL; i++) pips.append(h('i', { class: i < lv ? 'on' : '' }));
      const name = h('div', { class: 'name' }, PART_INFO[key].name, h('span', { class: 'chip' }, `Lv ${lv}`), pips);
      const desc = h('div', { class: 'desc' }, PART_INFO[key].desc);
      let btn: HTMLButtonElement;
      if (maxed) {
        btn = h('button', { class: 'gbtn', disabled: '' }, '최대');
      } else {
        const poor = save.credits < cost;
        btn = h('button', { class: `gbtn buy ${poor ? 'poor' : ''}` }, `Lv ${lv + 1} 장착`, h('span', { class: 'num' }, money(cost)));
        btn.disabled = poor;
        btn.addEventListener('click', () => {
          if (save.credits < cost) return;
          save.credits -= cost;
          car.parts[key] = lv + 1;
          persist();
          emit();
          render();
        });
      }
      const item = h('div', { class: 'gitem' }, name, desc, btn);
      item.addEventListener('pointerenter', () => {
        preview = key;
        statsSlot.replaceChildren(renderStats(spec, car));
      });
      item.addEventListener('pointerleave', () => {
        preview = null;
        statsSlot.replaceChildren(renderStats(spec, car));
      });
      list.append(item);
    }
    return list;
  }

  function swatches(options: ReadonlyArray<[string, string]>, current: string, pick: (hex: string) => void): HTMLElement {
    const box = h('div', { class: 'swatches', role: 'radiogroup' });
    for (const [hex, label] of options) {
      const b = h('button', { class: 'swatch', role: 'radio', 'aria-label': label, 'aria-checked': String(hex === current), style: `background:${hex}` });
      b.addEventListener('click', () => pick(hex));
      box.append(b);
    }
    return box;
  }

  function renderStyle(car: CarSave): HTMLElement {
    return h(
      'div',
      { class: 'glist' },
      h('div', { class: 'label' }, '도색'),
      swatches(PAINTS, car.paint, (hex) => {
        car.paint = hex;
        persist();
        emit();
        render();
      }),
      h('div', { class: 'label', style: 'margin-top:8px' }, '언더글로우'),
      swatches(GLOWS, car.glow, (hex) => {
        car.glow = hex;
        persist();
        emit();
        render();
      }),
      h('div', { class: 'gnote' }, '외형 변경은 무료예요. 차마다 따로 저장돼요.'),
    );
  }

  const statsSlot = h('div');
  const bodySlot = h('div');

  function render(): void {
    const spec = carById(save.current);
    const car = currentCar();
    const close = h('button', { class: 'gclose', type: 'button' }, '닫기 (G)');
    close.addEventListener('click', hide);
    const head = h(
      'div',
      { class: 'ghead' },
      h('h2', {}, '차고 ', h('span', {}, spec.name)),
      h('div', { class: 'credits num' }, h('small', {}, 'CREDITS'), save.credits.toLocaleString('ko-KR')),
      close,
    );
    const tabs = h('div', { class: 'gtabs', role: 'tablist' });
    for (const [key, label] of TABS) {
      const b = h('button', { class: 'gtab', role: 'tab', 'aria-selected': String(tab === key) }, label);
      b.addEventListener('click', () => {
        tab = key;
        preview = null;
        render();
      });
      tabs.append(b);
    }
    statsSlot.replaceChildren(renderStats(spec, car));
    bodySlot.replaceChildren(tab === 'cars' ? renderCars() : tab === 'tune' ? renderTune(spec, car) : renderStyle(car));
    const body = h('div', { class: 'gbody' }, statsSlot, bodySlot);
    root.replaceChildren(h('div', { class: 'gwin' }, head, tabs, body));
  }

  function show(): void {
    if (open) return;
    open = true;
    preview = null;
    render();
    root.hidden = false;
    ev.onOpen();
  }
  function hide(): void {
    if (!open) return;
    open = false;
    root.hidden = true;
    ev.onClose();
  }

  emit();
  return {
    get open() {
      return open;
    },
    show,
    hide,
    toggle() {
      if (open) hide();
      else show();
    },
  };
}
