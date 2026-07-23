/**
 * Real-time stream flourish: when new assistant text arrives, spawn a
 * short rainbow "fall-in" burst of the latest characters near the caret.
 * Keeps the full markdown body intact; this is a decorative overlay only.
 */
import {
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";

type Burst = {
  id: number;
  /** Visible glyphs from the latest delta (capped). */
  glyphs: string[];
};

type Props = {
  text: string;
  active: boolean;
};

let burstSeq = 0;

function pickGlyphs(chunk: string): string[] {
  // Prefer non-whitespace; fall back to sparkles if only spaces/newlines.
  const chars = Array.from(chunk).filter((c) => !/\s/.test(c));
  if (chars.length === 0) {
    return ["✦", "✧", "·", "✦", "✧"];
  }
  // Keep it light: last up to 10 glyphs of this delta.
  return chars.slice(-10);
}

export const StreamReveal = memo(function StreamReveal({
  text,
  active,
}: Props) {
  const prevLenRef = useRef(0);
  const [bursts, setBursts] = useState<Burst[]>([]);

  useEffect(() => {
    if (!active) {
      prevLenRef.current = text.length;
      setBursts([]);
      return;
    }
    const prev = prevLenRef.current;
    if (text.length <= prev) {
      prevLenRef.current = text.length;
      return;
    }
    const chunk = text.slice(prev);
    prevLenRef.current = text.length;
    const glyphs = pickGlyphs(chunk);
    const id = ++burstSeq;
    setBursts((b) => [...b.slice(-4), { id, glyphs }]);
    const t = window.setTimeout(() => {
      setBursts((b) => b.filter((x) => x.id !== id));
    }, 720);
    return () => window.clearTimeout(t);
  }, [text, active]);

  if (!active || bursts.length === 0) return null;

  return (
    <span className="stream-reveal" aria-hidden>
      {bursts.map((burst) => (
        <span key={burst.id} className="stream-reveal-burst">
          {burst.glyphs.map((g, i) => (
            <span
              key={`${burst.id}-${i}`}
              className="stream-reveal-char"
              style={
                {
                  ["--i" as string]: i,
                  ["--n" as string]: burst.glyphs.length,
                } as CSSProperties
              }
            >
              {g}
            </span>
          ))}
        </span>
      ))}
    </span>
  );
});
