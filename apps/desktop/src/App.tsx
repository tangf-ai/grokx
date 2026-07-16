import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type EngineInfo = {
  path: string;
  source: string;
  status: string;
};

type SessionInfo = {
  session_id: string;
  project_root?: string | null;
  status: string;
};

type ChatLine =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string }
  | { kind: "thought"; text: string }
  | { kind: "tool"; text: string }
  | { kind: "system"; text: string }
  | { kind: "error"; text: string };

type AgentEvent = {
  type: string;
  status?: string;
  detail?: string | null;
  session_id?: { "0"?: string } | string;
  text?: string;
  message?: string;
  state?: string;
  steps?: string[];
  tool?: {
    title?: string;
    kind?: string;
    status?: string;
  };
  request?: {
    summary?: string;
    tool_name?: string;
  };
  engine_session_id?: string | null;
};

function sessionIdOf(ev: AgentEvent): string {
  const s = ev.session_id;
  if (!s) return "";
  if (typeof s === "string") return s;
  return s["0"] ?? "";
}

export default function App() {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("0.1.0");
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string>("disconnected");
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const push = useCallback((line: ChatLine) => {
    setLines((prev) => [...prev, line]);
  }, []);

  const appendAssistant = useCallback((text: string) => {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === "assistant") {
        const copy = prev.slice(0, -1);
        copy.push({ kind: "assistant", text: last.text + text });
        return copy;
      }
      return [...prev, { kind: "assistant", text }];
    });
  }, []);

  const appendThought = useCallback((text: string) => {
    setLines((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.kind === "thought") {
        const copy = prev.slice(0, -1);
        copy.push({ kind: "thought", text: last.text + text });
        return copy;
      }
      return [...prev, { kind: "thought", text }];
    });
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines, busy]);

  useEffect(() => {
    invoke<string>("app_version")
      .then(setAppVersion)
      .catch(() => setAppVersion("0.1.0"));

    invoke<EngineInfo>("resolve_engine")
      .then(setEngine)
      .catch((e: unknown) => setError(String(e)));
  }, []);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    (async () => {
      unlisten = await listen<AgentEvent>("agent-event", (event) => {
        const ev = event.payload;
        switch (ev.type) {
          case "agent_status":
            setAgentStatus(ev.status ?? "unknown");
            if (ev.detail) {
              push({ kind: "system", text: `${ev.status}: ${ev.detail}` });
            }
            break;
          case "session_ready":
            setAgentStatus("ready");
            push({
              kind: "system",
              text: `Session ready${ev.engine_session_id ? ` (${ev.engine_session_id})` : ""}`,
            });
            break;
          case "user_message":
            // already added optimistically on send
            break;
          case "message_delta":
            if (ev.text) appendAssistant(ev.text);
            break;
          case "thought_delta":
            if (ev.text) appendThought(ev.text);
            break;
          case "tool_started":
            push({
              kind: "tool",
              text: `▶ ${ev.tool?.title ?? "tool"} (${ev.tool?.kind ?? "?"})`,
            });
            break;
          case "tool_updated":
            push({
              kind: "tool",
              text: `● ${ev.tool?.title ?? "tool"} → ${ev.tool?.status ?? "?"}`,
            });
            break;
          case "permission_needed":
            push({
              kind: "system",
              text: `Permission: ${ev.request?.summary ?? ev.request?.tool_name ?? "tool"}`,
            });
            break;
          case "plan_updated":
            if (ev.steps?.length) {
              push({ kind: "system", text: `Plan: ${ev.steps.join(" → ")}` });
            }
            break;
          case "turn_state":
            setBusy(ev.state === "streaming" || ev.state === "running_tools");
            break;
          case "turn_finished":
            setBusy(false);
            if (ev.state === "error") {
              push({ kind: "error", text: "Turn ended with error" });
            }
            break;
          case "agent_error":
            setBusy(false);
            push({ kind: "error", text: ev.message ?? "Agent error" });
            break;
          default:
            // ignore unknown for forward-compat
            void sessionIdOf(ev);
            break;
        }
      });
      if (cancelled) unlisten?.();
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [appendAssistant, appendThought, push]);

  const onConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      const info = await invoke<SessionInfo>("connect_workspace", {
        projectRoot: null,
        autoApprove: true,
      });
      setSession(info);
      setAgentStatus(info.status);
      push({
        kind: "system",
        text: `Connected · cwd ${info.project_root ?? "."}`,
      });
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  const onSend = async () => {
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    push({ kind: "user", text });
    setBusy(true);
    try {
      await invoke("send_prompt", { text });
    } catch (e) {
      setBusy(false);
      push({ kind: "error", text: String(e) });
    }
  };

  const onCancel = async () => {
    try {
      await invoke("cancel_turn");
    } catch (e) {
      push({ kind: "error", text: String(e) });
    } finally {
      setBusy(false);
    }
  };

  const connected = useMemo(
    () => Boolean(session?.session_id) && agentStatus.toLowerCase().includes("ready"),
    [session, agentStatus],
  );

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">grokx</div>
        <nav>
          <div className="nav-item active">Workspace</div>
          <div className="nav-item muted">Sessions</div>
          <div className="nav-item muted">Settings</div>
        </nav>
        <div className="sidebar-footer">v{appVersion}</div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>ACP chat</h1>
          <p className="subtitle">
            Minimal loop: connect → prompt → stream tools / text.
          </p>
        </header>

        <section className="panel">
          <h2>Engine</h2>
          {error && <pre className="error">{error}</pre>}
          {engine ? (
            <dl className="kv">
              <dt>Binary</dt>
              <dd className="mono">{engine.path}</dd>
              <dt>Source</dt>
              <dd>{engine.source}</dd>
              <dt>Agent</dt>
              <dd>{agentStatus}</dd>
              <dt>Session</dt>
              <dd className="mono">{session?.session_id || "—"}</dd>
              <dt>CWD</dt>
              <dd className="mono">{session?.project_root || "—"}</dd>
            </dl>
          ) : (
            !error && <p className="muted">Resolving engine…</p>
          )}
          <div className="row-actions">
            <button onClick={onConnect} disabled={connecting}>
              {connecting ? "Connecting…" : connected ? "Reconnect" : "Connect agent"}
            </button>
            {busy && (
              <button className="ghost" onClick={onCancel}>
                Cancel turn
              </button>
            )}
          </div>
          <p className="hint">
            Dev mode uses PATH <code>grok</code> when bundled runtime is missing,
            and auto-approves tool permissions for the first loop.
          </p>
        </section>

        <section className="panel chat">
          <h2>Chat</h2>
          <div className="transcript">
            {lines.length === 0 && (
              <p className="muted">Connect, then send a prompt.</p>
            )}
            {lines.map((line, i) => (
              <div key={i} className={`line line-${line.kind}`}>
                <span className="tag">{line.kind}</span>
                <pre>{line.text}</pre>
              </div>
            ))}
            <div ref={bottomRef} />
          </div>
          <div className="composer">
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void onSend();
                }
              }}
              disabled={!session || busy}
              placeholder={
                session ? "Message the agent…" : "Connect agent first…"
              }
            />
            <button onClick={() => void onSend()} disabled={!session || busy || !draft.trim()}>
              {busy ? "…" : "Send"}
            </button>
          </div>
        </section>
      </main>

      <aside className="right">
        <h2>Review</h2>
        <p className="muted">
          Tool timeline appears in chat for now. Diff / approvals panel comes
          next.
        </p>
      </aside>
    </div>
  );
}
