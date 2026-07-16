import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type EngineInfo = {
  path: string;
  source: string;
  status: string;
};

export default function App() {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("0.1.0");

  useEffect(() => {
    invoke<string>("app_version")
      .then(setAppVersion)
      .catch(() => setAppVersion("0.1.0"));

    invoke<EngineInfo>("resolve_engine")
      .then(setEngine)
      .catch((e: unknown) => setError(String(e)));
  }, []);

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
          <h1>Desktop scaffold</h1>
          <p className="subtitle">
            Tauri shell + Rust core. Engine is bundled Grok Build (subtree).
          </p>
        </header>

        <section className="panel">
          <h2>Engine runtime</h2>
          {error && <pre className="error">{error}</pre>}
          {engine ? (
            <dl className="kv">
              <dt>Status</dt>
              <dd>{engine.status}</dd>
              <dt>Source</dt>
              <dd>{engine.source}</dd>
              <dt>Path</dt>
              <dd className="mono">{engine.path}</dd>
            </dl>
          ) : (
            !error && <p className="muted">Resolving engine…</p>
          )}
          <p className="hint">
            Resolution order: custom path → bundled <code>runtime/grok</code> →
            PATH (dev fallback).
          </p>
        </section>

        <section className="panel chat-placeholder">
          <h2>Chat</h2>
          <p className="muted">
            ACP session loop lands next: prompt → stream → tools → approvals →
            diff.
          </p>
          <div className="composer">
            <input disabled placeholder="Message the agent…" />
            <button disabled>Send</button>
          </div>
        </section>
      </main>

      <aside className="right">
        <h2>Review</h2>
        <p className="muted">Diff / plan / approvals panel (placeholder).</p>
      </aside>
    </div>
  );
}
