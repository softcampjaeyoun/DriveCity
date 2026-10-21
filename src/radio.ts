// 라디오: 외부 음원 없이 WebAudio 로 반복 재생하는 두 방송국
// 1 미드나잇 신스웨이브 (아르페지오 + 베이스 + 드럼), 2 한강 로파이 (느린 코드 + 바이닐 노이즈)

export interface Radio {
  readonly station: number;
  readonly name: string;
  set(station: number): void;
  next(): void;
}

export const STATIONS = ['꺼짐', '미드나잇 신스웨이브', '한강 로파이'];

type Note = number; // MIDI
const hz = (n: Note) => 440 * Math.pow(2, (n - 69) / 12);

interface Pattern {
  bpm: number;
  /** 한 마디 코드 (루트 MIDI, 구성음 간격) */
  chords: Array<[Note, number[]]>;
  arp: boolean;
  vinyl: boolean;
}

const SYNTHWAVE: Pattern = { bpm: 112, chords: [[57, [0, 3, 7, 10]], [53, [0, 4, 7, 11]], [48, [0, 4, 7, 11]], [55, [0, 4, 7, 10]]], arp: true, vinyl: false };
const LOFI: Pattern = { bpm: 76, chords: [[60, [0, 4, 7, 11]], [57, [0, 3, 7, 10]], [53, [0, 4, 7, 11]], [55, [0, 4, 7, 10]]], arp: false, vinyl: true };

export function createRadio(ctx: AudioContext, out: AudioNode, initial: number, onChange: (name: string, station: number) => void): Radio {
  const bus = ctx.createGain();
  bus.gain.value = 0.22;
  const comp = ctx.createDynamicsCompressor();
  bus.connect(comp);
  comp.connect(out);

  let station = 0;
  let pattern: Pattern | null = null;
  let step = 0; // 16분음표 단위
  let nextTime = 0;
  let timer: number | null = null;
  let vinyl: AudioBufferSourceNode | null = null;

  const noiseBuf = (() => {
    const b = ctx.createBuffer(1, ctx.sampleRate / 2, ctx.sampleRate);
    const d = b.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    return b;
  })();

  function tone(type: OscillatorType, freq: number, t: number, dur: number, gain: number, cutoff = 2400): void {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.value = freq;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = cutoff;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(f);
    f.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  function kick(t: number): void {
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(40, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.9, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    o.connect(g);
    g.connect(bus);
    o.start(t);
    o.stop(t + 0.3);
  }
  function hat(t: number, gain: number, dur = 0.05): void {
    const s = ctx.createBufferSource();
    s.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = 6000;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    s.connect(f);
    f.connect(g);
    g.connect(bus);
    s.start(t);
    s.stop(t + dur + 0.02);
  }
  function snare(t: number): void {
    hat(t, 0.5, 0.14);
    tone('triangle', 180, t, 0.12, 0.3);
  }

  function schedule(p: Pattern, t: number, s: number): void {
    const beat = 60 / p.bpm;
    const bar = Math.floor(s / 16) % p.chords.length;
    const [root, iv] = p.chords[bar];
    const inBar = s % 16;
    if (p.arp) {
      // 16분음표 아르페지오, 8분음표 베이스, 4비트 드럼
      const n = root + 12 + iv[inBar % iv.length] + (inBar >= 8 ? 12 : 0);
      tone('sawtooth', hz(n), t, beat * 0.3, 0.12, 1800);
      if (inBar % 2 === 0) tone('square', hz(root - 12), t, beat * 0.45, 0.1, 500);
      if (inBar % 4 === 0) kick(t);
      if (inBar % 8 === 4) snare(t);
      if (inBar % 2 === 1) hat(t, 0.18);
    } else {
      // 마디마다 코드 한 번, 느슨한 드럼
      if (inBar === 0) for (const k of iv) tone('triangle', hz(root + k) * (1 + (Math.random() - 0.5) * 0.004), t, beat * 3.8, 0.1, 1400);
      if (inBar === 8) tone('sine', hz(root - 12), t, beat * 1.8, 0.16, 400);
      if (inBar === 0 || inBar === 10) kick(t);
      if (inBar === 4 || inBar === 12) snare(t);
      if (inBar % 4 === 2) hat(t, 0.08, 0.08);
    }
  }

  function tick(): void {
    if (!pattern) return;
    const sixteenth = 60 / pattern.bpm / 4;
    while (nextTime < ctx.currentTime + 0.15) {
      schedule(pattern, nextTime, step);
      nextTime += sixteenth;
      step++;
    }
  }

  function stop(): void {
    if (timer !== null) clearInterval(timer);
    timer = null;
    pattern = null;
    if (vinyl) {
      vinyl.stop();
      vinyl = null;
    }
  }

  function set(s: number): void {
    station = ((s % STATIONS.length) + STATIONS.length) % STATIONS.length;
    stop();
    if (station === 0) {
      onChange(STATIONS[0], 0);
      return;
    }
    pattern = station === 1 ? SYNTHWAVE : LOFI;
    step = 0;
    nextTime = ctx.currentTime + 0.1;
    timer = setInterval(tick, 40);
    if (pattern.vinyl) {
      vinyl = ctx.createBufferSource();
      vinyl.buffer = noiseBuf;
      vinyl.loop = true;
      const f = ctx.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 3000;
      f.Q.value = 0.6;
      const g = ctx.createGain();
      g.gain.value = 0.025;
      vinyl.connect(f);
      f.connect(g);
      g.connect(bus);
      vinyl.start();
    }
    onChange(STATIONS[station], station);
  }

  set(initial);
  return {
    get station() {
      return station;
    },
    get name() {
      return STATIONS[station];
    },
    set,
    next: () => set(station + 1),
  };
}
