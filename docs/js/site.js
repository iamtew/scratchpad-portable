const THEME_KEY = "theme";

function storedTheme() {
  const t = localStorage.getItem(THEME_KEY);
  return t === "light" || t === "dark" || t === "system" ? t : "system";
}

function applyTheme(t) {
  document.documentElement.dataset.theme = t;
  if (t === "system") localStorage.removeItem(THEME_KEY);
  else localStorage.setItem(THEME_KEY, t);
  document.querySelectorAll("[data-theme-set]").forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.themeSet === t));
  });
  document.dispatchEvent(new Event("themechange"));
}

function setupTheme() {
  applyTheme(storedTheme());
  document.querySelectorAll("[data-theme-set]").forEach((btn) => {
    btn.addEventListener("click", () => applyTheme(btn.dataset.themeSet));
  });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (storedTheme() === "system") document.dispatchEvent(new Event("themechange"));
  });
}

function setupDialog() {
  const dialog = document.getElementById("shot-dialog");
  const openBtn = document.getElementById("shot-open");
  if (!dialog || !openBtn) return;
  openBtn.addEventListener("click", () => dialog.showModal());
  dialog.addEventListener("click", (e) => {
    if (!e.target.closest(".overlay")) dialog.close();
  });
}

function setupStub() {
  const uc = document.getElementById("under-construction");
  if (!uc) return;
  uc.addEventListener("click", (e) => e.preventDefault());
}

function cssRgb(name) {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return raw.split(/[,\s]+/).map(Number);
}

async function startPixi() {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  if (!window.PIXI) return;
  const canvas = document.getElementById("pixi");
  const app = new PIXI.Application();
  await app.init({
    canvas,
    resizeTo: window,
    backgroundAlpha: 0,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(devicePixelRatio || 1, 2),
  });

  const dots = [];
  const g = new PIXI.Graphics();
  app.stage.addChild(g);

  function seed() {
    dots.length = 0;
    const n = Math.max(28, Math.floor((app.screen.width * app.screen.height) / 28000));
    for (let i = 0; i < n; i++) {
      dots.push({
        x: Math.random() * app.screen.width,
        y: Math.random() * app.screen.height,
        r: 0.7 + Math.random() * 1.8,
        vx: (Math.random() - 0.5) * 0.18,
        vy: -0.04 - Math.random() * 0.12,
        a: 0.12 + Math.random() * 0.28,
      });
    }
  }

  function draw() {
    const [cr, cg, cb] = cssRgb("--dot");
    g.clear();
    for (const d of dots) {
      d.x += d.vx;
      d.y += d.vy;
      if (d.y < -8) d.y = app.screen.height + 8;
      if (d.x < -8) d.x = app.screen.width + 8;
      if (d.x > app.screen.width + 8) d.x = -8;
      g.circle(d.x, d.y, d.r);
      g.fill({ color: (cr << 16) | (cg << 8) | cb, alpha: d.a });
    }
  }

  seed();
  app.ticker.add(draw);
  app.renderer.on("resize", seed);
  document.addEventListener("themechange", draw);
}

function setupDownload() {
  fetch("releases.json")
    .then((r) => {
      if (!r.ok) throw new Error("no list");
      return r.json();
    })
    .then((data) => {
      if (!data || !data.tag || !Array.isArray(data.files)) return;
      const name = data.files.find((f) => /\.zip$/i.test(f));
      if (!name) return;
      const href = `https://github.com/iamtew/scratchpad-portable/releases/download/${data.tag}/${encodeURIComponent(name)}`;
      document.querySelectorAll("[data-download]").forEach((a) => {
        a.href = href;
        a.hidden = false;
      });
    })
    .catch(() => {});
}

setupTheme();
setupDialog();
setupStub();
setupDownload();
startPixi();
