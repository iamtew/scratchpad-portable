const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function hsl(h, s, l) {
  s /= 100;
  l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
  };
  return (Math.round(f(0) * 255) << 16) | (Math.round(f(8) * 255) << 8) | Math.round(f(4) * 255);
}

const rand = (lo, hi) => lo + Math.random() * (hi - lo);

// Wide faint, then narrow bright. Pixi drops the path on each stroke, so rebuild it.
const GLOW = [[32, 0.07], [14, 0.3], [2.4, 1]];

function glowLine(g, pts, color, scale, gain) {
  if (pts.length < 4) return;
  for (let p = 0; p < GLOW.length; p++) {
    g.moveTo(pts[0], pts[1]);
    for (let i = 2; i < pts.length; i += 2) g.lineTo(pts[i], pts[i + 1]);
    g.stroke({
      width: GLOW[p][0] * scale,
      color,
      alpha: GLOW[p][1] * gain,
      cap: "round",
      join: "round",
    });
  }
}

function polyPoints(cx, cy, r, n, rot) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  return pts;
}

// Soft white dot. Tint and additive blend do the color.
function glowTexture(PIXI, size = 128) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const r = size / 2;
  const grd = g.createRadialGradient(r, r, 0, r, r, r);
  grd.addColorStop(0, "rgba(255,255,255,1)");
  grd.addColorStop(0.2, "rgba(255,255,255,0.55)");
  grd.addColorStop(0.5, "rgba(255,255,255,0.12)");
  grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return PIXI.Texture.from(c);
}

function glowSprite(PIXI, tex) {
  const s = new PIXI.Sprite(tex);
  s.anchor.set(0.5);
  s.blendMode = "add";
  return s;
}

function wrap(s, w, h, m = 48) {
  if (s.x < -m) s.x += w + m * 2;
  else if (s.x > w + m) s.x -= w + m * 2;
  if (s.y < -m) s.y += h + m * 2;
  else if (s.y > h + m) s.y -= h + m * 2;
}

// One hue and its pair for this 8-bar block. Energy only changes speed and level.
function gradeNow() {
  const music = window.TripMusic;
  const place = music && music.place
    ? music.place
    : { bar: 0, energy: 30, silence: false, sixteenth: 0 };
  const kickAge = music ? music.currentTime - music.lastKickTime : 9;
  const kick = Math.max(0, 1 - kickAge / 0.16);
  const section = Math.floor(place.bar / 8);
  const hue = (section * 47) % 360;
  const silence = !!place.silence;
  return {
    section,
    hue,
    hue2: (hue + 140) % 360,
    kick,
    sixteenth: place.sixteenth,
    drive: silence ? 0.2 : 0.4 + place.energy / 150,
    bright: silence ? 0.2 : Math.min(1, 0.55 + place.energy / 190),
  };
}

// The old rush, with glow instead of hairline strokes.
function tunnel(PIXI, tex) {
  const root = new PIXI.Container();
  const lines = new PIXI.Graphics();
  lines.blendMode = "add";
  root.addChild(lines);
  const rings = Array.from({ length: 12 }, (_, i) => {
    const sides = 6 + (i % 3);
    const orbs = [];
    for (let s = 0; s < sides; s++) {
      const o = glowSprite(PIXI, tex);
      o.side = s;
      root.addChild(o);
      orbs.push(o);
    }
    return { z: i / 12, sides, orbs };
  });
  const core = glowSprite(PIXI, tex);
  root.addChild(core);
  const rotOf = (i, t) => t * (0.11 + (i % 5) * 0.025) + i * 0.4;

  return {
    root,
    update(t, w, h, dt, grade) {
      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.hypot(cx, cy) * 1.12;
      const hit = 1 + grade.kick * 0.045;
      lines.clear();
      for (let i = 0; i < rings.length; i++) {
        const ring = rings[i];
        ring.z += grade.drive * 0.26 * dt;
        if (ring.z > 1) ring.z -= 1;
        const z = ring.z;
        const r = (12 + z * z * maxR) * hit;
        const rot = rotOf(i, t);
        const col = hsl(i % 2 ? grade.hue2 : grade.hue, 80, 62);
        glowLine(lines, polyPoints(cx, cy, r, ring.sides, rot), col, 0.28 + z * 0.85, grade.bright * (0.3 + z * 0.7));
        for (const o of ring.orbs) {
          const a = rot + (o.side / ring.sides) * Math.PI * 2;
          o.x = cx + Math.cos(a) * r;
          o.y = cy + Math.sin(a) * r;
          o.tint = col;
          o.scale.set((0.05 + z * 0.16) * (1 + grade.kick * 0.45));
          o.alpha = grade.bright * (0.25 + z * 0.7);
        }
      }
      core.x = cx;
      core.y = cy;
      core.tint = hsl(grade.hue, 70, 78);
      core.scale.set(0.7 + grade.kick * 0.55);
      core.alpha = grade.bright * (0.35 + grade.kick * 0.4);
    },
  };
}

// Streaks on a slow vector field, plus a few large dim orbs for depth.
function flow(PIXI, tex, w0, h0) {
  const root = new PIXI.Container();
  const n = Math.min(420, Math.max(120, Math.round((w0 * h0) / 4000)));
  const ps = [];
  for (let i = 0; i < n; i++) {
    const s = glowSprite(PIXI, tex);
    const big = Math.random() < 0.07;
    s.x = rand(0, w0);
    s.y = rand(0, h0);
    s.big = big;
    s.base = big ? rand(1.3, 2.6) : rand(0.07, 0.2);
    s.alpha0 = big ? rand(0.05, 0.11) : rand(0.4, 0.85);
    s.speed = big ? rand(8, 18) : rand(30, 78);
    s.pair = i % 2;
    root.addChild(s);
    ps.push(s);
  }
  return {
    root,
    update(t, w, h, dt, grade) {
      for (const s of ps) {
        const a = (Math.sin(s.x * 0.0023 + t * 0.16) + Math.cos(s.y * 0.0027 - t * 0.11)) * Math.PI;
        s.x += Math.cos(a) * s.speed * grade.drive * dt;
        s.y += Math.sin(a) * s.speed * grade.drive * dt;
        wrap(s, w, h);
        s.tint = hsl(s.pair ? grade.hue2 : grade.hue, 84, s.big ? 60 : 72);
        if (s.big) s.scale.set(s.base * (1 + grade.kick * 0.1));
        else s.scale.set(s.base * 3.1 * (1 + grade.kick * 0.35), s.base * (1 + grade.kick * 0.35));
        if (!s.big) s.rotation = a;
        s.alpha = s.alpha0 * grade.bright * (1 + grade.kick * 0.2);
      }
    },
  };
}

// Three counter-rotating polygons. Spokes stay off the core so the middle holds.
function mandala(PIXI, tex) {
  const root = new PIXI.Container();
  const g = new PIXI.Graphics();
  g.blendMode = "add";
  root.addChild(g);
  const core = glowSprite(PIXI, tex);
  root.addChild(core);
  const rings = [
    { n: 6, spin: 0.18, scale: 1, pair: 0 },
    { n: 8, spin: -0.27, scale: 0.62, pair: 1 },
    { n: 3, spin: 0.09, scale: 1.22, pair: 0 },
  ];
  return {
    root,
    update(t, w, h, dt, grade) {
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.4;
      g.clear();
      rings.forEach((ring, i) => {
        const rot = t * ring.spin * grade.drive;
        const r = R * ring.scale * (i === 1 ? 1 + grade.kick * 0.06 : 1);
        const col = hsl(ring.pair ? grade.hue2 : grade.hue, 82, 64);
        const pts = polyPoints(cx, cy, r, ring.n, rot);
        glowLine(g, pts, col, 0.7, grade.bright);
        if (i !== 0) return;
        for (let s = 0; s < ring.n; s++) {
          const a = rot + (s / ring.n) * Math.PI * 2;
          glowLine(g, [
            cx + Math.cos(a) * r * 0.22, cy + Math.sin(a) * r * 0.22,
            cx + Math.cos(a) * r, cy + Math.sin(a) * r,
          ], col, 0.32, grade.bright * 0.8);
        }
      });
      core.x = cx;
      core.y = cy;
      core.tint = hsl(grade.hue2, 75, 80);
      core.scale.set(0.85 + grade.kick * 0.5);
      core.alpha = grade.bright * (0.5 + grade.kick * 0.35);
    },
  };
}

// Floor grid running at the camera, sun on the horizon, bokeh in the sky.
function horizon(PIXI, tex, w0, h0) {
  const root = new PIXI.Container();
  const g = new PIXI.Graphics();
  g.blendMode = "add";
  root.addChild(g);
  const sun = glowSprite(PIXI, tex);
  root.addChild(sun);
  const sky = Array.from({ length: 16 }, () => {
    const s = glowSprite(PIXI, tex);
    s.x = rand(0, w0);
    s.y = rand(0, h0 * 0.5);
    s.base = rand(0.5, 1.8);
    s.vy = rand(10, 28);
    s.ph = rand(0, 6.28);
    s.pair = Math.random() < 0.5;
    root.addChild(s);
    return s;
  });
  return {
    root,
    update(t, w, h, dt, grade) {
      const yH = h * 0.46;
      const vx = w * (0.5 + Math.sin(t * 0.12) * 0.035);
      const col = hsl(grade.hue, 78, 60);
      const col2 = hsl(grade.hue2, 74, 64);
      g.clear();
      for (let i = 0; i <= 10; i++) {
        const u = i / 10;
        const x0 = vx + (u - 0.5) * w * 0.16;
        const x1 = w / 2 + (u - 0.5) * w * 1.55;
        glowLine(g, [x0, yH + 10, x1, h + 8], i % 2 ? col2 : col, 0.4, grade.bright * 0.85);
      }
      const scroll = (t * 0.32 * grade.drive) % 1;
      for (let i = 0; i < 9; i++) {
        const z = (i / 9 + scroll) % 1;
        const y = yH + z * z * (h * 1.04 - yH);
        const spread = 0.06 + z * 0.92;
        const fade = Math.sin(z * Math.PI);
        glowLine(g, [w / 2 - spread * w * 0.78, y, w / 2 + spread * w * 0.78, y], col, 0.3 + z * 0.55, grade.bright * fade);
      }
      sun.x = vx;
      sun.y = yH;
      sun.tint = hsl(grade.hue2, 65, 74);
      sun.scale.set(2.4 + grade.kick * 0.35);
      sun.alpha = grade.bright * 0.42;
      for (const s of sky) {
        s.y -= s.vy * grade.drive * dt;
        s.x += Math.sin(t * 0.35 + s.ph) * 10 * dt;
        if (s.y < -40) {
          s.y = yH + rand(0, 30);
          s.x = rand(0, w);
        }
        s.tint = hsl(s.pair ? grade.hue2 : grade.hue, 80, 68);
        s.scale.set(s.base * (1 + grade.kick * 0.12));
        s.alpha = grade.bright * (0.08 + 0.06 * Math.sin(t * 0.8 + s.ph));
      }
    },
  };
}

// A few large bodies and fine dust. The black is the point.
function orbit(PIXI, tex) {
  const root = new PIXI.Container();
  const g = new PIXI.Graphics();
  g.blendMode = "add";
  root.addChild(g);
  const core = glowSprite(PIXI, tex);
  root.addChild(core);
  const bodies = Array.from({ length: 5 }, (_, i) => {
    const s = glowSprite(PIXI, tex);
    s.orbit = 0.2 + i * 0.13;
    s.speed = (0.12 + i * 0.05) * (i % 2 ? -1 : 1);
    s.phase = (i / 5) * Math.PI * 2;
    s.base = 0.9 + (5 - i) * 0.28;
    s.flat = 0.42 + (i % 3) * 0.08;
    root.addChild(s);
    return s;
  });
  const dust = Array.from({ length: 48 }, () => {
    const s = glowSprite(PIXI, tex);
    s.orbit = rand(0.16, 0.86);
    s.speed = rand(-0.22, 0.22);
    s.phase = rand(0, 6.28);
    s.base = rand(0.035, 0.09);
    s.flat = rand(0.32, 0.7);
    root.addChild(s);
    return s;
  });
  return {
    root,
    update(t, w, h, dt, grade) {
      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.min(w, h) * 0.46;
      g.clear();
      const ringR = maxR * 0.46;
      const pts = [];
      for (let i = 0; i <= 72; i++) {
        const a = (i / 72) * Math.PI * 2 + t * 0.05;
        pts.push(cx + Math.cos(a) * ringR, cy + Math.sin(a) * ringR * 0.58);
      }
      glowLine(g, pts, hsl(grade.hue, 70, 64), 0.45, grade.bright * 0.55);
      core.x = cx;
      core.y = cy;
      core.tint = hsl(grade.hue, 60, 82);
      core.scale.set(1.7 + grade.kick * 0.65);
      core.alpha = grade.bright * (0.55 + grade.kick * 0.3);
      for (const s of bodies) {
        const a = s.phase + t * s.speed * grade.drive;
        s.x = cx + Math.cos(a) * s.orbit * maxR;
        s.y = cy + Math.sin(a) * s.orbit * maxR * s.flat;
        s.tint = hsl(grade.hue2, 72, 64);
        s.scale.set(s.base);
        s.alpha = grade.bright * 0.32;
      }
      for (const s of dust) {
        const a = s.phase + t * s.speed * grade.drive;
        s.x = cx + Math.cos(a) * s.orbit * maxR;
        s.y = cy + Math.sin(a) * s.orbit * maxR * s.flat;
        s.tint = hsl(grade.hue, 86, 74);
        s.scale.set(s.base * (1 + grade.kick * 0.3));
        s.alpha = grade.bright * 0.55;
      }
    },
  };
}

// Four sine ribbons. Sparks ride the same curve, so they stay glued to the line.
function ribbons(PIXI, tex) {
  const root = new PIXI.Container();
  const g = new PIXI.Graphics();
  g.blendMode = "add";
  root.addChild(g);
  const sparks = Array.from({ length: 40 }, (_, i) => {
    const s = glowSprite(PIXI, tex);
    s.ribbon = i % 4;
    s.u = Math.random();
    s.speed = rand(0.045, 0.11);
    s.base = rand(0.09, 0.2);
    root.addChild(s);
    return s;
  });
  function yAt(i, x, w, h, t, grade) {
    const cy = h * (0.2 + i * 0.2);
    const amp = h * (0.055 + i * 0.012) * (1 + grade.kick * 0.08);
    const k = (0.7 + i * 0.28) * grade.drive;
    return cy + Math.sin((x / w) * Math.PI * (2.2 + i * 0.45) + t * k + i) * amp;
  }
  return {
    root,
    update(t, w, h, dt, grade) {
      g.clear();
      for (let i = 0; i < 4; i++) {
        const pts = [];
        for (let x = -8; x <= w + 8; x += 10) pts.push(x, yAt(i, x, w, h, t, grade));
        glowLine(g, pts, hsl(i % 2 ? grade.hue2 : grade.hue, 82, 62), 0.72, grade.bright * (1 + grade.kick * 0.15));
      }
      for (const s of sparks) {
        s.u = (s.u + s.speed * grade.drive * dt) % 1;
        s.x = s.u * w;
        s.y = yAt(s.ribbon, s.x, w, h, t, grade);
        s.tint = hsl(s.ribbon % 2 ? grade.hue : grade.hue2, 90, 76);
        s.scale.set(s.base * (1 + grade.kick * 0.55));
        s.alpha = grade.bright * 0.8;
      }
    },
  };
}

let pixiStarted = false;

async function startPixi() {
  if (!window.PIXI || pixiStarted) return;
  pixiStarted = true;
  const PIXI = window.PIXI;
  const canvas = document.getElementById("pixi");
  const app = new PIXI.Application();
  await app.init({
    canvas,
    resizeTo: window,
    background: 0x050506,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(devicePixelRatio || 1, 2),
  });

  const tex = glowTexture(PIXI);
  const w0 = app.screen.width || innerWidth;
  const h0 = app.screen.height || innerHeight;
  // Order is the 8-bar cycle. Hue changes with the block, so a repeat is a new grade.
  const scenes = [
    tunnel(PIXI, tex),
    flow(PIXI, tex, w0, h0),
    mandala(PIXI, tex),
    horizon(PIXI, tex, w0, h0),
    orbit(PIXI, tex),
    ribbons(PIXI, tex),
  ];
  for (const s of scenes) {
    s.fade = 0;
    s.root.alpha = 0;
    app.stage.addChild(s.root);
  }
  scenes[0].fade = 1;
  scenes[0].root.alpha = 1;

  const shock = new PIXI.Graphics();
  shock.blendMode = "add";
  app.stage.addChild(shock);

  let t = 0;
  let shockT = 10;
  let prevKick = 0;

  const frame = (rawDt) => {
    const dt = reduceMotion ? 0 : Math.min(rawDt, 0.05);
    t += dt;
    const grade = gradeNow();
    const ease = reduceMotion ? 1 : Math.min(1, dt * 4.5);
    const active = grade.section % scenes.length;
    const { width: w, height: h } = app.screen;
    for (let i = 0; i < scenes.length; i++) {
      const s = scenes[i];
      const target = i === active ? 1 : 0;
      s.fade += (target - s.fade) * ease;
      // Square it. Additive lines at 30% still read as solid, so a linear fade stacks two pictures.
      s.root.alpha = s.fade * s.fade;
      s.root.visible = s.fade > 0.06;
      if (s.root.visible) s.update(t, w, h, dt, grade);
    }

    if (reduceMotion) return;
    const rising = grade.kick > 0.82 && prevKick <= 0.82;
    prevKick = grade.kick;
    const nearDown = grade.sixteenth <= 1 || grade.sixteenth >= 13;
    if (rising && nearDown) shockT = 0;
    shockT += dt;
    shock.clear();
    if (shockT < 0.46) {
      const u = shockT / 0.46;
      const r = (0.05 + u * 0.7) * Math.hypot(w, h);
      const col = hsl(grade.hue, 76, 70);
      const gain = (1 - u) * grade.bright;
      shock.circle(w / 2, h / 2, r);
      shock.stroke({ width: 26 * (1 - u), color: col, alpha: gain * 0.07, cap: "round" });
      shock.circle(w / 2, h / 2, r);
      shock.stroke({ width: 2.2, color: col, alpha: gain * 0.32, cap: "round" });
    }
  };

  app.ticker.add((ticker) => frame(ticker.deltaMS / 1000));
  if (reduceMotion) {
    // One still per section. The picture still cuts every 8 bars, it just does not travel.
    app.ticker.stop();
    let shown = -1;
    const still = () => {
      const section = window.TripMusic.place ? Math.floor(window.TripMusic.place.bar / 8) : 0;
      if (section === shown) return;
      shown = section;
      frame(0);
      app.render();
    };
    still();
    setInterval(still, 250);
  }
}

function setupAudioUi() {
  const mute = document.getElementById("mute");
  const vol = document.getElementById("vol");
  mute.addEventListener("click", () => {
    const on = mute.getAttribute("aria-pressed") === "true";
    mute.setAttribute("aria-pressed", String(!on));
    mute.setAttribute("aria-label", on ? "Mute" : "Unmute");
    window.TripMusic.setMuted(!on);
  });
  vol.addEventListener("input", () => {
    window.TripMusic.setVolume(vol.value);
    if (Number(vol.value) === 0) {
      mute.setAttribute("aria-pressed", "true");
      mute.setAttribute("aria-label", "Unmute");
      window.TripMusic.setMuted(true);
    } else if (mute.getAttribute("aria-pressed") === "true") {
      mute.setAttribute("aria-pressed", "false");
      mute.setAttribute("aria-label", "Mute");
      window.TripMusic.setMuted(false);
    }
  });
}

function fmtTime(sec) {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function paintTime() {
  const music = window.TripMusic;
  document.getElementById("time").textContent = `${fmtTime(music.elapsed)} / ${fmtTime(music.duration)}`;
}

function resetToBegin() {
  const gate = document.querySelector(".gate");
  const bar = document.querySelector(".bar");
  const begin = document.getElementById("begin");
  const seek = document.getElementById("seek");
  bar.hidden = true;
  gate.hidden = false;
  gate.classList.remove("fade");
  begin.disabled = false;
  seek.value = 0;
  paintTime();
  document.title = "Are you ready?";
}

function watchProgress() {
  const music = window.TripMusic;
  const seek = document.getElementById("seek");
  if (music.ended) return;
  if (seek.dataset.drag !== "1") seek.value = music.progress;
  paintTime();
  requestAnimationFrame(watchProgress);
}

function setupBegin() {
  const gate = document.querySelector(".gate");
  const bar = document.querySelector(".bar");
  const begin = document.getElementById("begin");
  const vol = document.getElementById("vol");
  const seek = document.getElementById("seek");
  window.TripMusic.onEnded = resetToBegin;
  paintTime();
  document.getElementById("stop").addEventListener("click", () => {
    window.TripMusic.stop();
  });
  seek.addEventListener("pointerdown", () => {
    seek.dataset.drag = "1";
  });
  seek.addEventListener("pointerup", () => {
    seek.dataset.drag = "0";
  });
  seek.addEventListener("pointercancel", () => {
    seek.dataset.drag = "0";
  });
  seek.addEventListener("input", () => {
    window.TripMusic.seek(seek.value);
    paintTime();
  });
  begin.addEventListener("click", async () => {
    begin.disabled = true;
    await window.TripMusic.start();
    window.TripMusic.setVolume(vol.value);
    seek.value = 0;
    paintTime();
    watchProgress();
    gate.classList.add("fade");
    startPixi();
    setTimeout(() => {
      gate.hidden = true;
      bar.hidden = false;
      document.title = "Trip Experience";
    }, 800);
  });
}

setupAudioUi();
setupBegin();
