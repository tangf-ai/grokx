/**
 * Reliable window drag for Tauri 2 overlay title bars.
 *
 * `data-tauri-drag-region` is flaky with nested React content in WKWebView.
 * Calling `getCurrentWindow().startDragging()` from mousedown works consistently.
 */
import type { MouseEvent as ReactMouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";

const INTERACTIVE = "button, a, input, textarea, select, label, [role='button']";

function isInteractiveTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest(INTERACTIVE));
}

/** Attach to onMouseDown of a title-bar / chrome region. */
export function onTitlebarMouseDown(
  e: ReactMouseEvent | MouseEvent,
): void {
  // Left button only; ignore double-click maximize for now (detail === 2).
  if (e.button !== 0) return;
  if (isInteractiveTarget(e.target)) return;

  e.preventDefault();
  void getCurrentWindow()
    .startDragging()
    .catch((err) => {
      console.warn("startDragging failed:", err);
    });
}
