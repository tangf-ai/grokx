/**
 * Windowed chat list with measured row heights.
 * Estimates only bootstrap; ResizeObserver corrects pads so scroll can
 * always reach the true bottom (and jump-to-bottom works).
 */
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from "react";

export type VirtualItem = {
  id: string;
  /** Rough height hint (px) until measured. */
  estimateHeight: number;
};

/** Imperative helpers for accurate jump-to-row (uses measured heights). */
export type VirtualChatListHandle = {
  /**
   * Pixel offset of the top of `id` from the top of the list content
   * (sum of heights of preceding rows; measured when available).
   */
  offsetOf: (id: string) => number | null;
  /** Height used for a row (measured or estimate). */
  heightOf: (id: string) => number | null;
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

type WindowRange = {
  start: number;
  end: number;
  topPad: number;
  bottomPad: number;
};

/** Full render below this count — measurement cost is fine, avoids pad bugs. */
const FULL_RENDER_LIMIT = 48;

function heightsFor(
  items: VirtualItem[],
  measured: Map<string, number>,
): number[] {
  const n = items.length;
  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const m = measured.get(items[i].id);
    out[i] = Math.max(24, m ?? (items[i].estimateHeight || 64));
  }
  return out;
}

function computeWindow(
  items: VirtualItem[],
  measured: Map<string, number>,
  scrollTop: number,
  viewportH: number,
  overscanPx: number,
): WindowRange {
  const n = items.length;
  if (n === 0) {
    return { start: 0, end: 0, topPad: 0, bottomPad: 0 };
  }

  if (n <= FULL_RENDER_LIMIT) {
    return { start: 0, end: n, topPad: 0, bottomPad: 0 };
  }

  const heights = heightsFor(items, measured);

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

  // Always keep the last few rows mounted so true bottom height is real,
  // not a short estimate that blocks scrolling / jump-to-bottom.
  const TAIL_KEEP = 12;
  end = Math.max(end, n - TAIL_KEEP);

  // Near the bottom: mount everything to the end (expand window downward).
  const total = heights.reduce((a, b) => a + b, 0);
  const distFromBottom = total - (scrollTop + viewportH);
  if (distFromBottom < viewportH * 2) {
    end = n;
  }

  let topPad = 0;
  for (let i = 0; i < start; i++) topPad += heights[i];
  let bottomPad = 0;
  for (let i = end; i < n; i++) bottomPad += heights[i];

  if (end - start >= n - 2 || bottomPad === 0 && start === 0) {
    return { start: 0, end: n, topPad: 0, bottomPad: 0 };
  }

  return { start, end, topPad, bottomPad };
}

function VirtualChatListInner<T extends VirtualItem>(
  {
    items,
    scrollerRef,
    overscanPx = 1200,
    renderItem,
    footer,
    className,
  }: Props<T>,
  ref: React.ForwardedRef<VirtualChatListHandle>,
) {
  const [range, setRange] = useState<WindowRange>({
    start: 0,
    end: items.length,
    topPad: 0,
    bottomPad: 0,
  });
  /** Measured row heights by id — drives pad correction. */
  const measuredRef = useRef<Map<string, number>>(new Map());
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [measureTick, setMeasureTick] = useState(0);
  const rafRef = useRef<number | null>(null);
  const measureRafRef = useRef<number | null>(null);
  const rowElsRef = useRef<Map<string, HTMLDivElement>>(new Map());
  const roRef = useRef<ResizeObserver | null>(null);

  useImperativeHandle(
    ref,
    () => ({
      offsetOf(id: string) {
        const list = itemsRef.current;
        let acc = 0;
        for (const item of list) {
          if (item.id === id) return acc;
          const m = measuredRef.current.get(item.id);
          acc += Math.max(24, m ?? (item.estimateHeight || 64));
        }
        return null;
      },
      heightOf(id: string) {
        const list = itemsRef.current;
        const item = list.find((x) => x.id === id);
        if (!item) return null;
        const m = measuredRef.current.get(id);
        return Math.max(24, m ?? (item.estimateHeight || 64));
      },
    }),
    [],
  );

  const bumpMeasure = useCallback(() => {
    if (measureRafRef.current != null) return;
    measureRafRef.current = requestAnimationFrame(() => {
      measureRafRef.current = null;
      setMeasureTick((t) => t + 1);
    });
  }, []);

  const recompute = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const next = computeWindow(
      items,
      measuredRef.current,
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
  }, [items, scrollerRef, overscanPx, measureTick]);

  // Drop measurements for removed messages; recompute when list changes.
  useEffect(() => {
    const live = new Set(items.map((i) => i.id));
    let pruned = false;
    for (const id of measuredRef.current.keys()) {
      if (!live.has(id)) {
        measuredRef.current.delete(id);
        pruned = true;
      }
    }
    if (pruned) bumpMeasure();
    recompute();
  }, [items, recompute, bumpMeasure]);

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

  // Observe mounted rows; correct height map when markdown finishes layout.
  useLayoutEffect(() => {
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      let changed = false;
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const id = node.dataset.vrowId;
        if (!id) continue;
        const h = Math.ceil(entry.contentRect.height);
        if (h <= 0) continue;
        const prev = measuredRef.current.get(id);
        // Ignore sub-pixel noise.
        if (prev != null && Math.abs(prev - h) < 2) continue;
        measuredRef.current.set(id, h);
        changed = true;
      }
      if (changed) bumpMeasure();
    });
    roRef.current = ro;
    for (const [, node] of rowElsRef.current) {
      ro.observe(node);
    }
    return () => {
      ro.disconnect();
      roRef.current = null;
    };
  }, [range.start, range.end, items, bumpMeasure]);

  const setRowRef = useCallback(
    (id: string, node: HTMLDivElement | null) => {
      const prev = rowElsRef.current.get(id);
      if (prev && prev !== node) {
        roRef.current?.unobserve(prev);
        rowElsRef.current.delete(id);
      }
      if (node) {
        node.dataset.vrowId = id;
        rowElsRef.current.set(id, node);
        roRef.current?.observe(node);
        // Immediate measure so first paint after jump isn't short.
        const h = Math.ceil(node.getBoundingClientRect().height);
        if (h > 0) {
          const old = measuredRef.current.get(id);
          if (old == null || Math.abs(old - h) >= 2) {
            measuredRef.current.set(id, h);
            bumpMeasure();
          }
        }
      }
    },
    [bumpMeasure],
  );

  const slice = useMemo(
    () => items.slice(range.start, range.end),
    [items, range.start, range.end],
  );

  const topStyle: CSSProperties = {
    height: range.topPad,
    flexShrink: 0,
    pointerEvents: "none",
  };
  const bottomStyle: CSSProperties = {
    height: range.bottomPad,
    flexShrink: 0,
    pointerEvents: "none",
  };

  return (
    <div className={className}>
      {range.topPad > 0 && (
        <div style={topStyle} aria-hidden className="chat-virtual-pad" />
      )}
      {slice.map((item, i) => (
        <div
          key={item.id}
          className="chat-virtual-item"
          ref={(node) => setRowRef(item.id, node)}
        >
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

const VirtualChatListForward = forwardRef(VirtualChatListInner) as <
  T extends VirtualItem,
>(
  props: Props<T> & { ref?: React.Ref<VirtualChatListHandle> },
) => React.ReactElement | null;

export const VirtualChatList = memo(
  VirtualChatListForward,
) as typeof VirtualChatListForward;
