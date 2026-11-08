// Live 144 BPM full-on: kick/bass engine, a rolling 303, and the mutating agents.
(function (global) {
  const BPM = 144;
  const SIXTEENTH = 60 / BPM / 4;
  const EIGHTH = 60 / BPM / 2;
  const LOOKAHEAD_MS = 25;
  const SCHEDULE_AHEAD = 0.12;
  // One pass. Each phrase is 16 bars. Then the track ends.
  const PHRASES = [
    { bars: 16, energy: 15 },
    { bars: 16, energy: 35 },
    { bars: 16, energy: 55 },
    { bars: 16, energy: 85 },
    { bars: 16, energy: 30 },
    { bars: 16, energy: 90 },
  ];
  const TOTAL_BARS = PHRASES.reduce((n, p) => n + p.bars, 0);
  const TOTAL_STEPS = TOTAL_BARS * 16;
  const BASS_MASKS = [
    [0, 1, 1, 1],
    [0, 1, 1, 0],
    [0, 1, 0, 1],
    [0, 1, 1, 1],
  ];
  const BASS_HZ = [41.2, 41.2, 49.0, 36.71];
  const LEAD_HZ = [329.63, 369.99, 415.3, 493.88, 554.37];
  // Semitones from the bass root, accent, slide into the next step.
  // Rests are null. Slides never run into a rest. Accents sit off the kick.
  const ACID = [
    [0, 0, 1],
    [12, 1, 0],
    [7, 0, 1],
    [3, 0, 0],
    null,
    [0, 0, 1],
    [3, 1, 0],
    [7, 0, 1],
    [10, 0, 0],
    [12, 1, 0],
    null,
    [7, 0, 1],
    [3, 0, 0],
    [0, 0, 1],
    [5, 1, 0],
    [7, 0, 0],
  ];

  let ctx;
  let sum;
  let kickIn;
  let kickTap;
  let tone;
  let master;
  let bassFilter;
  let bassShaper;
  let bassEq;
  let acidOsc;
  let acidFilter;
  let acidAmp;
  let acidHeld = false;
  let acidPeak = 0.055;
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
  let ended = false;
  let onEnded = null;

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
    const n = 1024;
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
    let acc = 0;
    let phrase = 0;
    let energy = PHRASES[0].energy;
    let barInPhrase = bar;
    for (let i = 0; i < PHRASES.length; i++) {
      const p = PHRASES[i];
      if (bar < acc + p.bars) {
        phrase = i;
        energy = p.energy;
        barInPhrase = bar - acc;
        break;
      }
      acc += p.bars;
    }
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
    // Knock lives around 150 Hz. Higher than that, and it becomes the click.
    const knock = ctx.createOscillator();
    knock.type = "sine";
    knock.frequency.setValueAtTime(150, t);
    knock.frequency.exponentialRampToValueAtTime(52, t + 0.035);
    const kg = envGain(t, 0.5, 0.002, 0.14);
    knock.connect(kg).connect(kickIn);
    knock.start(t);
    knock.stop(t + 0.2);

    // Sub tail. The knock is gone by 170 ms; this is the weight under it.
    const sub = ctx.createOscillator();
    sub.type = "sine";
    sub.frequency.setValueAtTime(70, t);
    sub.frequency.exponentialRampToValueAtTime(46, t + 0.08);
    const sg = envGain(t, 0.5, 0.004, 0.3);
    sub.connect(sg).connect(kickIn);
    sub.start(t);
    sub.stop(t + 0.34);

    // Short knock an octave up. This is the definition, and it is gone in 50 ms.
    const beater = ctx.createOscillator();
    beater.type = "sine";
    beater.frequency.setValueAtTime(300, t);
    beater.frequency.exponentialRampToValueAtTime(110, t + 0.02);
    const bg = envGain(t, 0.42, 0.001, 0.05);
    beater.connect(bg).connect(kickTap);
    beater.start(t);
    beater.stop(t + 0.07);

    lastKickTime = t;
  }

  function bass(t, c) {
    if (c.beat16 === 0) return;
    const mask = BASS_MASKS[Math.floor(c.bar / 8) % BASS_MASKS.length];
    if (!mask[c.beat16]) return;

    const cycle = Math.floor(c.bar / 8);
    const hz = BASS_HZ[cycle % BASS_HZ.length];
    if (c.beat16 === 1 && c.sixteenth === 1) {
      bassShaper.curve = shaperCurve(0.5 + (c.energy / 100) * 0.35);
    }

    const open = c.tension ? 180 : 0;
    const cut = 180 + c.energy * 1.6 + Math.sin(t * 0.35) * 40 + open;
    bassFilter.frequency.setTargetAtTime(Math.min(cut, 480), t, 0.03);
    bassFilter.Q.setTargetAtTime(c.tension ? 2.2 : 1.2, t, 0.05);

    // Sine is the fundamental the filtered saws lack, so the shaper warms a body.
    const body = ctx.createOscillator();
    body.type = "sine";
    body.frequency.value = hz;
    const bg = envGain(t, 0.25, 0.001, 0.1);
    body.connect(bg).connect(bassFilter);
    body.start(t);
    body.stop(t + 0.12);

    for (const detune of [-6, 6]) {
      const osc = ctx.createOscillator();
      osc.type = "sawtooth";
      osc.frequency.value = hz;
      osc.detune.value = detune;
      const g = envGain(t, 0.12, 0.001, 0.065);
      osc.connect(g).connect(bassFilter);
      osc.start(t);
      osc.stop(t + 0.085);
    }
  }

  function acidHz(semi, bar) {
    const root = BASS_HZ[Math.floor(bar / 8) % BASS_HZ.length] * 4;
    return root * Math.pow(2, semi / 12);
  }

  function acid(t, c) {
    const cell = ACID[c.sixteenth];
    if (!cell || c.energy < 35 || c.drop) {
      acidAmp.gain.cancelScheduledValues(t);
      acidAmp.gain.setTargetAtTime(0.0001, t, 0.02);
      acidHeld = false;
      return;
    }

    const semi = cell[0];
    const accent = cell[1];
    const slide = cell[2];
    const hz = acidHz(semi, c.bar);
    const next = ACID[(c.sixteenth + 1) % 16];
    const nextBar = c.sixteenth === 15 ? c.bar + 1 : c.bar;

    acidOsc.frequency.cancelScheduledValues(t);
    acidOsc.frequency.setValueAtTime(hz, t);
    // End just before the next step. The next note cancels from its own time,
    // and a ramp that lands on that time gets deleted before it can glide.
    if (slide && next) {
      acidOsc.frequency.exponentialRampToValueAtTime(acidHz(next[0], nextBar), t + SIXTEENTH - 0.001);
    }

    // A slide smears the pitch and leaves the filter alone.
    // An accent is the squelch, so it opens the filter even when the pitch slid in.
    const retrig = !acidHeld || accent;
    if (retrig) {
      // Env mod climbs and falls over 32 bars. Cutoff only drifts a little.
      const ride = 0.5 + 0.5 * Math.sin((c.bar / 32) * Math.PI * 2);
      const env = 450 + ride * 2200;
      const base = 400 + Math.sin(c.bar / 4) * 70;
      const peakF = Math.min(4600, base + env * (accent ? 1.55 : 1));
      const decay = accent ? 0.08 : 0.05;
      acidFilter.frequency.cancelScheduledValues(t);
      acidFilter.frequency.setValueAtTime(base, t);
      acidFilter.frequency.exponentialRampToValueAtTime(peakF, t + 0.012);
      acidFilter.frequency.exponentialRampToValueAtTime(base, t + 0.012 + decay);
      acidFilter.Q.setTargetAtTime(c.tension ? 20 : 16, t, 0.05);

      acidPeak = accent ? 0.09 : 0.055;
      acidAmp.gain.cancelScheduledValues(t);
      acidAmp.gain.setValueAtTime(0.0001, t);
      acidAmp.gain.exponentialRampToValueAtTime(acidPeak, t + 0.004);
      if (!slide) {
        acidAmp.gain.setValueAtTime(acidPeak, t + SIXTEENTH * 0.62);
        acidAmp.gain.exponentialRampToValueAtTime(0.0001, t + SIXTEENTH * 0.95);
      }
    } else if (!slide) {
      acidAmp.gain.cancelScheduledValues(t);
      acidAmp.gain.setValueAtTime(acidPeak, t);
      acidAmp.gain.exponentialRampToValueAtTime(0.0001, t + SIXTEENTH * 0.9);
    }

    acidHeld = !!slide;
  }

  function hats(t, c) {
    if (c.drop) return;
    const sixteenth = c.sixteenth;
    const closed = sixteenth % 2 === 1;
    const extra = c.energy > 50 && Math.random() < 0.3;
    if (!closed && !extra) return;
    if (closed && c.energy < 20 && sixteenth % 4 !== 1) return;
    const open = c.energy > 60 && (sixteenth === 6 || sixteenth === 14);
    const decay = open ? 0.16 : 0.045;
    const peak = open ? 0.05 : 0.04;
    // Air on top, a tick under it. Hiss alone is what made this thin.
    noiseBurst(t, sum, peak, 0.001, decay, "highpass", open ? 7000 : 6500, 0.7);
    noiseBurst(t, sum, peak * 0.75, 0.001, decay * 0.75, "bandpass", open ? 5000 : 4200, 1.4);
    if (Math.random() < (c.energy < 20 ? 0.35 : 0.8)) {
      noiseBurst(
        t,
        sum,
        0.016 + Math.random() * 0.02,
        0.002,
        0.045 + Math.random() * 0.03,
        "bandpass",
        5200 + Math.random() * 1800,
        2
      );
    }
  }

  function ride(t, c) {
    if (c.energy < 70 || c.sixteenth % 4 !== 2) return;
    noiseBurst(t, sum, 0.02, 0.002, 0.22, "highpass", 6500, 0.4);
    const car = ctx.createOscillator();
    const mod = ctx.createOscillator();
    const modG = ctx.createGain();
    modG.gain.value = 80;
    mod.frequency.value = 640;
    car.frequency.value = 320;
    const g = envGain(t, 0.012, 0.002, 0.2);
    mod.connect(modG).connect(car.frequency);
    car.connect(g).connect(sum);
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
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 3 + Math.sin(t * 2.1) * 1.2;
    lp.frequency.setValueAtTime(700 + c.energy * 12, t);
    lp.frequency.exponentialRampToValueAtTime(400 + c.energy * 8, t + 0.14);
    const peak = 0.04 + (c.energy / 100) * 0.045;
    // Same note, not an octave down. Body in the mids, not a second bass.
    const body = ctx.createOscillator();
    body.type = "sine";
    body.frequency.value = note;
    const bg = envGain(t, peak * 0.45, 0.004, 0.13);
    body.connect(bg).connect(lp);
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.value = note;
    const g = envGain(t, peak, 0.002, 0.12);
    osc.connect(g).connect(lp);
    lp.connect(tone);
    body.start(t);
    osc.start(t);
    body.stop(t + 0.16);
    osc.stop(t + 0.15);
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
    acid(t, c);
    hats(t, c);
    ride(t, c);
    lead(t, c);
    laser(t, c);
    riser(t, c);
    fxMotion(t, c);
  }

  function tick() {
    if (!ctx || ended) return;
    while (nextTime < ctx.currentTime + SCHEDULE_AHEAD) {
      if (step >= TOTAL_STEPS) {
        finish();
        return;
      }
      schedule(step, nextTime);
      step += 1;
      nextTime += SIXTEENTH;
    }
    timer = setTimeout(tick, LOOKAHEAD_MS);
  }

  function stop() {
    const wasLive = !!ctx;
    clearTimeout(timer);
    timer = 0;
    const dying = ctx;
    ctx = null;
    sum = null;
    kickIn = null;
    kickTap = null;
    tone = null;
    master = null;
    step = 0;
    lastKickTime = -99;
    acidHeld = false;
    if (dying) dying.close();
    if (wasLive && !ended) {
      ended = true;
      if (onEnded) onEnded();
    }
  }

  function finish() {
    if (ended) return;
    ended = true;
    if (master && ctx) master.gain.setTargetAtTime(0, ctx.currentTime, 0.04);
    const cb = onEnded;
    setTimeout(() => {
      stop();
      if (cb) cb();
    }, 280);
  }

  function applyGain() {
    if (!master) return;
    master.gain.setTargetAtTime(muted ? 0 : volume, ctx.currentTime, 0.03);
  }

  function wireBus() {
    // The curve clamps past ±1. Trim first, glue, then makeup. That clamp is the clip.
    sum = ctx.createGain();
    sum.gain.value = 0.55;
    // Stereo, so the acid offset is not folded back to the center.
    // Mono sources still copy to both sides.
    sum.channelCount = 2;
    sum.channelCountMode = "explicit";
    const glue = ctx.createWaveShaper();
    glue.curve = shaperCurve(0.4);
    glue.oversample = "2x";
    const makeup = ctx.createGain();
    makeup.gain.value = 1.35;
    const air = ctx.createBiquadFilter();
    air.type = "highshelf";
    air.frequency.value = 7500;
    air.gain.value = -3;
    master = ctx.createGain();
    master.gain.value = volume;
    sum.connect(glue).connect(makeup).connect(air).connect(master).connect(ctx.destination);

    // Shaper stays cool. Level comes back after the lowpass, so the knock is audible.
    kickIn = ctx.createGain();
    kickIn.gain.value = 0.55;
    const kickWarm = ctx.createWaveShaper();
    kickWarm.curve = shaperCurve(0.25);
    kickWarm.oversample = "2x";
    const kickBody = ctx.createBiquadFilter();
    kickBody.type = "lowpass";
    kickBody.frequency.value = 700;
    const kickLevel = ctx.createGain();
    kickLevel.gain.value = 1.5;
    kickIn.connect(kickWarm).connect(kickBody);
    kickTap = kickBody;
    kickBody.connect(kickLevel).connect(sum);

    bassFilter = ctx.createBiquadFilter();
    bassFilter.type = "lowpass";
    bassFilter.frequency.value = 240;
    bassFilter.Q.value = 1.2;
    bassShaper = ctx.createWaveShaper();
    bassShaper.curve = shaperCurve(0.5);
    bassShaper.oversample = "2x";
    bassEq = ctx.createBiquadFilter();
    bassEq.type = "peaking";
    bassEq.frequency.value = 100;
    bassEq.gain.value = 4;
    bassEq.Q.value = 0.9;
    const mud = ctx.createBiquadFilter();
    mud.type = "peaking";
    mud.frequency.value = 320;
    mud.gain.value = -1.5;
    bassFilter.connect(bassShaper).connect(bassEq).connect(mud).connect(sum);

    // Lead saturator feeds the dry mix and the delay, so the echoes match the note.
    tone = ctx.createGain();
    const toneWarm = ctx.createWaveShaper();
    toneWarm.curve = shaperCurve(0.3);
    toneWarm.oversample = "2x";
    tone.connect(toneWarm);
    toneWarm.connect(sum);

    delaySend = ctx.createGain();
    delaySend.gain.value = 0.55;
    toneWarm.connect(delaySend);
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
    delayHp.connect(sum);

    // One saw for the whole track. Resonance stays high; the cutoff envelope squelches.
    // The slow oscillator drifts under that envelope. The shaper fattens the resonant peak.
    acidOsc = ctx.createOscillator();
    acidOsc.type = "sawtooth";
    acidOsc.frequency.value = BASS_HZ[0] * 4;
    acidFilter = ctx.createBiquadFilter();
    acidFilter.type = "lowpass";
    acidFilter.frequency.value = 420;
    acidFilter.Q.value = 16;
    const acidLfo = ctx.createOscillator();
    acidLfo.frequency.value = 0.15;
    const acidDrift = ctx.createGain();
    acidDrift.gain.value = 140;
    acidLfo.connect(acidDrift).connect(acidFilter.frequency);
    const acidShaper = ctx.createWaveShaper();
    acidShaper.curve = shaperCurve(0.65);
    acidShaper.oversample = "2x";
    const acidHp = ctx.createBiquadFilter();
    acidHp.type = "highpass";
    acidHp.frequency.value = 180;
    acidAmp = ctx.createGain();
    acidAmp.gain.value = 0.0001;
    const acidSend = ctx.createGain();
    acidSend.gain.value = 0.14;
    // One side a few milliseconds late. The voice is still one saw.
    // The delay send taps the mono amp, so the echoes are not a second copy of that offset.
    const acidMerge = ctx.createChannelMerger(2);
    const acidHaas = ctx.createDelay(0.05);
    acidHaas.delayTime.value = 0.014;
    acidOsc.connect(acidFilter).connect(acidShaper).connect(acidHp).connect(acidAmp);
    acidAmp.connect(acidMerge, 0, 0);
    acidAmp.connect(acidHaas);
    acidHaas.connect(acidMerge, 0, 1);
    acidMerge.connect(sum);
    acidAmp.connect(acidSend).connect(delaySend);
    acidOsc.start();
    acidLfo.start();

    atmoFilter = ctx.createBiquadFilter();
    atmoFilter.type = "lowpass";
    atmoFilter.frequency.value = 700;
    atmoGain = ctx.createGain();
    atmoGain.gain.value = 0.02;
    const atmo = ctx.createBufferSource();
    atmo.buffer = atmoBuf;
    atmo.loop = true;
    atmo.connect(atmoFilter).connect(atmoGain).connect(sum);
    atmo.start();
  }

  async function start() {
    if (ctx) return;
    ended = false;
    step = 0;
    lastKickTime = 0;
    acidHeld = false;
    ctx = new AudioContext();
    noiseBuf = noiseBuffer(0.25, false);
    atmoBuf = noiseBuffer(2, true);
    wireBus();
    await ctx.resume();
    nextTime = ctx.currentTime + 0.05;
    tick();
  }

  global.TripMusic = {
    start,
    stop,
    set onEnded(fn) {
      onEnded = fn;
    },
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
    seek(p) {
      if (!ctx || ended) return;
      const frac = Math.max(0, Math.min(1, Number(p)));
      step = Math.min(TOTAL_STEPS - 1, Math.floor(frac * TOTAL_STEPS));
      nextTime = ctx.currentTime;
      acidHeld = false;
      if (acidAmp) acidAmp.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.02);
    },
    get progress() {
      return Math.min(1, step / TOTAL_STEPS);
    },
    get duration() {
      return TOTAL_STEPS * SIXTEENTH;
    },
    get elapsed() {
      return Math.min(TOTAL_STEPS, step) * SIXTEENTH;
    },
    get ended() {
      return ended;
    },
  };
})(window);
