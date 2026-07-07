// Procedural WebAudio sound — every effect is synthesized, no asset files.

export function createAudio() {
  const A = { volume: 0.6, ready: false };
  let ctx, master, duck, noiseBuf;

  function init() {
    if (A.ready) return;
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    duck = ctx.createBiquadFilter();
    duck.type = 'lowpass';
    duck.frequency.value = 19000;
    master = ctx.createGain();
    master.gain.value = A.volume;
    const comp = ctx.createDynamicsCompressor();
    duck.connect(comp).connect(master).connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.2, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    A.ready = true;
    startWind();
  }
  // audio can only start on a user gesture
  const kick = () => { init(); if (ctx.state === 'suspended') ctx.resume(); };
  window.addEventListener('pointerdown', kick, { passive: true });
  window.addEventListener('keydown', kick, { passive: true });

  A.setVolume = (v) => { A.volume = v; if (master) master.gain.value = v; };
  // slow-mo audio muffle
  A.setDuck = (on) => { if (duck) duck.frequency.setTargetAtTime(on ? 480 : 19000, ctx.currentTime, 0.06); };

  const env = (gainNode, t0, peak, attack, decay) => {
    gainNode.gain.setValueAtTime(0.0001, t0);
    gainNode.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0001), t0 + attack);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  };

  function tone({ type = 'sine', f0 = 440, f1 = f0, dur = 0.2, peak = 0.3, attack = 0.005, detune = 0 }) {
    if (!A.ready) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.detune.value = detune;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + dur);
    env(g, t, peak, attack, dur);
    o.connect(g).connect(duck);
    o.start(t); o.stop(t + dur + 0.1);
  }

  function noise({ dur = 0.3, peak = 0.3, attack = 0.005, type = 'lowpass', f0 = 2000, f1 = f0, q = 0.8 }) {
    if (!A.ready) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true;
    src.playbackRate.value = 0.6 + Math.random() * 0.8;
    const flt = ctx.createBiquadFilter(), g = ctx.createGain();
    flt.type = type; flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t);
    flt.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t + dur);
    env(g, t, peak, attack, dur);
    src.connect(flt).connect(g).connect(duck);
    src.start(t); src.stop(t + dur + 0.1);
  }

  A.uiClick = () => tone({ type: 'triangle', f0: 700, f1: 950, dur: 0.07, peak: 0.15 });
  A.drawTick = () => noise({ dur: 0.05, peak: 0.02, type: 'bandpass', f0: 3200, q: 2 });
  A.fizzle = () => { noise({ dur: 0.3, peak: 0.12, f0: 900, f1: 200 }); tone({ type: 'sine', f0: 300, f1: 90, dur: 0.3, peak: 0.1 }); };

  A.castBolt = () => { tone({ type: 'sawtooth', f0: 1300, f1: 300, dur: 0.16, peak: 0.18 }); noise({ dur: 0.1, peak: 0.1, type: 'highpass', f0: 2500 }); };
  A.castFire = () => noise({ dur: 0.5, peak: 0.3, f0: 500, f1: 2400, attack: 0.08 });
  A.castBoulder = () => { noise({ dur: 0.5, peak: 0.3, f0: 250, f1: 90 }); tone({ type: 'square', f0: 90, f1: 45, dur: 0.4, peak: 0.12 }); };
  A.castGrab = () => { tone({ type: 'sine', f0: 200, f1: 800, dur: 0.5, peak: 0.14 }); noise({ dur: 0.5, peak: 0.1, type: 'bandpass', f0: 600, f1: 1800, q: 3 }); };

  A.lightning = () => {
    noise({ dur: 0.35, peak: 0.5, type: 'highpass', f0: 900, attack: 0.002 });
    tone({ type: 'sawtooth', f0: 160, f1: 40, dur: 0.5, peak: 0.3 });
    noise({ dur: 0.9, peak: 0.2, f0: 300, f1: 60, attack: 0.05 });
  };
  A.boom = (size = 1) => {
    tone({ type: 'sine', f0: 120 * size, f1: 32, dur: 0.55 * size, peak: 0.5, attack: 0.002 });
    noise({ dur: 0.5 * size, peak: 0.4, f0: 1800, f1: 100, attack: 0.002 });
  };
  A.thud = () => { tone({ type: 'sine', f0: 90, f1: 38, dur: 0.22, peak: 0.4, attack: 0.002 }); noise({ dur: 0.15, peak: 0.2, f0: 500, f1: 120 }); };
  A.rockCrack = () => {
    noise({ dur: 0.25, peak: 0.4, type: 'bandpass', f0: 1400, f1: 500, q: 1.5, attack: 0.002 });
    for (let i = 0; i < 4; i++) setTimeout(() => tone({ type: 'square', f0: 300 + Math.random() * 500, f1: 120, dur: 0.08, peak: 0.08 }), i * 45);
  };
  A.shieldUp = () => { tone({ type: 'sine', f0: 350, f1: 700, dur: 0.35, peak: 0.2 }); tone({ type: 'sine', f0: 525, f1: 1050, dur: 0.35, peak: 0.12, detune: 6 }); };
  A.shieldHit = () => tone({ type: 'triangle', f0: 900, f1: 500, dur: 0.12, peak: 0.2 });
  A.shatter = () => {
    noise({ dur: 0.4, peak: 0.4, type: 'highpass', f0: 2200, attack: 0.002 });
    for (let i = 0; i < 6; i++) setTimeout(() => tone({ type: 'sine', f0: 1400 + Math.random() * 2200, f1: 700, dur: 0.15, peak: 0.09 }), i * 35);
  };
  A.mirrorUp = () => tone({ type: 'sine', f0: 1200, f1: 1800, dur: 0.18, peak: 0.14 });
  A.reflect = () => { tone({ type: 'sine', f0: 1700, f1: 2400, dur: 0.2, peak: 0.25 }); tone({ type: 'sine', f0: 850, f1: 1200, dur: 0.25, peak: 0.15 }); };
  A.healChime = () => [523, 659, 784, 1047].forEach((f, i) =>
    setTimeout(() => tone({ type: 'sine', f0: f, f1: f * 1.01, dur: 0.5, peak: 0.1 }), i * 130));
  A.hurt = () => { tone({ type: 'square', f0: 220, f1: 110, dur: 0.12, peak: 0.15 }); noise({ dur: 0.1, peak: 0.12, f0: 800, f1: 300 }); };
  A.fling = () => noise({ dur: 0.4, peak: 0.25, type: 'bandpass', f0: 400, f1: 2000, q: 2, attack: 0.02 });
  A.burnLoopTick = () => noise({ dur: 0.3, peak: 0.05, type: 'bandpass', f0: 900 + Math.random() * 600, q: 1.2 });
  A.taunt = () => { tone({ type: 'square', f0: 300 + Math.random() * 200, f1: 250, dur: 0.09, peak: 0.07 }); setTimeout(() => tone({ type: 'square', f0: 350 + Math.random() * 250, f1: 300, dur: 0.09, peak: 0.07 }), 100); };
  A.horn = () => {
    [196, 262, 392].forEach((f, i) => setTimeout(() => {
      tone({ type: 'sawtooth', f0: f, f1: f, dur: 0.5, peak: 0.14 });
      tone({ type: 'sawtooth', f0: f * 1.005, f1: f, dur: 0.5, peak: 0.1, detune: 8 });
    }, i * 160));
  };
  A.victory = () => [392, 523, 659, 784].forEach((f, i) => setTimeout(() => tone({ type: 'triangle', f0: f, f1: f, dur: 0.6, peak: 0.16 }), i * 150));
  A.defeat = () => [330, 294, 262, 196].forEach((f, i) => setTimeout(() => tone({ type: 'sawtooth', f0: f, f1: f * 0.97, dur: 0.7, peak: 0.12 }), i * 220));

  function startWind() {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf; src.loop = true; src.playbackRate.value = 0.3;
    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass'; flt.frequency.value = 260; flt.Q.value = 0.6;
    const g = ctx.createGain(); g.gain.value = 0.028;
    const lfo = ctx.createOscillator(), lfoG = ctx.createGain();
    lfo.frequency.value = 0.13; lfoG.gain.value = 90;
    lfo.connect(lfoG).connect(flt.frequency);
    src.connect(flt).connect(g).connect(duck);
    src.start(); lfo.start();
  }

  return A;
}
