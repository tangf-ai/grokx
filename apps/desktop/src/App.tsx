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

type SessionListRow = {
  session_id: string;
  project_root: string;
  project_name: string;
  title: string;
  engine_session_id?: string | null;
  updated_at: string;
};

type PendingPermission = {
  id: string;
  summary: string;
  tool_name: string;
  detail?: string | null;
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
    id?: string;
    summary?: string;
    tool_name?: string;
    detail?: string | null;
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
  const [sessions, setSessions] = useState<SessionListRow[]>([]);
  const [projectRoot, setProjectRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("0.1.0");
  const [lines, setLines] = useState<ChatLine[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string>("disconnected");
  const [autoApprove, setAutoApprove] = useState(false);
  const [pendingPerm, setPendingPerm] = useState<PendingPermission | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  const refreshSessions = useCallback(async () => {
    try {
      const rows = await invoke<SessionListRow[]>("list_sessions");
      setSessions(rows);
    } catch {
      /* store empty until first connect */
    }
  }, []);

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
  }, [lines, busy, pendingPerm]);

  useEffect(() => {
    invoke<string>("app_version")
      .then(setAppVersion)
      .catch(() => setAppVersion("0.1.0"));

    invoke<EngineInfo>("resolve_engine")
      .then(setEngine)
      .catch((e: unknown) => setError(String(e)));

    void refreshSessions();
  }, [refreshSessions]);

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
            void refreshSessions();
            break;
          case "user_message":
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
            if (ev.request?.id) {
              setPendingPerm({
                id: ev.request.id,
                summary: ev.request.summary ?? "Permission required",
                tool_name: ev.request.tool_name ?? "tool",
                detail: ev.request.detail,
              });
              setBusy(true);
            }
            push({
              kind: "system",
              text: `Permission pending: ${ev.request?.summary ?? ev.request?.tool_name ?? "tool"}`,
            });
            break;
          case "plan_updated":
            if (ev.steps?.length) {
              push({ kind: "system", text: `Plan: ${ev.steps.join(" → ")}` });
            }
            break;
          case "turn_state":
            setBusy(
              ev.state === "streaming" ||
                ev.state === "running_tools" ||
                ev.state === "waiting_permission",
            );
            break;
          case "turn_finished":
            setBusy(false);
            setPendingPerm(null);
            if (ev.state === "error") {
              push({ kind: "error", text: "Turn ended with error" });
            }
            void refreshSessions();
            break;
          case "agent_error":
            setBusy(false);
            push({ kind: "error", text: ev.message ?? "Agent error" });
            break;
          default:
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
  }, [appendAssistant, appendThought, push, refreshSessions]);

  const onSetProject = async () => {
    const root = projectRoot.trim();
    if (!root) {
      setError("Enter a project directory path");
      return;
    }
    setError(null);
    try {
      const path = await invoke<string>("set_project_root", { projectRoot: root });
      setProjectRoot(path);
      push({ kind: "system", text: `Project set: ${path}` });
    } catch (e) {
      setError(String(e));
    }
  };

  const onConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      if (projectRoot.trim()) {
        await invoke<string>("set_project_root", {
          projectRoot: projectRoot.trim(),
        });
      }
      const info = await invoke<SessionInfo>("connect_workspace", {
        projectRoot: projectRoot.trim() || null,
        autoApprove,
      });
      setSession(info);
      if (info.project_root) setProjectRoot(info.project_root);
      setAgentStatus(info.status);
      push({
        kind: "system",
        text: `Connected · cwd ${info.project_root ?? "."} · autoApprove=${autoApprove}`,
      });
      await refreshSessions();
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  const onReconnect = async (sessionId: string) => {
    setConnecting(true);
    setError(null);
    try {
      const info = await invoke<SessionInfo>("reconnect_session", {
        sessionId,
        autoApprove,
      });
      setSession(info);
      if (info.project_root) setProjectRoot(info.project_root);
      setAgentStatus(info.status);
      push({ kind: "system", text: `Reconnected as ${info.session_id}` });
      await refreshSessions();
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
      setPendingPerm(null);
    }
  };

  const onPermission = async (decision: "allow_once" | "deny") => {
    if (!pendingPerm) return;
    const id = pendingPerm.id;
    try {
      await invoke("resolve_permission", { requestId: id, decision });
      push({
        kind: "system",
        text: `Permission ${decision === "deny" ? "denied" : "allowed"}: ${pendingPerm.summary}`,
      });
      setPendingPerm(null);
    } catch (e) {
      push({ kind: "error", text: String(e) });
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
          <div className="nav-item">Sessions</div>
        </nav>
        <div className="session-list">
          {sessions.length === 0 && (
            <p className="muted small">No sessions yet.</p>
          )}
          {sessions.map((s) => (
            <button
              key={s.session_id}
              className="session-row"
              onClick={() => void onReconnect(s.session_id)}
              title={s.project_root}
            >
              <div className="session-title">{s.title || s.session_id.slice(0, 8)}</div>
              <div className="session-meta mono">
                {s.project_name} · {new Date(s.updated_at).toLocaleString()}
              </div>
            </button>
          ))}
        </div>
        <div className="sidebar-footer">v{appVersion}</div>
      </aside>

      <main className="main">
        <header className="topbar">
          <h1>ACP chat</h1>
          <p className="subtitle">
            Project → connect → prompt → permissions → stream.
          </p>
        </header>

        <section className="panel">
          <h2>Project & engine</h2>
          {error && <pre className="error">{error}</pre>}
          <div className="project-row">
            <input
              className="project-input"
              value={projectRoot}
              onChange={(e) => setProjectRoot(e.target.value)}
              placeholder="/path/to/project"
            />
            <button onClick={() => void onSetProject()}>Set project</button>
          </div>
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
              <dd className="mono">{session?.project_root || projectRoot || "—"}</dd>
            </dl>
          ) : (
            !error && <p className="muted">Resolving engine…</p>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={autoApprove}
              onChange={(e) => setAutoApprove(e.target.checked)}
            />
            Auto-approve tools (skip permission UI)
          </label>
          <div className="row-actions">
            <button onClick={() => void onConnect()} disabled={connecting}>
              {connecting ? "Connecting…" : connected ? "Reconnect" : "Connect agent"}
            </button>
            {busy && (
              <button className="ghost" onClick={() => void onCancel()}>
                Cancel turn
              </button>
            )}
          </div>
        </section>

        <section className="panel chat">
          <h2>Chat</h2>
          <div className="transcript">
            {lines.length === 0 && (
              <p className="muted">Set a project, connect, then send a prompt.</p>
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
            <button
              onClick={() => void onSend()}
              disabled={!session || busy || !draft.trim()}
            >
              {busy ? "…" : "Send"}
            </button>
          </div>
        </section>
      </main>

      <aside className="right">
        <h2>Approvals</h2>
        {pendingPerm ? (
          <div className="perm-card">
            <div className="perm-title">{pendingPerm.tool_name}</div>
            <p>{pendingPerm.summary}</p>
            {pendingPerm.detail && (
              <pre className="perm-detail">{pendingPerm.detail}</pre>
            )}
            <div className="row-actions">
              <button onClick={() => void onPermission("allow_once")}>Allow</button>
              <button className="ghost" onClick={() => void onPermission("deny")}>
                Deny
              </button>
            </div>
            <p className="hint">
              Agent is blocked until you choose. Request id:{" "}
              <code>{pendingPerm.id.slice(0, 8)}</code>
            </p>
          </div>
        ) : (
          <p className="muted">
            When auto-approve is off, tool permission requests appear here and
            the agent waits.
          </p>
        )}
      </aside>
    </div>
  );
}
