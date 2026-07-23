/**
 * Soft fall-in for newly streamed text: neutral ink, slow settle, easy on eyes.
 * Decorative only — full markdown body stays intact.
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
  glyphs: string[];
};

type Props = {
  text: string;
  active: boolean;
};

let burstSeq = 0;

function pickGlyphs(chunk: string): string[] {
  // Prefer readable characters; skip pure whitespace deltas.
  const chars = Array.from(chunk).filter((c) => !/\s/.test(c));
  if (chars.length === 0) return [];
  // Last few glyphs of this delta — keep light so fall stays calm.
  return chars.slice(-6);
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
    if (glyphs.length === 0) return;

    const id = ++burstSeq;
    setBursts((b) => [...b.slice(-3), { id, glyphs }]);
    // Match CSS animation length (~1.1s) + small tail.
    const t = window.setTimeout(() => {
      setBursts((b) => b.filter((x) => x.id !== id));
    }, 1200);
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
