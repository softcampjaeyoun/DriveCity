export interface Input {
  up: boolean;
  down: boolean;
  left: boolean;
  right: boolean;
  hb: boolean;
  nitro: boolean;
}

export const IDLE: Readonly<Input> = { up: false, down: false, left: false, right: false, hb: false, nitro: false };

export type Action = 'reset' | 'camera' | 'mute' | 'battle' | 'garage' | 'start' | 'escape' | 'radio' | 'fx' | 'cancel' | 'weather';
const KEY_ACTIONS: Record<string, Action> = {
  KeyR: 'reset',
  KeyC: 'camera',
  KeyM: 'mute',
  KeyF: 'battle',
  KeyG: 'garage',
  KeyN: 'radio',
  KeyV: 'fx',
  KeyX: 'cancel',
  KeyK: 'weather',
  Enter: 'start',
  Escape: 'escape',
};
const TOUCH_ACTIONS: Record<string, Action> = { battle: 'battle', garage: 'garage', radio: 'radio' };

export interface InputSystem {
  read(): Input;
  on(action: Action, fn: () => void): void;
}

export function createInput(): InputSystem {
  const keys = new Set<string>();
  const touch: Record<string, boolean> = {};
  const handlers = new Map<Action, Array<() => void>>();
  const fire = (a: Action) => handlers.get(a)?.forEach((fn) => fn());

  addEventListener('keydown', (e) => {
    if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    keys.add(e.code);
    if (e.repeat) return;
    const a = KEY_ACTIONS[e.code];
    if (a) fire(a);
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  document.querySelectorAll<HTMLButtonElement>('.tbtn').forEach((b) => {
    const k = b.dataset.k ?? '';
    const on = (e: Event) => {
      e.preventDefault();
      const a = TOUCH_ACTIONS[k];
      if (a) {
        fire(a);
        return;
      }
      touch[k] = true;
      b.classList.add('on');
    };
    const off = (e: Event) => {
      e.preventDefault();
      touch[k] = false;
      b.classList.remove('on');
    };
    b.addEventListener('pointerdown', on);
    b.addEventListener('pointerup', off);
    b.addEventListener('pointercancel', off);
    b.addEventListener('pointerleave', off);
  });

  const has = (...codes: string[]) => codes.some((k) => keys.has(k));
  return {
    read: () => ({
      up: has('KeyW', 'ArrowUp') || !!touch.up,
      down: has('KeyS', 'ArrowDown') || !!touch.down,
      left: has('KeyA', 'ArrowLeft') || !!touch.left,
      right: has('KeyD', 'ArrowRight') || !!touch.right,
      hb: has('Space') || !!touch.hb,
      nitro: has('ShiftLeft', 'ShiftRight') || !!touch.nitro,
    }),
    on(action, fn) {
      const list = handlers.get(action) ?? [];
      list.push(fn);
      handlers.set(action, list);
    },
  };
}
