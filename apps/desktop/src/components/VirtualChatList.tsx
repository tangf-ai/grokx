/**
 * Lightweight windowed chat list: only mount rows near the viewport.
 * Variable-height items use estimated sizes + overscan; no extra deps.
 */
import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

export type VirtualItem = {
  id: string;
  /** Rough height hint (px) for windowing math. */
  estimateHeight: number;
};

type Props<T extends VirtualItem> = {
  items: T[];
  scrollerRef: RefObject<HTMLElement | null>;
  /** Pixels of overscan above/below viewport. */
  overscanPx?: number;
  renderItem: (item: T, index: number) => ReactNode;
  /** Bottom sentinel for auto-scroll / jump targets. */
  footer?: ReactNode;
  className?: string;
};

type WindowRange = { start: number; end: number; topPad: number; bottomPad: number };

function computeWindow(
  items: VirtualItem[],
  scrollTop: number,
  viewportH: number,
  overscanPx: number,
): WindowRange {
  const n = items.length;
  if (n === 0) {
    return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
  }

  // Prefix heights
  const heights = new Array<number>(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const h = Math.max(24, items[i].estimateHeight || 64);
    heights[i] = h;
    total += h;
  }

  const viewStart = Math.max(0, scrollTop - overscanPx);
  const viewEnd = scrollTop + viewportH + overscanPx;

  let acc = 0;
  let start = 0;
  for (let i = 0; i < n; i++) {
    const next = acc + heights[i];
    if (next > viewStart) {
      start = i;
      break;
    }
    acc = next;
    start = i;
  }

  let end = start;
  let span = acc;
  for (let i = start; i < n; i++) {
    span += heights[i];
    end = i + 1;
    if (span >= viewEnd) break;
  }

  // Always keep a reasonable minimum window for short lists.
  if (n <= 40) {
    return { start: 0, end: n, topPad: 0, bottomPad: 0 };
  }

  let topPad = 0;
  for (let i = 0; i < start; i++) topPad += heights[i];
  let bottomPad = 0;
  for (let i = end; i < n; i++) bottomPad += heights[i];

  // Guard: if estimates are way off, fall back to full list for tiny remaining.
  if (end - start >= n - 2) {
    return { start: 0, end: n, topPad: 0, bottomPad: 0 };
  }

  void total;
  return { start, end, topPad, bottomPad };
}

function VirtualChatListInner<T extends VirtualItem>({
  items,
  scrollerRef,
  overscanPx = 900,
  renderItem,
  footer,
  className,
}: Props<T>) {
  const [range, setRange] = useState<WindowRange>({
    start: 0,
    end: items.length,
    topPad: 0,
    bottomPad: 0,
  });
  const rafRef = useRef<number | null>(null);

  const recompute = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = computeWindow(
      items,
      el.scrollTop,
      el.clientHeight,
      overscanPx,
    );
    setRange((prev) => {
      if (
        prev.start === next.start &&
        prev.end === next.end &&
        prev.topPad === next.topPad &&
        prev.bottomPad === next.bottomPad
      ) {
        return prev;
      }
      return next;
    });
  }, [items, scrollerRef, overscanPx]);

  useEffect(() => {
    recompute();
  }, [recompute, items.length]);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (rafRef.current != null) return;
      rafRef.current = requestAnimationFrame(() => {
        rafRef.current = null;
        recompute();
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, [scrollerRef, recompute]);

  const slice = useMemo(
    () => items.slice(range.start, range.end),
    [items, range.start, range.end],
  );

  const topStyle: CSSProperties = { height: range.topPad, flexShrink: 0 };
  const bottomStyle: CSSProperties = { height: range.bottomPad, flexShrink: 0 };

  return (
    <div className={className}>
      {range.topPad > 0 && (
        <div style={topStyle} aria-hidden className="chat-virtual-pad" />
      )}
      {slice.map((item, i) => (
        <div key={item.id} className="chat-virtual-item">
          {renderItem(item, range.start + i)}
        </div>
      ))}
      {range.bottomPad > 0 && (
        <div style={bottomStyle} aria-hidden className="chat-virtual-pad" />
      )}
      {footer}
    </div>
  );
}

export const VirtualChatList = memo(VirtualChatListInner) as typeof VirtualChatListInner;
