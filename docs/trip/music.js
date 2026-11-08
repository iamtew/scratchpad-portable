// Live 140 BPM psytrance: 909 kick, resonant bass, high stabs.
(function (global) {
  const BPM = 140;
  const SIXTEENTH = 60 / BPM / 4;
  const LOOKAHEAD_MS = 25;
  const SCHEDULE_AHEAD = 0.12;

  let ctx;
  let master;
  let bassFilter;
  let noiseBuf;
  let timer = 0;
  let nextTime = 0;
  let step = 0;
  let volume = 0.7;
  let muted = false;
  let lastKickTime = 0;

  function noiseBuffer() {
    const n = ctx.sampleRate * 0.2;
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  function envGain(t, peak, attack, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  function kick(t) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(165, t);
    osc.frequency.exponentialRampToValueAtTime(48, t + 0.055);
    const g = envGain(t, 1, 0.002, 0.22);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.28);

    const click = ctx.createBufferSource();
    click.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.value = 1800;
    const cg = envGain(t, 0.22, 0.001, 0.018);
    click.connect(hp).connect(cg).connect(master);
    click.start(t);
    click.stop(t + 0.03);

    lastKickTime = t;
  }

  function bass(t) {
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = 41.2;
    const g = envGain(t, 0.28, 0.005, 0.07);
    osc.connect(g).connect(bassFilter);
    osc.start(t);
    osc.stop(t + 0.09);
    const cut = 220 + Math.sin(t * 1.7) * 80;
    bassFilter.frequency.setTargetAtTime(cut, t, 0.02);
  }

  function stab(t, freq, peak) {
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.value = freq;
    const bp = ctx.createBiquadFilter();
    bp.type = "bandpass";
    bp.frequency.value = freq * 1.4;
    bp.Q.value = 6;
    const g = envGain(t, peak, 0.002, 0.06);
    osc.connect(bp).connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  function schedule(s, t) {
    const sixteenth = s % 4;
    if (sixteenth === 0) kick(t);
    else bass(t);

    const bar = s % 16;
    if (bar === 4 || bar === 12) stab(t, 659.25, 0.09);
    else if (bar === 6 || bar === 14) stab(t, 783.99, 0.07);
    else if (bar === 10) stab(t, 987.77, 0.08);
  }

  function tick() {
    while (nextTime < ctx.currentTime + SCHEDULE_AHEAD) {
      schedule(step, nextTime);
      step += 1;
      nextTime += SIXTEENTH;
    }
    timer = setTimeout(tick, LOOKAHEAD_MS);
  }

  function applyGain() {
    if (!master) return;
    master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.03);
  }

  async function start() {
    if (ctx) return;
    ctx = new AudioContext();
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);

    bassFilter = ctx.createBiquadFilter();
    bassFilter.type = "lowpass";
    bassFilter.frequency.value = 240;
    bassFilter.Q.value = 14;
    bassFilter.connect(master);

    noiseBuf = noiseBuffer();
    await ctx.resume();
    nextTime = ctx.currentTime + 0.05;
    step = 0;
    tick();
  }

  global.TripMusic = {
    start,
    setVolume(v) {
      volume = Math.max(0, Math.min(1, Number(v)));
      applyGain();
    },
    setMuted(m) {
      muted = !!m;
      applyGain();
    },
    get step() {
      return step;
    },
    get lastKickTime() {
      return lastKickTime;
    },
    get currentTime() {
      return ctx ? ctx.currentTime : 0;
    },
  };
})(window);
