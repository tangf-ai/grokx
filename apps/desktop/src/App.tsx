import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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

type Attachment = {
  path: string;
  name: string;
  mime?: string | null;
  size?: number | null;
};

type ModelOption = { id: string; name: string };
type EffortOption = { id: string; label: string };

type PublicSettings = {
  custom_engine_path?: string | null;
  prefer_bundled_engine: boolean;
  model?: string | null;
  effort?: string | null;
  sync_to_grok_config: boolean;
  endpoint: {
    model_id: string;
    name?: string | null;
    base_url?: string | null;
    has_api_key: boolean;
    api_key_hint?: string | null;
    env_key?: string | null;
    api_backend?: string | null;
    context_window?: number | null;
    default_effort?: string | null;
  };
  grok_config_path: string;
};

function formatBytes(n?: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

type ChatLine =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "thought"; text: string }
  | { id: string; kind: "tool"; text: string }
  | { id: string; kind: "system"; text: string }
  | { id: string; kind: "error"; text: string }
  | { id: string; kind: "waiting"; text: string };

let chatLineSeq = 0;
function nextLineId(kind: string): string {
  chatLineSeq += 1;
  return `${kind}-${Date.now()}-${chatLineSeq}`;
}

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

function shortPath(p: string | null | undefined): string {
  if (!p) return "No project";
  const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
  if (parts.length <= 2) return p;
  return `…/${parts.slice(-2).join("/")}`;
}

function chipIcon(kind: ChatLine["kind"]): string {
  switch (kind) {
    case "tool":
      return "⌘";
    case "system":
      return "ⓘ";
    case "error":
      return "!";
    default:
      return "·";
  }
}

export default function App() {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessions, setSessions] = useState<SessionListRow[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
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
  /** Main view: workspace chat vs full settings page. */
  const [view, setView] = useState<"workspace" | "settings">("workspace");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState<string>("grok-4.5");
  const [efforts, setEfforts] = useState<EffortOption[]>([]);
  const [effortId, setEffortId] = useState<string>("medium");
  /** Sticky user prompt while reading replies (id of last scrolled-past user msg). */
  const [stickyUserId, setStickyUserId] = useState<string | null>(null);
  const [highlightUserId, setHighlightUserId] = useState<string | null>(null);
  const [settingsMsg, setSettingsMsg] = useState<string | null>(null);
  const [savingSettings, setSavingSettings] = useState(false);
  // Form fields for system LLM config
  const [cfgModelId, setCfgModelId] = useState("grok-4.5");
  const [cfgName, setCfgName] = useState("Grok 4.5");
  const [cfgBaseUrl, setCfgBaseUrl] = useState("");
  const [cfgApiKey, setCfgApiKey] = useState("");
  const [cfgEnvKey, setCfgEnvKey] = useState("");
  const [cfgBackend, setCfgBackend] = useState("chat_completions");
  const [cfgContext, setCfgContext] = useState("500000");
  const [cfgEffort, setCfgEffort] = useState("medium");
  const [cfgSyncGrok, setCfgSyncGrok] = useState(true);
  const [cfgEnginePath, setCfgEnginePath] = useState("");
  const [cfgHasKey, setCfgHasKey] = useState(false);
  const [cfgKeyHint, setCfgKeyHint] = useState<string | null>(null);
  const [cfgGrokPath, setCfgGrokPath] = useState("~/.grok/config.toml");
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const userMsgEls = useRef<Map<string, HTMLDivElement>>(new Map());

  const refreshSessions = useCallback(async () => {
    try {
      const rows = await invoke<SessionListRow[]>("list_sessions");
      setSessions(rows);
    } catch {
      /* store empty until first connect */
    }
  }, []);

  const push = useCallback((line: Omit<ChatLine, "id"> & { id?: string }) => {
    const full = { ...line, id: line.id ?? nextLineId(line.kind) } as ChatLine;
    setLines((prev) => [...prev, full]);
    return full.id;
  }, []);

  const appendAssistant = useCallback((text: string) => {
    setLines((prev) => {
      // Drop waiting placeholder once real content starts.
      let base = prev;
      if (base.length && base[base.length - 1].kind === "waiting") {
        base = base.slice(0, -1);
      }
      const last = base[base.length - 1];
      if (last && last.kind === "assistant") {
        const copy = base.slice(0, -1);
        copy.push({ ...last, text: last.text + text });
        return copy;
      }
      return [...base, { id: nextLineId("assistant"), kind: "assistant", text }];
    });
  }, []);

  const appendThought = useCallback((text: string) => {
    setLines((prev) => {
      let base = prev;
      if (base.length && base[base.length - 1].kind === "waiting") {
        base = base.slice(0, -1);
      }
      const last = base[base.length - 1];
      if (last && last.kind === "thought") {
        const copy = base.slice(0, -1);
        copy.push({ ...last, text: last.text + text });
        return copy;
      }
      return [...base, { id: nextLineId("thought"), kind: "thought", text }];
    });
  }, []);

  const clearWaiting = useCallback(() => {
    setLines((prev) => {
      if (prev.length && prev[prev.length - 1].kind === "waiting") {
        return prev.slice(0, -1);
      }
      return prev;
    });
  }, []);

  const lastUserMessage = useMemo(() => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (lines[i].kind === "user") return lines[i] as Extract<ChatLine, { kind: "user" }>;
    }
    return null;
  }, [lines]);

  const updateStickyUser = useCallback(() => {
    const scroller = chatScrollRef.current;
    if (!scroller || !lastUserMessage) {
      setStickyUserId(null);
      return;
    }
    const el = userMsgEls.current.get(lastUserMessage.id);
    if (!el) {
      // Message just added — keep sticky once there's content after it.
      const idx = lines.findIndex((l) => l.id === lastUserMessage.id);
      const hasAfter = idx >= 0 && idx < lines.length - 1;
      setStickyUserId(hasAfter ? lastUserMessage.id : null);
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const msgRect = el.getBoundingClientRect();
    // Sticky when the user bubble has scrolled above the visible chat area.
    const scrolledPast = msgRect.bottom < scrollerRect.top + 8;
    const idx = lines.findIndex((l) => l.id === lastUserMessage.id);
    const hasAfter = idx >= 0 && idx < lines.length - 1;
    setStickyUserId(scrolledPast && hasAfter ? lastUserMessage.id : null);
  }, [lastUserMessage, lines]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    // After auto-scroll to bottom, user msg is past — show sticky.
    requestAnimationFrame(() => updateStickyUser());
  }, [lines, busy, pendingPerm, updateStickyUser]);

  useEffect(() => {
    const scroller = chatScrollRef.current;
    if (!scroller) return;
    const onScroll = () => updateStickyUser();
    scroller.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    updateStickyUser();
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [updateStickyUser, view]);

  const jumpToUserMessage = useCallback(
    (id: string) => {
      const el = userMsgEls.current.get(id);
      const scroller = chatScrollRef.current;
      if (!el || !scroller) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      setHighlightUserId(id);
      window.setTimeout(() => {
        setHighlightUserId((cur) => (cur === id ? null : cur));
      }, 1600);
      // After scroll animation, recompute sticky
      window.setTimeout(() => updateStickyUser(), 400);
    },
    [updateStickyUser],
  );

  const stickyUserText = useMemo(() => {
    if (!stickyUserId) return null;
    const line = lines.find((l) => l.id === stickyUserId && l.kind === "user");
    return line?.text ?? null;
  }, [stickyUserId, lines]);

  const refreshModels = useCallback(async () => {
    try {
      const list = await invoke<ModelOption[]>("list_models");
      if (list.length) setModels(list);
      const cur = await invoke<string | null>("current_model");
      if (cur) setModelId(cur);
      else if (list[0]) setModelId(list[0].id);
    } catch {
      setModels([
        { id: "grok-4.5", name: "Grok 4.5" },
        { id: "grok-code", name: "Grok Code" },
        { id: "grok-build", name: "Grok Build" },
      ]);
    }
  }, []);

  const applyPublicSettings = useCallback((s: PublicSettings) => {
    setCfgModelId(s.endpoint.model_id || "grok-4.5");
    setCfgName(s.endpoint.name || "");
    setCfgBaseUrl(s.endpoint.base_url || "");
    setCfgEnvKey(s.endpoint.env_key || "");
    setCfgBackend(s.endpoint.api_backend || "chat_completions");
    setCfgContext(String(s.endpoint.context_window ?? 500000));
    setCfgEffort(s.endpoint.default_effort || s.effort || "medium");
    setCfgSyncGrok(s.sync_to_grok_config);
    setCfgEnginePath(s.custom_engine_path || "");
    setCfgHasKey(s.endpoint.has_api_key);
    setCfgKeyHint(s.endpoint.api_key_hint || null);
    setCfgGrokPath(s.grok_config_path);
    setCfgApiKey("");
    if (s.model) setModelId(s.model);
    if (s.effort || s.endpoint.default_effort) {
      setEffortId(s.effort || s.endpoint.default_effort || "medium");
    }
  }, []);

  const loadSettings = useCallback(async () => {
    try {
      const s = await invoke<PublicSettings>("get_settings");
      applyPublicSettings(s);
    } catch (e) {
      setSettingsMsg(String(e));
    }
  }, [applyPublicSettings]);

  const onSaveSettings = async () => {
    setSavingSettings(true);
    setSettingsMsg(null);
    try {
      const cw = Number(cfgContext);
      const s = await invoke<PublicSettings>("save_settings", {
        update: {
          custom_engine_path: cfgEnginePath,
          prefer_bundled_engine: true,
          model: cfgModelId,
          effort: cfgEffort,
          sync_to_grok_config: cfgSyncGrok,
          endpoint_model_id: cfgModelId,
          endpoint_name: cfgName,
          endpoint_base_url: cfgBaseUrl,
          endpoint_api_key: cfgApiKey || null,
          clear_api_key: false,
          endpoint_env_key: cfgEnvKey,
          endpoint_api_backend: cfgBackend,
          endpoint_context_window: Number.isFinite(cw) ? cw : null,
          endpoint_default_effort: cfgEffort,
        },
      });
      applyPublicSettings(s);
      setModelId(cfgModelId);
      setEffortId(cfgEffort);
      // Keep model list in sync with configured id
      setModels((prev) => {
        if (prev.some((m) => m.id === cfgModelId)) return prev;
        return [
          { id: cfgModelId, name: cfgName || cfgModelId },
          ...prev,
        ];
      });
      setSettingsMsg(
        cfgSyncGrok
          ? "已保存，并同步到 Grok 引擎配置。重新 Connect 后生效。"
          : "已保存。重新 Connect 后生效。",
      );
    } catch (e) {
      setSettingsMsg(String(e));
    } finally {
      setSavingSettings(false);
    }
  };

  const onClearApiKey = async () => {
    setSavingSettings(true);
    setSettingsMsg(null);
    try {
      const s = await invoke<PublicSettings>("save_settings", {
        update: { clear_api_key: true },
      });
      applyPublicSettings(s);
      setSettingsMsg("API Key 已清除。");
    } catch (e) {
      setSettingsMsg(String(e));
    } finally {
      setSavingSettings(false);
    }
  };

  useEffect(() => {
    invoke<string>("app_version")
      .then(setAppVersion)
      .catch(() => setAppVersion("0.1.0"));

    invoke<EngineInfo>("resolve_engine")
      .then(setEngine)
      .catch((e: unknown) => setError(String(e)));

    invoke<EffortOption[]>("list_efforts")
      .then((list) => {
        if (list.length) setEfforts(list);
      })
      .catch(() => {
        setEfforts([
          { id: "none", label: "None" },
          { id: "low", label: "Low" },
          { id: "medium", label: "Medium" },
          { id: "high", label: "High" },
          { id: "xhigh", label: "Extra high" },
        ]);
      });

    void refreshSessions();
    void refreshModels();
    void loadSettings();
  }, [refreshSessions, refreshModels, loadSettings]);

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
              text: `Session ready${ev.engine_session_id ? ` · ${ev.engine_session_id.slice(0, 8)}` : ""}`,
            });
            void refreshSessions();
            void refreshModels();
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
            clearWaiting();
            push({
              kind: "tool",
              text: ev.tool?.title ?? "Running tool",
            });
            break;
          case "tool_updated":
            clearWaiting();
            push({
              kind: "tool",
              text: `${ev.tool?.title ?? "Tool"} → ${ev.tool?.status ?? "updated"}`,
            });
            break;
          case "permission_needed":
            clearWaiting();
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
              text: `Waiting for approval · ${ev.request?.summary ?? ev.request?.tool_name ?? "tool"}`,
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
            clearWaiting();
            if (ev.state === "error") {
              push({ kind: "error", text: "Turn ended with error" });
            }
            void refreshSessions();
            break;
          case "agent_error":
            setBusy(false);
            clearWaiting();
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
  }, [
    appendAssistant,
    appendThought,
    clearWaiting,
    push,
    refreshSessions,
    refreshModels,
  ]);

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

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
      push({ kind: "system", text: `Project set · ${path}` });
    } catch (e) {
      setError(String(e));
    }
  };

  const onConnect = async () => {
    setConnecting(true);
    setError(null);
    setView("workspace");
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
        text: `Connected · ${info.project_root ?? "."}`,
      });
      await refreshSessions();
      await refreshModels();
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  const onNewTask = async () => {
    setLines([]);
    setPendingPerm(null);
    setView("workspace");
    await onConnect();
  };

  /** Create a brand-new session (Sessions list + button). */
  const onNewSession = async () => {
    if (connecting || busy) return;
    setView("workspace");
    setLines([]);
    setPendingPerm(null);
    setAttachments([]);
    setDraft("");
    setError(null);
    // Prefer last known project so + always works from the list.
    const root =
      projectRoot.trim() ||
      session?.project_root?.trim() ||
      sessions[0]?.project_root?.trim() ||
      "";
    if (root && root !== projectRoot) {
      setProjectRoot(root);
    }
    setConnecting(true);
    try {
      if (root) {
        await invoke<string>("set_project_root", { projectRoot: root });
      }
      const info = await invoke<SessionInfo>("connect_workspace", {
        projectRoot: root || null,
        autoApprove,
      });
      setSession(info);
      if (info.project_root) setProjectRoot(info.project_root);
      setAgentStatus(info.status);
      push({
        kind: "system",
        text: `新建会话 · ${info.project_root ?? (root || ".")}`,
      });
      await refreshSessions();
      await refreshModels();
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  /** Activate an existing session from the list (click). */
  const onActivateSession = async (s: SessionListRow) => {
    if (renamingId === s.session_id || connecting) return;
    setView("workspace");

    // Already the active session — just focus workspace, no reconnect.
    if (session?.session_id === s.session_id) {
      return;
    }

    setConnecting(true);
    setError(null);
    setLines([]);
    setPendingPerm(null);
    setAttachments([]);
    setDraft("");
    try {
      // Ensure project path matches the session before reconnect.
      if (s.project_root) {
        setProjectRoot(s.project_root);
        try {
          await invoke<string>("set_project_root", {
            projectRoot: s.project_root,
          });
        } catch {
          /* path may still work via reconnect metadata */
        }
      }
      const info = await invoke<SessionInfo>("reconnect_session", {
        sessionId: s.session_id,
        autoApprove,
      });
      setSession(info);
      if (info.project_root) setProjectRoot(info.project_root);
      else if (s.project_root) setProjectRoot(s.project_root);
      setAgentStatus(info.status);
      push({
        kind: "system",
        text: `已激活会话 · ${s.title || s.session_id.slice(0, 8)}`,
      });
      await refreshSessions();
      await refreshModels();
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  const startRename = (s: SessionListRow, e?: React.MouseEvent) => {
    e?.stopPropagation();
    setRenamingId(s.session_id);
    setRenameDraft(s.title || s.session_id.slice(0, 8));
    setTimeout(() => renameInputRef.current?.focus(), 0);
  };

  const commitRename = async () => {
    if (!renamingId) return;
    const title = renameDraft.trim();
    const id = renamingId;
    setRenamingId(null);
    if (!title) return;
    try {
      await invoke("rename_session", { sessionId: id, title });
      await refreshSessions();
    } catch (err) {
      setError(String(err));
    }
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft("");
  };

  const onPickAttachments = async () => {
    try {
      const files = await invoke<
        Array<{
          path: string;
          name?: string | null;
          mime?: string | null;
          size?: number | null;
        }>
      >("pick_attachments");
      if (!files?.length) return;
      setAttachments((prev) => {
        const seen = new Set(prev.map((p) => p.path));
        const next = [...prev];
        for (const f of files) {
          if (seen.has(f.path)) continue;
          next.push({
            path: f.path,
            name: f.name || f.path.split(/[/\\]/).pop() || f.path,
            mime: f.mime,
            size: f.size,
          });
        }
        return next;
      });
    } catch (e) {
      setError(String(e));
    }
  };

  const removeAttachment = (path: string) => {
    setAttachments((prev) => prev.filter((a) => a.path !== path));
  };

  const onModelChange = async (id: string) => {
    setModelId(id);
    try {
      await invoke("set_model", { modelId: id });
    } catch {
      /* local selection still applies on next prompt */
    }
  };

  const onSend = async () => {
    const text = draft.trim();
    if ((!text && attachments.length === 0) || busy) return;
    const pendingAttachments = attachments;
    setDraft("");
    setAttachments([]);
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
    }
    const display =
      pendingAttachments.length > 0
        ? `${text || "(attachments)"}${text ? "\n\n" : ""}📎 ${pendingAttachments
            .map((a) => a.name)
            .join(", ")}`
        : text;
    push({ kind: "user", text: display });
    // Immediate left-side feedback so the UI doesn't look frozen.
    push({ kind: "waiting", text: "Grokx 正在思考…" });
    setBusy(true);
    try {
      await invoke("send_prompt_rich", {
        payload: {
          text,
          attachments: pendingAttachments.map((a) => ({
            path: a.path,
            name: a.name,
            mime: a.mime ?? null,
            size: a.size ?? null,
          })),
          model: modelId || null,
          effort: effortId || null,
        },
      });
    } catch (e) {
      setBusy(false);
      clearWaiting();
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
        text:
          decision === "deny"
            ? `Denied · ${pendingPerm.summary}`
            : `Allowed · ${pendingPerm.summary}`,
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

  const statusClass = busy ? "busy" : connected ? "ready" : "";
  const title =
    sessions.find((s) => s.session_id === session?.session_id)?.title ||
    shortPath(session?.project_root || projectRoot) ||
    "New task";

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand">Grokx</div>
          <button
            className="icon-btn"
            title="Settings"
            onClick={() => {
              setView("settings");
              void loadSettings();
            }}
          >
            ⚙
          </button>
        </div>

        <nav className="nav">
          <button
            className={`nav-item${view === "workspace" ? " active" : ""}`}
            onClick={() => setView("workspace")}
          >
            <span className="nav-glyph">⌂</span>
            Workspace
          </button>
          <button
            className="nav-item"
            onClick={() => void onNewTask()}
            disabled={connecting}
          >
            <span className="nav-glyph">✎</span>
            {connecting ? "Connecting…" : "New task"}
          </button>
          <button
            className="nav-item"
            onClick={() => void onConnect()}
            disabled={connecting}
          >
            <span className="nav-glyph">↻</span>
            {connected ? "Reconnect" : "Connect agent"}
          </button>
          <button
            className={`nav-item${view === "settings" ? " active" : ""}`}
            onClick={() => {
              setView("settings");
              void loadSettings();
            }}
          >
            <span className="nav-glyph">⚙</span>
            Settings
          </button>
        </nav>

        <div className="section-label-row">
          <span className="section-label">Sessions</span>
          <button
            type="button"
            className="session-add-btn"
            title="新建会话"
            disabled={connecting || busy}
            onClick={() => void onNewSession()}
          >
            +
          </button>
        </div>
        <div className="session-list">
          {sessions.length === 0 && (
            <div className="session-empty">No sessions yet</div>
          )}
          {sessions.map((s) => (
            <div
              key={s.session_id}
              className={`session-row${
                s.session_id === session?.session_id ? " active" : ""
              }`}
              onClick={() => void onActivateSession(s)}
              onDoubleClick={(e) => startRename(s, e)}
              title={`${s.project_root}\n单击激活 · 双击或 ✎ 重命名`}
            >
              {renamingId === s.session_id ? (
                <input
                  ref={renameInputRef}
                  className="session-rename-input"
                  value={renameDraft}
                  onChange={(e) => setRenameDraft(e.target.value)}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void commitRename();
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      cancelRename();
                    }
                  }}
                  onBlur={() => void commitRename()}
                />
              ) : (
                <>
                  <div className="session-row-main">
                    <div className="session-title">
                      {s.title || s.session_id.slice(0, 8)}
                    </div>
                    <button
                      type="button"
                      className="session-rename-btn"
                      title="重命名"
                      onClick={(e) => startRename(s, e)}
                    >
                      ✎
                    </button>
                  </div>
                  <div className="session-meta">
                    {s.project_name} ·{" "}
                    {new Date(s.updated_at).toLocaleString()}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>

        <div className="sidebar-bottom">
          <div className="sidebar-meta">v{appVersion}</div>
        </div>
      </aside>

      {view === "settings" ? (
        <main className="main settings-main">
          <header className="topbar">
            <div style={{ minWidth: 0 }}>
              <h1 className="topbar-title">Settings</h1>
              <p className="topbar-sub">
                系统配置 · 大模型与引擎（不常用，配置一次即可）
              </p>
            </div>
            <button
              className="btn"
              onClick={() => setView("workspace")}
            >
              返回工作区
            </button>
          </header>

          <div className="settings-page">
            <div className="settings-grid">
              <section className="card settings-card">
                <h3>大模型配置</h3>
                <p className="muted" style={{ marginBottom: 12 }}>
                  配置 API 地址、Key 与默认模型。日常聊天无需进入此页；保存后
                  {cfgSyncGrok ? "会同步到引擎配置，" : ""}
                  重新 Connect 生效。
                </p>
                {settingsMsg && (
                  <div
                    className={
                      settingsMsg.includes("失败") ||
                      settingsMsg.toLowerCase().includes("error")
                        ? "error-banner"
                        : "settings-ok"
                    }
                  >
                    {settingsMsg}
                  </div>
                )}
                <div className="settings-form-grid">
                  <div className="field">
                    <label>Model ID</label>
                    <input
                      value={cfgModelId}
                      onChange={(e) => setCfgModelId(e.target.value)}
                      placeholder="grok-4.5"
                    />
                  </div>
                  <div className="field">
                    <label>显示名称</label>
                    <input
                      value={cfgName}
                      onChange={(e) => setCfgName(e.target.value)}
                      placeholder="Grok 4.5"
                    />
                  </div>
                  <div className="field field-span-2">
                    <label>Base URL</label>
                    <input
                      value={cfgBaseUrl}
                      onChange={(e) => setCfgBaseUrl(e.target.value)}
                      placeholder="https://api.x.ai/v1 或 http://host:port/v1"
                    />
                  </div>
                  <div className="field field-span-2">
                    <label>
                      API Key
                      {cfgHasKey && cfgKeyHint
                        ? `（已保存 ${cfgKeyHint}）`
                        : ""}
                    </label>
                    <input
                      type="password"
                      value={cfgApiKey}
                      onChange={(e) => setCfgApiKey(e.target.value)}
                      placeholder={
                        cfgHasKey
                          ? "留空则保持原 Key，输入新值可覆盖"
                          : "sk-..."
                      }
                      autoComplete="off"
                    />
                  </div>
                  <div className="field">
                    <label>Env Key（可选）</label>
                    <input
                      value={cfgEnvKey}
                      onChange={(e) => setCfgEnvKey(e.target.value)}
                      placeholder="XAI_API_KEY"
                    />
                  </div>
                  <div className="field">
                    <label>API Backend</label>
                    <select
                      className="settings-select"
                      value={cfgBackend}
                      onChange={(e) => setCfgBackend(e.target.value)}
                    >
                      <option value="chat_completions">chat_completions</option>
                      <option value="responses">responses</option>
                      <option value="anthropic_messages">
                        anthropic_messages
                      </option>
                    </select>
                  </div>
                  <div className="field">
                    <label>Context window</label>
                    <input
                      value={cfgContext}
                      onChange={(e) => setCfgContext(e.target.value)}
                      placeholder="500000"
                    />
                  </div>
                  <div className="field">
                    <label>默认推理强度</label>
                    <select
                      className="settings-select"
                      value={cfgEffort}
                      onChange={(e) => setCfgEffort(e.target.value)}
                    >
                      {(efforts.length
                        ? efforts
                        : [
                            { id: "none", label: "None" },
                            { id: "low", label: "Low" },
                            { id: "medium", label: "Medium" },
                            { id: "high", label: "High" },
                            { id: "xhigh", label: "Extra high" },
                            { id: "max", label: "Max" },
                          ]
                      ).map((e) => (
                        <option key={e.id} value={e.id}>
                          {e.label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={cfgSyncGrok}
                    onChange={(e) => setCfgSyncGrok(e.target.checked)}
                  />
                  同步写入 ~/.grok/config.toml
                </label>
                <p className="hint mono" style={{ marginTop: 0 }}>
                  {cfgGrokPath}
                </p>
                <div className="btn-row">
                  <button
                    className="btn btn-primary"
                    onClick={() => void onSaveSettings()}
                    disabled={savingSettings}
                  >
                    {savingSettings ? "保存中…" : "保存配置"}
                  </button>
                  {cfgHasKey && (
                    <button
                      className="btn btn-ghost"
                      onClick={() => void onClearApiKey()}
                      disabled={savingSettings}
                    >
                      清除 Key
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={() => void loadSettings()}
                    disabled={savingSettings}
                  >
                    重新加载
                  </button>
                </div>
              </section>

              <section className="card settings-card">
                <h3>项目与引擎</h3>
                {error && <div className="error-banner">{error}</div>}
                <div className="field">
                  <label>Project path</label>
                  <input
                    value={projectRoot}
                    onChange={(e) => setProjectRoot(e.target.value)}
                    placeholder="/path/to/project"
                  />
                </div>
                <div className="btn-row">
                  <button className="btn" onClick={() => void onSetProject()}>
                    Set project
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => void onConnect()}
                    disabled={connecting}
                  >
                    {connecting
                      ? "Connecting…"
                      : connected
                        ? "Reconnect"
                        : "Connect"}
                  </button>
                </div>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={autoApprove}
                    onChange={(e) => setAutoApprove(e.target.checked)}
                  />
                  Auto-approve tools on next connect
                </label>
                <div className="field">
                  <label>自定义引擎路径（可选）</label>
                  <input
                    value={cfgEnginePath}
                    onChange={(e) => setCfgEnginePath(e.target.value)}
                    placeholder="/path/to/grok"
                  />
                </div>
                {engine ? (
                  <dl className="kv">
                    <dt>Source</dt>
                    <dd>{engine.source}</dd>
                    <dt>Binary</dt>
                    <dd className="mono">{engine.path}</dd>
                    <dt>Agent</dt>
                    <dd>{agentStatus}</dd>
                  </dl>
                ) : (
                  !error && <p className="muted">Resolving engine…</p>
                )}
                <p className="hint">
                  日常使用请返回工作区；模型与 Key 一般只需配置一次。
                </p>
              </section>
            </div>
          </div>
        </main>
      ) : (
        <>
          <main className="main">
            <header className="topbar">
              <div style={{ minWidth: 0 }}>
                <h1 className="topbar-title">{title}</h1>
                <p className="topbar-sub">
                  {shortPath(session?.project_root || projectRoot)}
                  {session?.session_id
                    ? ` · ${session.session_id.slice(0, 8)}`
                    : ""}
                </p>
              </div>
              <div className="status-pill">
                <span className={`status-dot ${statusClass}`} />
                {busy ? "Working" : connected ? "Ready" : agentStatus}
              </div>
            </header>

            <div className="chat-scroll" ref={chatScrollRef}>
              {stickyUserId && stickyUserText != null && (
                <button
                  type="button"
                  className="user-sticky-bar"
                  title="点击定位到该条用户消息"
                  onClick={() => jumpToUserMessage(stickyUserId)}
                >
                  <span className="user-sticky-label">你的输入</span>
                  <span className="user-sticky-text">{stickyUserText}</span>
                  <span className="user-sticky-jump">定位 ↓</span>
                </button>
              )}
              <div
                className={`chat-inner${
                  stickyUserId ? " chat-inner-sticky" : ""
                }`}
              >
                {lines.length === 0 && (
                  <div className="empty-state">
                    <h2>What should we work on?</h2>
                    <p>
                      连接 agent 后即可开始对话。大模型地址与 Key 请在左侧{" "}
                      <strong>Settings</strong> 中配置一次即可。
                    </p>
                  </div>
                )}

                {lines.map((line, i) => {
                  if (line.kind === "tool" || line.kind === "system") {
                    return (
                      <div key={line.id} className="msg-chip">
                        <span className="chip-icon">{chipIcon(line.kind)}</span>
                        <span>{line.text}</span>
                      </div>
                    );
                  }
                  if (line.kind === "waiting") {
                    return (
                      <div key={line.id} className="msg msg-waiting">
                        <div className="msg-body waiting-body">
                          <span className="waiting-dots" aria-hidden>
                            <span />
                            <span />
                            <span />
                          </span>
                          <span>{line.text}</span>
                        </div>
                      </div>
                    );
                  }
                  if (line.kind === "assistant") {
                    return (
                      <div key={line.id} className="msg msg-assistant">
                        <div className="msg-body md-body">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {line.text}
                          </ReactMarkdown>
                          {busy && i === lines.length - 1 && (
                            <span className="stream-caret" aria-hidden />
                          )}
                        </div>
                      </div>
                    );
                  }
                  if (line.kind === "thought") {
                    return (
                      <div key={line.id} className="msg msg-thought">
                        <div className="msg-body md-body thought-md">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {line.text}
                          </ReactMarkdown>
                        </div>
                      </div>
                    );
                  }
                  if (line.kind === "user") {
                    return (
                      <div
                        key={line.id}
                        className={`msg msg-user${
                          highlightUserId === line.id ? " msg-user-highlight" : ""
                        }`}
                        data-user-msg={line.id}
                        ref={(el) => {
                          if (el) userMsgEls.current.set(line.id, el);
                          else userMsgEls.current.delete(line.id);
                        }}
                      >
                        <div className="msg-body">{line.text}</div>
                      </div>
                    );
                  }
                  return (
                    <div key={line.id} className={`msg msg-${line.kind}`}>
                      <div className="msg-body">{line.text}</div>
                    </div>
                  );
                })}
                <div ref={bottomRef} />
              </div>
            </div>

            <div className="composer-dock">
              {attachments.length > 0 && (
                <div className="attach-row">
                  {attachments.map((a) => (
                    <div key={a.path} className="attach-chip" title={a.path}>
                      <span className="attach-icon">
                        {a.mime?.startsWith("image/") ? "🖼" : "📄"}
                      </span>
                      <span className="attach-name">{a.name}</span>
                      {a.size != null && (
                        <span className="attach-size">
                          {formatBytes(a.size)}
                        </span>
                      )}
                      <button
                        type="button"
                        className="attach-remove"
                        onClick={() => removeAttachment(a.path)}
                        aria-label="Remove attachment"
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                ref={textareaRef}
                value={draft}
                rows={1}
                onChange={(e) => {
                  setDraft(e.target.value);
                  resizeTextarea();
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void onSend();
                  }
                }}
                disabled={!session || (busy && !pendingPerm)}
                placeholder={
                  session
                    ? "Ask for follow-up changes"
                    : "Connect agent first…"
                }
              />
              <div className="composer-bar">
                <div className="composer-left">
                  <button
                    type="button"
                    className="composer-plus"
                    title="Attach files"
                    onClick={() => void onPickAttachments()}
                    disabled={!session || busy}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    className={`access-toggle${autoApprove ? "" : " off"}`}
                    onClick={() => setAutoApprove((v) => !v)}
                    title="Toggle auto-approve for the next connect"
                  >
                    {autoApprove ? "Auto-approve" : "Needs approval"}
                  </button>
                </div>
                <div className="composer-right">
                  <select
                    className="composer-select"
                    value={modelId}
                    onChange={(e) => void onModelChange(e.target.value)}
                    title="Model"
                    disabled={busy}
                  >
                    {(models.length
                      ? models
                      : [{ id: "grok-4.5", name: "Grok 4.5" }]
                    ).map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="composer-select effort"
                    value={effortId}
                    onChange={(e) => setEffortId(e.target.value)}
                    title="Reasoning effort"
                    disabled={busy}
                  >
                    {(efforts.length
                      ? efforts
                      : [
                          { id: "low", label: "Low" },
                          { id: "medium", label: "Medium" },
                          { id: "high", label: "High" },
                        ]
                    ).map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.label}
                      </option>
                    ))}
                  </select>
                  {busy ? (
                    <button
                      type="button"
                      className="send-btn stop"
                      onClick={() => void onCancel()}
                      title="Stop"
                    >
                      ■
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="send-btn"
                      onClick={() => void onSend()}
                      disabled={
                        !session ||
                        (!draft.trim() && attachments.length === 0)
                      }
                      title="Send"
                    >
                      ↑
                    </button>
                  )}
                </div>
              </div>
            </div>
          </main>

          <aside className="right">
            <h2>Outputs</h2>

            {pendingPerm && (
              <div className="card">
                <div className="perm-title">{pendingPerm.tool_name}</div>
                <p>{pendingPerm.summary}</p>
                {pendingPerm.detail && (
                  <pre className="perm-detail">{pendingPerm.detail}</pre>
                )}
                <div className="btn-row" style={{ marginTop: 12 }}>
                  <button
                    className="btn btn-accent"
                    onClick={() => void onPermission("allow_once")}
                  >
                    Allow
                  </button>
                  <button
                    className="btn btn-ghost"
                    onClick={() => void onPermission("deny")}
                  >
                    Deny
                  </button>
                </div>
                <p className="hint">
                  Agent is waiting · {pendingPerm.id.slice(0, 8)}
                </p>
              </div>
            )}

            {!session && (
              <div className="card">
                <h3>快速连接</h3>
                <p className="muted" style={{ marginBottom: 10 }}>
                  选择项目并连接 agent。模型 Key / 地址请在 Settings 配置。
                </p>
                {error && <div className="error-banner">{error}</div>}
                <div className="field">
                  <label>Project path</label>
                  <input
                    value={projectRoot}
                    onChange={(e) => setProjectRoot(e.target.value)}
                    placeholder="/path/to/project"
                  />
                </div>
                <div className="btn-row">
                  <button className="btn" onClick={() => void onSetProject()}>
                    Set project
                  </button>
                  <button
                    className="btn btn-primary"
                    onClick={() => void onConnect()}
                    disabled={connecting}
                  >
                    {connecting ? "Connecting…" : "Connect"}
                  </button>
                </div>
                <button
                  className="btn"
                  style={{ marginTop: 10, width: "100%" }}
                  onClick={() => {
                    setView("settings");
                    void loadSettings();
                  }}
                >
                  打开 Settings
                </button>
              </div>
            )}

            {session && !pendingPerm && (
              <div className="card">
                <h3>Approvals</h3>
                <p className="muted">
                  关闭 Auto-approve 时，工具权限请求会显示在这里。
                </p>
              </div>
            )}

            <div className="card">
              <h3>Create a file or site</h3>
              <p className="muted">
                让 agent 搭建文件、修 bug 或审阅当前项目。
              </p>
            </div>
          </aside>
        </>
      )}
    </div>
  );
}
