// 엔진음(톱니파 + 사각파)과 타이어 스키드(대역통과 노이즈). 외부 파일 없이 합성

export interface EngineAudio {
  update(freq: number, throttle: boolean, skid: boolean): void;
  toggleMute(): boolean;
  resume(): void;
}

export function createAudio(): EngineAudio | null {
  try {
    const ctx = new AudioContext();
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
    eg.connect(ctx.destination);

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
    sg.connect(ctx.destination);

    o1.start();
    o2.start();
    noise.start();

    let muted = false;
    return {
      update(freq, throttle, skid) {
        const t = ctx.currentTime;
        o1.frequency.setTargetAtTime(freq, t, 0.05);
        o2.frequency.setTargetAtTime(freq * 0.5, t, 0.05);
        eg.gain.setTargetAtTime(muted ? 0 : 0.035 + (throttle ? 0.035 : 0), t, 0.08);
        sg.gain.setTargetAtTime(muted || !skid ? 0 : 0.05, t, 0.06);
      },
      toggleMute() {
        muted = !muted;
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
