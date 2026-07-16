import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  IconAlert,
  IconBrand,
  IconChevronLeft,
  IconChevronRight,
  IconInfo,
  IconPaperclip,
  IconPen,
  IconPlus,
  IconRefresh,
  IconSend,
  IconSettings,
  IconStop,
  IconTool,
  IconTrash,
} from "./icons";

type EngineInfo = {
  path: string;
  source: string;
  status: string;
};

type SessionInfo = {
  session_id: string;
  project_root?: string | null;
  /** Temporary task cwd under ~/.grokx/tasks/<id> */
  work_path?: string | null;
  status: string;
};

type SessionListRow = {
  session_id: string;
  project_id: string;
  project_root: string;
  project_name: string;
  work_path: string;
  title: string;
  engine_session_id?: string | null;
  /** Stable list order key (newest-created first). */
  created_at: string;
  updated_at: string;
};

/**
 * Product model:
 * - Project = concrete workspace path (stable, user-chosen folder)
 * - Task (API: session) = temporary cwd at ~/.grokx/tasks/<id>
 *   with a `project` symlink for source access
 */
type ProjectListRow = {
  project_id: string;
  name: string;
  root_path: string;
  session_count: number;
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
  /** Optional object URL for image preview in the composer. */
  previewUrl?: string | null;
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

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/** Short sidebar title from first user message + optional first assistant reply. */
function summarizeChatTitle(userText: string, assistantText?: string): string {
  const firstLine = (t: string) =>
    t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";

  let user = firstLine(userText)
    .replace(/https?:\/\/\S+/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!user) {
    user = firstLine(userText).replace(/\s+/g, " ").trim();
  }

  const asst = firstLine(assistantText ?? "")
    .replace(/\s+/g, " ")
    .trim();

  let title = user;
  if (asst && asst.length <= 28 && user) {
    title = `${user} · ${asst}`;
  } else if (!user && asst) {
    title = asst;
  }

  const chars = [...title];
  if (chars.length > 40) {
    return `${chars.slice(0, 40).join("")}…`;
  }
  return title || "New task";
}

type TraceItem = {
  id: string;
  kind: "thought" | "tool" | "system" | "waiting";
  text: string;
};

type ChatLine =
  | { id: string; kind: "user"; text: string }
  | { id: string; kind: "assistant"; text: string }
  | { id: string; kind: "thought"; text: string }
  | { id: string; kind: "tool"; text: string }
  | { id: string; kind: "system"; text: string }
  | { id: string; kind: "error"; text: string }
  | { id: string; kind: "waiting"; text: string }
  /** Collapsed process (thinking / tools / status) after a turn finishes. */
  | {
      id: string;
      kind: "trace";
      items: TraceItem[];
      durationMs: number;
      expanded: boolean;
    };

let chatLineSeq = 0;
function nextLineId(kind: string): string {
  chatLineSeq += 1;
  return `${kind}-${Date.now()}-${chatLineSeq}`;
}

/** After a turn ends: fold thought/tool/system into one collapsible trace above the answer. */
function collapseTurnProcess(
  lines: ChatLine[],
  durationMs: number,
): ChatLine[] {
  let lastUser = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].kind === "user") {
      lastUser = i;
      break;
    }
  }
  if (lastUser < 0) return lines;

  const head = lines.slice(0, lastUser + 1);
  const tail = lines.slice(lastUser + 1);
  // Don't collapse twice.
  if (tail.some((l) => l.kind === "trace")) return lines;

  const items: TraceItem[] = [];
  const answers: ChatLine[] = [];
  const rest: ChatLine[] = [];

  for (const line of tail) {
    if (line.kind === "waiting") continue; // drop typing placeholder
    if (
      line.kind === "thought" ||
      line.kind === "tool" ||
      line.kind === "system"
    ) {
      items.push({ id: line.id, kind: line.kind, text: line.text });
    } else if (line.kind === "assistant") {
      answers.push(line);
    } else {
      rest.push(line);
    }
  }

  if (items.length === 0) return lines;

  const trace: ChatLine = {
    id: nextLineId("trace"),
    kind: "trace",
    items,
    durationMs: Math.max(0, durationMs),
    expanded: false,
  };

  return [...head, trace, ...answers, ...rest];
}

function summarizeTrace(items: TraceItem[]): string {
  const thoughts = items.filter((i) => i.kind === "thought").length;
  const tools = items.filter((i) => i.kind === "tool").length;
  const systems = items.filter((i) => i.kind === "system").length;
  const parts: string[] = [];
  if (thoughts) parts.push(thoughts === 1 ? "thinking" : `${thoughts} thoughts`);
  if (tools) parts.push(tools === 1 ? "1 tool" : `${tools} tools`);
  if (systems && !thoughts && !tools) parts.push("activity");
  if (parts.length === 0) parts.push(`${items.length} steps`);
  return parts.join(" · ");
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

function ChipIcon({ kind }: { kind: ChatLine["kind"] | TraceItem["kind"] }) {
  switch (kind) {
    case "tool":
      return <IconTool size={14} />;
    case "system":
      return <IconInfo size={14} />;
    case "error":
      return <IconAlert size={14} />;
    case "thought":
      return <IconPen size={14} />;
    case "waiting":
      return <IconInfo size={14} />;
    default:
      return <IconInfo size={14} />;
  }
}

export default function App() {
  const [engine, setEngine] = useState<EngineInfo | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [projects, setProjects] = useState<ProjectListRow[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
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
  /** Right Outputs rail — collapsible to free chat space. */
  const [outputsOpen, setOutputsOpen] = useState(true);
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
  /** Wall-clock start of the in-flight agent turn (for duration on collapse). */
  const turnStartedAtRef = useRef<number | null>(null);
  /** Keep latest lines for flush-to-disk without stale closures. */
  const linesRef = useRef<ChatLine[]>([]);
  const sessionIdRef = useRef<string | null>(null);
  const workPathRef = useRef<string | null>(null);
  const historySaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bump when switching tasks so stale reconnect logs don't overwrite history. */
  const historyEpochRef = useRef(0);
  /** Auto-title only once per task after the first successful assistant reply. */
  const autoTitledSessionRef = useRef<Set<string>>(new Set());
  const sessionsRef = useRef<SessionListRow[]>([]);

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    sessionIdRef.current = session?.session_id ?? null;
    workPathRef.current = session?.work_path ?? null;
  }, [session?.session_id, session?.work_path]);

  /** Connection / reconnect noise — never persist or restore these alone. */
  const isConnectionNoise = useCallback((line: ChatLine): boolean => {
    if (line.kind === "waiting") return true;
    if (line.kind !== "system") return false;
    const t = line.text.toLowerCase();
    return (
      t.startsWith("starting:") ||
      t.startsWith("ready:") ||
      t.startsWith("task ready") ||
      t.startsWith("switched task") ||
      t.startsWith("new task") ||
      t.startsWith("opened project") ||
      t.startsWith("using default") ||
      t.startsWith("connected") ||
      t.includes("acp handshake") ||
      t.includes("acp session ready") ||
      t.includes("spawning ") ||
      t.includes("task cwd ")
    );
  }, []);

  const hasRealChatContent = useCallback((chatLines: ChatLine[]) => {
    return chatLines.some(
      (l) =>
        l.kind === "user" ||
        l.kind === "assistant" ||
        l.kind === "trace" ||
        l.kind === "thought" ||
        l.kind === "tool" ||
        l.kind === "error",
    );
  }, []);

  const persistChatHistory = useCallback(
    async (
      sessionId: string,
      chatLines: ChatLine[],
      workPath?: string | null,
    ) => {
      // Never wipe a good history file with only reconnect noise.
      if (!hasRealChatContent(chatLines)) return;
      const toSave = chatLines.filter(
        (l) => l.kind !== "waiting" && !isConnectionNoise(l),
      );
      if (toSave.length === 0) return;
      try {
        await invoke("save_chat_history", {
          sessionId,
          json: JSON.stringify(toSave),
          workPath: workPath || workPathRef.current || null,
        });
      } catch (e) {
        console.warn("save_chat_history failed", e);
      }
    },
    [hasRealChatContent, isConnectionNoise],
  );

  const schedulePersistHistory = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    // Don't schedule saves of pure noise after reconnect.
    if (!hasRealChatContent(linesRef.current)) return;
    if (historySaveTimer.current) clearTimeout(historySaveTimer.current);
    const epoch = historyEpochRef.current;
    const work = workPathRef.current;
    historySaveTimer.current = setTimeout(() => {
      // Drop if user switched tasks since schedule.
      if (historyEpochRef.current !== epoch) return;
      if (sessionIdRef.current !== sid) return;
      void persistChatHistory(sid, linesRef.current, work);
    }, 500);
  }, [persistChatHistory, hasRealChatContent]);

  const flushPersistHistory = useCallback(async () => {
    if (historySaveTimer.current) {
      clearTimeout(historySaveTimer.current);
      historySaveTimer.current = null;
    }
    const sid = sessionIdRef.current;
    const work = workPathRef.current;
    if (!sid) return;
    await persistChatHistory(sid, linesRef.current, work);
  }, [persistChatHistory]);

  const loadChatHistory = useCallback(
    async (sessionId: string, workPath?: string | null) => {
      try {
        const raw = await invoke<string | null>("load_chat_history", {
          sessionId,
          workPath: workPath || null,
        });
        if (!raw) return [] as ChatLine[];
        const parsed = JSON.parse(raw) as ChatLine[];
        if (!Array.isArray(parsed)) return [] as ChatLine[];
        return parsed.filter(
          (l) => l && l.kind && l.kind !== "waiting" && !isConnectionNoise(l),
        );
      } catch {
        return [] as ChatLine[];
      }
    },
    [isConnectionNoise],
  );

  const refreshProjects = useCallback(async () => {
    try {
      const rows = await invoke<ProjectListRow[]>("list_projects");
      setProjects(rows);
      return rows;
    } catch {
      return [] as ProjectListRow[];
    }
  }, []);

  const refreshSessions = useCallback(
    async (projectId?: string | null) => {
      const pid = projectId === undefined ? selectedProjectId : projectId;
      try {
        let rows: SessionListRow[];
        if (pid) {
          // Tasks under a user-selected Project.
          rows = await invoke<SessionListRow[]>("list_sessions_for_project", {
            projectId: pid,
          });
        } else {
          // No project selected: show all tasks (including default-sandbox ones).
          rows = await invoke<SessionListRow[]>("list_sessions");
        }
        // Stable UI order: newest-created first. Clicking a task must not reorder.
        rows = [...rows].sort((a, b) => {
          const ca = Date.parse(a.created_at || a.updated_at);
          const cb = Date.parse(b.created_at || b.updated_at);
          return (Number.isFinite(cb) ? cb : 0) - (Number.isFinite(ca) ? ca : 0);
        });
        setSessions(rows);
        return rows;
      } catch {
        return [] as SessionListRow[];
      }
    },
    [selectedProjectId],
  );

  /** After connect / activate: sync projects + tasks. */
  const refreshHierarchy = useCallback(
    async (opts?: {
      projectId?: string | null;
      projectRoot?: string | null;
      /** When true, keep Tasks unbound to Projects list (New task default). */
      standaloneTask?: boolean;
    }) => {
      const projRows = await refreshProjects();
      // Only match against user-visible projects (default sandbox is filtered out).
      let pid: string | null =
        opts?.standaloneTask
          ? null
          : (opts?.projectId ?? selectedProjectId);
      if (pid && !projRows.some((p) => p.project_id === pid)) {
        pid = null;
      }
      if (!pid && opts?.projectRoot && !opts.standaloneTask) {
        const match = projRows.find((p) => p.root_path === opts.projectRoot);
        pid = match?.project_id ?? null;
      }
      if (pid) {
        setSelectedProjectId(pid);
        const hit = projRows.find((p) => p.project_id === pid);
        if (hit?.root_path) setProjectRoot(hit.root_path);
        await refreshSessions(pid);
      } else {
        // Standalone / default-sandbox tasks: clear project highlight, list all tasks.
        setSelectedProjectId(null);
        await refreshSessions(null);
      }
      return pid;
    },
    [refreshProjects, refreshSessions, selectedProjectId],
  );

  type PushLine =
    | { kind: "user"; text: string; id?: string }
    | { kind: "assistant"; text: string; id?: string }
    | { kind: "thought"; text: string; id?: string }
    | { kind: "tool"; text: string; id?: string }
    | { kind: "system"; text: string; id?: string }
    | { kind: "error"; text: string; id?: string }
    | { kind: "waiting"; text: string; id?: string };

  const push = useCallback(
    (line: PushLine) => {
      const full = {
        ...line,
        id: line.id ?? nextLineId(line.kind),
      } as ChatLine;
      setLines((prev) => {
        const next = [...prev, full];
        linesRef.current = next;
        return next;
      });
      schedulePersistHistory();
      return full.id;
    },
    [schedulePersistHistory],
  );

  const appendAssistant = useCallback(
    (text: string) => {
      setLines((prev) => {
        // Drop waiting placeholder once real content starts.
        let base = prev;
        if (base.length && base[base.length - 1].kind === "waiting") {
          base = base.slice(0, -1);
        }
        const last = base[base.length - 1];
        let next: ChatLine[];
        if (last && last.kind === "assistant") {
          const copy = base.slice(0, -1);
          copy.push({ ...last, text: last.text + text });
          next = copy;
        } else {
          next = [
            ...base,
            { id: nextLineId("assistant"), kind: "assistant", text },
          ];
        }
        linesRef.current = next;
        return next;
      });
      schedulePersistHistory();
    },
    [schedulePersistHistory],
  );

  const maybeAutoTitleFromChat = useCallback(async (chat: ChatLine[]) => {
    const sid = sessionIdRef.current;
    if (!sid || autoTitledSessionRef.current.has(sid)) return;

    const currentTitle =
      sessionsRef.current.find((s) => s.session_id === sid)?.title?.trim() ||
      "";
    const isPlaceholder =
      !currentTitle ||
      currentTitle === "New task" ||
      currentTitle === "Restored task";
    if (!isPlaceholder) {
      autoTitledSessionRef.current.add(sid);
      return;
    }

    const firstUser = chat.find(
      (l): l is Extract<ChatLine, { kind: "user" }> =>
        l.kind === "user" && Boolean(l.text.trim()),
    );
    const firstAssistant = chat.find(
      (l): l is Extract<ChatLine, { kind: "assistant" }> =>
        l.kind === "assistant" && Boolean(l.text.trim()),
    );
    if (!firstUser || !firstAssistant) return;

    const title = summarizeChatTitle(firstUser.text, firstAssistant.text);
    if (!title) return;

    autoTitledSessionRef.current.add(sid);
    try {
      await invoke("rename_session", { sessionId: sid, title });
      // Patch local list in place so order is unchanged (created_at sort on server).
      setSessions((prev) =>
        prev.map((s) => (s.session_id === sid ? { ...s, title } : s)),
      );
    } catch {
      autoTitledSessionRef.current.delete(sid);
    }
  }, []);

  const finishTurnCollapse = useCallback(
    (error?: boolean) => {
      const started = turnStartedAtRef.current;
      turnStartedAtRef.current = null;
      const durationMs = started != null ? Date.now() - started : 0;
      setLines((prev) => {
        let next = collapseTurnProcess(prev, durationMs);
        if (error) {
          const hasError = next.some((l) => l.kind === "error");
          if (!hasError) {
            next = [
              ...next,
              {
                id: nextLineId("error"),
                kind: "error",
                text: "Turn ended with error",
              },
            ];
          }
        }
        linesRef.current = next;
        // After first successful assistant reply, summarize and rename the task.
        if (!error) {
          void maybeAutoTitleFromChat(next);
        }
        return next;
      });
      // Persist immediately after a turn settles.
      void flushPersistHistory();
    },
    [flushPersistHistory, maybeAutoTitleFromChat],
  );

  const toggleTrace = useCallback(
    (id: string) => {
      setLines((prev) => {
        const next = prev.map((line) =>
          line.kind === "trace" && line.id === id
            ? { ...line, expanded: !line.expanded }
            : line,
        );
        linesRef.current = next;
        return next;
      });
      schedulePersistHistory();
    },
    [schedulePersistHistory],
  );

  const appendThought = useCallback(
    (text: string) => {
      setLines((prev) => {
        let base = prev;
        if (base.length && base[base.length - 1].kind === "waiting") {
          base = base.slice(0, -1);
        }
        const last = base[base.length - 1];
        let next: ChatLine[];
        if (last && last.kind === "thought") {
          const copy = base.slice(0, -1);
          copy.push({ ...last, text: last.text + text });
          next = copy;
        } else {
          next = [
            ...base,
            { id: nextLineId("thought"), kind: "thought", text },
          ];
        }
        linesRef.current = next;
        return next;
      });
      schedulePersistHistory();
    },
    [schedulePersistHistory],
  );

  const clearWaiting = useCallback(() => {
    setLines((prev) => {
      if (prev.length && prev[prev.length - 1].kind === "waiting") {
        const next = prev.slice(0, -1);
        linesRef.current = next;
        return next;
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
    return line && line.kind === "user" ? line.text : null;
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
          ? "Saved and synced to Grok engine config. Reconnect to apply."
          : "Saved. Reconnect to apply.",
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
      setSettingsMsg("API key cleared.");
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

    void refreshHierarchy();
    void refreshModels();
    void loadSettings();
  }, [refreshHierarchy, refreshModels, loadSettings]);

  useEffect(() => {
    let unlisten: UnlistenFn | undefined;
    let cancelled = false;

    (async () => {
      unlisten = await listen<AgentEvent>("agent-event", (event) => {
        const ev = event.payload;
        switch (ev.type) {
          case "agent_status":
            setAgentStatus(ev.status ?? "unknown");
            // Connection lifecycle stays in the status pill — not the chat transcript.
            break;
          case "session_ready":
            setAgentStatus("ready");
            // Don't push "Task ready" into chat (pollutes history on reconnect).
            void refreshHierarchy();
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
              finishTurnCollapse(true);
            } else {
              // Collapse thinking / tools; keep final assistant answer below.
              finishTurnCollapse(false);
            }
            // Refresh titles/metadata only — list order is stable (created_at).
            void refreshSessions(selectedProjectId);
            break;
          case "agent_error":
            setBusy(false);
            clearWaiting();
            push({ kind: "error", text: ev.message ?? "Agent error" });
            finishTurnCollapse(true);
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
    refreshHierarchy,
    refreshModels,
    refreshSessions,
    selectedProjectId,
    finishTurnCollapse,
  ]);

  const resizeTextarea = () => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  };

  const selectedProject = useMemo(
    () => projects.find((p) => p.project_id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  /** Select a project (stable path). Loads its tasks; does not start an agent. */
  const onSelectProject = async (p: ProjectListRow) => {
    setSelectedProjectId(p.project_id);
    setProjectRoot(p.root_path);
    setView("workspace");
    try {
      await invoke<string>("set_project_root", { projectRoot: p.root_path });
    } catch {
      /* ignore path errors; still show tasks */
    }
    await refreshSessions(p.project_id);
  };

  /** Reconnect agent on the current task (or create one if none). */
  const onConnect = async () => {
    if (session?.session_id) {
      await onActivateSession(
        sessions.find((s) => s.session_id === session.session_id) ?? {
          session_id: session.session_id,
          project_id: selectedProjectId ?? "",
          project_root: session.project_root ?? projectRoot,
          project_name: selectedProject?.name ?? "",
          work_path: session.work_path ?? "",
          title: "",
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
      );
      return;
    }
    await onNewSession();
  };

  /** New task under current project. */
  const onNewTask = async () => {
    setPendingPerm(null);
    setView("workspace");
    await onNewSession();
  };

  /**
   * Pick a folder as project (fixed path) via native dialog, then create
   * the first temporary task under ~/.grokx/tasks/<id>.
   */
  const onOpenProject = async () => {
    if (connecting || busy) return;
    setView("workspace");
    setError(null);
    try {
      const picked = await invoke<string | null>("pick_project_dir");
      if (!picked) return;
      await flushPersistHistory();
      setLines([]);
      linesRef.current = [];
      setPendingPerm(null);
      setAttachments([]);
      setDraft("");
      setConnecting(true);
      const root = picked;
      setProjectRoot(root);
      await invoke<string>("set_project_root", { projectRoot: root });
      const info = await invoke<SessionInfo>("connect_workspace", {
        projectRoot: root,
        autoApprove,
      });
      setSession(info);
      if (info.project_root) setProjectRoot(info.project_root);
      setAgentStatus(info.status);
      push({
        kind: "system",
        text: `Opened project · ${info.project_root ?? root}`,
      });
      if (info.work_path) {
        push({
          kind: "system",
          text: `Task workspace · ${info.work_path} (project via ./project)`,
        });
      }
      await refreshHierarchy({ projectRoot: info.project_root ?? root });
      await refreshModels();
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  /**
   * New temporary task in Tasks only.
   * - If a user Project is selected: attach to that project.
   * - Otherwise: use internal default sandbox (~/.grokx/workspace) — NOT
     shown under Projects.
   * Task cwd: ~/.grokx/tasks/<id>.
   */
  const onNewSession = async () => {
    if (connecting || busy) return;
    setView("workspace");
    // Save current task transcript before leaving.
    await flushPersistHistory();
    historyEpochRef.current += 1;
    setLines([]);
    linesRef.current = [];
    setPendingPerm(null);
    setAttachments([]);
    setDraft("");
    setError(null);
    setBusy(false);
    turnStartedAtRef.current = null;
    setConnecting(true);
    // Only treat an explicitly selected sidebar Project as a real project.
    const userProject = selectedProject;
    const standalone = !userProject;
    try {
      let root = userProject?.root_path?.trim() || "";
      if (!root) {
        // Internal sandbox for standalone tasks — never appears in Projects.
        root = await invoke<string>("ensure_default_project");
        setProjectRoot(root);
      } else {
        if (root !== projectRoot) setProjectRoot(root);
        await invoke<string>("set_project_root", { projectRoot: root });
      }
      const info = await invoke<SessionInfo>("connect_workspace", {
        projectRoot: root,
        autoApprove,
      });
      setSession(info);
      sessionIdRef.current = info.session_id;
      workPathRef.current = info.work_path ?? null;
      if (info.project_root && !standalone) {
        setProjectRoot(info.project_root);
      }
      setAgentStatus(info.status);
      // Fresh task — empty history (no connection spam).
      setLines([]);
      linesRef.current = [];
      await refreshHierarchy({
        projectId: standalone ? null : userProject?.project_id ?? null,
        projectRoot: standalone ? null : info.project_root ?? root,
        standaloneTask: standalone,
      });
      await refreshModels();
    } catch (e) {
      setError(String(e));
    } finally {
      setConnecting(false);
    }
  };

  /** Activate an existing task (click) — restore history, never creates a new row. */
  const onActivateSession = async (s: SessionListRow) => {
    if (renamingId === s.session_id || connecting) return;
    setView("workspace");

    // Highlight parent Project only if it is a user-visible project.
    const visibleProject = projects.find((p) => p.project_id === s.project_id);
    if (visibleProject) {
      setSelectedProjectId(visibleProject.project_id);
    } else {
      setSelectedProjectId(null);
    }

    // Already the active task — just focus workspace, no engine restart.
    // Do not refresh/reorder the list on click.
    if (session?.session_id === s.session_id) {
      return;
    }

    // Persist the task we're leaving so we can resume it later.
    const leavingId = sessionIdRef.current;
    const leavingWork = workPathRef.current;
    const leavingLines = linesRef.current;
    if (historySaveTimer.current) {
      clearTimeout(historySaveTimer.current);
      historySaveTimer.current = null;
    }
    if (leavingId && hasRealChatContent(leavingLines)) {
      await persistChatHistory(leavingId, leavingLines, leavingWork);
    }

    // Invalidate any pending saves from the previous task.
    historyEpochRef.current += 1;
    const epoch = historyEpochRef.current;

    setConnecting(true);
    setError(null);
    setPendingPerm(null);
    setAttachments([]);
    setDraft("");
    setBusy(false);
    turnStartedAtRef.current = null;

    // Optimistically highlight the clicked row immediately.
    setSession({
      session_id: s.session_id,
      project_root: s.project_root,
      work_path: s.work_path,
      status: "Starting",
    });
    sessionIdRef.current = s.session_id;
    workPathRef.current = s.work_path || null;
    if (s.project_root) setProjectRoot(s.project_root);

    // Restore transcript ASAP (by work_path) so chat is visible during reconnect.
    const history = await loadChatHistory(s.session_id, s.work_path);
    if (historyEpochRef.current !== epoch) return;
    setLines(history);
    linesRef.current = history;

    try {
      if (s.project_root) {
        try {
          await invoke<string>("set_project_root", {
            projectRoot: s.project_root,
          });
        } catch {
          /* path may still work via reconnect metadata */
        }
      }
      // reconnect_session reuses this session_id — does not append a new list item.
      const info = await invoke<SessionInfo>("reconnect_session", {
        sessionId: s.session_id,
        autoApprove,
      });
      if (historyEpochRef.current !== epoch) return;
      if (info.session_id !== s.session_id) {
        console.warn(
          "activate returned different session id",
          info.session_id,
          "expected",
          s.session_id,
        );
      }
      setSession({
        session_id: s.session_id,
        project_root: info.project_root ?? s.project_root,
        work_path: info.work_path ?? s.work_path,
        status: info.status,
      });
      sessionIdRef.current = s.session_id;
      workPathRef.current = info.work_path ?? s.work_path ?? null;
      if (info.project_root) setProjectRoot(info.project_root);
      setAgentStatus(info.status);

      // Re-load history after reconnect in case first load raced; never clear real chat.
      const history2 = await loadChatHistory(
        s.session_id,
        info.work_path ?? s.work_path,
      );
      if (historyEpochRef.current !== epoch) return;
      if (history2.length > 0) {
        setLines(history2);
        linesRef.current = history2;
      } else if (hasRealChatContent(linesRef.current)) {
        // Keep what we already showed.
      }

      // Keep list order stable: only refresh session metadata/titles, no full hierarchy reshuffle.
      await refreshSessions(visibleProject ? s.project_id : null);
      await refreshModels();
    } catch (e) {
      setError(String(e));
      // Keep restored history visible even if reconnect fails.
    } finally {
      if (historyEpochRef.current === epoch) {
        setConnecting(false);
      }
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
      // Mark as user-named so auto-title won't overwrite.
      autoTitledSessionRef.current.add(id);
      // Patch in place — keep list order (created_at).
      setSessions((prev) =>
        prev.map((row) =>
          row.session_id === id ? { ...row, title } : row,
        ),
      );
    } catch (err) {
      setError(String(err));
    }
  };

  const cancelRename = () => {
    setRenamingId(null);
    setRenameDraft("");
  };

  const onDeleteSession = async (s: SessionListRow, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (connecting || busy) return;
    const label = s.title || s.session_id.slice(0, 8);
    const ok = window.confirm(
      `Delete task “${label}”?\n\nThis removes the task and its chat history from disk.`,
    );
    if (!ok) return;

    // If deleting the active task, clear chat UI after.
    const wasActive = session?.session_id === s.session_id;
    if (wasActive) {
      await flushPersistHistory();
      historyEpochRef.current += 1;
    }

    try {
      await invoke("delete_session", { sessionId: s.session_id });
      setSessions((prev) => prev.filter((row) => row.session_id !== s.session_id));
      autoTitledSessionRef.current.delete(s.session_id);

      if (wasActive) {
        setSession(null);
        sessionIdRef.current = null;
        workPathRef.current = null;
        setLines([]);
        linesRef.current = [];
        setPendingPerm(null);
        setAttachments([]);
        setDraft("");
        setBusy(false);
        setAgentStatus("disconnected");
      }
      // Refresh project counts if needed.
      void refreshProjects();
    } catch (err) {
      setError(String(err));
    }
  };

  const addAttachments = useCallback(
    (
      files: Array<{
        path: string;
        name?: string | null;
        mime?: string | null;
        size?: number | null;
        previewUrl?: string | null;
      }>,
    ) => {
      if (!files.length) return;
      setAttachments((prev) => {
        const seen = new Set(prev.map((p) => p.path));
        const next = [...prev];
        for (const f of files) {
          if (seen.has(f.path)) continue;
          seen.add(f.path);
          next.push({
            path: f.path,
            name: f.name || f.path.split(/[/\\]/).pop() || f.path,
            mime: f.mime,
            size: f.size,
            previewUrl: f.previewUrl ?? null,
          });
        }
        return next;
      });
    },
    [],
  );

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
      addAttachments(files);
    } catch (e) {
      setError(String(e));
    }
  };

  const fileToBase64 = (file: File | Blob): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== "string") {
          reject(new Error("failed to read file"));
          return;
        }
        const comma = result.indexOf(",");
        resolve(comma >= 0 ? result.slice(comma + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.readAsDataURL(file);
    });

  const savePastedBlob = async (
    blob: Blob,
    nameHint?: string | null,
  ): Promise<Attachment | null> => {
    let mime = (blob.type || "").trim();
    if (!mime || mime === "application/octet-stream") {
      // macOS screenshots often omit type; assume PNG for image-like blobs.
      mime = "image/png";
    }
    const dataBase64 = await fileToBase64(blob);
    const saved = await invoke<{
      path: string;
      name?: string | null;
      mime?: string | null;
      size?: number | null;
    }>("save_pasted_attachment", {
      payload: {
        dataBase64,
        mime,
        name: nameHint || null,
      },
    });
    let previewUrl: string | null = null;
    if (mime.startsWith("image/")) {
      try {
        previewUrl = URL.createObjectURL(blob);
      } catch {
        previewUrl = null;
      }
    }
    return {
      path: saved.path,
      name:
        saved.name ||
        nameHint ||
        saved.path.split(/[/\\]/).pop() ||
        "paste.png",
      mime: saved.mime ?? mime,
      size: saved.size ?? blob.size,
      previewUrl,
    };
  };

  /** Collect image/file entries from a paste event (macOS screenshots included). */
  const collectPasteFiles = (cd: DataTransfer): File[] => {
    const out: File[] = [];
    const seen = new Set<string>();
    const pushFile = (f: File | null) => {
      if (!f || f.size === 0) return;
      const key = `${f.name}|${f.size}|${f.type}|${f.lastModified}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(f);
    };

    // 1) items: preferred — catches image/png from Cmd+Ctrl+Shift+4 / Cmd+C
    if (cd.items) {
      for (let i = 0; i < cd.items.length; i++) {
        const item = cd.items[i];
        const type = (item.type || "").toLowerCase();
        if (item.kind === "file" || type.startsWith("image/")) {
          pushFile(item.getAsFile());
        }
      }
    }
    // 2) files list
    if (cd.files) {
      for (let i = 0; i < cd.files.length; i++) {
        pushFile(cd.files.item(i));
      }
    }
    return out;
  };

  const attachOsClipboardImage = async (): Promise<boolean> => {
    try {
      const saved = await invoke<{
        path: string;
        name?: string | null;
        mime?: string | null;
        size?: number | null;
      } | null>("read_clipboard_image");
      if (!saved?.path) return false;
      addAttachments([
        {
          path: saved.path,
          name: saved.name || "clipboard.png",
          mime: saved.mime || "image/png",
          size: saved.size,
          previewUrl: null,
        },
      ]);
      return true;
    } catch (e) {
      console.warn("read_clipboard_image failed", e);
      return false;
    }
  };

  const onComposerPaste = async (
    e: React.ClipboardEvent<HTMLTextAreaElement>,
  ) => {
    const cd = e.clipboardData;
    if (!cd) return;

    const fileItems = collectPasteFiles(cd);
    const types = cd.types ? Array.from(cd.types) : [];
    const looksLikeImage =
      fileItems.some((f) => (f.type || "").startsWith("image/") || !f.type) ||
      types.some((t) => t.toLowerCase().startsWith("image/") || t === "Files");

    // Pure text paste — leave to the browser.
    if (fileItems.length === 0 && !looksLikeImage) {
      return;
    }

    // We handle image/file ourselves so text doesn't swallow the paste.
    if (fileItems.length > 0 || looksLikeImage) {
      e.preventDefault();
    }

    if (!session) {
      setError("Open a task first to attach clipboard images/files");
      return;
    }

    try {
      const saved: Attachment[] = [];
      for (const file of fileItems) {
        const name =
          file.name && file.name !== "image.png" && file.name !== "blob"
            ? file.name
            : `paste-${Date.now()}.png`;
        const att = await savePastedBlob(file, name);
        if (att) saved.push(att);
      }
      if (saved.length) {
        addAttachments(saved);
        return;
      }
      // Fallback: OS clipboard image (macOS screenshot often only here).
      if (looksLikeImage || types.length === 0) {
        const ok = await attachOsClipboardImage();
        if (!ok && fileItems.length === 0) {
          // Last resort: try OS clipboard even if types looked empty.
          await attachOsClipboardImage();
        }
      }
    } catch (err) {
      setError(String(err));
    }
  };

  /** Global paste while composer focused is covered; also allow paste when dock is focused. */
  useEffect(() => {
    const onWindowPaste = (ev: ClipboardEvent) => {
      const t = ev.target as HTMLElement | null;
      // If paste is already on our textarea, React handler runs.
      if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
      // Ignore paste in settings forms.
      if (view !== "workspace") return;
      if (!session || busy) return;
      const cd = ev.clipboardData;
      if (!cd) return;
      const files = collectPasteFiles(cd);
      const types = cd.types ? Array.from(cd.types) : [];
      const looksLikeImage =
        files.length > 0 ||
        types.some((x) => x.toLowerCase().startsWith("image/") || x === "Files");
      if (!looksLikeImage) return;
      ev.preventDefault();
      void (async () => {
        try {
          if (files.length) {
            const saved: Attachment[] = [];
            for (const file of files) {
              const att = await savePastedBlob(
                file,
                file.name || `paste-${Date.now()}.png`,
              );
              if (att) saved.push(att);
            }
            if (saved.length) {
              addAttachments(saved);
              return;
            }
          }
          await attachOsClipboardImage();
        } catch (err) {
          setError(String(err));
        }
      })();
    };
    window.addEventListener("paste", onWindowPaste);
    return () => window.removeEventListener("paste", onWindowPaste);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session, busy, view]);

  const removeAttachment = (path: string) => {
    setAttachments((prev) => {
      const target = prev.find((a) => a.path === path);
      if (target?.previewUrl) {
        try {
          URL.revokeObjectURL(target.previewUrl);
        } catch {
          /* ignore */
        }
      }
      return prev.filter((a) => a.path !== path);
    });
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
    turnStartedAtRef.current = Date.now();
    const display =
      pendingAttachments.length > 0
        ? `${text || "(attachments)"}${text ? "\n\n" : ""}📎 ${pendingAttachments
            .map((a) => a.name)
            .join(", ")}`
        : text;
    push({ kind: "user", text: display });
    // Immediate left-side feedback so the UI doesn't look frozen.
    push({ kind: "waiting", text: "Grokx is thinking…" });
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
      finishTurnCollapse(true);
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
      // Still collapse any in-flight process stream.
      finishTurnCollapse(false);
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
  const activeTaskTitle =
    sessions.find((s) => s.session_id === session?.session_id)?.title || null;
  const title =
    activeTaskTitle ||
    selectedProject?.name ||
    shortPath(session?.project_root || projectRoot) ||
    "New task";

  return (
    <div
      className={`layout${outputsOpen ? "" : " layout-outputs-collapsed"}${
        view === "settings" ? " layout-settings" : ""
      }`}
    >
      <aside className="sidebar">
        <div className="brand-row">
          <button
            type="button"
            className="brand brand-btn"
            title="Back to workspace"
            onClick={() => setView("workspace")}
          >
            <IconBrand size={20} className="brand-mark" />
            <span>Grokx</span>
          </button>
          <button
            className={`icon-btn${view === "settings" ? " active" : ""}`}
            title="Settings"
            onClick={() => {
              setView("settings");
              void loadSettings();
            }}
          >
            <IconSettings size={16} />
          </button>
        </div>

        <nav className="nav">
          <button
            className="nav-item"
            onClick={() => void onNewTask()}
            disabled={connecting}
          >
            <span className="nav-glyph">
              <IconPen size={16} />
            </span>
            {connecting ? "Connecting…" : "New task"}
          </button>
          <button
            className="nav-item"
            onClick={() => void onConnect()}
            disabled={connecting}
          >
            <span className="nav-glyph">
              <IconRefresh size={16} />
            </span>
            {connected ? "Reconnect" : "Connect agent"}
          </button>
        </nav>

        {/* Project = fixed user-chosen folder */}
        <div className="section-label-row">
          <span className="section-label">Projects</span>
          <button
            type="button"
            className="session-add-btn"
            title="Open project folder (fixed path)"
            disabled={connecting || busy}
            onClick={() => void onOpenProject()}
          >
            <IconPlus size={16} />
          </button>
        </div>
        <div className="project-list">
          {projects.length === 0 && (
            <div className="session-empty">
              No projects · + opens a folder
            </div>
          )}
          {projects.map((p) => (
            <div
              key={p.project_id}
              className={`project-row${
                p.project_id === selectedProjectId ? " active" : ""
              }`}
              onClick={() => void onSelectProject(p)}
              title={`Project (fixed path)\n${p.root_path}`}
            >
              <div className="project-row-main">
                <div className="project-title">{p.name}</div>
                <span className="project-count">{p.session_count}</span>
              </div>
              <div className="project-meta">{shortPath(p.root_path)}</div>
            </div>
          ))}
        </div>

        {/* Tasks = temporary ~/.grokx/tasks/<id> only; does not create Projects */}
        <div className="section-label-row">
          <span className="section-label">
            Tasks
            {selectedProject ? ` · ${selectedProject.name}` : ""}
          </span>
          <button
            type="button"
            className="session-add-btn"
            title={
              selectedProject
                ? "New task under this project (~/.grokx/tasks/…)"
                : "New temporary task (Tasks only, no Project entry)"
            }
            disabled={connecting || busy}
            onClick={() => void onNewSession()}
          >
            <IconPlus size={16} />
          </button>
        </div>
        <div className="session-list">
          {sessions.length === 0 && (
            <div className="session-empty">No tasks · click + to start</div>
          )}
          {sessions.map((s) => (
            <div
              key={s.session_id}
              className={`session-row${
                s.session_id === session?.session_id ? " active" : ""
              }`}
              onClick={() => void onActivateSession(s)}
              onDoubleClick={(e) => startRename(s, e)}
              title={`Task workspace (temporary)\n${s.work_path || "~/.grokx/tasks/…"}\nProject: ${s.project_root}\nClick to switch · double-click or ✎ to rename · 🗑 to delete`}
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
                      className="session-action-btn"
                      title="Rename task"
                      onClick={(e) => startRename(s, e)}
                    >
                      <IconPen size={12} />
                    </button>
                    <button
                      type="button"
                      className="session-action-btn session-delete-btn"
                      title="Delete task"
                      onClick={(e) => void onDeleteSession(s, e)}
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                  <div className="session-meta">
                    {s.work_path
                      ? shortPath(s.work_path)
                      : new Date(s.created_at || s.updated_at).toLocaleString()}
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
                System · model and engine (set once)
              </p>
            </div>
            <button
              className="btn"
              onClick={() => setView("workspace")}
            >
              Back to workspace
            </button>
          </header>

          <div className="settings-page">
            <div className="settings-grid">
              <section className="card settings-card">
                <h3>Model</h3>
                <p className="muted" style={{ marginBottom: 12 }}>
                  Configure API endpoint, key, and default model. Daily chat does not need this page; after save
                  {cfgSyncGrok ? "it syncs to the engine config, " : ""}
                  reconnect to apply.
                </p>
                {settingsMsg && (
                  <div
                    className={
                      settingsMsg.toLowerCase().includes("fail") ||
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
                    <label>Display name</label>
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
                      placeholder="https://api.x.ai/v1 or http://host:port/v1"
                    />
                  </div>
                  <div className="field field-span-2">
                    <label>
                      API Key
                      {cfgHasKey && cfgKeyHint
                        ? ` (saved ${cfgKeyHint})`
                        : ""}
                    </label>
                    <input
                      type="password"
                      value={cfgApiKey}
                      onChange={(e) => setCfgApiKey(e.target.value)}
                      placeholder={
                        cfgHasKey
                          ? "Leave blank to keep current key"
                          : "sk-..."
                      }
                      autoComplete="off"
                    />
                  </div>
                  <div className="field">
                    <label>Env key (optional)</label>
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
                    <label>Default effort</label>
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
                  Also write ~/.grok/config.toml
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
                    {savingSettings ? "Saving…" : "Save settings"}
                  </button>
                  {cfgHasKey && (
                    <button
                      className="btn btn-ghost"
                      onClick={() => void onClearApiKey()}
                      disabled={savingSettings}
                    >
                      Clear key
                    </button>
                  )}
                  <button
                    className="btn"
                    onClick={() => void loadSettings()}
                    disabled={savingSettings}
                  >
                    Reload
                  </button>
                </div>
              </section>

              <section className="card settings-card">
                <h3>Project & engine</h3>
                {error && <div className="error-banner">{error}</div>}
                <p className="muted" style={{ marginBottom: 12 }}>
                  Open a project folder from the sidebar (+). Each task gets a
                  temporary workspace under <code>~/.grokx/tasks/</code> with a{" "}
                  <code>project</code> link to your sources.
                </p>
                {selectedProject && (
                  <dl className="kv">
                    <dt>Project</dt>
                    <dd className="mono">{selectedProject.root_path}</dd>
                    {session?.work_path && (
                      <>
                        <dt>Task cwd</dt>
                        <dd className="mono">{session.work_path}</dd>
                      </>
                    )}
                  </dl>
                )}
                <div className="btn-row">
                  <button
                    className="btn btn-primary"
                    onClick={() => void onOpenProject()}
                    disabled={connecting}
                  >
                    {connecting ? "Opening…" : "Open project…"}
                  </button>
                  <button
                    className="btn"
                    onClick={() => void onConnect()}
                    disabled={connecting}
                  >
                    {connecting
                      ? "Connecting…"
                      : connected
                        ? "Reconnect"
                        : "Connect agent"}
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
                  <label>Custom engine path (optional)</label>
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
                  {selectedProject
                    ? `Project ${selectedProject.name} · ${shortPath(selectedProject.root_path)}`
                    : session?.work_path
                      ? "Temporary task"
                      : "No project"}
                  {session?.work_path
                    ? ` · ${shortPath(session.work_path)}`
                    : activeTaskTitle
                      ? ` · ${activeTaskTitle}`
                      : session?.session_id
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
                  title="Jump to this user message"
                  onClick={() => jumpToUserMessage(stickyUserId)}
                >
                  <span className="user-sticky-label">Your message</span>
                  <span className="user-sticky-text">{stickyUserText}</span>
                  <span className="user-sticky-jump">Jump ↓</span>
                </button>
              )}
              <div
                className={`chat-inner${
                  stickyUserId ? " chat-inner-sticky" : ""
                }`}
              >
                {lines.length === 0 && (
                  <div className="empty-state">
                    <h2>Start a task</h2>
                    <p>
                      Click <strong>New task</strong> or <strong>Tasks +</strong> to create
                      a temporary session under <code>~/.grokx/tasks/</code> and chat.
                      That does <strong>not</strong> add a Project. Use{" "}
                      <strong>Projects +</strong> only when you want to open a real code
                      folder. Model key: <strong>Settings</strong>.
                    </p>
                  </div>
                )}

                {lines.map((line, i) => {
                  if (line.kind === "trace") {
                    return (
                      <div key={line.id} className="msg msg-trace">
                        <div className="trace-panel">
                          <button
                            type="button"
                            className="trace-summary"
                            onClick={() => toggleTrace(line.id)}
                            aria-expanded={line.expanded}
                          >
                            <span className="trace-chevron" aria-hidden>
                              {line.expanded ? "▾" : "▸"}
                            </span>
                            <span className="trace-label">
                              Worked · {summarizeTrace(line.items)}
                            </span>
                            <span className="trace-duration">
                              {formatDuration(line.durationMs)}
                            </span>
                          </button>
                          {line.expanded && (
                            <div className="trace-body">
                              {line.items.map((item) => {
                                if (item.kind === "thought") {
                                  return (
                                    <div
                                      key={item.id}
                                      className="msg msg-thought trace-item"
                                    >
                                      <div className="msg-body md-body thought-md">
                                        <ReactMarkdown
                                          remarkPlugins={[remarkGfm]}
                                        >
                                          {item.text}
                                        </ReactMarkdown>
                                      </div>
                                    </div>
                                  );
                                }
                                return (
                                  <div
                                    key={item.id}
                                    className="msg-chip trace-item"
                                  >
                                    <span className="chip-icon">
                                      <ChipIcon kind={item.kind} />
                                    </span>
                                    <span>{item.text}</span>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }
                  if (line.kind === "tool" || line.kind === "system") {
                    return (
                      <div key={line.id} className="msg-chip">
                        <span className="chip-icon">
                          <ChipIcon kind={line.kind} />
                        </span>
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
                    <div
                      key={a.path}
                      className={`attach-chip${
                        a.mime?.startsWith("image/") ? " attach-chip-image" : ""
                      }`}
                      title={a.path}
                    >
                      {a.mime?.startsWith("image/") && a.previewUrl ? (
                        <img
                          className="attach-thumb"
                          src={a.previewUrl}
                          alt={a.name}
                        />
                      ) : (
                        <span className="attach-icon">
                          {a.mime?.startsWith("image/") ? "🖼" : "📄"}
                        </span>
                      )}
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
                onPaste={(e) => {
                  void onComposerPaste(e);
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
                    ? "Describe what this task should do… (paste text or images)"
                    : "Click Tasks + to create a task and start chatting…"
                }
              />
              <div className="composer-bar">
                <div className="composer-left">
                  <button
                    type="button"
                    className="composer-plus"
                    title="Attach files (or paste from clipboard)"
                    onClick={() => void onPickAttachments()}
                    disabled={!session || busy}
                  >
                    <IconPaperclip size={16} />
                  </button>
                  <button
                    type="button"
                    className={`access-toggle${autoApprove ? "" : " off"}`}
                    onClick={() => setAutoApprove((v) => !v)}
                    title="Auto-approve tools on next connect"
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
                      <IconStop size={14} />
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
                      <IconSend size={16} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          </main>

          {outputsOpen ? (
            <aside className="right">
              <div className="right-header">
                <h2>Outputs</h2>
                <button
                  type="button"
                  className="icon-btn"
                  title="Collapse outputs"
                  onClick={() => setOutputsOpen(false)}
                >
                  <IconChevronRight size={16} />
                </button>
              </div>

              {error && !session && (
                <div className="error-banner" style={{ marginBottom: 12 }}>
                  {error}
                </div>
              )}

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
                    Agent waiting · {pendingPerm.id.slice(0, 8)}
                  </p>
                </div>
              )}

              {session && !pendingPerm && (
                <div className="card">
                  <h3>Approvals</h3>
                  <p className="muted">
                    When auto-approve is off, tool permission requests appear
                    here.
                  </p>
                </div>
              )}

              {session && (
                <div className="card">
                  <h3>Current task</h3>
                  <dl className="kv">
                    {session.project_root && (
                      <>
                        <dt>Project</dt>
                        <dd className="mono" title={session.project_root}>
                          {shortPath(session.project_root)}
                        </dd>
                      </>
                    )}
                    {session.work_path && (
                      <>
                        <dt>Task cwd</dt>
                        <dd className="mono" title={session.work_path}>
                          {shortPath(session.work_path)}
                        </dd>
                      </>
                    )}
                  </dl>
                  <p className="muted" style={{ marginTop: 8 }}>
                    Temporary workspace under ~/.grokx/tasks/. Project sources
                    via ./project.
                  </p>
                </div>
              )}

              {!session && !pendingPerm && (
                <div className="card">
                  <h3>Outputs</h3>
                  <p className="muted">
                    Permissions and task details show up here after you open a
                    project from the sidebar.
                  </p>
                </div>
              )}
            </aside>
          ) : (
            <div className="right-collapsed">
              <button
                type="button"
                className="icon-btn right-expand-btn"
                title="Show outputs"
                onClick={() => setOutputsOpen(true)}
              >
                <IconChevronLeft size={16} />
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
