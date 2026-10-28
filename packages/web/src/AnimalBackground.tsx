import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown, Pause, Play, Waves } from "lucide-react";
import { ANIMAL_KINDS, renderAnimal, type AnimalKind } from "./animals";
import { Button } from "@/components/ui/button";

type Scene = "ocean" | AnimalKind;
type Preferences = { scene: Scene; paused: boolean };
const STORAGE_KEY = "agent-profiler:animal-background:v1";
const LABELS: Record<Scene, string> = { ocean: "Ocean mix", shark: "Sharks", ray: "Rays", seahorse: "Seahorses", jellyfish: "Jellyfish" };

function initialPreferences(): Preferences {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    if (value && (value.scene === "ocean" || ANIMAL_KINDS.includes(value.scene))) return { scene: value.scene, paused: value.paused === true };
  } catch { /* Storage is optional; private browsing still gets a background. */ }
  return { scene: "ocean", paused: false };
}

/** One persistent, bounded background for the entire workspace, not route art. */
export function AnimalBackground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const clock = useRef(2.4);
  const [preferences, setPreferences] = useState(initialPreferences);
  const [open, setOpen] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const panelId = useId();

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences)); } catch { /* No persistence requirement. */ }
  }, [preferences]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!panelRef.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); setOpen(false);
      panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", escape); };
  }, [open]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const preference = window.matchMedia("(prefers-reduced-motion: reduce)");
    const textures = Array.from({ length: 4 }, () => {
      const texture = document.createElement("canvas");
      texture.width = 640; texture.height = 480;
      return { canvas: texture, context: texture.getContext("2d") };
    });
    const protection = document.createElement("canvas");
    const mask = protection.getContext("2d");
    let width = 0, height = 0, dpr = 1;
    let disposed = false, frame = 0, timer = 0, previous = 0;
    let maskDirty = true, maskTimer = 0;

    const updateProtection = () => {
      if (!mask) return;
      mask.setTransform(1, 0, 0, 1, 0, 0);
      mask.clearRect(0, 0, protection.width, protection.height);
      mask.setTransform(dpr, 0, 0, dpr, 0, 0);
      // A soft quiet zone around reading areas. Shapes remain visible in the
      // workspace; measured text never competes with full-strength glyphs.
      const nodes = document.querySelectorAll("main h1, main h2, main p, .table-frame, .findings-list, .metric-baseline, .property-list, .body-pre, .workspace-note, .session-list-footer, main code");
      for (const node of nodes) {
        const box = node.getBoundingClientRect();
        if (!box.width || !box.height || box.bottom < 0 || box.top > height) continue;
        mask.fillStyle = "rgba(0,0,0,0.6)";
        mask.filter = "blur(20px)";
        mask.fillRect(box.x - 12, box.y - 12, box.width + 24, box.height + 24);
        mask.filter = "none";
        mask.fillStyle = "rgba(0,0,0,0.25)";
        mask.fillRect(box.x, box.y, box.width, box.height);
      }
      maskDirty = false;
    };

    const draw = () => {
      if (!width || !height) return;
      if (maskDirty) updateProtection();
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const mobile = width < 768;
      const areaLeft = mobile ? 0 : 224;
      const areaWidth = width - areaLeft;
      const positions = mobile
        ? [{ x: .66, y: .37, size: 1.05, kind: "seahorse" }, { x: .25, y: .82, size: 1.25, kind: "ray" }]
        : [{ x: .79, y: .54, size: .55, kind: "seahorse" }, { x: .19, y: .77, size: .66, kind: "ray" }, { x: .55, y: .91, size: .48, kind: "shark" }, { x: .9, y: .25, size: .38, kind: "jellyfish" }];
      positions.forEach((position, i) => {
        const kind = preferences.scene === "ocean" ? position.kind as AnimalKind : preferences.scene;
        const texture = textures[i];
        if (!texture.context) return;
        renderAnimal(texture.context, kind, clock.current + i * 3.7, texture.canvas.width, texture.canvas.height);
        const size = Math.min(areaWidth * position.size, mobile ? 520 : 780);
        const tall = kind === "seahorse" || kind === "jellyfish";
        const w = tall ? size * .68 : size;
        const h = tall ? size : size * .65;
        const driftX = Math.sin(clock.current * .075 + i * 1.9) * (mobile ? 18 : 36);
        const driftY = Math.sin(clock.current * .1 + i * 2.1) * 23;
        ctx.save();
        ctx.translate(areaLeft + areaWidth * position.x + driftX, height * position.y + driftY);
        ctx.rotate(tall ? Math.sin(clock.current * .08 + i) * .08 : -.12 + Math.sin(clock.current * .07 + i) * .15);
        ctx.globalAlpha = i === 0 ? .95 : .7;
        ctx.drawImage(texture.canvas, -w / 2, -h / 2, w, h);
        ctx.restore();
      });
      if (mask) {
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalCompositeOperation = "destination-out";
        ctx.drawImage(protection, 0, 0);
        ctx.globalCompositeOperation = "source-over";
      }
    };
    const stop = () => { cancelAnimationFrame(frame); window.clearTimeout(timer); frame = timer = 0; previous = 0; };
    const animates = () => !disposed && !document.hidden && !preferences.paused && !preference.matches;
    const tick = (now: number) => {
      frame = 0;
      if (!animates()) return;
      if (previous) clock.current += Math.min((now - previous) / 1000, .15);
      previous = now;
      draw();
      timer = window.setTimeout(() => { timer = 0; if (animates()) frame = requestAnimationFrame(tick); }, 67);
    };
    const schedule = () => { stop(); draw(); if (animates()) frame = requestAnimationFrame(tick); };
    const invalidate = () => {
      maskDirty = true;
      if (!maskTimer) maskTimer = window.setTimeout(() => { maskTimer = 0; if (!animates() && !document.hidden) draw(); }, 100);
    };
    const resize = () => {
      width = window.innerWidth; height = window.innerHeight;
      // Cap both DPR and total backing pixels, independent of monitor size.
      dpr = Math.min(window.devicePixelRatio || 1, 1.5, Math.sqrt(2_000_000 / Math.max(1, width * height)));
      canvas.width = protection.width = Math.max(1, Math.floor(width * dpr));
      canvas.height = protection.height = Math.max(1, Math.floor(height * dpr));
      maskDirty = true;
      schedule();
    };
    const motionChanged = () => { setReducedMotion(preference.matches); schedule(); };
    const observer = new MutationObserver(invalidate);
    const main = document.querySelector("main");
    if (main) observer.observe(main, { childList: true, subtree: true, attributes: true, characterData: true });
    const resizeObserver = new ResizeObserver(invalidate);
    if (main) resizeObserver.observe(main);
    window.addEventListener("resize", resize);
    document.addEventListener("scroll", invalidate, true);
    document.addEventListener("visibilitychange", schedule);
    preference.addEventListener("change", motionChanged);
    setReducedMotion(preference.matches);
    resize();
    return () => {
      disposed = true; stop(); window.clearTimeout(maskTimer);
      observer.disconnect(); resizeObserver.disconnect();
      window.removeEventListener("resize", resize);
      document.removeEventListener("scroll", invalidate, true);
      document.removeEventListener("visibilitychange", schedule);
      preference.removeEventListener("change", motionChanged);
    };
  }, [preferences.scene, preferences.paused]);

  return <>
    <div className="animal-backdrop" aria-hidden="true"><canvas ref={canvasRef} /></div>
    <div ref={panelRef} className="background-controls" data-background-controls onKeyDown={event => {
      if (event.key === "Escape" && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); panelRef.current?.querySelector<HTMLButtonElement>("button")?.focus(); }
    }}>
      <Button variant="ghost" size="sm" aria-label="Background scene settings" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(value => !value)}><Waves className="h-3.5 w-3.5" /><span className="hidden sm:inline">Background</span><ChevronDown className="h-3 w-3" /></Button>
      {open && <div id={panelId} className="background-settings" role="group" aria-label="Background scene">
        <label htmlFor={`${panelId}-animal`} className="text-xs font-medium">Animals</label>
        <select id={`${panelId}-animal`} value={preferences.scene} onChange={event => setPreferences(p => ({ ...p, scene: event.target.value as Scene }))}>
          {(["ocean", ...ANIMAL_KINDS] as Scene[]).map(scene => <option key={scene} value={scene}>{LABELS[scene]}</option>)}
        </select>
        <div className="mt-4 flex items-center justify-between gap-3 text-xs"><span>{reducedMotion ? "Motion off · system preference" : preferences.paused ? "Motion paused" : "Slow drift"}</span><Button size="sm" disabled={reducedMotion} onClick={() => setPreferences(p => ({ ...p, paused: !p.paused }))} aria-label={reducedMotion ? "Animal background motion disabled by system preference" : preferences.paused ? "Play animal background" : "Pause animal background"}>{preferences.paused || reducedMotion ? <Play className="h-3 w-3" /> : <Pause className="h-3 w-3" />}{reducedMotion ? "Motion off" : preferences.paused ? "Play" : "Pause"}</Button></div>
        <p className="mt-3 text-xs leading-relaxed text-muted-foreground">Present on every page. Motion stops in hidden tabs; reduced motion keeps a still scene.</p>
      </div>}
    </div>
  </>;
}
