/**
 * Side chat panel body — Grok Build `/btw` (x.ai/btw).
 * Local Q&A only; does not write to the main session transcript.
 * Embedded in the right rail under the Chat tab.
 *
 * Assistant text is rendered as Markdown. Engine `/btw` returns a full
 * answer (no token stream), so we progressively reveal it for a live feel.
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconSend, IconTrash } from "../icons";

export type SideChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: string;
  /** Waiting for engine (no answer text yet). */
  pending?: boolean;
  /** Progressively revealing the final answer. */
  streaming?: boolean;
  error?: boolean;
};

type Props = {
  sessionId: string | null;
  connected: boolean;
  messages: SideChatMessage[];
  /** Append / replace messages for this session (parent owns storage). */
  onMessagesChange: (
    updater: (prev: SideChatMessage[]) => SideChatMessage[],
  ) => void;
  /** When true, focus the composer (e.g. user switched to Chat tab). */
  active?: boolean;
};

let sideSeq = 0;
function nextId(prefix: string): string {
  sideSeq += 1;
  return `${prefix}-${Date.now()}-${sideSeq}`;
}

/** Open external links outside the webview (same policy as main chat). */
function openExternal(url: string): void {
  const trimmed = url.trim();
  if (!trimmed || !/^(https?:|mailto:)/i.test(trimmed)) return;
  void openUrl(trimmed).catch(() => {
    /* ignore */
  });
}

const SideMarkdown = memo(function SideMarkdown({
  text,
  streaming,
}: {
  text: string;
  streaming?: boolean;
}) {
  if (!text.trim()) {
    return streaming ? (
      <span className="stream-caret" aria-hidden />
    ) : null;
  }
  return (
    <div className="md-body side-chat-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a({ href, children, node: _node, ...props }) {
            return (
              <a
                {...props}
                href={href}
                rel="noopener noreferrer"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  if (href) openExternal(href);
                }}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
      {streaming ? <span className="stream-caret" aria-hidden /> : null}
    </div>
  );
});

/**
 * Reveal `full` into the message id with a typewriter cadence.
 * Uses code-point chunks so CJK doesn't split mid-glyph.
 */
function useRevealAnswer(
  onMessagesChange: Props["onMessagesChange"],
  genRef: React.MutableRefObject<number>,
) {
  const timerRef = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const reveal = useCallback(
    (msgId: string, full: string, gen: number) => {
      if (timerRef.current != null) {
        window.clearTimeout(timerRef.current);
        timerRef.current = null;
      }

      const chars = Array.from(full);
      if (chars.length === 0) {
        onMessagesChange((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  id: msgId,
                  role: "assistant",
                  text: "No response",
                  at: new Date().toISOString(),
                }
              : m,
          ),
        );
        return;
      }

      // Adaptive chunk size: short answers feel snappy; long ones finish sooner.
      const chunk =
        chars.length < 80 ? 1 : chars.length < 400 ? 2 : chars.length < 1200 ? 4 : 8;
      // ~30–45 fps feel without flooding React.
      const intervalMs = 16;

      let i = 0;
      const tick = () => {
        if (genRef.current !== gen) return;
        i = Math.min(chars.length, i + chunk);
        const partial = chars.slice(0, i).join("");
        const done = i >= chars.length;
        onMessagesChange((prev) =>
          prev.map((m) =>
            m.id === msgId
              ? {
                  id: msgId,
                  role: "assistant" as const,
                  text: partial,
                  at: new Date().toISOString(),
                  streaming: !done,
                }
              : m,
          ),
        );
        if (!done) {
          timerRef.current = window.setTimeout(tick, intervalMs);
        } else {
          timerRef.current = null;
        }
      };
      // Start with empty streaming bubble so first paint isn't a freeze.
      onMessagesChange((prev) =>
        prev.map((m) =>
          m.id === msgId
            ? {
                id: msgId,
                role: "assistant",
                text: "",
                at: new Date().toISOString(),
                streaming: true,
              }
            : m,
        ),
      );
      timerRef.current = window.setTimeout(tick, 0);
    },
    [onMessagesChange, genRef],
  );

  return reveal;
}

export const SideChat = memo(function SideChat({
  sessionId,
  connected,
  messages,
  onMessagesChange,
  active = true,
}: Props) {
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  /** Ignore stale answers after clear / session switch. */
  const genRef = useRef(0);
  const reveal = useRevealAnswer(onMessagesChange, genRef);

  useEffect(() => {
    genRef.current += 1;
    setBusy(false);
    setDraft("");
  }, [sessionId]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages]);

  useEffect(() => {
    if (active && connected) {
      inputRef.current?.focus();
    }
  }, [active, connected, sessionId]);

  const canSend =
    Boolean(sessionId) && connected && !busy && draft.trim().length > 0;

  const clearLocal = useCallback(() => {
    genRef.current += 1;
    setBusy(false);
    onMessagesChange(() => []);
  }, [onMessagesChange]);

  const send = useCallback(async () => {
    const question = draft.trim();
    if (!question || !sessionId || !connected || busy) return;

    const gen = ++genRef.current;
    const userMsg: SideChatMessage = {
      id: nextId("side-user"),
      role: "user",
      text: question,
      at: new Date().toISOString(),
    };
    const pendingId = nextId("side-asst");
    const pendingMsg: SideChatMessage = {
      id: pendingId,
      role: "assistant",
      text: "",
      at: new Date().toISOString(),
      pending: true,
    };

    setDraft("");
    setBusy(true);
    onMessagesChange((prev) => [...prev, userMsg, pendingMsg]);

    try {
      const answer = await invoke<string>("send_btw", { question });
      if (genRef.current !== gen) return;
      const full = answer?.trim() || "No response";
      // Progressive reveal + markdown as text grows.
      reveal(pendingId, full, gen);
    } catch (e) {
      if (genRef.current !== gen) return;
      onMessagesChange((prev) =>
        prev.map((m) =>
          m.id === pendingId
            ? {
                id: pendingId,
                role: "assistant" as const,
                text: String(e),
                at: new Date().toISOString(),
                error: true,
              }
            : m,
        ),
      );
    } finally {
      if (genRef.current === gen) setBusy(false);
    }
  }, [draft, sessionId, connected, busy, onMessagesChange, reveal]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  };

  return (
    <div className="side-chat side-chat-embedded" aria-label="Side chat">
      <div className="side-chat-toolbar">
        <span className="side-chat-toolbar-hint">
          /btw · not in main context
        </span>
        <button
          type="button"
          className="icon-btn"
          title="Clear side chat"
          aria-label="Clear side chat"
          onClick={clearLocal}
          disabled={messages.length === 0 && !draft}
        >
          <IconTrash size={14} />
        </button>
      </div>

      <div className="side-chat-body" ref={listRef}>
        {messages.length === 0 ? (
          <div className="side-chat-empty">
            <p>
              Ask a side question without adding to the main chat context.
            </p>
            <p className="side-chat-empty-hint">
              Uses Grok Build <code>/btw</code> — works while the agent is
              Working. Answers render as Markdown.
            </p>
          </div>
        ) : (
          messages.map((m) => (
            <div
              key={m.id}
              className={`side-chat-msg side-chat-msg-${m.role}${
                m.pending ? " is-pending" : ""
              }${m.streaming ? " is-streaming" : ""}${
                m.error ? " is-error" : ""
              }`}
            >
              <div className="side-chat-bubble">
                {m.role === "user" ? (
                  m.text
                ) : m.error ? (
                  m.text
                ) : m.pending && !m.text ? (
                  <span className="side-chat-thinking">
                    Thinking
                    <span className="side-chat-thinking-dots" aria-hidden>
                      …
                    </span>
                    <span className="stream-caret" aria-hidden />
                  </span>
                ) : (
                  <SideMarkdown text={m.text} streaming={m.streaming} />
                )}
              </div>
            </div>
          ))
        )}
      </div>

      <div className="side-chat-composer">
        {!sessionId || !connected ? (
          <p className="side-chat-composer-hint">
            Connect a task to use side chat.
          </p>
        ) : null}
        <textarea
          ref={inputRef}
          className="side-chat-input"
          rows={2}
          placeholder="Do anything"
          value={draft}
          disabled={!sessionId || !connected || busy}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="side-chat-composer-row">
          <span className="side-chat-composer-meta">
            {busy ? "Asking…" : "Side question"}
          </span>
          <button
            type="button"
            className="send-btn"
            title="Send side question"
            disabled={!canSend}
            onClick={() => void send()}
          >
            <IconSend size={14} />
          </button>
        </div>
      </div>
    </div>
  );
});
