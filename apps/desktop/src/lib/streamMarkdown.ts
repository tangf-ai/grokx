/**
 * Split streaming markdown so closed blocks can be parsed while an
 * unfinished fenced code block stays plain text (cheap to update).
 */

export type StreamMarkdownParts = {
  closed: string;
  openFence: string | null;
};

/** Odd number of ``` / ~~~ fences ⇒ last fence is still open. */
export function splitStreamingMarkdown(src: string): StreamMarkdownParts {
  if (!src) return { closed: "", openFence: null };
  const fenceRe = /^( {0,3})(`{3,}|~{3,})/gm;
  const starts: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(src)) !== null) {
    starts.push(m.index);
  }
  if (starts.length % 2 === 0) {
    return { closed: src, openFence: null };
  }
  const openAt = starts[starts.length - 1];
  return {
    closed: src.slice(0, openAt),
    openFence: src.slice(openAt),
  };
}
