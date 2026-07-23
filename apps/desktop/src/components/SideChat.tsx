/**
 * Side chat — Grok Build `/btw` (x.ai/btw).
 * Local Q&A only; does not write to the main session transcript.
 * Message layout + composer dock mirror the main chat where possible.
 */
import {
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { IconSend, IconStop, IconTrash } from "../icons";
import {
  ComposerInput,
  type ComposerInputHandle,
} from "./ComposerInput";

export type SideChatMessage = {
  id: string;
  role: "user" | "assistant" | "thought";
  text: string;
  at: string;
  /** Waiting for engine (assistant placeholder). */
  pending?: boolean;
  error?: boolean;
  /** Thought row expanded (default true when just received). */
  thoughtOpen?: boolean;
};

type Props = {
  sessionId: string | null;
  connected: boolean;
  messages: SideChatMessage[];
  onMessagesChange: (
    updater: (prev: SideChatMessage[]) => SideChatMessage[],
  ) => void;
  active?: boolean;
};

type BtwResult = {
  answer: string;
  thinking?: string | null;
};

let sideSeq = 0;
function nextId(prefix: string): string {
  sideSeq += 1;
  return `${prefix}-${Date.now()}-${sideSeq}`;
}

function openExternal(url: string): void {
  const trimmed = url.trim();
  if (!trimmed || !/^(https?:|mailto:)/i.test(trimmed)) return;
  void openUrl(trimmed).catch(() => {
    /* ignore */
  });
}

const SideMarkdown = memo(function SideMarkdown({ text }: { text: string }) {
  if (!text.trim()) return null;
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
    </div>
  );
});

export const SideChat = memo(function SideChat({
  sessionId,
  connected,
  messages,
  onMessagesChange,
  active = true,
}: Props) {
  const [busy, setBusy] = useState(false);
  const [hasDraft, setHasDraft] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);
  const composerRef = useRef<ComposerInputHandle | null>(null);
  const genRef = useRef(0);

  useEffect(() => {
    genRef.current += 1;
    setBusy(false);
    setHasDraft(false);
    composerRef.current?.clear();
  }, [sessionId]);

  /** Smooth follow to bottom when side-chat content grows. */
  const sideScrollRaf = useRef<number | null>(null);
  useEffect(() => {
    return () => {
      if (sideScrollRaf.current != null) {
        cancelAnimationFrame(sideScrollRaf.current);
        sideScrollRaf.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    // Already chasing bottom — live loop reads scrollHeight each frame.
    if (sideScrollRaf.current != null) return;

    const step = () => {
      const root = listRef.current;
      if (!root) {
        sideScrollRaf.current = null;
        return;
      }
      const maxTop = Math.max(0, root.scrollHeight - root.clientHeight);
      const remaining = maxTop - root.scrollTop;
      if (remaining <= 0.5) {
        if (remaining > 0) root.scrollTop = maxTop;
        // Keep a light poll while waiting for answer (height may still change).
        if (busy) {
          sideScrollRaf.current = requestAnimationFrame(step);
        } else {
          sideScrollRaf.current = null;
        }
        return;
      }
      const ease =
        remaining > 200 ? 0.26 : remaining > 80 ? 0.18 : 0.13;
      let delta = remaining * ease;
      if (delta < 1) delta = Math.min(1, remaining);
      if (delta > 72) delta = 72;
      root.scrollTop = Math.min(maxTop, root.scrollTop + delta);
      sideScrollRaf.current = requestAnimationFrame(step);
    };
    sideScrollRaf.current = requestAnimationFrame(step);
  }, [messages, busy]);

  useEffect(() => {
    if (active && connected) {
      composerRef.current?.focus();
    }
  }, [active, connected, sessionId]);

  const canSend =
    Boolean(sessionId) && connected && !busy && hasDraft;

  const clearLocal = useCallback(() => {
    genRef.current += 1;
    setBusy(false);
    onMessagesChange(() => []);
  }, [onMessagesChange]);

  const toggleThought = useCallback(
    (id: string) => {
      onMessagesChange((prev) =>
        prev.map((m) =>
          m.id === id && m.role === "thought"
            ? { ...m, thoughtOpen: !(m.thoughtOpen ?? true) }
            : m,
        ),
      );
    },
    [onMessagesChange],
  );

  const send = useCallback(async () => {
    const question = (composerRef.current?.getValue() ?? "").trim();
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

    composerRef.current?.clear();
    setHasDraft(false);
    setBusy(true);
    onMessagesChange((prev) => [...prev, userMsg, pendingMsg]);

    try {
      const raw = await invoke<BtwResult | string>("send_btw", { question });
      if (genRef.current !== gen) return;

      // Compat: older bridge returned plain string.
      const answer =
        typeof raw === "string"
          ? raw.trim()
          : (raw?.answer ?? "").trim() || "No response";
      const thinking =
        typeof raw === "string"
          ? null
          : (raw?.thinking ?? "").trim() || null;

      onMessagesChange((prev) => {
        const withoutPending = prev.filter((m) => m.id !== pendingId);
        const next: SideChatMessage[] = [...withoutPending];
        if (thinking) {
          next.push({
            id: nextId("side-thought"),
            role: "thought",
            text: thinking,
            at: new Date().toISOString(),
            thoughtOpen: true,
          });
        }
        next.push({
          id: pendingId,
          role: "assistant",
          text: answer,
          at: new Date().toISOString(),
        });
        return next;
      });
    } catch (e) {
      if (genRef.current !== gen) return;
      onMessagesChange((prev) =>
        prev.map((m) =>
          m.id === pendingId
            ? {
                id: pendingId,
                role: "assistant",
                text: String(e),
                at: new Date().toISOString(),
                error: true,
              }
            : m,
        ),
      );
    } finally {
      if (genRef.current === gen) {
        setBusy(false);
        composerRef.current?.focus();
      }
    }
  }, [sessionId, connected, busy, onMessagesChange]);

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
          disabled={messages.length === 0 && !hasDraft}
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
              Uses Grok Build <code>/btw</code> — same composer as main chat.
              Thinking appears like the main transcript when the model returns
              it.
            </p>
          </div>
        ) : (
          messages.map((m) => {
            if (m.role === "user") {
              return (
                <div key={m.id} className="msg msg-user side-chat-line">
                  <div className="msg-user-stack">
                    <div className="msg-body">
                      <div className="msg-user-text">{m.text}</div>
                    </div>
                  </div>
                </div>
              );
            }
            if (m.role === "thought") {
              const open = m.thoughtOpen ?? true;
              return (
                <div key={m.id} className="msg msg-thought side-chat-line">
                  <button
                    type="button"
                    className="side-chat-thought-toggle"
                    onClick={() => toggleThought(m.id)}
                    aria-expanded={open}
                  >
                    <span className="side-chat-thought-chevron" aria-hidden>
                      {open ? "▾" : "▸"}
                    </span>
                    Thinking
                  </button>
                  {open && (
                    <div className="msg-body md-body thought-md">
                      <SideMarkdown text={m.text} />
                    </div>
                  )}
                </div>
              );
            }
            // assistant
            return (
              <div
                key={m.id}
                className={`msg msg-assistant side-chat-line${
                  m.pending ? " is-pending" : ""
                }${m.error ? " is-error" : ""}`}
              >
                <div className="msg-body md-body">
                  {m.pending && !m.text ? (
                    <div className="waiting-body">
                      <span className="waiting-dots" aria-hidden>
                        <span />
                        <span />
                        <span />
                      </span>
                      <span>Thinking…</span>
                    </div>
                  ) : m.error ? (
                    m.text
                  ) : (
                    <SideMarkdown text={m.text} />
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      <div className="side-chat-composer-dock">
        {!sessionId || !connected ? (
          <p className="side-chat-composer-hint">
            Connect a task to use side chat.
          </p>
        ) : null}
        <ComposerInput
          ref={composerRef}
          disabled={!sessionId || !connected || busy}
          placeholder={
            sessionId && connected
              ? "Describe what this task should do… (paste text or images)"
              : "Connect a task to start…"
          }
          onSubmit={() => {
            void send();
          }}
          onDraftChange={(t) => setHasDraft(t.trim().length > 0)}
        />
        <div className="composer-bar side-chat-composer-bar">
          <div className="composer-left">
            <span className="side-chat-composer-meta">
              {busy ? "Asking…" : "Not in main context"}
            </span>
          </div>
          <div className="composer-right">
            {busy ? (
              <button
                type="button"
                className="send-btn stop"
                title="Stop waiting (discards late reply)"
                aria-label="Stop side chat wait"
                onClick={() => {
                  genRef.current += 1;
                  setBusy(false);
                  onMessagesChange((prev) =>
                    prev.filter((m) => !(m.role === "assistant" && m.pending)),
                  );
                }}
              >
                <IconStop size={14} />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                title="Send side question"
                disabled={!canSend}
                onClick={() => void send()}
              >
                <IconSend size={16} />
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});
