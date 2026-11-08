// Live 144 BPM full-on: kick/bass engine plus mutating agents.
(function (global) {
  const BPM = 144;
  const SIXTEENTH = 60 / BPM / 4;
  const EIGHTH = 60 / BPM / 2;
  const LOOKAHEAD_MS = 25;
  const SCHEDULE_AHEAD = 0.12;
  // 16-bar phrases. Climax then breakdown is the drop.
  const PHRASE_ENERGY = [15, 35, 55, 85, 30, 90];
  const BASS_MASKS = [
    [0, 1, 1, 1],
    [0, 1, 1, 0],
    [0, 1, 0, 1],
    [0, 1, 1, 1],
  ];
  const BASS_HZ = [41.2, 41.2, 49.0, 36.71];
  const LEAD_HZ = [329.63, 369.99, 415.3, 493.88, 554.37];

  let ctx;
  let master;
  let bassFilter;
  let bassShaper;
  let bassEq;
  let delayL;
  let delayR;
  let delayFbL;
  let delayFbR;
  let delayHp;
  let delaySend;
  let atmoGain;
  let atmoFilter;
  let noiseBuf;
  let atmoBuf;
  let timer = 0;
  let nextTime = 0;
  let step = 0;
  let volume = 0.7;
  let muted = false;
  let lastKickTime = 0;

  function fillNoise(d, pink) {
    let b0 = 0;
    let b1 = 0;
    let b2 = 0;
    for (let i = 0; i < d.length; i++) {
      const w = Math.random() * 2 - 1;
      if (!pink) {
        d[i] = w;
        continue;
      }
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.296516;
      b2 = 0.57 * b2 + w * 1.052691;
      d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.12;
    }
  }

  function noiseBuffer(seconds, pink) {
    const n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate);
    fillNoise(buf.getChannelData(0), pink);
    return buf;
  }

  function shaperCurve(drive) {
    const n = 256;
    const curve = new Float32Array(n);
    const k = 1 + drive * 5;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      curve[i] = Math.tanh(x * k);
    }
    return curve;
  }

  function envGain(t, peak, attack, decay) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t + Math.max(attack, 0.001));
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  function noiseBurst(t, dest, peak, attack, decay, type, freq, q) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = envGain(t, peak, attack, decay);
    src.connect(f).connect(g).connect(dest);
    src.start(t);
    src.stop(t + attack + decay + 0.02);
  }

  function clock(s) {
    const bar = Math.floor(s / 16);
    const phrase = Math.floor(bar / 16) % PHRASE_ENERGY.length;
    const barInPhrase = bar % 16;
    const energy = PHRASE_ENERGY[phrase];
    const tension = energy >= 70 && barInPhrase >= 12;
    return {
      s,
      bar,
      phrase,
      barInPhrase,
      sixteenth: s % 16,
      beat16: s % 4,
      energy,
      tension,
      drop: energy <= 30,
    };
  }

  function kick(t) {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(55, t + 0.04);
    const g = envGain(t, 1, 0.001, 0.15);
    osc.connect(g).connect(master);
    osc.start(t);
    osc.stop(t + 0.18);
    noiseBurst(t, master, 0.2, 0.001, 0.016, "highpass", 2000, 0.7);
    lastKickTime = t;
  }

  function bass(t, c) {
    if (c.beat16 === 0) return;
    const mask = BASS_MASKS[Math.floor(c.bar / 8) % BASS_MASKS.length];
    if (!mask[c.beat16]) return;

    const cycle = Math.floor(c.bar / 8);
    const hz = BASS_HZ[cycle % BASS_HZ.length];
    if (c.beat16 === 1 && c.sixteenth === 1) {
      bassShaper.curve = shaperCurve(0.25 + (c.energy / 100) * 0.35);
    }

    const open = c.tension ? 180 : 0;
    const cut = 180 + c.energy * 1.6 + Math.sin(t * 0.35) * 40 + open;
    bassFilter.frequency.setTargetAtTime(Math.min(cut, 480), t, 0.03);
    bassFilter.Q.setTargetAtTime(c.tension ? 2.2 : 1.2, t, 0.05);

    for (const detune of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = hz;
      osc.detune.value = detune;
      const g = envGain(t, 0.16, 0.001, 0.065);
      osc.connect(g).connect(bassFilter);
      osc.start(t);
      osc.stop(t + 0.085);
    }
  }

  function hats(t, c) {
    if (c.drop) return;
    const sixteenth = c.sixteenth;
    const closed = sixteenth % 2 === 1;
    const extra = c.energy > 50 && Math.random() < 0.3;
    if (!closed && !extra) return;
    if (closed && c.energy < 20 && sixteenth % 4 !== 1) return;
    const open = c.energy > 60 && sixteenth === 14;
    const decay = open ? 0.16 : 0.018;
    const peak = open ? 0.045 : 0.028;
    noiseBurst(t, master, peak, 0.001, decay, "highpass", open ? 7000 : 8500, 0.6);
    if (c.energy > 40 && Math.random() < 0.7) {
      noiseBurst(t, master, 0.012 + Math.random() * 0.018, 0.001, 0.04, "bandpass", 5500, 1.2);
    }
  }

  function ride(t, c) {
    if (c.energy < 70 || c.sixteenth % 4 !== 2) return;
    noiseBurst(t, master, 0.02, 0.002, 0.22, "highpass", 9000, 0.4);
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modG = ctx.createGain();
    modG.gain.value = 80;
    mod.frequency.value = 640;
    car.frequency.value = 320;
    const g = envGain(t, 0.012, 0.002, 0.2);
    mod.connect(modG).connect(car.frequency);
    car.connect(g).connect(master);
    mod.start(t);
    car.start(t);
    mod.stop(t + 0.24);
    car.stop(t + 0.24);
  }

  function lead(t, c) {
    if (c.energy < 45 || c.drop) return;
    const sixteenth = c.sixteenth;
    const motifA = sixteenth === 4 || sixteenth === 5 || sixteenth === 6;
    const motifB = sixteenth >= 8 && sixteenth <= 11 && c.energy > 55;
    const motifC = (sixteenth === 14 || sixteenth === 15) && c.energy > 70;
    if (!motifA && !motifB && !motifC) return;

    const note = LEAD_HZ[(c.bar + sixteenth) % LEAD_HZ.length];
    const osc = ctx.createOscillator();
    osc.type = sixteenth % 2 ? "square" : "sawtooth";
    osc.frequency.value = note;
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 8 + Math.sin(t * 2.1) * 4;
    lp.frequency.setValueAtTime(900 + c.energy * 18, t);
    lp.frequency.exponentialRampToValueAtTime(400 + c.energy * 8, t + 0.12);
    const peak = 0.035 + (c.energy / 100) * 0.04;
    const g = envGain(t, peak, 0.002, 0.09);
    osc.connect(lp).connect(g);
    g.connect(master);
    g.connect(delaySend);
    osc.start(t);
    osc.stop(t + 0.14);
  }

  function laser(t, c) {
    if (!c.tension || c.sixteenth !== 15 || Math.random() > 0.45) return;
    const osc = ctx.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(1800, t);
    osc.frequency.exponentialRampToValueAtTime(300, t + 0.03);
    const g = envGain(t, 0.06, 0.001, 0.05);
    osc.connect(g).connect(delaySend);
    osc.start(t);
    osc.stop(t + 0.06);
  }

  function riser(t, c) {
    if (!c.tension || c.sixteenth !== 0) return;
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    hp.frequency.setValueAtTime(400, t);
    hp.frequency.exponentialRampToValueAtTime(6000, t + SIXTEENTH * 4);
    const g = envGain(t, 0.04, 0.05, SIXTEENTH * 3.5);
    src.connect(hp).connect(g).connect(delaySend);
    src.start(t);
    src.stop(t + SIXTEENTH * 4);
  }

  function fxMotion(t, c) {
    const fb = c.drop ? 0.12 : 0.22 + (c.energy / 100) * 0.18 + (c.tension ? 0.12 : 0);
    delayFbL.gain.setTargetAtTime(fb, t, 0.08);
    delayFbR.gain.setTargetAtTime(fb * 0.9, t, 0.08);
    delayL.delayTime.setTargetAtTime(EIGHTH * (1 + Math.sin(t * 0.15) * 0.012), t, 0.05);
    if (atmoGain) {
      const a = c.drop ? 0.01 : 0.018 + c.energy * 0.00025;
      atmoGain.gain.setTargetAtTime(a, t, 0.2);
      atmoFilter.frequency.setTargetAtTime(500 + c.energy * 8 + Math.sin(t * 0.07) * 120, t, 0.4);
    }
  }

  function schedule(s, t) {
    const c = clock(s);
    if (c.beat16 === 0) kick(t);
    bass(t, c);
    hats(t, c);
    ride(t, c);
    lead(t, c);
    laser(t, c);
    riser(t, c);
    fxMotion(t, c);
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

  function wireBus() {
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(ctx.destination);

    bassFilter = ctx.createBiquadFilter();
    bassFilter.type = "lowpass";
    bassFilter.frequency.value = 240;
    bassFilter.Q.value = 1.2;
    bassShaper = ctx.createWaveShaper();
    bassShaper.curve = shaperCurve(0.3);
    bassEq = ctx.createBiquadFilter();
    bassEq.type = "peaking";
    bassEq.frequency.value = 100;
    bassEq.gain.value = 4;
    bassEq.Q.value = 0.9;
    const mud = ctx.createBiquadFilter();
    mud.type = "peaking";
    mud.frequency.value = 320;
    mud.gain.value = -3;
    bassFilter.connect(bassShaper).connect(bassEq).connect(mud).connect(master);

    delaySend = ctx.createGain();
    delaySend.gain.value = 0.55;
    delayL = ctx.createDelay(1);
    delayR = ctx.createDelay(1);
    delayL.delayTime.value = EIGHTH;
    delayR.delayTime.value = EIGHTH * 1.5;
    delayFbL = ctx.createGain();
    delayFbR = ctx.createGain();
    delayFbL.gain.value = 0.25;
    delayFbR.gain.value = 0.22;
    delayHp = ctx.createBiquadFilter();
    delayHp.type = "highpass";
    delayHp.frequency.value = 280;
    delaySend.connect(delayL);
    delaySend.connect(delayR);
    delayL.connect(delayFbL).connect(delayL);
    delayR.connect(delayFbR).connect(delayR);
    delayL.connect(delayHp);
    delayR.connect(delayHp);
    delayHp.connect(master);

    atmoFilter = ctx.createBiquadFilter();
    atmoFilter.type = "lowpass";
    atmoFilter.frequency.value = 700;
    atmoGain = ctx.createGain();
    atmoGain.gain.value = 0.02;
    const atmo = ctx.createBufferSource();
    atmo.buffer = atmoBuf;
    atmo.loop = true;
    atmo.connect(atmoFilter).connect(atmoGain).connect(master);
    atmo.start();
  }

  async function start() {
    if (ctx) return;
    ctx = new AudioContext();
    noiseBuf = noiseBuffer(0.25, false);
    atmoBuf = noiseBuffer(2, true);
    wireBus();
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
