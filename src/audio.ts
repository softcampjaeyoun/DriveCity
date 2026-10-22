// 엔진음(톱니파 + 사각파), 타이어 스키드(대역통과 노이즈), 경찰 사이렌. 외부 파일 없이 합성

export interface EngineAudio {
  ctx: AudioContext;
  /** 라디오 등 다른 소리가 붙는 마스터 */
  master: GainNode;
  update(dt: number, freq: number, throttle: boolean, skid: boolean, siren: boolean): void;
  /** 다른 차의 경적. vol 0..1 (거리로 줄인다), pan -1..1 */
  horn(vol: number, pan?: number): void;
  toggleMute(): boolean;
  readonly muted: boolean;
  resume(): void;
}

export function createAudio(): EngineAudio | null {
  try {
    const ctx = new AudioContext();
    const master = ctx.createGain();
    master.gain.value = 1;
    master.connect(ctx.destination);

    const o1 = ctx.createOscillator();
    o1.type = 'sawtooth';
    const o2 = ctx.createOscillator();
    o2.type = 'square';
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 700;
    const eg = ctx.createGain();
    eg.gain.value = 0;
    o1.connect(lp);
    o2.connect(lp);
    lp.connect(eg);
    eg.connect(master);

    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    const noise = ctx.createBufferSource();
    noise.buffer = buf;
    noise.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1800;
    bp.Q.value = 3;
    const sg = ctx.createGain();
    sg.gain.value = 0;
    noise.connect(bp);
    bp.connect(sg);
    sg.connect(master);

    // 사이렌: 두 음을 번갈아
    const so = ctx.createOscillator();
    so.type = 'triangle';
    so.frequency.value = 700;
    const sgain = ctx.createGain();
    sgain.gain.value = 0;
    so.connect(sgain);
    sgain.connect(master);
    let sirenPhase = 0;

    o1.start();
    o2.start();
    noise.start();
    so.start();

    let muted = false;
    return {
      ctx,
      master,
      get muted() {
        return muted;
      },
      update(dt, freq, throttle, skid, siren) {
        const t = ctx.currentTime;
        o1.frequency.setTargetAtTime(freq, t, 0.05);
        o2.frequency.setTargetAtTime(freq * 0.5, t, 0.05);
        eg.gain.setTargetAtTime(muted ? 0 : 0.035 + (throttle ? 0.035 : 0), t, 0.08);
        sg.gain.setTargetAtTime(muted || !skid ? 0 : 0.05, t, 0.06);
        if (siren) {
          sirenPhase += dt * 1.4;
          so.frequency.setTargetAtTime(Math.floor(sirenPhase) % 2 ? 880 : 640, t, 0.12);
        }
        sgain.gain.setTargetAtTime(muted || !siren ? 0 : 0.03, t, 0.1);
      },
      horn(vol, pan = 0) {
        if (muted || vol < 0.02) return;
        const t = ctx.currentTime;
        const len = 0.28 + Math.random() * 0.25;
        const base = 400 + Math.random() * 90;
        const g = ctx.createGain();
        g.gain.setValueAtTime(0, t);
        g.gain.linearRampToValueAtTime(0.09 * vol, t + 0.02);
        g.gain.setValueAtTime(0.09 * vol, t + len - 0.05);
        g.gain.linearRampToValueAtTime(0, t + len);
        const lp = ctx.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1600;
        const panner = ctx.createStereoPanner();
        panner.pan.value = Math.max(-1, Math.min(1, pan));
        g.connect(lp);
        lp.connect(panner);
        panner.connect(master);
        // 두 음이 섞인 자동차 경적 (장3도)
        for (const f of [base, base * 1.26]) {
          const o = ctx.createOscillator();
          o.type = 'square';
          o.frequency.value = f;
          o.connect(g);
          o.start(t);
          o.stop(t + len + 0.05);
        }
      },
      toggleMute() {
        muted = !muted;
        master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.05);
        return muted;
      },
      resume() {
        if (ctx.state === 'suspended') void ctx.resume();
      },
    };
  } catch {
    return null;
  }
}
