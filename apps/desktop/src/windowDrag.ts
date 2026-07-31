/**
 * Reliable window drag for Tauri 2 overlay title bars.
 *
 * `data-tauri-drag-region` is flaky with nested React content in WKWebView.
 * Calling `getCurrentWindow().startDragging()` from mousedown works consistently.
 * Double-click chrome toggles maximize (fill the screen, keep dock/menu bar).
 *
 * Important: maximize must run exactly once per double-click. Calling
 * `toggleMaximize` from both mousedown (detail>=2) and dblclick flips
 * maximize→restore immediately.
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const INTERACTIVE =
  "button, a, input, textarea, select, label, [role='button'], [role='tab']";

/**
 * Wait longer than a typical double-click gap before starting a drag,
 * so the second click can cancel the pending drag.
 */
const DRAG_DELAY_MS = 280;
/** Ignore repeated maximize toggles within this window (dblclick + detail=2). */
const TOGGLE_COOLDOWN_MS = 500;

let dragTimer: ReturnType<typeof setTimeout> | null = null;
let lastToggleAt = 0;

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(INTERACTIVE));
}

function clearDragTimer(): void {
  if (dragTimer != null) {
    clearTimeout(dragTimer);
    dragTimer = null;
  }
}

/**
 * Toggle maximized (fill screen). Exit true fullscreen first if active.
 * Debounced so mousedown+dblclick never apply twice.
 */
async function toggleFillScreen(): Promise<void> {
  const now =
    typeof performance !== "undefined" ? performance.now() : Date.now();
  if (now - lastToggleAt < TOGGLE_COOLDOWN_MS) {
    return;
  }
  lastToggleAt = now;

  const win = getCurrentWindow();
  try {
    if (await win.isFullscreen()) {
      await win.setFullscreen(false);
    }
  } catch {
    /* ignore — fullscreen permission may be absent */
  }
  try {
    await win.toggleMaximize();
  } catch (err) {
    console.warn("toggleMaximize failed:", err);
  }
}

/**
 * Attach to onMouseDown of a title-bar / chrome region.
 * Single click → delayed drag. Double-click is handled by onTitlebarDoubleClick.
 */
export function onTitlebarMouseDown(
  e: ReactMouseEvent | MouseEvent,
): void {
  if (e.button !== 0) return;
  if (isInteractiveTarget(e.target)) return;

  e.preventDefault();

  // Second click of a double-click: cancel pending drag only.
  // Do NOT toggle maximize here — onDoubleClick does that once.
  if (e.detail >= 2) {
    clearDragTimer();
    return;
  }

  clearDragTimer();
  dragTimer = setTimeout(() => {
    dragTimer = null;
    void getCurrentWindow()
      .startDragging()
      .catch((err) => {
        console.warn("startDragging failed:", err);
      });
  }, DRAG_DELAY_MS);
}

/** Double-click chrome → maximize / restore (exactly once). */
export function onTitlebarDoubleClick(
  e: ReactMouseEvent | MouseEvent,
): void {
  if (isInteractiveTarget(e.target)) return;
  e.preventDefault();
  e.stopPropagation();
  clearDragTimer();
  void toggleFillScreen();
}
