/**
 * The landing page's note field.
 *
 * A single fixed, transparent canvas behind the whole page. It is `aria-hidden`
 * and `pointer-events: none`, so it can never be clicked, focused or read; the
 * pointer, scroll and visibility listeners all live on `window` instead.
 *
 * Nothing here is on the critical path. The canvas is an empty element until
 * `requestIdleCallback` fires after first paint, and only then is the engine
 * chunk `import()`ed — this component deliberately has no static import into
 * `src/components/notes/`, so the atlas, both engines and vgpu all stay out of
 * the initial bundle. The headline and the buttons are painted and interactive
 * before a single note exists, and they stay that way if the import fails.
 *
 * Lifecycle rules it enforces on behalf of both engines:
 *   - pause while the tab is hidden (it keeps running as the page scrolls);
 *   - re-read the palette when the theme flips (the engine is rebuilt);
 *   - render one still frame — and never a burst — under reduced motion;
 *   - hand over to the Canvas2D engine if the GPU engine fails or is lost;
 *   - release every listener, observer, timer and GPU resource on unmount.
 */
import { useEffect, useRef } from "react";

import { useReducedMotion } from "../../hooks/useReducedMotion";
import type { EngineContext, NotesEngine, Rect } from "./field";
import type { EngineKind } from "./createEngine";

type NotesModule = typeof import("./createEngine");

/** The shader has six calm slots; extra tagged elements are ignored. */
const CALM_SLOTS = 6;

/**
 * Anything that moves the page moves the pockets with it. The layout settles
 * late — the branded fonts swap in, the logo decodes, a poster's masked line
 * reveal finishes — and a pocket measured before that is a pocket over the
 * wrong pixels. The observer plus one late pass covers it.
 */
const RESETTLE_MS = 700;
/** Ink in both themes, used for the instant before the real colour is read. */
const PLACEHOLDER_INK = { r: 22, g: 26, b: 22 };

export function NotesField({ dark }: {
  /** A theme flip rebuilds the engine so the palette is re-read. */
  dark: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { reduced } = useReducedMotion();

  useEffect(() => {
    const element = canvasRef.current;
    if (!element) return;
    // Re-bound with a definite type: the closures below outlive this narrowing.
    const canvas: HTMLCanvasElement = element;

    // `?notes=off` is a switch for measurements and tests; nothing loads at all.
    const force = new URLSearchParams(window.location.search).get("notes");
    if (force === "off") return;

    let disposed = false;
    let module: NotesModule | null = null;
    let engine: NotesEngine | null = null;
    let idleCleanup: () => void = () => {};
    let raf = 0;

    const context: EngineContext = {
      canvas,
      colors: [],
      staff: PLACEHOLDER_INK,
      reduced,
      onFallback: () => swap(),
    };

    /**
     * Readable pockets, in viewport-normalised coordinates.
     *
     * Only elements actually in view become pockets. An off-screen element
     * clamps to a zero-height rect and was silently skipped, which is the right
     * answer anyway — but an element *straddling* the fold used to be clamped to
     * the visible sliver and then treated as if that were the whole thing. Now
     * the box is intersected with the viewport explicitly, so a heading half off
     * the bottom is a pocket over its visible half.
     */
    function calmRects(): Rect[] {
      const width = Math.max(1, window.innerWidth);
      const height = Math.max(1, window.innerHeight);
      const rects: Rect[] = [];
      const tagged = document.querySelectorAll<HTMLElement>("[data-notes-calm]");
      for (const taggedElement of tagged) {
        if (rects.length >= CALM_SLOTS) break;
        const box = taggedElement.getBoundingClientRect();
        const left = Math.max(0, box.left);
        const top = Math.max(0, box.top);
        const right = Math.min(width, box.right);
        const bottom = Math.min(height, box.bottom);
        const w = right - left;
        const h = bottom - top;
        if (w < 8 || h < 8) continue;
        rects.push({ x: left / width, y: top / height, w: w / width, h: h / height });
      }
      return rects;
    }

    function applyCalm(): void {
      engine?.setCalm(calmRects());
    }

    /** Start or stop to match tab visibility and the hero's position. */
    function sync(): void {
      if (!engine) return;
      const wanted = document.visibilityState !== "hidden";
      if (wanted) engine.start();
      else engine.stop();
    }

    /** The GPU engine gave up; finish the effect in 2D. */
    function swap(): void {
      if (!module || disposed) return;
      engine?.destroy();
      engine = module.createFallbackEngine(context);
      canvas.dataset.engine = "canvas";
      applyCalm();
      engine.setScroll(window.scrollY);
      engine.start();
      sync();
    }

    async function boot(): Promise<void> {
      let loaded: NotesModule;
      try {
        loaded = await import("./createEngine");
      } catch {
        // A chunk that never arrives must leave the page entirely intact, so
        // the failure stops here rather than reaching the visitor.
        return;
      }
      if (disposed) return;
      module = loaded;

      const palette = loaded.fieldPalette(canvas);
      context.colors = palette.colors;
      context.staff = palette.staff;

      const booted = await loaded.createNotesEngine(context, force);
      if (disposed) {
        booted.engine.destroy();
        return;
      }
      engine = booted.engine;
      const kind: EngineKind = booted.kind;
      canvas.dataset.engine = kind;
      applyCalm();
      resettle();
      engine.setScroll(window.scrollY);
      // One frame now, so reduced motion has its still picture; `sync()` then
      // decides whether the loop keeps running.
      engine.start();
      sync();
    }

    function onPointerMove(event: PointerEvent): void {
      engine?.setPointer(event.clientX / window.innerWidth, event.clientY / window.innerHeight);
    }
    function onPointerDown(event: PointerEvent): void {
      onPointerMove(event);
      engine?.burst(event.clientX / window.innerWidth, event.clientY / window.innerHeight);
    }
    function onPointerGone(): void {
      engine?.setPointer(null, null);
    }
    function scheduleFrame(work: () => void): void {
      if (raf) return;
      raf = window.requestAnimationFrame(() => {
        raf = 0;
        work();
      });
    }
    function onScroll(): void {
      scheduleFrame(() => {
        engine?.setScroll(window.scrollY);
        applyCalm();
      });
    }
    function onResize(): void {
      scheduleFrame(() => {
        engine?.resize();
        applyCalm();
      });
    }

    // Re-fit the pockets whenever the page's own layout moves: the font swap,
    // the logo decoding, an image arriving, the hero's reveal finishing.
    let settleTimers: number[] = [];
    function resettle(): void {
      applyCalm();
      for (const timer of settleTimers) window.clearTimeout(timer);
      settleTimers = [
        window.setTimeout(applyCalm, RESETTLE_MS / 2),
        window.setTimeout(applyCalm, RESETTLE_MS),
      ];
    }
    const layoutObserver =
      typeof ResizeObserver === "function" ? new ResizeObserver(resettle) : null;
    layoutObserver?.observe(document.documentElement);

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    window.addEventListener("blur", onPointerGone);
    document.addEventListener("pointerleave", onPointerGone);
    document.addEventListener("visibilitychange", sync);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onResize);
    document.fonts?.addEventListener?.("loadingdone", resettle);

    // After first paint: the hero text is already on screen and interactive.
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(() => void boot(), { timeout: 1500 });
      idleCleanup = () => window.cancelIdleCallback(handle);
    } else {
      const handle = window.setTimeout(() => void boot(), 250);
      idleCleanup = () => window.clearTimeout(handle);
    }

    return () => {
      disposed = true;
      idleCleanup();
      if (raf) window.cancelAnimationFrame(raf);
      layoutObserver?.disconnect();
      for (const timer of settleTimers) window.clearTimeout(timer);
      settleTimers = [];
      document.fonts?.removeEventListener?.("loadingdone", resettle);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("blur", onPointerGone);
      document.removeEventListener("pointerleave", onPointerGone);
      document.removeEventListener("visibilitychange", sync);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onResize);
      engine?.destroy();
      engine = null;
      delete canvas.dataset.engine;
    };
  }, [dark, reduced]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      data-notes-field=""
      data-motion={reduced ? "reduced" : "full"}
      /*
       * Behind every painted surface on the page, including in-flow content: a
       * negative index on a transparent fixed layer is what lets the note field
       * show through the margins and between sections while the opaque hero
       * panel and cards still cover it.
       */
      className="pointer-events-none fixed inset-0 -z-10 h-full w-full"
    />
  );
}
