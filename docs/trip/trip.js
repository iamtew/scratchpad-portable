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

function ngon(g, cx, cy, r, n, rot) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = rot + (i / n) * Math.PI * 2;
    pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r);
  }
  g.poly(pts);
}

async function startPixi() {
  if (!window.PIXI) return;
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

  const rings = new PIXI.Graphics();
  const gas = new PIXI.Graphics();
  const flash = new PIXI.Graphics();
  gas.blendMode = "add";
  flash.blendMode = "add";
  app.stage.addChild(rings, gas, flash);

  const N = 22;
  const depths = Array.from({ length: N }, (_, i) => i / N);
  const clouds = Array.from({ length: 9 }, () => ({
    a: Math.random() * Math.PI * 2,
    d: 0.12 + Math.random() * 0.55,
    r: 40 + Math.random() * 90,
    hue: 260 + Math.random() * 80,
    spin: (Math.random() - 0.5) * 0.25,
  }));
  const speed = reduceMotion ? 0.035 : 0.22;

  app.ticker.add(() => {
    const w = app.screen.width;
    const h = app.screen.height;
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.hypot(cx, cy) * 1.15;
    const t = performance.now() / 1000;
    const music = window.TripMusic;
    const kickAge = music ? music.currentTime - music.lastKickTime : 9;
    const kick = Math.max(0, 1 - kickAge / 0.14);

    for (let i = 0; i < depths.length; i++) {
      depths[i] += speed * app.ticker.deltaMS * 0.001;
      if (depths[i] > 1) depths[i] -= 1;
    }

    rings.clear();
    for (let i = 0; i < depths.length; i++) {
      const z = depths[i];
      const r = 8 + z * z * maxR;
      const sides = 6 + (i % 3);
      const rot = t * (0.15 + (i % 5) * 0.04) + i;
      const hue = (t * 28 + i * 17) % 360;
      const alpha = 0.15 + z * 0.55;
      ngon(rings, cx, cy, r, sides, rot);
      rings.stroke({ width: 1.2 + z * 2.2, color: hsl(hue, 80, 58 + kick * 12), alpha });

      const tickR = 3 + z * 7;
      for (let s = 0; s < sides; s++) {
        const a = rot + (s / sides) * Math.PI * 2;
        rings.circle(cx + Math.cos(a) * r, cy + Math.sin(a) * r, tickR);
        rings.fill({ color: hsl((hue + 40) % 360, 90, 70), alpha: 0.25 + z * 0.4 });
      }
    }

    gas.clear();
    for (const c of clouds) {
      c.a += c.spin * app.ticker.deltaMS * 0.001;
      const dist = c.d * maxR * (0.35 + kick * 0.12);
      const x = cx + Math.cos(c.a + t * 0.2) * dist;
      const y = cy + Math.sin(c.a + t * 0.2) * dist * 0.72;
      const pulse = 1 + Math.sin(t * 2 + c.a) * 0.12 + kick * 0.2;
      gas.circle(x, y, c.r * pulse);
      gas.fill({ color: hsl(c.hue, 70, 45), alpha: 0.07 + kick * 0.05 });
    }

    flash.clear();
    if (kick > 0) {
      flash.rect(0, 0, w, h);
      flash.fill({ color: hsl((t * 40) % 360, 80, 70), alpha: kick * 0.18 });
    }
  });
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

function setupBegin() {
  const gate = document.querySelector(".gate");
  const bar = document.querySelector(".bar");
  const begin = document.getElementById("begin");
  const vol = document.getElementById("vol");
  begin.addEventListener("click", async () => {
    begin.disabled = true;
    await window.TripMusic.start();
    window.TripMusic.setVolume(vol.value);
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
