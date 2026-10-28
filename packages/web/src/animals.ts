/**
 * Original analytical marine silhouettes and ASCII shading, authored for Agent
 * Profiler. No pixels, paths, or code are copied from the visual reference or
 * the separately licensed vendor/ascii-sharks renderer.
 * Coordinates describe one animal, not its placement in the surrounding scene.
 */
export type AnimalKind = "shark" | "ray" | "seahorse" | "jellyfish";
export const ANIMAL_KINDS: AnimalKind[] = ["shark", "ray", "seahorse", "jellyfish"];

const COLS = 100;
const ROWS = 70;
const GLYPHS = ".:;=+tx%S8#@";
const PALETTE = ["#958bb8", "#a095c0", "#aba0c8", "#b6aad0", "#c0b4d8"];
const clamp = (n: number) => Math.max(0, Math.min(1, n));

function ellipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number) {
  return clamp(1 - ((x - cx) / rx) ** 2 - ((y - cy) / ry) ** 2);
}

function tube(x: number, y: number, ax: number, ay: number, bx: number, by: number, radius: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const t = clamp(((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1));
  return clamp(1 - Math.hypot(x - ax - t * dx, y - ay - t * dy) / radius);
}

// Precomputed original tapered spiral: the outer loop connects to the abdomen,
// while the smaller inner loop leaves the characteristic open curl visible.
const CURL = Array.from({ length: 37 }, (_, i) => {
  const t = i / 36;
  const angle = Math.PI - t * Math.PI * 2.15;
  const radius = 0.112 * (1 - t * 0.86);
  return [0.552 + Math.cos(angle) * radius, 0.79 + Math.sin(angle) * radius] as const;
});

function seahorse(x: number, y: number) {
  const neckX = 0.535 + (y - 0.26) * 0.28;
  let d = Math.max(
    ellipse(x, y, 0.548, 0.459, 0.104, 0.171),
    ellipse(x, y, neckX, 0.305, 0.051, 0.124),
    ellipse(x, y, 0.496, 0.197, 0.077, 0.068),
    tube(x, y, 0.467, 0.217, 0.333, 0.252, 0.026),
    tube(x, y, 0.523, 0.577, 0.465, 0.696, 0.038),
    tube(x, y, 0.465, 0.696, CURL[0][0], CURL[0][1], 0.025),
  );
  for (let i = 1; i < CURL.length; i++) {
    d = Math.max(d, tube(x, y, CURL[i - 1][0], CURL[i - 1][1], CURL[i][0], CURL[i][1], 0.023 - i * 0.00036));
  }
  // Three fleshy crown spines, a scalloped dorsal fin, and the dark eye.
  for (let i = 0; i < 3; i++) {
    d = Math.max(d, tube(x, y, 0.48 + i * 0.029, 0.155, 0.465 + i * 0.034, 0.101 + i * 0.009, 0.012));
  }
  if (y > 0.365 && y < 0.535) {
    const fin = 0.657 + 0.014 * Math.sin(y * 145);
    if (x > 0.615 && x < fin) d = Math.max(d, 0.38);
  }
  if (ellipse(x, y, 0.464, 0.191, 0.012, 0.013) > 0) return 0.12;
  if (d === 0) return 0;
  const ribs = Math.cos((y + (x - 0.54) * 0.32) * 168);
  return clamp(0.38 + d * 0.43 + ribs * 0.1);
}

function ray(x: number, y: number, time: number) {
  const side = Math.abs(x - 0.5) / 0.445;
  const wingY = y - Math.sin(time * 0.7 + side * 3.6) * 0.026 * side * side;
  let d = 0;
  if (side < 1) {
    const front = 0.16 + 0.21 * side ** 0.72;
    const back = 0.63 - 0.26 * side ** 1.65;
    if (wingY > front && wingY < back) {
      const cross = (wingY - front) / (back - front);
      d = 0.36 + 0.4 * Math.sin(cross * Math.PI) * (1 - side * 0.45);
      d += Math.cos(side * 53 + cross * 7) * 0.045;
    }
  }
  d = Math.max(d, ellipse(x, y, 0.5, 0.39, 0.065, 0.238) * 0.85);
  if (y > 0.59 && y < 0.96) {
    const t = (y - 0.59) / 0.37;
    const tailX = 0.5 + Math.sin(t * 5 - time * 0.8) * t * 0.045;
    if (Math.abs(x - tailX) < 0.012 * (1 - t * 0.7)) d = 0.6;
  }
  if (ellipse(x, y, 0.475, 0.263, 0.009, 0.014) > 0 || ellipse(x, y, 0.525, 0.263, 0.009, 0.014) > 0) return 0.15;
  return clamp(d);
}

function jellyfish(x: number, y: number, time: number) {
  const pulse = Math.sin(time * 0.8);
  const rx = 0.306 + pulse * 0.012;
  const rim = 0.414 + pulse * 0.012;
  const bell = ((x - 0.5) / rx) ** 2 + ((y - rim) / 0.265) ** 2;
  if (y <= rim && bell < 1) {
    const radial = Math.abs(x - 0.5) / rx;
    return clamp(0.43 + (1 - bell) * 0.35 + Math.cos(radial * 25) * 0.09);
  }
  if (Math.abs(x - 0.5) < rx && Math.abs(y - rim - 0.012 * Math.cos((x - 0.5) * 110)) < 0.022) return 0.76;
  let d = 0;
  // Unequal hanging lengths and phase-delayed waves avoid a curtain of lines.
  for (let i = 0; i < 9; i++) {
    const startX = 0.267 + i * 0.058;
    const length = 0.32 + 0.17 * (0.5 + 0.5 * Math.sin(i * 2.3));
    const t = (y - rim) / length;
    if (t < 0 || t > 1) continue;
    const cx = startX + Math.sin(t * 8 - time * 0.65 + i * 0.9) * (0.008 + t * 0.033);
    const radius = (i % 3 === 1 ? 0.018 : 0.009) * (1 - t * 0.65);
    if (Math.abs(x - cx) < radius) d = Math.max(d, 0.42 + 0.27 * (1 - t));
  }
  return d;
}

function shark(x: number, y: number, time: number) {
  const s = (x - 0.105) / 0.76;
  if (s < 0 || s > 1) return 0;
  const bend = Math.sin(s * 7 - time * 0.9) * 0.035 * s * s;
  const cross = y - 0.46 - bend;
  const w = s < 0.2
    ? 0.094 * Math.sqrt(Math.max(0, 1 - ((s - 0.2) / 0.2) ** 2))
    : 0.094 * (1 - (s - 0.2) / 0.8) ** 1.2 + 0.007;
  if (Math.abs(cross) < w) {
    if (s > 0.09 && s < 0.12 && cross < -w * 0.35) return 0.15;
    const gills = s > 0.23 && s < 0.33 && cross > 0 && Math.sin(s * 220) > 0.4;
    return gills ? 0.26 : clamp(0.85 - Math.abs(cross) / w * 0.34);
  }
  // Falcate dorsal/pectoral fins use curved boundaries, never painted polygons.
  if (s > 0.32 && s < 0.54) {
    const t = (s - 0.32) / 0.22;
    const dorsal = Math.sin(t * Math.PI) ** 0.7 * 0.205;
    if (cross < 0 && -cross < w + dorsal && s > 0.32 + (-cross) * 0.5) return 0.56;
  }
  if (s > 0.29 && s < 0.58) {
    const t = (s - 0.29) / 0.29;
    if (cross > w && cross < w + Math.sin(t * Math.PI) ** 1.4 * 0.18) return 0.48;
  }
  if (s > 0.64 && s < 0.76 && cross > 0 && cross < w + Math.sin((s - 0.64) / 0.12 * Math.PI) * 0.062) return 0.45;
  if (s > 0.82) {
    const t = (s - 0.82) / 0.18;
    const reach = t * 0.24;
    if (Math.abs(cross) < reach && Math.abs(cross) > reach * (0.45 + t * 0.35)) return 0.62;
  }
  return 0;
}

/** Pure, reproducible density sampler. Normalized coordinates; time in seconds. */
export function sampleAnimal(kind: AnimalKind, x: number, y: number, time: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(time) || x < 0 || x > 1 || y < 0 || y > 1) return 0;
  // Transform the sampling position, not the glyph seed: texture travels with
  // the body instead of scintillating randomly between animation frames.
  x -= Math.sin(time * 0.19) * 0.012;
  y -= Math.sin(time * 0.27) * 0.009;
  switch (kind) {
    case "seahorse": return seahorse(x, y);
    case "ray": return ray(x, y, time);
    case "jellyfish": return jellyfish(x, y, time);
    case "shark": return shark(x, y, time);
  }
}

/** Paint one transparent offscreen canvas. The caller owns scene compositing,
 * opacity, aspect ratio, frame scheduling, pause, and reduced-motion handling.
 * width/height are logical dimensions; the existing backing store may be DPR-scaled.
 */
export function renderAnimal(context: CanvasRenderingContext2D, kind: AnimalKind, time: number, width: number, height: number): void {
  context.save();
  context.setTransform(1, 0, 0, 1, 0, 0);
  context.clearRect(0, 0, context.canvas.width, context.canvas.height);
  if (!(width > 0 && height > 0) || !Number.isFinite(width) || !Number.isFinite(height) || !Number.isFinite(time)) {
    context.restore();
    return;
  }
  context.setTransform(context.canvas.width / width, 0, 0, context.canvas.height / height, 0, 0);
  context.globalAlpha = 1;
  context.globalCompositeOperation = "source-over";
  const cellW = width / COLS;
  const cellH = height / ROWS;
  context.font = `500 ${Math.min(cellW / 0.61, cellH * 1.08)}px ui-monospace, "SFMono-Regular", Consolas, monospace`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const driftX = Math.sin(time * 0.19) * 0.012;
  const driftY = Math.sin(time * 0.27) * 0.009;
  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const x = (col + 0.5) / COLS;
      const y = (row + 0.5) / ROWS;
      const density = sampleAnimal(kind, x, y, time);
      if (density === 0) continue;
      const key = Math.abs(Math.imul(Math.floor((x - driftX) * COLS), 73856093) ^ Math.imul(Math.floor((y - driftY) * ROWS), 19349663));
      const index = Math.max(0, Math.min(GLYPHS.length - 1, Math.floor(density * (GLYPHS.length - 1)) + key % 3 - 1));
      context.fillStyle = PALETTE[Math.min(PALETTE.length - 1, Math.floor(density * PALETTE.length))];
      context.fillText(GLYPHS[index], x * width, y * height);
    }
  }
  context.restore();
}
