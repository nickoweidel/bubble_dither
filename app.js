const canvas = document.getElementById("stage");
const ctx = canvas.getContext("2d", { alpha: false });

const els = {
  text: document.getElementById("textInput"),
  image: document.getElementById("imageInput"),
  imageLabel: document.getElementById("imageLabel"),
  modeText: document.getElementById("modeText"),
  modeImage: document.getElementById("modeImage"),
  clearImage: document.getElementById("clearImage"),
  pause: document.getElementById("pause"),
  speed: document.getElementById("speed"),
  bigChance: document.getElementById("bigChance"),
  cellSize: document.getElementById("cellSize"),
  bubbleScale: document.getElementById("bubbleScale"),
  stroke: document.getElementById("stroke"),
  background: document.getElementById("background"),
  bubble: document.getElementById("bubble"),
  imageColor: document.getElementById("imageColor"),
  exportSvg: document.getElementById("exportSvg"),
  exportWebm: document.getElementById("exportWebm"),
  textSource: document.querySelector(".text-source"),
  uploadSource: document.querySelector(".upload-source"),
  sliders: [...document.querySelectorAll(".slider-control")],
  swatches: [...document.querySelectorAll(".swatch-chip")],
};

const maskCanvas = document.createElement("canvas");
const maskCtx = maskCanvas.getContext("2d", { willReadFrequently: true });
const TEXT_SCALE = 0.42;

let dpr = 1;
let width = 0;
let height = 0;
let cell = 28;
let cols = 0;
let rows = 0;
let mask = new Float32Array();
let cellColors = new Uint8ClampedArray();
let sourceImage = null;
let useImage = false;
let clusters = [];
let clusterSpots = [];
let recorder = null;
let chunks = [];
let lastTime = performance.now();
let spawnCarry = 0;

const state = {
  background: els.background.value,
  bubble: els.bubble.value,
  stroke: Number(els.stroke.dataset.value),
  speed: Number(els.speed.dataset.value),
  bigChance: Number(els.bigChance.dataset.value),
  cellSize: Number(els.cellSize.dataset.value),
  bubbleScale: Number(els.bubbleScale.dataset.value),
  sampleImageColor: false,
  paused: false,
};

function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  width = Math.max(1, window.innerWidth);
  height = Math.max(1, window.innerHeight);
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  cell = state.cellSize;
  cols = Math.ceil(width / cell);
  rows = Math.ceil(height / cell);
  mask = new Float32Array(cols * rows);
  cellColors = new Uint8ClampedArray(cols * rows * 3);
  clusters = [];
  buildMask();
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function gridIndex(x, y) {
  return y * cols + x;
}

function buildMask() {
  if (!cols || !rows) return;

  maskCanvas.width = cols;
  maskCanvas.height = rows;
  maskCtx.clearRect(0, 0, cols, rows);

  if (useImage && sourceImage) {
    drawImageMask();
  } else {
    drawTextMask();
  }

  const pixels = maskCtx.getImageData(0, 0, cols, rows).data;
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const i = (y * cols + x) * 4;
      const alpha = pixels[i + 3] / 255;
      const luma = (pixels[i] * 0.2126 + pixels[i + 1] * 0.7152 + pixels[i + 2] * 0.0722) / 255;
      const density = alpha * (useImage ? 1 - luma : luma);
      const index = gridIndex(x, y);
      mask[index] = useImage
        ? density > 0.035
          ? clamp(density, 0.04, 1)
          : 0
        : density > 0.18
          ? 1
          : 0;

      if (useImage) {
        const ci = index * 3;
        cellColors[ci] = pixels[i];
        cellColors[ci + 1] = pixels[i + 1];
        cellColors[ci + 2] = pixels[i + 2];
      }
    }
  }

  clusterSpots = [];
  for (let y = 0; y < rows - 1; y += 1) {
    for (let x = 0; x < cols - 1; x += 1) {
      if (canSpawnCluster(x, y)) clusterSpots.push([x, y]);
    }
  }

  if (!clusters.length && state.bigChance > 0) {
    const initialClusters = Math.max(1, Math.round(state.bigChance * 36));
    for (let i = 0; i < initialClusters; i += 1) spawnCluster(true);
  }
}

function drawTextMask() {
  const text = els.text.value.trim() || "Пузырь";
  maskCtx.save();
  maskCtx.fillStyle = "white";
  maskCtx.textAlign = "center";
  maskCtx.textBaseline = "middle";
  maskCtx.font = `900 ${findTextSize(text)}px "Roboto Slab", Georgia, serif`;
  maskCtx.fillText(text, cols / 2, rows / 2 - rows * 0.035);
  maskCtx.restore();
}

function findTextSize(text) {
  let size = Math.max(8, rows * TEXT_SCALE);
  maskCtx.font = `900 ${size}px "Roboto Slab", Georgia, serif`;
  const maxWidth = cols * 0.9;
  const metrics = maskCtx.measureText(text);
  if (metrics.width > maxWidth) {
    size *= maxWidth / metrics.width;
  }
  return clamp(size, 7, rows * 0.9);
}

function drawImageMask() {
  const imgRatio = sourceImage.naturalWidth / sourceImage.naturalHeight;
  const boxW = cols * 0.82;
  const boxH = rows * 0.74;
  const boxRatio = boxW / boxH;
  let dw = boxW;
  let dh = boxH;

  if (imgRatio > boxRatio) {
    dh = boxW / imgRatio;
  } else {
    dw = boxH * imgRatio;
  }

  const dx = (cols - dw) / 2;
  const dy = (rows - dh) / 2;
  maskCtx.drawImage(sourceImage, dx, dy, dw, dh);
}

function shouldDraw(x, y) {
  return x >= 0 && y >= 0 && x < cols && y < rows && mask[gridIndex(x, y)] > 0;
}

function shouldCluster(x, y) {
  return shouldDraw(x, y) && mask[gridIndex(x, y)] > (useImage ? 0.18 : 0);
}

function canSpawnCluster(x, y) {
  return shouldCluster(x, y) && shouldCluster(x + 1, y) && shouldCluster(x, y + 1) && shouldCluster(x + 1, y + 1);
}

function spawnCluster(warm = false) {
  if (!clusterSpots.length) return;

  for (let tries = 0; tries < 80; tries += 1) {
    const [x, y] = clusterSpots[Math.floor(Math.random() * clusterSpots.length)];

    const overlaps = clusters.some((cluster) => Math.abs(cluster.x - x) < 2 && Math.abs(cluster.y - y) < 2);
    if (overlaps) continue;

    const life = 0.85 + Math.random() * 1.45;
    clusters.push({
      x,
      y,
      age: warm ? life * (0.25 + Math.random() * 0.45) : 0,
      life,
      delay: warm ? 0 : Math.random() * 0.15,
    });
    return;
  }
}

function updateClusters(dt) {
  if (state.paused) return;

  const speed = state.speed;
  if (speed <= 0.001 || state.bigChance <= 0.001) {
    clusters = [];
    return;
  }

  const desired = state.bigChance * 0.9 * speed * dt * Math.max(20, cols * rows * 0.045);
  spawnCarry += desired;
  while (spawnCarry >= 1) {
    spawnCluster();
    spawnCarry -= 1;
  }

  for (const cluster of clusters) {
    cluster.age += dt * speed;
  }
  clusters = clusters.filter((cluster) => cluster.age < cluster.life + cluster.delay);
}

function render(now) {
  const dt = Math.min(0.05, (now - lastTime) / 1000);
  lastTime = now;
  updateClusters(dt);

  ctx.fillStyle = state.background;
  ctx.fillRect(0, 0, width, height);

  ctx.lineWidth = state.stroke;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  for (const bubble of collectBubbles()) {
    ctx.save();
    ctx.globalAlpha = bubble.alpha;
    ctx.strokeStyle = bubble.color;
    drawBubble(bubble.x, bubble.y, bubble.radius);
    ctx.restore();
  }

  requestAnimationFrame(render);
}

function collectBubbles() {
  const occupied = new Uint8Array(cols * rows);
  const bubbles = [];

  for (const cluster of clusters) {
    const bubble = clusterBubble(cluster, occupied);
    if (bubble) bubbles.push(bubble);
  }

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      const i = gridIndex(x, y);
      if (!mask[i] || occupied[i]) continue;
      bubbles.push({
        x: (x + 0.5) * cell,
        y: (y + 0.5) * cell,
        radius: radiusForDensity(mask[i]),
        color: colorForCell(i),
        alpha: 1,
      });
    }
  }

  return bubbles;
}

function clusterBubble(cluster, occupied) {
  const p = clamp((cluster.age - cluster.delay) / cluster.life, 0, 1);
  if (p <= 0) return null;

  const popStart = 0.76;
  const grow = easeOutCubic(clamp(p / 0.3, 0, 1));
  const pop = p > popStart ? clamp((p - popStart) / (1 - popStart), 0, 1) : 0;
  const alpha = 1 - easeInCubic(pop);
  const radius = cell * state.bubbleScale * (0.5 + 0.34 * grow + 0.14 * pop);
  const cx = (cluster.x + 1) * cell;
  const cy = (cluster.y + 1) * cell;

  for (let oy = 0; oy < 2; oy += 1) {
    for (let ox = 0; ox < 2; ox += 1) {
      occupied[gridIndex(cluster.x + ox, cluster.y + oy)] = alpha > 0.03 ? 1 : 0;
    }
  }

  if (alpha <= 0.03) return null;

  return { x: cx, y: cy, radius, color: colorForCluster(cluster), alpha };
}

function drawBubble(x, y, radius) {
  const lineInset = state.stroke * 0.5;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(1, radius - lineInset), 0, Math.PI * 2);
  ctx.stroke();
}

function radiusForDensity(density) {
  const scale = state.bubbleScale;
  if (!useImage) return cell * 0.5 * scale;
  const shaped = Math.pow(clamp(density, 0, 1), 0.72);
  return cell * scale * (0.12 + shaped * 0.38);
}

function colorForCell(index) {
  if (!useImage || !state.sampleImageColor) return state.bubble;
  const ci = index * 3;
  return `rgb(${cellColors[ci]} ${cellColors[ci + 1]} ${cellColors[ci + 2]})`;
}

function colorForCluster(cluster) {
  if (!useImage || !state.sampleImageColor) return state.bubble;

  let r = 0;
  let g = 0;
  let b = 0;
  let count = 0;
  for (let oy = 0; oy < 2; oy += 1) {
    for (let ox = 0; ox < 2; ox += 1) {
      const x = cluster.x + ox;
      const y = cluster.y + oy;
      if (!shouldDraw(x, y)) continue;
      const ci = gridIndex(x, y) * 3;
      r += cellColors[ci];
      g += cellColors[ci + 1];
      b += cellColors[ci + 2];
      count += 1;
    }
  }

  if (!count) return state.bubble;
  return `rgb(${Math.round(r / count)} ${Math.round(g / count)} ${Math.round(b / count)})`;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function easeInCubic(t) {
  return t * t * t;
}

function syncState() {
  state.background = els.background.value;
  state.bubble = els.bubble.value;
  document.body.style.background = state.background;
  syncSwatches();
  syncRangeViews();
}

function syncPauseButton() {
  els.pause.textContent = state.paused ? ">" : "II";
  els.pause.title = state.paused ? "Продолжить" : "Пауза";
  els.pause.setAttribute("aria-label", els.pause.title);
}

function syncImageColorButton() {
  els.imageColor.classList.toggle("active", state.sampleImageColor);
  els.imageColor.title = state.sampleImageColor ? "Один цвет" : "Цвет из фото";
  els.imageColor.setAttribute("aria-label", els.imageColor.title);
}

function syncSwatches() {
  for (const chip of els.swatches) {
    const key = chip.dataset.swatch;
    chip.style.setProperty("--swatch-color", state[key]);
  }
}

function syncRangeView(control) {
  const min = Number(control.dataset.min || 0);
  const max = Number(control.dataset.max || 100);
  const value = Number(control.dataset.value || min);
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  const clamped = clamp(percent, 0, 100);
  control.style.setProperty("--p", `${clamped}%`);
  control.style.setProperty("--range-p", `${clamped}%`);
  control.setAttribute("aria-valuemin", String(min));
  control.setAttribute("aria-valuemax", String(max));
  control.setAttribute("aria-valuenow", String(value));
}

function syncRangeViews() {
  for (const control of els.sliders) syncRangeView(control);
}

function setSliderValue(control, value) {
  const key = control.dataset.key;
  const min = Number(control.dataset.min || 0);
  const max = Number(control.dataset.max || 100);
  const clamped = clamp(value, min, max);
  control.dataset.value = String(clamped);
  state[key] = clamped;
  syncRangeView(control);
  if (key === "cellSize") resize();
}

function setSliderFromPointer(control, clientX) {
  const rect = control.getBoundingClientRect();
  const min = Number(control.dataset.min || 0);
  const max = Number(control.dataset.max || 100);
  const ratio = clamp((clientX - rect.left) / rect.width, 0, 1);
  setSliderValue(control, min + ratio * (max - min));
}

function download(url, filename) {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" };
    return entities[char];
  });
}

function exportSvg() {
  const circles = collectBubbles()
    .map((bubble) => {
      const opacity = bubble.alpha < 0.999 ? ` opacity="${bubble.alpha.toFixed(3)}"` : "";
      return `<circle cx="${bubble.x.toFixed(2)}" cy="${bubble.y.toFixed(2)}" r="${Math.max(0.1, bubble.radius - state.stroke * 0.5).toFixed(2)}" fill="none" stroke="${escapeXml(bubble.color)}" stroke-width="${state.stroke}"${opacity}/>`;
    })
    .join("\n  ");

  const svg = `<svg width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}" fill="none" xmlns="http://www.w3.org/2000/svg">
  <rect width="100%" height="100%" fill="${escapeXml(state.background)}"/>
  ${circles}
</svg>`;

  const blob = new Blob([svg], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  download(url, "bubble-dither.svg");
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function exportWebm() {
  if (recorder?.state === "recording") {
    recorder.stop();
    els.exportWebm.textContent = "WebM";
    return;
  }

  const stream = canvas.captureStream(60);
  chunks = [];
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";
  recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (event) => {
    if (event.data.size) chunks.push(event.data);
  };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    download(url, "bubble-dither.webm");
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  recorder.start();
  els.exportWebm.textContent = "Стоп";
  setTimeout(() => {
    if (recorder?.state === "recording") recorder.stop();
    els.exportWebm.textContent = "WebM";
  }, 5000);
}

function loadImage(file) {
  if (!file) return;
  const img = new Image();
  const url = URL.createObjectURL(file);
  img.onload = () => {
    sourceImage = img;
    setMode("image", false);
    els.imageLabel.textContent = file.name;
    clusters = [];
    buildMask();
    URL.revokeObjectURL(url);
  };
  img.src = url;
}

function setMode(mode, rebuild = true) {
  useImage = mode === "image";
  els.modeText.classList.toggle("active", !useImage);
  els.modeImage.classList.toggle("active", useImage);
  els.textSource.classList.toggle("hidden", useImage);
  els.uploadSource.classList.toggle("hidden", !useImage);
  if (rebuild) {
    clusters = [];
    buildMask();
  }
}

for (const control of [els.background, els.bubble]) {
  control.addEventListener("input", syncState);
}

for (const slider of els.sliders) {
  slider.addEventListener("pointerdown", (event) => {
    if (event.target === els.pause) return;
    slider.setPointerCapture(event.pointerId);
    setSliderFromPointer(slider, event.clientX);
  });
  slider.addEventListener("pointermove", (event) => {
    if (!slider.hasPointerCapture(event.pointerId)) return;
    setSliderFromPointer(slider, event.clientX);
  });
  slider.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const min = Number(slider.dataset.min || 0);
    const max = Number(slider.dataset.max || 100);
    const current = Number(slider.dataset.value || min);
    const step = (max - min) / 100;
    setSliderValue(slider, current + (event.key === "ArrowRight" ? step : -step));
  });
}

els.pause.addEventListener("click", () => {
  state.paused = !state.paused;
  syncPauseButton();
});
els.imageColor.addEventListener("click", () => {
  state.sampleImageColor = !state.sampleImageColor;
  syncImageColorButton();
});

els.text.addEventListener("input", () => {
  if (!useImage) {
    clusters = [];
    buildMask();
  }
});
els.modeText.addEventListener("click", () => setMode("text"));
els.modeImage.addEventListener("click", () => setMode("image"));
els.clearImage.addEventListener("click", () => {
  sourceImage = null;
  els.image.value = "";
  els.imageLabel.textContent = "Загрузить";
  setMode("text");
});
els.image.addEventListener("change", () => loadImage(els.image.files[0]));
els.exportSvg.addEventListener("click", exportSvg);
els.exportWebm.addEventListener("click", exportWebm);
window.addEventListener("resize", resize);

syncState();
syncPauseButton();
syncImageColorButton();
setMode("text", false);
document.fonts.ready.then(() => {
  resize();
  requestAnimationFrame((time) => {
    lastTime = time;
    requestAnimationFrame(render);
  });
});
