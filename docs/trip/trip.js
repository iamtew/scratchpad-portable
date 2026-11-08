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

// Two offset glows so a cloud is a lump, not a disk.
function cloudTexture(PIXI, size = 256) {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d");
  ctx.globalCompositeOperation = "lighter";
  const r = size / 2;
  for (const [ox, oy] of [[-0.14, -0.1], [0.16, 0.12]]) {
    const grd = ctx.createRadialGradient(r + ox * r, r + oy * r, 0, r, r, r * 0.92);
    grd.addColorStop(0, "rgba(255,255,255,0.9)");
    grd.addColorStop(0.35, "rgba(255,255,255,0.35)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, size, size);
  }
  return PIXI.Texture.from(c);
}

// Tear round blobs into gas. Warp UVs with fbm, then cut alpha with the same noise.
const VAPOUR_FRAG = `
in vec2 vTextureCoord;
out vec4 finalColor;
uniform sampler2D uTexture;
uniform float uTime;
uniform float uAmt;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p) {
  float s = 0.0;
  float a = 0.5;
  for (int i = 0; i < 4; i++) {
    s += a * noise(p);
    p *= 2.03;
    a *= 0.5;
  }
  return s;
}

void main() {
  vec2 uv = vTextureCoord;
  float n = fbm(uv * 4.0 + vec2(uTime * 0.07, uTime * 0.05));
  float n2 = fbm(uv * 3.0 + vec2(8.0, uTime * 0.04));
  vec2 warp = vec2(n - 0.5, n2 - 0.5) * uAmt;
  vec2 sampleUv = clamp(uv + warp, 0.0, 1.0);
  vec4 c = texture(uTexture, sampleUv);
  c.rgb *= 0.75 + 0.5 * n;
  c.a *= 0.65 + 0.4 * n;
  finalColor = c;
}
`;

function vapourFilter(PIXI, uAmt) {
  const filter = new PIXI.Filter({
    glProgram: PIXI.GlProgram.from({
      vertex: PIXI.defaultFilterVert,
      fragment: VAPOUR_FRAG,
      name: "vapour-noise",
    }),
    resources: {
      warpUniforms: {
        uTime: { value: 0, type: "f32" },
        uAmt: { value: uAmt, type: "f32" },
      },
    },
    padding: 40,
  });
  filter.blendMode = "add";
  return filter;
}

// Faint gas. spec: n, smoke, rush, flat, tight, base, uAmt, band.
function vapour(PIXI, tex, spec = {}) {
  const n = spec.n ?? 28;
  const smokeN = Math.round(n * (spec.smoke ?? 0.5));
  const rushSpd = spec.rush ?? 0.35;
  const flat = spec.flat ?? 1;
  const tight = spec.tight ?? 0.15;
  const baseLo = spec.base ? spec.base[0] : 3.4;
  const baseHi = spec.base ? spec.base[1] : 7;
  const band = spec.band;
  const uAmt = spec.uAmt ?? 0.14;
  const root = new PIXI.Container();
  root.blendMode = "add";
  const warp = vapourFilter(PIXI, uAmt);
  root.filters = [warp];
  const uniforms = warp.resources.warpUniforms.uniforms;
  const ps = [];
  for (let i = 0; i < n; i++) {
    const s = glowSprite(PIXI, tex);
    s.smoke = i < smokeN;
    s.z = Math.random();
    s.u = Math.random();
    s.v = band ? band.y + (Math.random() - 0.5) * band.spread : Math.random();
    s.ph = rand(0, 6.28);
    s.base = rand(baseLo, baseHi);
    s.alpha0 = rand(0.12, 0.22);
    s.pair = i % 2;
    s.rot0 = rand(0, Math.PI);
    root.addChild(s);
    ps.push(s);
  }
  return {
    root,
    update(t, w, h, dt, grade) {
      uniforms.uTime = t;
      const cx = w / 2;
      const cy = h / 2;
      for (const s of ps) {
        s.tint = hsl(s.pair ? grade.hue2 : grade.hue, 78, 48);
        if (s.smoke) {
          s.x = s.u * w + Math.sin(t * 0.08 + s.ph) * w * 0.08;
          s.y = s.v * h + Math.cos(t * 0.06 + s.ph) * h * 0.05 * flat;
          s.scale.set(s.base * (1.1 + Math.sin(t * 0.15 + s.ph) * 0.2), s.base * (1.1 + Math.sin(t * 0.15 + s.ph) * 0.2) * flat);
          s.alpha = s.alpha0 * grade.bright * (0.45 + 0.25 * Math.sin(t * 0.2 + s.ph));
          s.rotation = s.rot0 + t * 0.03;
        } else {
          s.z = rush(s.z, dt * rushSpd, grade);
          const lift = fly(s.z);
          s.x = cx + (s.u - 0.5) * w * (tight + lift * 1.1);
          s.y = cy + (s.v - 0.5) * h * (tight + lift * 1.1) * flat;
          s.scale.set(s.base * (0.4 + lift * 1.4), s.base * (0.4 + lift * 1.4) * flat);
          s.alpha = s.alpha0 * grade.bright * (0.15 + 0.7 * Math.sin(s.z * Math.PI));
        }
      }
    },
  };
}

function addVapour(scene, PIXI, cloud, spec) {
  const mist = vapour(PIXI, cloud, spec);
  scene.root.addChildAt(mist.root, 0);
  const draw = scene.update;
  scene.update = (t, w, h, dt, grade) => {
    mist.update(t, w, h, dt, grade);
    draw(t, w, h, dt, grade);
  };
}

// Forward travel. z 0 is far (small, at the center), z 1 has passed the camera.
// About 3 seconds to cross at mid energy. Reduced motion passes dt 0, so it holds.
function rush(z, dt, grade) {
  z += dt * (0.18 + grade.drive * 0.2) * (1 + grade.kick * 0.35);
  return z >= 1 ? z - 1 : z;
}

function fly(z) {
  return z * z;
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
        ring.z = rush(ring.z, dt, grade);
        const z = ring.z;
        const r = (12 + fly(z) * maxR) * hit;
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

// Streaks born at the center. They curl, then fly out and grow.
function flow(PIXI, tex, w0, h0) {
  const root = new PIXI.Container();
  const n = Math.min(420, Math.max(120, Math.round((w0 * h0) / 4000)));
  const ps = [];
  for (let i = 0; i < n; i++) {
    const s = glowSprite(PIXI, tex);
    const big = Math.random() < 0.12;
    s.big = big;
    s.z = Math.random();
    s.ang = rand(0, Math.PI * 2);
    s.curl = rand(-0.7, 0.7);
    s.base = big ? rand(1.8, 3.4) : rand(0.07, 0.2);
    s.alpha0 = big ? rand(0.06, 0.14) : rand(0.4, 0.85);
    s.pair = i % 2;
    root.addChild(s);
    ps.push(s);
  }
  return {
    root,
    update(t, w, h, dt, grade) {
      const cx = w / 2;
      const cy = h / 2;
      const reach = Math.hypot(cx, cy) * 1.15;
      for (const s of ps) {
        const prev = s.z;
        s.z = rush(s.z, dt * (s.big ? 0.42 : 1), grade);
        if (s.z < prev) s.ang = rand(0, Math.PI * 2);
        s.ang += s.curl * dt * (1.5 - s.z);
        const rad = fly(s.z) * reach;
        s.x = cx + Math.cos(s.ang) * rad;
        s.y = cy + Math.sin(s.ang) * rad * 0.86;
        const grow = 0.35 + fly(s.z) * 2.4;
        s.tint = hsl(s.pair ? grade.hue2 : grade.hue, 84, s.big ? 60 : 72);
        if (s.big) s.scale.set(s.base * grow * 0.7 * (1 + grade.kick * 0.1));
        else s.scale.set(s.base * 3.2 * grow * (1 + grade.kick * 0.35), s.base * grow);
        if (!s.big) s.rotation = s.ang;
        s.alpha = s.alpha0 * grade.bright * (0.2 + s.z * 0.9) * (1 + grade.kick * 0.2);
      }
    },
  };
}

// One mandala at three depths. Each copy grows from the center and flies past.
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
  let z = 0;
  return {
    root,
    update(t, w, h, dt, grade) {
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.42;
      z = rush(z, dt, grade);
      g.clear();
      rings.forEach((ring, i) => {
        const depth = (z + i / 3) % 1;
        const rot = t * ring.spin * grade.drive;
        const r = R * ring.scale * (0.15 + fly(depth) * 2.2) * (i === 1 ? 1 + grade.kick * 0.06 : 1);
        const fade = Math.sin(depth * Math.PI);
        const col = hsl(ring.pair ? grade.hue2 : grade.hue, 82, 64);
        const pts = polyPoints(cx, cy, r, ring.n, rot);
        glowLine(g, pts, col, 0.55 + depth * 0.4, grade.bright * fade);
        if (i !== 0) return;
        for (let s = 0; s < ring.n; s++) {
          const a = rot + (s / ring.n) * Math.PI * 2;
          glowLine(g, [
            cx + Math.cos(a) * r * 0.22, cy + Math.sin(a) * r * 0.22,
            cx + Math.cos(a) * r, cy + Math.sin(a) * r,
          ], col, 0.28, grade.bright * fade * 0.8);
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

// Floor and ceiling grids from one vanishing point. Floor is hue, ceiling is hue2.
function horizon(PIXI, tex) {
  const root = new PIXI.Container();
  const sky = Array.from({ length: 16 }, () => {
    const s = glowSprite(PIXI, tex);
    s.u = Math.random();
    s.z = Math.random();
    s.base = rand(0.5, 1.8);
    s.ph = rand(0, 6.28);
    s.pair = Math.random() < 0.5;
    root.addChild(s);
    return s;
  });
  const g = new PIXI.Graphics();
  g.blendMode = "add";
  root.addChild(g);
  const sun = glowSprite(PIXI, tex);
  root.addChild(sun);
  let scroll = 0;
  return {
    root,
    update(t, w, h, dt, grade) {
      const yH = h * 0.46;
      const vx = w * (0.5 + Math.sin(t * 0.12) * 0.035);
      const floorCol = hsl(grade.hue, 78, 60);
      const ceilCol = hsl(grade.hue2, 74, 64);
      scroll = rush(scroll, dt, grade);
      g.clear();
      const drawGrid = (yNear, color) => {
        const yFar = yNear > yH ? yH + 10 : yH - 10;
        for (let i = 0; i <= 10; i++) {
          const u = i / 10;
          const x0 = vx + (u - 0.5) * w * 0.16;
          const x1 = w / 2 + (u - 0.5) * w * 1.55;
          glowLine(g, [x0, yFar, x1, yNear], color, 0.4, grade.bright * 0.85);
        }
        for (let i = 0; i < 9; i++) {
          const z = (i / 9 + scroll) % 1;
          const y = yH + fly(z) * (yNear - yH);
          const spread = 0.06 + z * 0.92;
          const fade = Math.sin(z * Math.PI);
          glowLine(g, [w / 2 - spread * w * 0.78, y, w / 2 + spread * w * 0.78, y], color, 0.3 + z * 0.55, grade.bright * fade);
        }
      };
      drawGrid(h + 8, floorCol);
      drawGrid(-8, ceilCol);
      sun.x = vx;
      sun.y = yH;
      sun.tint = hsl(grade.hue2, 65, 74);
      sun.scale.set(2.4 + grade.kick * 0.35);
      sun.alpha = grade.bright * 0.42;
      for (const s of sky) {
        s.z = rush(s.z, dt * 0.7, grade);
        const lift = fly(s.z);
        s.x = w * 0.5 + (s.u - 0.5) * w * (0.2 + lift * 1.2);
        s.y = yH - lift * h * 0.62 + Math.sin(t * 0.35 + s.ph) * 6;
        s.tint = hsl(s.pair ? grade.hue2 : grade.hue, 80, 68);
        s.scale.set(s.base * (0.35 + lift * 1.6) * (1 + grade.kick * 0.12));
        s.alpha = grade.bright * (0.04 + 0.18 * Math.sin(s.z * Math.PI));
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
    s.orbit = 0.55 + (i % 3) * 0.18;
    s.speed = (0.12 + i * 0.05) * (i % 2 ? -1 : 1);
    s.phase = (i / 5) * Math.PI * 2;
    s.base = 0.9 + (5 - i) * 0.28;
    s.flat = 0.42 + (i % 3) * 0.08;
    s.z = i / 5;
    root.addChild(s);
    return s;
  });
  const dust = Array.from({ length: 48 }, () => {
    const s = glowSprite(PIXI, tex);
    s.orbit = rand(0.45, 1);
    s.speed = rand(-0.22, 0.22);
    s.phase = rand(0, 6.28);
    s.base = rand(0.035, 0.09);
    s.flat = rand(0.32, 0.7);
    s.z = Math.random();
    root.addChild(s);
    return s;
  });
  let ringZ = 0;
  return {
    root,
    update(t, w, h, dt, grade) {
      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.min(w, h) * 0.52;
      ringZ = rush(ringZ, dt, grade);
      g.clear();
      for (let k = 0; k < 2; k++) {
        const depth = (ringZ + k * 0.5) % 1;
        const ringR = maxR * (0.12 + fly(depth) * 1.15);
        const pts = [];
        for (let i = 0; i <= 72; i++) {
          const a = (i / 72) * Math.PI * 2 + t * 0.05;
          pts.push(cx + Math.cos(a) * ringR, cy + Math.sin(a) * ringR * 0.58);
        }
        glowLine(g, pts, hsl(grade.hue, 70, 64), 0.4 + depth * 0.25, grade.bright * 0.55 * Math.sin(depth * Math.PI));
      }
      core.x = cx;
      core.y = cy;
      core.tint = hsl(grade.hue, 60, 82);
      core.scale.set(1.7 + grade.kick * 0.65);
      core.alpha = grade.bright * (0.55 + grade.kick * 0.3);
      for (const s of bodies) {
        s.z = rush(s.z, dt, grade);
        const a = s.phase + t * s.speed * grade.drive;
        const rad = s.orbit * (0.2 + fly(s.z) * 1.6) * maxR;
        s.x = cx + Math.cos(a) * rad;
        s.y = cy + Math.sin(a) * rad * s.flat;
        s.tint = hsl(grade.hue2, 72, 64);
        s.scale.set(s.base * (0.35 + fly(s.z) * 1.2));
        s.alpha = grade.bright * 0.4 * (0.25 + s.z);
      }
      for (const s of dust) {
        s.z = rush(s.z, dt, grade);
        const a = s.phase + t * s.speed * grade.drive;
        const rad = s.orbit * (0.2 + fly(s.z) * 1.6) * maxR;
        s.x = cx + Math.cos(a) * rad;
        s.y = cy + Math.sin(a) * rad * s.flat;
        s.tint = hsl(grade.hue, 86, 74);
        s.scale.set(s.base * (0.4 + fly(s.z) * 1.8) * (1 + grade.kick * 0.3));
        s.alpha = grade.bright * 0.55 * (0.2 + s.z);
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
    s.slot = i % 3;
    s.u = Math.random();
    s.speed = rand(0.045, 0.11);
    s.base = rand(0.09, 0.2);
    root.addChild(s);
    return s;
  });
  let z = 0;
  function yAt(i, x, w, h, t, grade, depth) {
    const spread = 0.16 + fly(depth) * 0.95;
    const cy = h * 0.5 + (i - 1.5) * h * 0.24 * spread;
    const amp = h * (0.045 + i * 0.01) * spread * (1 + grade.kick * 0.08);
    const k = (0.7 + i * 0.28) * grade.drive;
    return cy + Math.sin((x / w) * Math.PI * (2.2 + i * 0.45) + t * k + i) * amp;
  }
  return {
    root,
    update(t, w, h, dt, grade) {
      z = rush(z, dt, grade);
      g.clear();
      for (let d = 0; d < 3; d++) {
        const depth = (z + d / 3) % 1;
        const fade = Math.sin(depth * Math.PI);
        for (let i = 0; i < 4; i++) {
          const pts = [];
          for (let x = -8; x <= w + 8; x += 10) pts.push(x, yAt(i, x, w, h, t, grade, depth));
          glowLine(g, pts, hsl(i % 2 ? grade.hue2 : grade.hue, 82, 62), 0.45 + depth * 0.4, grade.bright * fade * (1 + grade.kick * 0.15));
        }
      }
      for (const s of sparks) {
        const depth = (z + s.slot / 3) % 1;
        s.u = (s.u + s.speed * grade.drive * dt) % 1;
        s.x = s.u * w;
        s.y = yAt(s.ribbon, s.x, w, h, t, grade, depth);
        s.tint = hsl(s.ribbon % 2 ? grade.hue : grade.hue2, 90, 76);
        s.scale.set(s.base * (0.4 + fly(depth) * 1.8) * (1 + grade.kick * 0.55));
        s.alpha = grade.bright * 0.85 * (0.25 + depth);
      }
    },
  };
}

async function loadCode() {
  const urls = ["trip.js", "music.js", "../js/site.js"];
  const parts = await Promise.all(
    urls.map((u) => fetch(u).then((r) => (r.ok ? r.text() : "")).catch(() => ""))
  );
  return parts.filter(Boolean).join("\n\n");
}

function codeTexture(PIXI, src) {
  const fs = 11;
  const lh = 13;
  const cols = 64;
  const rows = 96;
  const pad = 6;
  const lines = [];
  for (const raw of src.split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (line.length <= cols) lines.push(line);
    else {
      for (let i = 0; i < line.length; i += cols) lines.push(line.slice(i, i + cols));
    }
  }
  if (!lines.length) return null;
  const c = document.createElement("canvas");
  c.width = pad * 2 + cols * 7;
  c.height = pad * 2 + rows * lh;
  const g = c.getContext("2d");
  g.font = `${fs}px ui-monospace, Consolas, "Cascadia Mono", monospace`;
  g.fillStyle = "#fff";
  g.textBaseline = "top";
  for (let i = 0; i < rows; i++) g.fillText(lines[i % lines.length], pad, pad + i * lh);
  return PIXI.Texture.from(c);
}

// Faint pages of the site's own JS. Behind vapour. Not meant to be read.
// Left and right of center, leaned in so the walls follow the rush.
function codeRain(PIXI, tex) {
  const root = new PIXI.Container();
  const specs = [
    { side: -1, x: 0.2, scale: 1.02, speed: 28, ph: 0, tilt: 0.5 },
    { side: -1, x: 0.08, scale: 0.8, speed: 17, ph: 1.7, tilt: 0.36 },
    { side: 1, x: 0.8, scale: 1.02, speed: 30, ph: 2.4, tilt: 0.5 },
    { side: 1, x: 0.92, scale: 0.8, speed: 16, ph: 4.1, tilt: 0.36 },
  ];
  const cols = specs.map((spec) => {
    const pair = new PIXI.Container();
    const a = new PIXI.Sprite(tex);
    const b = new PIXI.Sprite(tex);
    a.anchor.set(0.5, 0);
    b.anchor.set(0.5, 0);
    a.scale.set(spec.scale);
    b.scale.set(spec.scale);
    pair.addChild(a, b);
    root.addChild(pair);
    return { pair, a, b, spec, y: Math.random() * tex.height * spec.scale };
  });
  return {
    root,
    update(t, w, h, dt, grade) {
      for (const col of cols) {
        const sh = tex.height * col.spec.scale;
        col.y += (col.spec.speed + grade.drive * 18 + grade.kick * 10) * dt;
        if (col.y >= sh) col.y -= sh;
        col.pair.x = w * col.spec.x;
        col.pair.y = h * 0.5;
        col.pair.rotation = -col.spec.side * col.spec.tilt;
        col.a.y = col.y - sh / 2;
        col.b.y = col.y - sh / 2 - sh;
        const mix = 0.5 + 0.5 * Math.sin(t * 0.32 + col.spec.ph);
        const hue = (grade.hue + mix * 140 + t * 12 + col.spec.ph * 18) % 360;
        const tint = hsl(hue, 72, 62);
        col.a.tint = tint;
        col.b.tint = tint;
        col.pair.alpha = (0.11 + 0.09 * Math.sin(t * 0.48 + col.spec.ph)) * grade.bright;
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
    preference: "webgl",
    antialias: true,
    autoDensity: true,
    resolution: Math.min(devicePixelRatio || 1, 2),
  });

  const src = await loadCode();
  const codeTex = src ? codeTexture(PIXI, src) : null;
  const code = codeTex ? codeRain(PIXI, codeTex) : null;
  if (code) app.stage.addChildAt(code.root, 0);

  const tex = glowTexture(PIXI);
  const cloud = cloudTexture(PIXI);
  const w0 = app.screen.width || innerWidth;
  const h0 = app.screen.height || innerHeight;
  // Order is the 8-bar cycle. Hue changes with the block, so a repeat is a new grade.
  const scenes = [
    tunnel(PIXI, tex),
    flow(PIXI, tex, w0, h0),
    mandala(PIXI, tex),
    horizon(PIXI, tex),
    orbit(PIXI, tex),
    ribbons(PIXI, tex),
  ];
  addVapour(scenes[0], PIXI, cloud, { n: 16, smoke: 0.65, tight: 0.18, rush: 0.4, base: [3.4, 7] });
  addVapour(scenes[1], PIXI, cloud, { n: 14, smoke: 0.7, base: [3.2, 6.5] });
  addVapour(scenes[2], PIXI, cloud, { n: 16, smoke: 0.6, rush: 0.22, base: [3.8, 7.5] });
  addVapour(scenes[3], PIXI, cloud, { n: 18, smoke: 0.75, band: { y: 0.46, spread: 0.4 }, base: [3.4, 7] });
  addVapour(scenes[4], PIXI, cloud, { n: 16, smoke: 0.6, flat: 0.55, base: [3.4, 7] });
  addVapour(scenes[5], PIXI, cloud, { n: 16, smoke: 0.8, flat: 0.5, base: [3.8, 8] });
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
    if (code) code.update(t, w, h, dt, grade);
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
