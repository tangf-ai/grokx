import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openUrl } from "@tauri-apps/plugin-shell";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  IconAlert,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconCopy,
  IconFile,
  IconFolder,
  IconGithub,
  IconInfo,
  IconPaperclip,
  IconPen,
  IconPlus,
  IconRefresh,
  IconSend,
  IconSettings,
  IconStop,
  IconTask,
  IconTool,
  IconTrash,
} from "./icons";
import { onTitlebarMouseDown } from "./windowDrag";
import {
  detectVerbalOnlyCompletion,
  VERBAL_COMPLETION_NUDGE,
} from "./lib/verbalCompletion";
import {
  ComposerInput,
  type ComposerInputHandle,
} from "./components/ComposerInput";
import { VirtualChatList } from "./components/VirtualChatList";

/** Public open-source repository (opens in the system browser). */
const GROKX_GITHUB_URL = "https://github.com/tangf-ai/grokx";

/** Debounce identical opens — prevents shell open + webview target=_blank double fire. */
let lastExternalOpen: { url: string; at: number } | null = null;

/** Open http(s) / mailto links with the OS default app (browser, mail, …). */
function openExternalUrl(url: string): void {
  const trimmed = url.trim();
  if (!trimmed) return;
  // Allow only schemes that should leave the app shell.
  if (!/^(https?:|mailto:)/i.test(trimmed)) return;
  const now = Date.now();
  if (
    lastExternalOpen &&
    lastExternalOpen.url === trimmed &&
    now - lastExternalOpen.at < 800
  ) {
    return;
  }
  lastExternalOpen = { url: trimmed, at: now };
  void openUrl(trimmed).catch((err) => {
    console.error("Failed to open URL:", err);
  });
}

/**
 * Resolve markdown image src to a webview-loadable URL.
 * Agents often emit relative paths (e.g. `rdfs-owl-diagrams/01.png`) against
 * the task cwd — those must become `asset://` URLs via convertFileSrc.
 */
function resolveLocalMediaSrc(
  src: string | undefined,
  bases: Array<string | null | undefined>,
): string | undefined {
  if (!src) return undefined;
  const raw = src.trim().replace(/^<|>$/g, "");
  if (!raw) return undefined;
  // Remote / data / already asset protocol
  if (
    /^(https?:|data:|asset:|blob:)/i.test(raw) ||
    raw.startsWith("//")
  ) {
    return raw;
  }
  let path = raw;
  if (path.startsWith("file://")) {
    path = decodeURIComponent(path.replace(/^file:\/\//, ""));
  }
  // Absolute filesystem path
  const isAbs =
    path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
  if (!isAbs) {
    // Relative → try task cwd, then project root
    const rel = path.replace(/^\.\//, "");
    let joined: string | null = null;
    for (const base of bases) {
      if (!base) continue;
      const b = base.replace(/[/\\]+$/, "");
      joined = `${b}/${rel}`.replace(/\\/g, "/");
      break;
    }
    if (!joined) return raw;
    path = joined;
  }
  try {
    return convertFileSrc(path);
  } catch {
    return raw;
  }
}

/**
 * Shared markdown rendering for chat: links open in the system browser;
 * local images resolve against the active task workspace.
 */
function ChatMarkdown({
  children,
  mediaBases = [],
}: {
  children: string;
  /** Candidate roots for relative media (task cwd, project root). */
  mediaBases?: Array<string | null | undefined>;
}) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      urlTransform={(url) => {
        // Allow local paths / asset URLs through (default sanitizer may strip).
        if (!url) return url;
        if (/^(https?:|data:|asset:|blob:|file:)/i.test(url)) return url;
        if (url.startsWith("/") || url.startsWith("./") || !url.includes(":")) {
          return url;
        }
        return url;
      }}
      components={{
        a({ href, children: linkChildren, node: _node, ...props }) {
          return (
            <a
              {...props}
              href={href}
              // No target=_blank: WKWebView would also open the system browser,
              // doubling with our shell open().
              rel="noopener noreferrer"
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (href) openExternalUrl(href);
              }}
            >
              {linkChildren}
            </a>
          );
        },
        img({ src, alt, node: _node, ...props }) {
          const resolved = resolveLocalMediaSrc(src, mediaBases);
          if (!resolved) return null;
          return (
            <img
              {...props}
              src={resolved}
              alt={alt ?? ""}
              className="chat-md-img"
              loading="lazy"
              onClick={(e) => {
                e.preventDefault();
                // Prefer opening the original path when possible.
                const orig = (src || "").trim();
                if (orig && !/^(https?:|data:)/i.test(orig)) {
                  const abs =
                    orig.startsWith("/") || /^[A-Za-z]:[\\/]/.test(orig)
                      ? orig
                      : mediaBases.find(Boolean)
                        ? `${String(mediaBases.find(Boolean)).replace(
                            /[/\\]+$/,
                            "",
                          )}/${orig.replace(/^\.\//, "")}`
                        : null;
                  if (abs) {
                    void invoke("open_path", { path: abs }).catch(() => {});
                    return;
                  }
                }
                if (resolved.startsWith("http")) openExternalUrl(resolved);
              }}
            />
          );
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}

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

type PermissionMode = "ask" | "auto" | "always-approve";

type PublicSettings = {
  custom_engine_path?: string | null;
  prefer_bundled_engine: boolean;
  model?: string | null;
  effort?: string | null;
  sync_to_grok_config: boolean;
  /** `ask` | `auto` | `always-approve` (full trust) */
  permission_mode?: string | null;
  /** Legacy mirror of full trust */
  auto_approve?: boolean;
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

function normalizePermissionMode(raw?: string | null, legacyAuto?: boolean): PermissionMode {
  const v = (raw || "").trim().toLowerCase();
  if (v === "auto") return "auto";
  if (
    v === "always-approve" ||
    v === "always_approve" ||
    v === "yolo" ||
    v === "full-trust" ||
    v === "full_trust" ||
    v === "trusted"
  ) {
    return "always-approve";
  }
  if (!v && legacyAuto) return "always-approve";
  return "ask";
}

type ChatAttachment = {
  path: string;
  name: string;
  mime?: string | null;
  size?: number | null;
  /** asset:// URL for image preview in chat history */
  previewSrc?: string | null;
};

function formatBytes(n?: number | null): string {
  if (n == null) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** True for image attachments (mime or extension). */
function isImageAttachment(a: {
  name?: string | null;
  mime?: string | null;
}): boolean {
  if (a.mime?.startsWith("image/")) return true;
  const n = (a.name || "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(n);
}

/**
 * Prefer the original human filename. Never show a temp uuid-prefixed path
 * leaf when a real name is available.
 */
function attachmentDisplayName(a: {
  name?: string | null;
  path?: string | null;
}): string {
  const fromName = (a.name || "").trim();
  if (fromName && !/^[0-9a-f]{8}-/i.test(fromName)) {
    // Strip any accidental path prefix; keep basename.
    const leaf = fromName.split(/[/\\]/).pop() || fromName;
    if (leaf) return leaf;
  }
  const fromPath = (a.path || "").split(/[/\\]/).pop() || "";
  // Temp paste files look like `a1b2c3d4-报告.docx` — strip uuid prefix if present.
  const stripped = fromPath.replace(/^[0-9a-f]{8}-/i, "");
  return stripped || fromName || fromPath || "file";
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(1, Math.round(ms))}ms`;
  const sec = ms / 1000;
  if (sec < 60) return `${sec.toFixed(sec < 10 ? 1 : 0)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

/** Compact clock for user bubbles, e.g. 14:32 or 昨天 09:05. */
function formatMessageTime(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const now = new Date();
  const pad = (n: number) => n.toString().padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) return hm;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  if (isYesterday) return `昨天 ${hm}`;
  if (d.getFullYear() === now.getFullYear()) {
    return `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
  }
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/**
 * Rough token estimate for display (not API-reported usage).
 * CJK ideographs ≈ 1 token; other non-space chars ≈ 4 chars / token.
 */
function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x4e00 && code <= 0x9fff) ||
      (code >= 0x3400 && code <= 0x4dbf) ||
      (code >= 0x3040 && code <= 0x30ff) ||
      (code >= 0xac00 && code <= 0xd7af)
    ) {
      cjk += 1;
    } else if (/\s/u.test(ch)) {
      // ignore whitespace
    } else {
      other += 1;
    }
  }
  return Math.max(1, Math.round(cjk + other / 4));
}

function formatTokensPerSec(tps: number): string {
  if (!Number.isFinite(tps) || tps <= 0) return "—";
  if (tps >= 100) return `${Math.round(tps)}`;
  if (tps >= 10) return tps.toFixed(0);
  return tps.toFixed(1);
}

/** Compact token count for the context meter (e.g. 1.2k, 128k). */
function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return `${Math.round(n)}`;
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Estimate session context from visible chat (fallback when engine omits totalTokens). */
function estimateSessionTokens(chat: ChatLine[], draftText: string): number {
  let total = 0;
  for (const line of chat) {
    if (
      line.kind === "user" ||
      line.kind === "assistant" ||
      line.kind === "thought" ||
      line.kind === "system" ||
      line.kind === "error"
    ) {
      total += estimateTokens(line.text);
    } else if (line.kind === "tool") {
      total += estimateTokens(line.text);
    } else if (line.kind === "trace") {
      for (const item of line.items) {
        total += estimateTokens(item.text);
      }
    }
  }
  if (draftText.trim()) total += estimateTokens(draftText);
  return total;
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
  /** Merged consecutive identical tool lines (for × N display). */
  count?: number;
};

type ChatLine =
  | {
      id: string;
      kind: "user";
      text: string;
      /** ISO timestamp when the user sent this message. */
      at?: string;
      /** Optional image/file attachments shown as thumbnails in the bubble. */
      attachments?: ChatAttachment[];
    }
  | {
      id: string;
      kind: "assistant";
      text: string;
      /** Estimated output tokens (not API usage). */
      tokens?: number;
      /** Wall-clock stream duration for this reply (ms). */
      streamMs?: number;
      /** Estimated tokens / second over the stream window. */
      tokensPerSec?: number;
    }
  | { id: string; kind: "thought"; text: string }
  | {
      id: string;
      kind: "tool";
      text: string;
      /** Consecutive identical tool status lines merged into one chip. */
      count?: number;
    }
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

/** Rough row height for windowed chat (px). Prefer overscan over perfect accuracy. */
function estimateChatLineHeight(line: ChatLine): number {
  switch (line.kind) {
    case "tool":
    case "system":
      return 36;
    case "waiting":
      return 40;
    case "error":
      return 56;
    case "trace": {
      const base = 44;
      if (!line.expanded) return base;
      return base + Math.min(480, line.items.length * 36);
    }
    case "thought": {
      const lines = Math.ceil((line.text?.length ?? 0) / 90);
      return Math.min(320, 48 + lines * 18);
    }
    case "assistant": {
      const lines = Math.ceil((line.text?.length ?? 0) / 80);
      return Math.min(900, 56 + lines * 20);
    }
    case "user": {
      const textLines = Math.ceil((line.text?.length ?? 0) / 60);
      const atts = line.attachments?.length ?? 0;
      return Math.min(420, 52 + textLines * 18 + (atts > 0 ? 72 : 0));
    }
    default:
      return 64;
  }
}

/** Normalize tool chip text for merge comparison (trim + collapse spaces). */
function normalizeToolChipText(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

/**
 * Append a tool status line, merging consecutive identical texts into
 * `tool → running × N` instead of spamming the chat.
 */
function appendOrMergeToolLine(prev: ChatLine[], text: string): ChatLine[] {
  const label = normalizeToolChipText(text) || "Tool";
  let base = prev;
  if (base.length && base[base.length - 1].kind === "waiting") {
    base = base.slice(0, -1);
  }
  const last = base[base.length - 1];
  if (
    last &&
    last.kind === "tool" &&
    normalizeToolChipText(last.text) === label
  ) {
    const copy = base.slice(0, -1);
    copy.push({
      ...last,
      count: (last.count ?? 1) + 1,
    });
    return copy;
  }
  return [
    ...base,
    { id: nextLineId("tool"), kind: "tool", text: label, count: 1 },
  ];
}

/** Display label for a tool chip, with ×N when merged. */
function formatToolChipLabel(line: {
  text: string;
  count?: number;
}): string {
  const n = line.count ?? 1;
  if (n <= 1) return line.text;
  return `${line.text} × ${n}`;
}

/** Process kinds that fold into the collapsible "Worked" strip. */
function isProcessLine(
  line: ChatLine,
): line is Extract<ChatLine, { kind: "thought" | "tool" | "system" }> {
  return (
    line.kind === "thought" || line.kind === "tool" || line.kind === "system"
  );
}

/**
 * After a turn ends: fold thought/tool/system into one collapsible trace
 * above the answer(s). Safe to call again if late tool events arrived after
 * a previous collapse (merges into existing trace).
 */
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

  const items: TraceItem[] = [];
  const answers: ChatLine[] = [];
  const rest: ChatLine[] = [];
  let existingTrace: Extract<ChatLine, { kind: "trace" }> | null = null;

  for (const line of tail) {
    if (line.kind === "waiting") continue;
    if (line.kind === "trace") {
      // Keep first trace; fold any later process lines into it.
      if (!existingTrace) {
        existingTrace = line;
        items.push(...line.items);
      } else {
        items.push(...line.items);
      }
      continue;
    }
    if (isProcessLine(line)) {
      if (line.kind === "tool") {
        items.push({
          id: line.id,
          kind: "tool",
          text: line.text,
          count: line.count,
        });
      } else {
        items.push({ id: line.id, kind: line.kind, text: line.text });
      }
    } else if (line.kind === "assistant") {
      answers.push(line);
    } else {
      rest.push(line);
    }
  }

  if (items.length === 0) return lines;

  // Prefer measured duration; keep prior trace duration if new measure is 0.
  const priorDur = existingTrace?.durationMs ?? 0;
  const dur =
    durationMs > 0 ? durationMs : priorDur > 0 ? priorDur : 0;

  const trace: ChatLine = {
    id: existingTrace?.id ?? nextLineId("trace"),
    kind: "trace",
    items,
    durationMs: Math.max(0, dur),
    expanded: false,
  };

  return [...head, trace, ...answers, ...rest];
}

/**
 * Collapse every turn in a transcript that still has raw thought/tool lines.
 * Used when loading history that was saved before collapse ran.
 */
function collapseAllTurnsInHistory(lines: ChatLine[]): ChatLine[] {
  const userIdx: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].kind === "user") userIdx.push(i);
  }
  if (userIdx.length === 0) return lines;

  const out: ChatLine[] = [];
  // Preserve any prefix before the first user message.
  if (userIdx[0] > 0) {
    out.push(...lines.slice(0, userIdx[0]));
  }

  for (let u = 0; u < userIdx.length; u++) {
    const start = userIdx[u];
    const end = u + 1 < userIdx.length ? userIdx[u + 1] : lines.length;
    const turnSlice = lines.slice(start, end);
    if (turnSlice.some(isProcessLine)) {
      // collapseTurnProcess folds from the last user in its input — pass only this turn.
      const collapsed = collapseTurnProcess(turnSlice, 0);
      out.push(...collapsed);
    } else {
      out.push(...turnSlice);
    }
  }
  return out;
}

function summarizeTrace(items: TraceItem[]): string {
  const thoughts = items.filter((i) => i.kind === "thought").length;
  // Count merged tool chips by their × N (so 50× running = 50 tools, not 1).
  const tools = items
    .filter((i) => i.kind === "tool")
    .reduce((sum, i) => sum + (i.count ?? 1), 0);
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
  /** Engine `_meta.totalTokens` when present (context_usage events). */
  used_tokens?: number;
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

const SIDEBAR_W_MIN = 180;
const SIDEBAR_W_MAX = 440;
const RIGHT_W_MIN = 220;
const RIGHT_W_MAX = 560;

function clampWidth(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function readStoredWidth(
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n)) return fallback;
    return clampWidth(n, min, max);
  } catch {
    return fallback;
  }
}

function writeStoredWidth(key: string, value: number): void {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* ignore quota / private mode */
  }
}

/** Parent directory of a path (POSIX-ish). */
function parentDir(path: string): string | null {
  const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  if (i <= 0) return null;
  // Keep leading slash on absolute paths.
  return norm.slice(0, i) || "/";
}

type DirEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number | null;
  modified?: string | null;
};

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
  /** Project used for “new task under project” / highlight context. */
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(
    null,
  );
  /**
   * Projects whose nested task lists are open. Independent of selection so
   * switching to another project/session does not collapse an open project.
   */
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<string>>(
    () => new Set(),
  );
  const [sessions, setSessions] = useState<SessionListRow[]>([]);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameInputRef = useRef<HTMLInputElement | null>(null);
  const [projectRoot, setProjectRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [appVersion, setAppVersion] = useState<string>("0.1.0");
  const [lines, setLines] = useState<ChatLine[]>([]);
  /**
   * Composer draft lives in ComposerInput (local state) so typing does not
   * re-render the full chat. These are cheap parent mirrors only:
   * - draftForMeter: debounced, for context token estimate
   * - composerHasText: boolean for Send button enablement
   */
  const [draftForMeter, setDraftForMeter] = useState("");
  const [composerHasText, setComposerHasText] = useState(false);
  /** Edit a past user bubble, then re-send from that point. */
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const editTextareaRef = useRef<HTMLTextAreaElement | null>(null);
  /** Busy for the *focused* task (composer / status pill). */
  const [busy, setBusy] = useState(false);
  /**
   * Per-task busy map so sidebar shows Working on background agents.
   * Multiple tasks can stream in parallel; only the active one's chat is shown.
   */
  const [sessionBusyMap, setSessionBusyMap] = useState<Record<string, boolean>>(
    {},
  );
  /**
   * Sessions that produced activity while not focused — show a dot next to
   * the task title until the user opens that task.
   */
  const [sessionUnreadMap, setSessionUnreadMap] = useState<
    Record<string, boolean>
  >({});
  const sessionUnreadMapRef = useRef<Map<string, boolean>>(new Map());
  const [connecting, setConnecting] = useState(false);
  const [agentStatus, setAgentStatus] = useState<string>("disconnected");
  /** Tool permission: ask | auto | always-approve (full trust). */
  const [permissionMode, setPermissionMode] =
    useState<PermissionMode>("ask");
  /** Engine-reported session tokens (`_meta.totalTokens`); null → estimate from chat. */
  const [engineContextTokens, setEngineContextTokens] = useState<number | null>(
    null,
  );
  /** Per-task engine token totals so switching restores correctly; new tasks start empty. */
  const sessionContextTokensRef = useRef<Map<string, number>>(new Map());
  /** In-memory transcript for background tasks still receiving events. */
  const sessionLinesCacheRef = useRef<Map<string, ChatLine[]>>(new Map());
  const busyRef = useRef(false);
  const sessionBusyMapRef = useRef<Map<string, boolean>>(new Map());
  const [pendingPerm, setPendingPerm] = useState<PendingPermission | null>(null);
  /** Main view: workspace chat vs full settings page. */
  const [view, setView] = useState<"workspace" | "settings">("workspace");
  /** Right Outputs rail — collapsible to free chat space. */
  const [outputsOpen, setOutputsOpen] = useState(true);
  /** Draggable column widths (px); persisted across restarts. */
  const [sidebarWidth, setSidebarWidth] = useState(() =>
    readStoredWidth("grokx.sidebarWidth", 248, SIDEBAR_W_MIN, SIDEBAR_W_MAX),
  );
  const [rightWidth, setRightWidth] = useState(() =>
    readStoredWidth("grokx.rightWidth", 300, RIGHT_W_MIN, RIGHT_W_MAX),
  );
  const sidebarWidthRef = useRef(sidebarWidth);
  const rightWidthRef = useRef(rightWidth);
  useEffect(() => {
    sidebarWidthRef.current = sidebarWidth;
  }, [sidebarWidth]);
  useEffect(() => {
    rightWidthRef.current = rightWidth;
  }, [rightWidth]);
  const panelDragRef = useRef<{
    kind: "sidebar" | "right";
    startX: number;
    startW: number;
  } | null>(null);
  /** Right panel tab: overview (approvals/task) vs session files. */
  const [outputsTab, setOutputsTab] = useState<"overview" | "files">("overview");
  /** Which root is listed: task cwd vs project folder. */
  const [filesRootKind, setFilesRootKind] = useState<"task" | "project">("task");
  const [filesBrowsePath, setFilesBrowsePath] = useState<string | null>(null);
  const [filesEntries, setFilesEntries] = useState<DirEntry[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string | null>(null);
  type GitCommitRow = {
    hash: string;
    short: string;
    subject: string;
    author: string;
    relative: string;
  };
  type GitStatusInfo = {
    path: string;
    is_repo: boolean;
    branch?: string | null;
    head_short?: string | null;
    head?: string | null;
    upstream?: string | null;
    dirty: boolean;
    staged: number;
    unstaged: number;
    untracked: number;
    changes: string[];
    recent: GitCommitRow[];
    note?: string | null;
  };
  const [gitInfo, setGitInfo] = useState<GitStatusInfo | null>(null);
  const [gitLoading, setGitLoading] = useState(false);
  const [gitError, setGitError] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelId, setModelId] = useState<string>("grok-4.5");
  const [efforts, setEfforts] = useState<EffortOption[]>([]);
  const [effortId, setEffortId] = useState<string>("medium");
  /** Sticky user prompt while reading replies (id of last scrolled-past user msg). */
  const [stickyUserId, setStickyUserId] = useState<string | null>(null);
  const [highlightUserId, setHighlightUserId] = useState<string | null>(null);
  /** Floating control when chat is scrolled up and more content is below. */
  const [showScrollToBottom, setShowScrollToBottom] = useState(false);
  /** Assistant message just copied: which id + format (brief "Copied" feedback). */
  const [copiedMsg, setCopiedMsg] = useState<{
    id: string;
    format: "md" | "plain";
  } | null>(null);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
  const composerRef = useRef<ComposerInputHandle | null>(null);
  const chatScrollRef = useRef<HTMLDivElement | null>(null);
  const userMsgEls = useRef<Map<string, HTMLDivElement>>(new Map());
  /** Wall-clock start of the in-flight agent turn (for duration on collapse). */
  const turnStartedAtRef = useRef<number | null>(null);
  /**
   * Auto-continue when the model ends a turn with only verbal progress.
   * Resets when the user sends a new prompt; max 1 auto-nudge per user turn.
   */
  const verbalNudgeUsedRef = useRef(false);
  const autoNudgeInFlightRef = useRef(false);
  /** After Stop, ignore late busy events for this session until a new send. */
  const userStoppedSessionRef = useRef<string | null>(null);
  /** First assistant delta for the in-flight reply (for tok/s). */
  const assistantStreamStartedAtRef = useRef<number | null>(null);
  /** Last assistant delta timestamp for the in-flight reply. */
  const assistantStreamLastAtRef = useRef<number | null>(null);
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
  /**
   * Chat auto-follow: content can stream fast, but viewport eases toward the
   * bottom slowly. Once the user scrolls manually, stop until they send again
   * or return near the bottom.
   */
  const autoScrollEnabledRef = useRef(true);
  const userScrollIntentRef = useRef(false);
  const scrollAnimRef = useRef<number | null>(null);
  const lastProgrammaticScrollRef = useRef(0);
  /** Coalesce sticky visibility checks to one layout read per frame. */
  const stickyRafRef = useRef<number | null>(null);
  const stickyUserIdRef = useRef<string | null>(null);
  /** Last trackpad/wheel activity — don't fight inertia by re-enabling auto-scroll too soon. */
  const lastUserScrollAtRef = useRef(0);
  /**
   * Per-task scroll resume: when switching Tasks, restore the viewport
   * position the user left (not always jump to bottom).
   */
  const sessionScrollRef = useRef<
    Map<
      string,
      {
        scrollTop: number;
        /** True if user was near the live edge — resume bottom + auto-follow. */
        pinBottom: boolean;
        autoScroll: boolean;
      }
    >
  >(new Map());

  useEffect(() => {
    linesRef.current = lines;
  }, [lines]);

  useEffect(() => {
    sessionsRef.current = sessions;
  }, [sessions]);

  useEffect(() => {
    busyRef.current = busy;
  }, [busy]);

  useEffect(() => {
    sessionIdRef.current = session?.session_id ?? null;
    workPathRef.current = session?.work_path ?? null;
  }, [session?.session_id, session?.work_path]);

  /** Update busy for one task; sync focused `busy` when that task is active. */
  const setSessionBusyState = useCallback((sid: string, nextBusy: boolean) => {
    if (!sid) return;
    const wasBusy = sessionBusyMapRef.current.get(sid) === true;
    sessionBusyMapRef.current.set(sid, nextBusy);
    setSessionBusyMap((prev) => {
      if (prev[sid] === nextBusy) return prev;
      return { ...prev, [sid]: nextBusy };
    });
    if (sessionIdRef.current === sid) {
      busyRef.current = nextBusy;
      setBusy(nextBusy);
    }
    // Working → idle while user is not looking at this task → unread (green).
    if (wasBusy && !nextBusy) {
      const viewingThis =
        sessionIdRef.current === sid &&
        typeof document !== "undefined" &&
        document.visibilityState === "visible";
      if (!viewingThis) {
        // Defer so markSessionUnread is defined; call via ref pattern below.
        queueMicrotask(() => {
          if (sessionUnreadMapRef.current.get(sid)) return;
          if (
            sessionIdRef.current === sid &&
            document.visibilityState === "visible"
          ) {
            return;
          }
          sessionUnreadMapRef.current.set(sid, true);
          setSessionUnreadMap((prev) =>
            prev[sid] ? prev : { ...prev, [sid]: true },
          );
        });
      }
    }
  }, []);

  /** Mark a task as having unread activity (finished or updated while not viewed). */
  const markSessionUnread = useCallback((sid: string | null | undefined) => {
    if (!sid) return;
    // Actively viewing this task in a visible window → not unread.
    if (
      sessionIdRef.current === sid &&
      typeof document !== "undefined" &&
      document.visibilityState === "visible"
    ) {
      return;
    }
    if (sessionUnreadMapRef.current.get(sid)) return;
    sessionUnreadMapRef.current.set(sid, true);
    setSessionUnreadMap((prev) =>
      prev[sid] ? prev : { ...prev, [sid]: true },
    );
  }, []);

  const clearSessionUnread = useCallback((sid: string | null | undefined) => {
    if (!sid) return;
    if (!sessionUnreadMapRef.current.get(sid)) return;
    sessionUnreadMapRef.current.delete(sid);
    setSessionUnreadMap((prev) => {
      if (!prev[sid]) return prev;
      const next = { ...prev };
      delete next[sid];
      return next;
    });
  }, []);

  /**
   * Dock badge (macOS Dock / taskbar):
   * - Working tasks → red count (system badge; priority)
   * - Else unread finished tasks → green-style count (label with 🟢 when possible)
   * - Viewed / idle → clear
   *
   * Note: macOS dock badge chrome is system-red for numeric badges; we use
   * setBadgeCount for working, and setBadgeLabel("🟢N") for unread-only so
   * the two states stay distinguishable.
   */
  const syncDockBadge = useCallback(() => {
    let working = 0;
    for (const v of sessionBusyMapRef.current.values()) {
      if (v) working += 1;
    }
    if (busyRef.current && sessionIdRef.current) {
      if (!sessionBusyMapRef.current.get(sessionIdRef.current)) working += 1;
    }
    let unread = 0;
    for (const [sid, v] of sessionUnreadMapRef.current.entries()) {
      if (!v) continue;
      // Don't count unread for a task that is still working (working badge wins).
      if (sessionBusyMapRef.current.get(sid)) continue;
      if (busyRef.current && sessionIdRef.current === sid) continue;
      unread += 1;
    }

    const win = getCurrentWindow();
    void (async () => {
      try {
        if (working > 0) {
          // Red system badge = tasks currently working.
          await win.setBadgeLabel(undefined);
          await win.setBadgeCount(working);
        } else if (unread > 0) {
          // Finished but not viewed: green-tinted label (macOS still uses
          // badge chrome, but 🟢 distinguishes from working count).
          await win.setBadgeCount(undefined);
          await win.setBadgeLabel(`🟢${unread}`);
        } else {
          await win.setBadgeCount(undefined);
          await win.setBadgeLabel(undefined);
        }
      } catch {
        /* badge unsupported on some platforms */
      }
    })();
  }, []);

  useEffect(() => {
    syncDockBadge();
  }, [sessionBusyMap, sessionUnreadMap, busy, syncDockBadge]);

  // When the window becomes visible again, clear unread for the focused task
  // and refresh the dock badge.
  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === "visible" && sessionIdRef.current) {
        clearSessionUnread(sessionIdRef.current);
      }
      syncDockBadge();
    };
    document.addEventListener("visibilitychange", onVis);
    window.addEventListener("focus", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      window.removeEventListener("focus", onVis);
    };
  }, [clearSessionUnread, syncDockBadge]);

  /** Work path for a task id (active or from list). */
  const workPathForSession = useCallback((sid: string): string | null => {
    if (sessionIdRef.current === sid) return workPathRef.current;
    return (
      sessionsRef.current.find((s) => s.session_id === sid)?.work_path || null
    );
  }, []);

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

  /**
   * Mutate transcript for a session that is not currently focused.
   * Keeps background tasks streaming while the user looks at another chat.
   */
  const mutateBackgroundLines = useCallback(
    (sid: string, mutator: (prev: ChatLine[]) => ChatLine[]) => {
      if (!sid) return;
      const prev = sessionLinesCacheRef.current.get(sid) ?? [];
      const next = mutator(prev);
      sessionLinesCacheRef.current.set(sid, next);
      const wp = workPathForSession(sid);
      if (hasRealChatContent(next)) {
        void persistChatHistory(sid, next, wp);
      }
    },
    [workPathForSession, persistChatHistory, hasRealChatContent],
  );

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
        const filtered = parsed.filter(
          (l) => l && l.kind && l.kind !== "waiting" && !isConnectionNoise(l),
        );
        // Older histories may still have expanded thought/tool rows — fold them.
        return collapseAllTurnsInHistory(filtered);
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

  /**
   * Always load the full task list. UI splits them:
   * - under Projects → tasks whose project_id is a user project
   * - under Tasks → temporary / default-sandbox only
   */
  const refreshSessions = useCallback(async () => {
    try {
      let rows = await invoke<SessionListRow[]>("list_sessions");
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
  }, []);

  /** After connect / activate: sync projects + tasks. */
  const refreshHierarchy = useCallback(
    async (opts?: {
      projectId?: string | null;
      projectRoot?: string | null;
      /** When true, keep Tasks unbound to Projects list (temporary task). */
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
      } else if (opts?.standaloneTask) {
        setSelectedProjectId(null);
      }
      await refreshSessions();
      return pid;
    },
    [refreshProjects, refreshSessions, selectedProjectId],
  );

  type PushLine =
    | {
        kind: "user";
        text: string;
        id?: string;
        at?: string;
        attachments?: ChatAttachment[];
      }
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
        ...(line.kind === "user" && !line.at
          ? { at: new Date().toISOString() }
          : {}),
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
      const now = Date.now();
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
          if (assistantStreamStartedAtRef.current == null) {
            assistantStreamStartedAtRef.current = now;
          }
        } else {
          next = [
            ...base,
            { id: nextLineId("assistant"), kind: "assistant", text },
          ];
          assistantStreamStartedAtRef.current = now;
        }
        assistantStreamLastAtRef.current = now;
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

  /**
   * If the model ended with talk-only progress, warn in chat and auto-send a
   * one-shot follow-up that forces tool use + delivery confirmation.
   */
  const maybeHandleVerbalOnlyCompletion = useCallback(
    (chat: ChatLine[]) => {
      if (autoNudgeInFlightRef.current) return;
      const hit = detectVerbalOnlyCompletion(
        chat as Parameters<typeof detectVerbalOnlyCompletion>[0],
      );
      if (!hit) return;

      // Always surface a clear system note; auto-continue only once per user send.
      const canAutoNudge = hit.shouldNudge && !verbalNudgeUsedRef.current;
      const warnText = canAutoNudge
        ? hit.warning
        : hit.warning.replace(
            /将自动续跑一次[^\n]*/g,
            "请手动再发一条明确指令（要求执行工具并确认文件存在）。",
          );
      if (canAutoNudge) verbalNudgeUsedRef.current = true;

      const warnLine: ChatLine = {
        id: nextLineId("system"),
        kind: "system",
        text: warnText,
      };
      const withWarn = [...chat, warnLine];
      setLines(withWarn);
      linesRef.current = withWarn;
      void flushPersistHistory();

      if (!canAutoNudge) return;
      if (!sessionIdRef.current) return;

      autoNudgeInFlightRef.current = true;
      // Brief delay so UI paints the warning before the next turn starts.
      window.setTimeout(() => {
        void (async () => {
          const sid = sessionIdRef.current;
          if (!sid) {
            autoNudgeInFlightRef.current = false;
            return;
          }
          // User bubble for the auto-continue (visible, so history is honest).
          const userId = nextLineId("user");
          const waitingId = nextLineId("waiting");
          const nudged: ChatLine[] = [
            ...linesRef.current,
            {
              id: userId,
              kind: "user",
              text: "（自动续跑）请用工具完成交付并确认文件存在",
              at: new Date().toISOString(),
            },
            {
              id: waitingId,
              kind: "waiting",
              text: "Grokx is thinking…",
            },
          ];
          setLines(nudged);
          linesRef.current = nudged;
          turnStartedAtRef.current = Date.now();
          setSessionBusyState(sid, true);
          // Resume bottom follow for the auto-continue turn.
          autoScrollEnabledRef.current = true;
          userScrollIntentRef.current = false;
          try {
            await invoke("send_prompt_rich", {
              payload: {
                text: VERBAL_COMPLETION_NUDGE,
                attachments: [],
                model: modelId || null,
                effort: effortId || null,
              },
            });
          } catch (e) {
            setSessionBusyState(sid, false);
            // Drop waiting placeholder on send failure.
            setLines((prev) => {
              if (prev.length && prev[prev.length - 1].kind === "waiting") {
                const next = prev.slice(0, -1);
                linesRef.current = next;
                return next;
              }
              return prev;
            });
            push({ kind: "error", text: String(e) });
          } finally {
            autoNudgeInFlightRef.current = false;
          }
        })();
      }, 350);
    },
    [flushPersistHistory, setSessionBusyState, push, modelId, effortId],
  );

  const finishTurnCollapse = useCallback(
    (error?: boolean) => {
      const started = turnStartedAtRef.current;
      turnStartedAtRef.current = null;
      const durationMs = started != null ? Date.now() - started : 0;

      // Stamp generation speed on the last assistant reply in this turn.
      const streamStart = assistantStreamStartedAtRef.current;
      const streamEnd = assistantStreamLastAtRef.current ?? Date.now();
      assistantStreamStartedAtRef.current = null;
      assistantStreamLastAtRef.current = null;

      let finalChat: ChatLine[] | null = null;

      setLines((prev) => {
        let next = collapseTurnProcess(prev, durationMs);

        // Attach ~tokens / tok/s to the latest assistant message (after last user).
        let lastUser = -1;
        for (let i = next.length - 1; i >= 0; i--) {
          if (next[i].kind === "user") {
            lastUser = i;
            break;
          }
        }
        let lastAsst = -1;
        for (let i = next.length - 1; i > lastUser; i--) {
          if (next[i].kind === "assistant") {
            lastAsst = i;
            break;
          }
        }
        if (lastAsst >= 0) {
          const asst = next[lastAsst];
          if (asst.kind === "assistant" && asst.text.trim()) {
            const tokens = estimateTokens(asst.text);
            const streamMs =
              streamStart != null
                ? Math.max(1, streamEnd - streamStart)
                : undefined;
            const tokensPerSec =
              streamMs != null && streamMs >= 50
                ? tokens / (streamMs / 1000)
                : undefined;
            next = next.slice();
            next[lastAsst] = {
              ...asst,
              tokens,
              streamMs,
              tokensPerSec,
            };
          }
        }

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
        finalChat = next;
        // After first successful assistant reply, summarize and rename the task.
        if (!error) {
          void maybeAutoTitleFromChat(next);
        }
        return next;
      });

      // Late tool/thought events can race turn_finished — collapse once more
      // from the latest ref after React state has been scheduled.
      window.setTimeout(() => {
        const stillRaw = linesRef.current.some(
          (l, i, arr) => {
            if (!isProcessLine(l)) return false;
            // Only care about process lines after the last user.
            let lastUser = -1;
            for (let j = arr.length - 1; j >= 0; j--) {
              if (arr[j].kind === "user") {
                lastUser = j;
                break;
              }
            }
            return i > lastUser;
          },
        );
        if (!stillRaw) return;
        const repaired = collapseTurnProcess(linesRef.current, durationMs);
        linesRef.current = repaired;
        setLines(repaired);
        void flushPersistHistory();
      }, 80);

      // Persist immediately after a turn settles.
      void flushPersistHistory();

      // Premature verbal-only completion → warn + one auto-continue.
      if (!error && finalChat) {
        maybeHandleVerbalOnlyCompletion(finalChat);
      }
    },
    [
      flushPersistHistory,
      maybeAutoTitleFromChat,
      maybeHandleVerbalOnlyCompletion,
    ],
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

  const distanceFromBottom = useCallback((el: HTMLElement) => {
    return el.scrollHeight - el.scrollTop - el.clientHeight;
  }, []);

  const isNearBottom = useCallback(
    (el: HTMLElement, threshold = 80) => distanceFromBottom(el) <= threshold,
    [distanceFromBottom],
  );

  /** Snapshot current chat viewport for the active task (call before switching away). */
  const saveSessionScroll = useCallback(
    (sessionId: string | null | undefined) => {
      if (!sessionId) return;
      const el = chatScrollRef.current;
      if (!el) return;
      const pinBottom = distanceFromBottom(el) <= 80;
      sessionScrollRef.current.set(sessionId, {
        scrollTop: el.scrollTop,
        pinBottom,
        autoScroll: autoScrollEnabledRef.current || pinBottom,
      });
    },
    [distanceFromBottom],
  );

  /**
   * Restore a task's saved scroll after its transcript is in the DOM.
   * Double rAF waits for layout after setLines (scrollTop assignment fires
   * the existing scroll listener for sticky updates).
   */
  const restoreSessionScroll = useCallback((sessionId: string) => {
    const apply = () => {
      const el = chatScrollRef.current;
      if (!el) return;
      const saved = sessionScrollRef.current.get(sessionId);
      lastProgrammaticScrollRef.current = performance.now() + 160;

      if (!saved || saved.pinBottom) {
        el.scrollTop = el.scrollHeight;
        autoScrollEnabledRef.current = true;
        userScrollIntentRef.current = false;
      } else {
        const maxTop = Math.max(0, el.scrollHeight - el.clientHeight);
        el.scrollTop = Math.min(Math.max(0, saved.scrollTop), maxTop);
        // Stay where the user left off — do not auto-follow until they send
        // or intentionally return to the bottom.
        autoScrollEnabledRef.current = false;
        userScrollIntentRef.current = true;
      }
    };

    // First frame: React commit; second: layout with restored lines.
    requestAnimationFrame(() => {
      requestAnimationFrame(apply);
    });
  }, []);

  /** Ease viewport toward bottom (slow + smooth). Does not jump. */
  const ensureSmoothAutoScroll = useCallback(() => {
    if (!autoScrollEnabledRef.current) return;
    if (scrollAnimRef.current != null) return;

    const step = () => {
      scrollAnimRef.current = null;
      if (!autoScrollEnabledRef.current) return;
      const el = chatScrollRef.current;
      if (!el) return;

      const remaining = distanceFromBottom(el);
      if (remaining <= 1.5) {
        // Snap residual for crisp bottom alignment.
        if (remaining > 0) {
          lastProgrammaticScrollRef.current = performance.now();
          el.scrollTop = el.scrollHeight;
        }
        return;
      }

      // Ease: move a fraction of remaining distance each frame (slow follow).
      // Cap step so long streams don't race the eye.
      const ease = 0.08;
      const minStep = 0.6;
      const maxStep = 14;
      let delta = remaining * ease;
      if (delta < minStep) delta = Math.min(minStep, remaining);
      if (delta > maxStep) delta = maxStep;

      lastProgrammaticScrollRef.current = performance.now();
      el.scrollTop += delta;
      scrollAnimRef.current = requestAnimationFrame(step);
    };

    scrollAnimRef.current = requestAnimationFrame(step);
  }, [distanceFromBottom]);

  const enableAutoScroll = useCallback(() => {
    autoScrollEnabledRef.current = true;
    userScrollIntentRef.current = false;
    ensureSmoothAutoScroll();
  }, [ensureSmoothAutoScroll]);

  const disableAutoScroll = useCallback(() => {
    autoScrollEnabledRef.current = false;
    if (scrollAnimRef.current != null) {
      cancelAnimationFrame(scrollAnimRef.current);
      scrollAnimRef.current = null;
    }
  }, []);

  const updateScrollToBottomVisible = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) {
      setShowScrollToBottom(false);
      return;
    }
    // Enough content below the fold that a jump-to-bottom control is useful.
    const overflow = el.scrollHeight - el.clientHeight > 80;
    const away = distanceFromBottom(el) > 120;
    setShowScrollToBottom(overflow && away);
  }, [distanceFromBottom]);

  const applyStickyUserId = useCallback((next: string | null) => {
    if (stickyUserIdRef.current === next) return;
    stickyUserIdRef.current = next;
    setStickyUserId(next);
  }, []);

  const updateStickyUser = useCallback(() => {
    const scroller = chatScrollRef.current;
    if (!scroller || !lastUserMessage) {
      applyStickyUserId(null);
      return;
    }
    const el = userMsgEls.current.get(lastUserMessage.id);
    if (!el) {
      // Message just added — keep sticky once there's content after it.
      const idx = lines.findIndex((l) => l.id === lastUserMessage.id);
      const hasAfter = idx >= 0 && idx < lines.length - 1;
      applyStickyUserId(hasAfter ? lastUserMessage.id : null);
      return;
    }
    const scrollerRect = scroller.getBoundingClientRect();
    const msgRect = el.getBoundingClientRect();
    // Sticky when the user bubble has scrolled above the visible chat area.
    // Hysteresis avoids flicker at the threshold while trackpad-scrolling.
    const currentlySticky = stickyUserIdRef.current === lastUserMessage.id;
    const scrolledPast = currentlySticky
      ? msgRect.bottom < scrollerRect.top + 28
      : msgRect.bottom < scrollerRect.top + 4;
    const idx = lines.findIndex((l) => l.id === lastUserMessage.id);
    const hasAfter = idx >= 0 && idx < lines.length - 1;
    applyStickyUserId(scrolledPast && hasAfter ? lastUserMessage.id : null);
  }, [lastUserMessage, lines, applyStickyUserId]);

  /** Schedule sticky check once per frame — never every raw scroll event. */
  const scheduleStickyUser = useCallback(() => {
    if (stickyRafRef.current != null) return;
    stickyRafRef.current = requestAnimationFrame(() => {
      stickyRafRef.current = null;
      updateStickyUser();
    });
  }, [updateStickyUser]);

  const jumpToBottom = useCallback(() => {
    const el = chatScrollRef.current;
    if (!el) return;
    lastProgrammaticScrollRef.current = performance.now() + 500;
    el.scrollTo({
      top: Math.max(0, el.scrollHeight - el.clientHeight),
      behavior: "smooth",
    });
    // Resume live follow after manual jump to the edge.
    autoScrollEnabledRef.current = true;
    userScrollIntentRef.current = false;
    setShowScrollToBottom(false);
    window.setTimeout(() => {
      updateScrollToBottomVisible();
      scheduleStickyUser();
    }, 400);
  }, [scheduleStickyUser, updateScrollToBottomVisible]);

  // When chat content grows, ease toward bottom only if auto-follow is on.
  useEffect(() => {
    if (!autoScrollEnabledRef.current) {
      scheduleStickyUser();
      updateScrollToBottomVisible();
      return;
    }
    ensureSmoothAutoScroll();
    scheduleStickyUser();
    requestAnimationFrame(() => updateScrollToBottomVisible());
  }, [
    lines,
    busy,
    pendingPerm,
    ensureSmoothAutoScroll,
    scheduleStickyUser,
    updateScrollToBottomVisible,
  ]);

  // Detect user-driven scroll vs programmatic ease.
  useEffect(() => {
    const scroller = chatScrollRef.current;
    if (!scroller) return;

    const markUserIntent = () => {
      userScrollIntentRef.current = true;
      lastUserScrollAtRef.current = performance.now();
      // Any wheel/touch/keys means the user is in control.
      disableAutoScroll();
    };

    const onWheel = () => markUserIntent();
    const onTouchStart = () => markUserIntent();
    const onPointerDown = (e: PointerEvent) => {
      // Only scrollbar / content drag — not every click (avoids fighting Jump, etc.).
      const t = e.target as HTMLElement | null;
      if (t?.closest("button, a, input, textarea, select, label")) return;
      if (e.pointerType === "mouse" || e.pointerType === "pen" || e.pointerType === "touch") {
        // Likely scrollbar drag starts with pointerdown on the scroller chrome.
        if (e.offsetX >= scroller.clientWidth) {
          markUserIntent();
        }
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        e.key === "PageUp" ||
        e.key === "PageDown" ||
        e.key === "Home" ||
        e.key === "End" ||
        e.key === "ArrowUp" ||
        e.key === "ArrowDown" ||
        e.key === " "
      ) {
        // Only if chat is focused / event not from input.
        const t = e.target as HTMLElement | null;
        if (t && (t.tagName === "TEXTAREA" || t.tagName === "INPUT")) return;
        markUserIntent();
      }
    };

    const onScroll = () => {
      scheduleStickyUser();
      updateScrollToBottomVisible();
      // Ignore scroll events we just caused programmatically.
      if (performance.now() < lastProgrammaticScrollRef.current) {
        return;
      }
      if (performance.now() - lastProgrammaticScrollRef.current < 48) {
        return;
      }
      // Native scrollbar drag often only fires scroll, not pointer on content.
      if (userScrollIntentRef.current) {
        disableAutoScroll();
        return;
      }
      // If user dragged scrollbar without prior intent flag, treat large jumps
      // away from bottom as manual.
      if (!isNearBottom(scroller, 100)) {
        disableAutoScroll();
      }
    };

    // Re-enable when user scrolls back to the live edge — after inertia settles.
    const onScrollEndCheck = () => {
      if (autoScrollEnabledRef.current) return;
      // Trackpad inertia can keep scrolling 200–400ms after last wheel event.
      if (performance.now() - lastUserScrollAtRef.current < 280) return;
      if (isNearBottom(scroller, 48)) {
        // User returned to bottom — resume gentle follow.
        userScrollIntentRef.current = false;
        enableAutoScroll();
      }
    };

    let endTimer: ReturnType<typeof setTimeout> | null = null;
    const onScrollWithEnd = () => {
      onScroll();
      if (endTimer) clearTimeout(endTimer);
      endTimer = setTimeout(onScrollEndCheck, 220);
    };

    const onResize = () => {
      scheduleStickyUser();
      updateScrollToBottomVisible();
    };

    scroller.addEventListener("wheel", onWheel, { passive: true });
    scroller.addEventListener("touchstart", onTouchStart, { passive: true });
    scroller.addEventListener("pointerdown", onPointerDown, { passive: true });
    scroller.addEventListener("scroll", onScrollWithEnd, { passive: true });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", onResize);
    scheduleStickyUser();
    updateScrollToBottomVisible();

    return () => {
      if (endTimer) clearTimeout(endTimer);
      if (scrollAnimRef.current != null) {
        cancelAnimationFrame(scrollAnimRef.current);
        scrollAnimRef.current = null;
      }
      if (stickyRafRef.current != null) {
        cancelAnimationFrame(stickyRafRef.current);
        stickyRafRef.current = null;
      }
      scroller.removeEventListener("wheel", onWheel);
      scroller.removeEventListener("touchstart", onTouchStart);
      scroller.removeEventListener("pointerdown", onPointerDown);
      scroller.removeEventListener("scroll", onScrollWithEnd);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", onResize);
    };
  }, [
    scheduleStickyUser,
    updateScrollToBottomVisible,
    view,
    disableAutoScroll,
    enableAutoScroll,
    isNearBottom,
  ]);

  const jumpToUserMessage = useCallback(
    (id: string) => {
      const scroller = chatScrollRef.current;
      if (!scroller) return;

      // Manual navigation — pause auto-follow so we don't race back to bottom.
      disableAutoScroll();
      // Sticky is an absolute overlay (not in scroll flow). Hide it and scroll
      // immediately — waiting for reflow made the first click feel like a no-op.
      stickyUserIdRef.current = null;
      setStickyUserId(null);
      setHighlightUserId(id);

      const topPad = 20;
      // If the row is virtualized out of the DOM, jump via estimated prefix height first.
      if (!userMsgEls.current.get(id)) {
        let approx = 0;
        for (const line of linesRef.current) {
          if (line.id === id) break;
          approx += estimateChatLineHeight(line);
        }
        lastProgrammaticScrollRef.current = performance.now() + 500;
        scroller.scrollTop = Math.max(0, approx - topPad);
      }

      const alignToUser = () => {
        const target = userMsgEls.current.get(id);
        const root = chatScrollRef.current;
        if (!target || !root) return;
        const rootRect = root.getBoundingClientRect();
        const targetRect = target.getBoundingClientRect();
        const nextTop =
          root.scrollTop + (targetRect.top - rootRect.top) - topPad;
        // Instant jump — one click must land correctly (smooth was easy to cancel).
        lastProgrammaticScrollRef.current = performance.now() + 500;
        root.scrollTop = Math.max(0, nextTop);
      };

      // Scroll immediately on click (sticky is overlay — no layout shift).
      alignToUser();
      // Corrections after virtual window remounts the target row.
      requestAnimationFrame(() => alignToUser());
      window.setTimeout(alignToUser, 50);

      window.setTimeout(() => {
        setHighlightUserId((cur) => (cur === id ? null : cur));
      }, 1600);
      window.setTimeout(() => {
        updateStickyUser();
        updateScrollToBottomVisible();
      }, 200);
    },
    [updateStickyUser, updateScrollToBottomVisible, disableAutoScroll],
  );

  const stickyUserText = useMemo(() => {
    if (!stickyUserId) return null;
    const line = lines.find((l) => l.id === stickyUserId && l.kind === "user");
    return line && line.kind === "user" ? line.text : null;
  }, [stickyUserId, lines]);

  /** Context window size from Settings (default 500k for Grok 4.5-class models). */
  const contextWindow = useMemo(() => {
    const n = Number(cfgContext);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
    return 500_000;
  }, [cfgContext]);

  const estimatedContextTokens = useMemo(
    () => estimateSessionTokens(lines, draftForMeter),
    [lines, draftForMeter],
  );

  const clearComposer = useCallback(() => {
    composerRef.current?.clear();
    setDraftForMeter("");
    setComposerHasText(false);
  }, []);

  const onComposerDraftChange = useCallback((text: string) => {
    setComposerHasText(Boolean(text.trim()));
  }, []);

  const onComposerDraftSettled = useCallback((text: string) => {
    setDraftForMeter(text);
  }, []);

  // Prefer engine total only when it is for the active non-empty context;
  // empty new tasks should show ~0, not a stale process total.
  const contextUsed =
    engineContextTokens != null &&
    (estimatedContextTokens > 0 || engineContextTokens < 200)
      ? engineContextTokens
      : estimatedContextTokens;
  const contextFromEngine =
    engineContextTokens != null &&
    (estimatedContextTokens > 0 || engineContextTokens < 200);
  const contextPct = Math.min(
    100,
    Math.max(0, (contextUsed / contextWindow) * 100),
  );
  const contextMeterClass =
    contextPct >= 90
      ? "context-meter high"
      : contextPct >= 70
        ? "context-meter mid"
        : "context-meter";

  /**
   * Strip common Markdown so clipboard plain-text is readable outside MD editors.
   * Keeps link URLs and code content; drops fences / emphasis / headings markup.
   */
  const markdownToPlainText = useCallback((md: string): string => {
    let s = md.replace(/\r\n/g, "\n");
    // Fenced code blocks → inner code only
    s = s.replace(/```[\w-]*\n?([\s\S]*?)```/g, (_m, code: string) =>
      String(code).replace(/\n$/, ""),
    );
    // Inline code
    s = s.replace(/`([^`]+)`/g, "$1");
    // Images ![alt](url) → alt (url)
    s = s.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_m, alt: string, url: string) =>
      alt ? `${alt} (${url})` : url,
    );
    // Links [text](url) → text (url)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, url: string) =>
      label === url ? url : `${label} (${url})`,
    );
    // Autolinks <https://...>
    s = s.replace(/<(https?:\/\/[^>]+)>/g, "$1");
    // Headings
    s = s.replace(/^#{1,6}\s+/gm, "");
    // Blockquotes
    s = s.replace(/^>\s?/gm, "");
    // List markers
    s = s.replace(/^\s*[-*+]\s+/gm, "• ");
    s = s.replace(/^\s*\d+\.\s+/gm, (m) => m.replace(/^\s*/, ""));
    // Bold / italic / strike (order matters: longer delimiters first)
    s = s.replace(/\*\*\*([^*]+)\*\*\*/g, "$1");
    s = s.replace(/___([^_]+)___/g, "$1");
    s = s.replace(/\*\*([^*]+)\*\*/g, "$1");
    s = s.replace(/__([^_]+)__/g, "$1");
    s = s.replace(/\*([^*\n]+)\*/g, "$1");
    s = s.replace(/_([^_\n]+)_/g, "$1");
    s = s.replace(/~~([^~]+)~~/g, "$1");
    // Horizontal rules
    s = s.replace(/^\s*([-*_]){3,}\s*$/gm, "");
    // Collapse 3+ blank lines
    s = s.replace(/\n{3,}/g, "\n\n");
    return s.trim();
  }, []);

  const writeClipboardText = useCallback(async (body: string) => {
    try {
      await navigator.clipboard.writeText(body);
    } catch {
      // Fallback for environments where Clipboard API is blocked.
      const ta = document.createElement("textarea");
      ta.value = body;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
      } finally {
        document.body.removeChild(ta);
      }
    }
  }, []);

  const copyAssistantText = useCallback(
    async (id: string, text: string, format: "md" | "plain") => {
      const raw = text.trim();
      if (!raw) return;
      const body = format === "plain" ? markdownToPlainText(raw) : raw;
      if (!body) return;
      await writeClipboardText(body);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      setCopiedMsg({ id, format });
      copiedTimerRef.current = setTimeout(() => {
        setCopiedMsg((cur) =>
          cur && cur.id === id && cur.format === format ? null : cur,
        );
        copiedTimerRef.current = null;
      }, 1600);
    },
    [markdownToPlainText, writeClipboardText],
  );

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
    setPermissionMode(
      normalizePermissionMode(s.permission_mode, s.auto_approve),
    );
    if (s.model) setModelId(s.model);
    if (s.effort || s.endpoint.default_effort) {
      setEffortId(s.effort || s.endpoint.default_effort || "medium");
    }
  }, []);

  /** Persist permission mode and sync engine ~/.grok/config.toml. */
  const setPermissionModeAndSave = useCallback(
    async (next: PermissionMode) => {
      setPermissionMode(next);
      try {
        const s = await invoke<PublicSettings>("save_settings", {
          update: {
            permission_mode: next,
            // Keep legacy field for older code paths.
            auto_approve: next === "always-approve",
          },
        });
        applyPublicSettings(s);
      } catch (e) {
        console.warn("save permission_mode failed", e);
      }
    },
    [applyPublicSettings],
  );

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
        // Grok Build / Grok 4.5 practical menu (not the full API enum).
        setEfforts([
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
        const evSid = sessionIdOf(ev);
        const activeSid = sessionIdRef.current;
        // Events with a session id that is not focused go to background cache.
        // agent_status / agent_error may lack session id — treat as focused.
        const isBackground =
          Boolean(evSid) && Boolean(activeSid) && evSid !== activeSid;

        const markBusy = (sid: string | null | undefined, next: boolean) => {
          // After user hits Stop, ignore late tool/stream events that would
          // flip Working back on until the next send.
          if (
            next &&
            sid &&
            userStoppedSessionRef.current &&
            userStoppedSessionRef.current === sid
          ) {
            return;
          }
          if (sid) setSessionBusyState(sid, next);
          else if (!isBackground) {
            busyRef.current = next;
            setBusy(next);
          }
        };

        /** Background activity while user looks at another task → unread dot. */
        const markBgUnread = () => {
          if (isBackground && evSid) markSessionUnread(evSid);
        };

        /** Append a simple line to background transcript. */
        const bgPush = (
          sid: string,
          kind: ChatLine["kind"],
          text: string,
        ) => {
          mutateBackgroundLines(sid, (prev) => {
            if (kind === "tool") {
              return appendOrMergeToolLine(prev, text);
            }
            let base = prev;
            if (base.length && base[base.length - 1].kind === "waiting") {
              base = base.slice(0, -1);
            }
            return [
              ...base,
              { id: nextLineId(kind), kind, text } as ChatLine,
            ];
          });
        };

        const bgAppendStream = (
          sid: string,
          kind: "assistant" | "thought",
          text: string,
        ) => {
          if (!text) return;
          mutateBackgroundLines(sid, (prev) => {
            let base = prev;
            if (base.length && base[base.length - 1].kind === "waiting") {
              base = base.slice(0, -1);
            }
            const last = base[base.length - 1];
            if (last && last.kind === kind) {
              const copy = base.slice(0, -1);
              copy.push({ ...last, text: last.text + text } as ChatLine);
              return copy;
            }
            return [
              ...base,
              { id: nextLineId(kind), kind, text } as ChatLine,
            ];
          });
        };

        switch (ev.type) {
          case "agent_status":
            // Global connection pill only for the focused agent lifecycle.
            if (!isBackground) {
              setAgentStatus(ev.status ?? "unknown");
            }
            break;
          case "session_ready":
            if (!isBackground) {
              setAgentStatus("ready");
              void refreshHierarchy();
              void refreshModels();
            } else {
              void refreshSessions();
            }
            break;
          case "user_message":
            break;
          case "message_delta":
            markBusy(evSid || activeSid, true);
            markBgUnread();
            if (isBackground && evSid) {
              if (ev.text) bgAppendStream(evSid, "assistant", ev.text);
            } else if (ev.text) {
              appendAssistant(ev.text);
            }
            break;
          case "thought_delta":
            markBusy(evSid || activeSid, true);
            markBgUnread();
            if (isBackground && evSid) {
              if (ev.text) bgAppendStream(evSid, "thought", ev.text);
            } else if (ev.text) {
              appendThought(ev.text);
            }
            break;
          case "tool_started":
            markBusy(evSid || activeSid, true);
            markBgUnread();
            {
              const label = ev.tool?.title ?? "Running tool";
              if (isBackground && evSid) {
                bgPush(evSid, "tool", label);
              } else {
                clearWaiting();
                setLines((prev) => {
                  const next = appendOrMergeToolLine(prev, label);
                  linesRef.current = next;
                  return next;
                });
                schedulePersistHistory();
              }
            }
            break;
          case "tool_updated":
            markBusy(evSid || activeSid, true);
            markBgUnread();
            {
              const label = `${ev.tool?.title ?? "Tool"} → ${ev.tool?.status ?? "updated"}`;
              if (isBackground && evSid) {
                bgPush(evSid, "tool", label);
              } else {
                clearWaiting();
                setLines((prev) => {
                  const next = appendOrMergeToolLine(prev, label);
                  linesRef.current = next;
                  return next;
                });
                schedulePersistHistory();
              }
            }
            break;
          case "permission_needed":
            markBusy(evSid || activeSid, true);
            markBgUnread();
            if (isBackground && evSid) {
              bgPush(
                evSid,
                "system",
                `Waiting for approval · ${ev.request?.summary ?? ev.request?.tool_name ?? "tool"}`,
              );
              // Permission for background task: still surface so user can act.
              if (ev.request?.id) {
                setPendingPerm({
                  id: ev.request.id,
                  summary: ev.request.summary ?? "Permission required",
                  tool_name: ev.request.tool_name ?? "tool",
                  detail: ev.request.detail,
                });
              }
            } else {
              clearWaiting();
              if (ev.request?.id) {
                setPendingPerm({
                  id: ev.request.id,
                  summary: ev.request.summary ?? "Permission required",
                  tool_name: ev.request.tool_name ?? "tool",
                  detail: ev.request.detail,
                });
              }
              push({
                kind: "system",
                text: `Waiting for approval · ${ev.request?.summary ?? ev.request?.tool_name ?? "tool"}`,
              });
            }
            break;
          case "plan_updated":
            if (ev.steps?.length) {
              if (isBackground && evSid) {
                bgPush(evSid, "system", `Plan: ${ev.steps.join(" → ")}`);
              } else {
                push({
                  kind: "system",
                  text: `Plan: ${ev.steps.join(" → ")}`,
                });
              }
            }
            break;
          case "turn_state": {
            const nextBusy =
              ev.state === "streaming" ||
              ev.state === "running_tools" ||
              ev.state === "waiting_permission";
            markBusy(evSid || activeSid, nextBusy);
            break;
          }
          case "turn_finished":
            markBusy(evSid || activeSid, false);
            // Turn completed off-screen / other task → unread (green dock badge).
            {
              const finishedSid = evSid || activeSid;
              const notViewing =
                Boolean(finishedSid) &&
                (finishedSid !== sessionIdRef.current ||
                  (typeof document !== "undefined" &&
                    document.visibilityState !== "visible"));
              if (finishedSid && notViewing) {
                markSessionUnread(finishedSid);
              }
            }
            if (isBackground && evSid) {
              mutateBackgroundLines(evSid, (prev) => {
                let next = prev;
                if (next.length && next[next.length - 1].kind === "waiting") {
                  next = next.slice(0, -1);
                }
                if (ev.state === "error") {
                  next = [
                    ...next,
                    {
                      id: nextLineId("error"),
                      kind: "error",
                      text: "Turn ended with error",
                    },
                  ];
                } else if (ev.state === "cancelled") {
                  next = [
                    ...next,
                    {
                      id: nextLineId("system"),
                      kind: "system",
                      text: "Turn cancelled",
                    },
                  ];
                }
                // Collapse thinking/tools for background transcript too.
                return collapseTurnProcess(next, 0);
              });
              void refreshSessions();
            } else {
              setPendingPerm(null);
              clearWaiting();
              if (ev.state === "error") {
                push({ kind: "error", text: "Turn ended with error" });
                finishTurnCollapse(true);
              } else if (ev.state === "cancelled") {
                push({ kind: "system", text: "Turn cancelled" });
                finishTurnCollapse(false);
              } else {
                finishTurnCollapse(false);
              }
              void refreshSessions();
            }
            break;
          case "context_usage": {
            if (
              typeof ev.used_tokens !== "number" ||
              !Number.isFinite(ev.used_tokens)
            ) {
              break;
            }
            const usageSid = evSid || activeSid;
            if (!usageSid) break;
            // Empty new task: ignore large engine totals (process residue).
            const chatForCheck =
              usageSid === activeSid
                ? linesRef.current
                : (sessionLinesCacheRef.current.get(usageSid) ?? []);
            if (!hasRealChatContent(chatForCheck) && ev.used_tokens > 200) {
              break;
            }
            sessionContextTokensRef.current.set(usageSid, ev.used_tokens);
            if (usageSid === activeSid) {
              setEngineContextTokens(ev.used_tokens);
            }
            break;
          }
          case "agent_error": {
            const msg = ev.message ?? "Agent error";
            const soft =
              /timed out|still be working|still working/i.test(msg);
            if (isBackground && evSid) {
              bgPush(evSid, soft ? "system" : "error", msg);
              if (!soft) markBusy(evSid, false);
            } else {
              push({ kind: soft ? "system" : "error", text: msg });
              if (!soft) {
                markBusy(activeSid, false);
                clearWaiting();
                finishTurnCollapse(true);
              }
            }
            break;
          }
          default:
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
    finishTurnCollapse,
    setSessionBusyState,
    mutateBackgroundLines,
    hasRealChatContent,
    markSessionUnread,
  ]);

  const selectedProject = useMemo(
    () => projects.find((p) => p.project_id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  /** User project ids — tasks under these nest in Projects; others are temporary. */
  const userProjectIds = useMemo(
    () => new Set(projects.map((p) => p.project_id)),
    [projects],
  );

  const temporarySessions = useMemo(
    () => sessions.filter((s) => !userProjectIds.has(s.project_id)),
    [sessions, userProjectIds],
  );

  const sessionsByProjectId = useMemo(() => {
    const map = new Map<string, SessionListRow[]>();
    for (const s of sessions) {
      if (!userProjectIds.has(s.project_id)) continue;
      const list = map.get(s.project_id);
      if (list) list.push(s);
      else map.set(s.project_id, [s]);
    }
    return map;
  }, [sessions, userProjectIds]);

  /** Expand a project in the sidebar (keeps other projects open). */
  const expandProject = useCallback((projectId: string) => {
    setExpandedProjectIds((prev) => {
      if (prev.has(projectId)) return prev;
      const next = new Set(prev);
      next.add(projectId);
      return next;
    });
  }, []);

  /**
   * Click a project row: toggle its expanded task list (multi-open).
   * Also marks it as the selected project for “new task under…” context.
   */
  const onSelectProject = async (p: ProjectListRow) => {
    setView("workspace");
    const wasExpanded = expandedProjectIds.has(p.project_id);
    if (wasExpanded) {
      // Collapse only this project; leave others expanded.
      setExpandedProjectIds((prev) => {
        const next = new Set(prev);
        next.delete(p.project_id);
        return next;
      });
      // Keep selection if this was selected, or clear if collapsing selected.
      if (selectedProjectId === p.project_id) {
        setSelectedProjectId(null);
      }
      return;
    }
    expandProject(p.project_id);
    setSelectedProjectId(p.project_id);
    setProjectRoot(p.root_path);
    try {
      await invoke<string>("set_project_root", { projectRoot: p.root_path });
    } catch {
      /* ignore path errors; still show tasks */
    }
  };

  /** Remove project from sidebar (+ all its tasks). Source folder is kept. */
  const onDeleteProject = async (p: ProjectListRow, e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (connecting) return;
    const n = p.session_count;
    const ok = window.confirm(
      `Remove project “${p.name}” from Grokx?\n\n` +
        `This removes the project entry and ${n} task${n === 1 ? "" : "s"} ` +
        `(chat history under ~/.grokx/tasks/).\n\n` +
        `Your source folder is NOT deleted:\n${p.root_path}`,
    );
    if (!ok) return;

    const wasSelected = selectedProjectId === p.project_id;
    const activeBelongs =
      Boolean(session?.session_id) &&
      sessions.some(
        (s) =>
          s.session_id === session?.session_id && s.project_id === p.project_id,
      );

    if (activeBelongs) {
      await flushPersistHistory();
      historyEpochRef.current += 1;
    }

    try {
      await invoke("delete_project", { projectId: p.project_id });
      setProjects((prev) => prev.filter((row) => row.project_id !== p.project_id));
      // Drop task rows that belonged to this project.
      setSessions((prev) => {
        const kept = prev.filter((row) => row.project_id !== p.project_id);
        for (const gone of prev) {
          if (gone.project_id === p.project_id) {
            autoTitledSessionRef.current.delete(gone.session_id);
            sessionScrollRef.current.delete(gone.session_id);
            sessionContextTokensRef.current.delete(gone.session_id);
            sessionLinesCacheRef.current.delete(gone.session_id);
            sessionBusyMapRef.current.delete(gone.session_id);
            sessionUnreadMapRef.current.delete(gone.session_id);
          }
        }
        return kept;
      });
      setSessionUnreadMap((prev) => {
        let changed = false;
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          // Drop unread for deleted project tasks (already removed from ref).
          if (!sessionUnreadMapRef.current.has(id)) {
            delete next[id];
            changed = true;
          }
        }
        return changed ? next : prev;
      });

      if (wasSelected) {
        setSelectedProjectId(null);
      }
      setExpandedProjectIds((prev) => {
        if (!prev.has(p.project_id)) return prev;
        const next = new Set(prev);
        next.delete(p.project_id);
        return next;
      });
      if (activeBelongs) {
        setSession(null);
        sessionIdRef.current = null;
        workPathRef.current = null;
        setLines([]);
        linesRef.current = [];
        setPendingPerm(null);
        setAttachments([]);
        clearComposer();
        setBusy(false);
        setEngineContextTokens(null);
        setAgentStatus("disconnected");
      }
      await refreshSessions();
      void refreshProjects();
    } catch (err) {
      setError(String(err));
    }
  };

  /**
   * Force reconnect on the current task (or create one if none).
   * Rarely needed: New task / switching Tasks already connect. Kept for
   * recovery when the agent drops while you stay on the same task.
   */
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
        { forceReconnect: true },
      );
      return;
    }
    await onNewSession();
  };

  /** Sidebar top "New task" → always a temporary (Tasks) session. */
  const onNewTask = async () => {
    setPendingPerm(null);
    setView("workspace");
    await onNewStandaloneTask();
  };

  /**
   * Pick a folder as project (fixed path) via native dialog, then create
   * the first temporary task under ~/.grokx/tasks/<id>.
   */
  const onOpenProject = async () => {
    // Allow while another task is busy — multi-agent keeps it running.
    if (connecting) return;
    setView("workspace");
    setError(null);
    try {
      const picked = await invoke<string | null>("pick_project_dir");
      if (!picked) return;
      const leavingId = sessionIdRef.current;
      saveSessionScroll(leavingId);
      if (leavingId) {
        sessionLinesCacheRef.current.set(leavingId, linesRef.current);
      }
      await flushPersistHistory();
      setLines([]);
      linesRef.current = [];
      setPendingPerm(null);
      setAttachments([]);
      clearComposer();
      setBusy(false);
      setConnecting(true);
      autoScrollEnabledRef.current = true;
      userScrollIntentRef.current = false;
      const root = picked;
      setProjectRoot(root);
      await invoke<string>("set_project_root", { projectRoot: root });
      const info = await invoke<SessionInfo>("connect_workspace", {
        projectRoot: root,
        autoApprove: permissionMode === "always-approve",
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
   * Create a new task.
   * - `underProject`: attach to that user project (nested under Projects).
   * - otherwise: temporary task under default sandbox (Tasks section only).
   * Task cwd is always ~/.grokx/tasks/<id>.
   */
  const onNewSession = async (opts?: {
    underProject?: ProjectListRow | null;
  }) => {
    // Allow while another task is busy — prior agent keeps working in parallel.
    if (connecting) return;
    setView("workspace");
    // Remember where we were reading so returning to this task restores it.
    const leavingId = sessionIdRef.current;
    saveSessionScroll(leavingId);
    if (leavingId) {
      sessionLinesCacheRef.current.set(leavingId, linesRef.current);
    }
    // Save current task transcript before leaving.
    await flushPersistHistory();
    historyEpochRef.current += 1;
    setLines([]);
    linesRef.current = [];
    setPendingPerm(null);
    setAttachments([]);
    clearComposer();
    setEditingUserId(null);
    setEditDraft("");
    setError(null);
    setBusy(false);
    // New task = new context window; drop previous engine total immediately.
    setEngineContextTokens(null);
    turnStartedAtRef.current = null;
    setConnecting(true);
    // Fresh task starts at bottom with auto-follow on.
    autoScrollEnabledRef.current = true;
    userScrollIntentRef.current = false;
    stickyUserIdRef.current = null;
    setStickyUserId(null);

    const userProject =
      opts?.underProject === undefined
        ? selectedProject
        : opts.underProject;
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
        autoApprove: permissionMode === "always-approve",
      });
      setSession(info);
      sessionIdRef.current = info.session_id;
      // Ensure this id has no inherited engine total.
      sessionContextTokensRef.current.delete(info.session_id);
      setEngineContextTokens(null);
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

  /** New temporary task only (Tasks section +). */
  const onNewStandaloneTask = async () => {
    setSelectedProjectId(null);
    // Do not collapse expanded projects when creating a temporary task.
    await onNewSession({ underProject: null });
  };

  /** New task nested under a user project. */
  const onNewProjectTask = async (p: ProjectListRow, e?: React.MouseEvent) => {
    e?.stopPropagation();
    expandProject(p.project_id);
    setSelectedProjectId(p.project_id);
    setProjectRoot(p.root_path);
    await onNewSession({ underProject: p });
  };

  /** Activate an existing task (click) — restore history, never creates a new row.
   *  Other tasks keep running in the background (multi-agent). */
  const onActivateSession = async (
    s: SessionListRow,
    opts?: { forceReconnect?: boolean },
  ) => {
    if (renamingId === s.session_id || connecting) return;
    setView("workspace");

    // Open parent project (keep other projects expanded). Temporary tasks
    // only clear selection — they do not collapse open projects.
    const visibleProject = projects.find((p) => p.project_id === s.project_id);
    if (visibleProject) {
      expandProject(visibleProject.project_id);
      setSelectedProjectId(visibleProject.project_id);
    } else {
      setSelectedProjectId(null);
    }

    // Already the active task and agent is healthy — no engine restart.
    // If disconnected (or force), fall through and reconnect the same task.
    const agentReady = agentStatus.toLowerCase().includes("ready");
    if (
      session?.session_id === s.session_id &&
      !opts?.forceReconnect &&
      agentReady
    ) {
      return;
    }

    // Persist + cache the task we're leaving so background work continues cleanly.
    const leavingId = sessionIdRef.current;
    const leavingWork = workPathRef.current;
    const leavingLines = linesRef.current;
    // Capture scroll before DOM is replaced by the other task's transcript.
    saveSessionScroll(leavingId);
    if (historySaveTimer.current) {
      clearTimeout(historySaveTimer.current);
      historySaveTimer.current = null;
    }
    if (leavingId) {
      // Keep live transcript in memory while agent keeps working off-screen.
      sessionLinesCacheRef.current.set(leavingId, leavingLines);
      if (hasRealChatContent(leavingLines)) {
        await persistChatHistory(leavingId, leavingLines, leavingWork);
      }
    }

    // Invalidate any pending saves from the previous task.
    historyEpochRef.current += 1;
    const epoch = historyEpochRef.current;

    setConnecting(true);
    setError(null);
    setPendingPerm(null);
    setAttachments([]);
    clearComposer();
    setEditingUserId(null);
    setEditDraft("");
    // Restore busy for the task we're entering (may still be streaming).
    const enteringBusy = sessionBusyMapRef.current.get(s.session_id) ?? false;
    busyRef.current = enteringBusy;
    setBusy(enteringBusy);
    turnStartedAtRef.current = enteringBusy ? Date.now() : null;
    stickyUserIdRef.current = null;
    setStickyUserId(null);

    // Optimistically highlight the clicked row immediately.
    setSession({
      session_id: s.session_id,
      project_root: s.project_root,
      work_path: s.work_path,
      status: "Starting",
    });
    sessionIdRef.current = s.session_id;
    // Opening this task clears its unread indicator.
    clearSessionUnread(s.session_id);
    // Restore this task's last engine total (if any); otherwise estimate from chat.
    setEngineContextTokens(
      sessionContextTokensRef.current.get(s.session_id) ?? null,
    );
    workPathRef.current = s.work_path || null;
    if (s.project_root) setProjectRoot(s.project_root);

    // Prefer in-memory cache (includes live stream while we were away).
    // Clear previous task's lines immediately so background→active events
    // for the new task don't append onto the old transcript during await.
    const cached = sessionLinesCacheRef.current.get(s.session_id);
    if (cached && cached.length > 0) {
      setLines(cached);
      linesRef.current = cached;
    } else {
      setLines([]);
      linesRef.current = [];
    }

    // Entire activate path must clear `connecting` — early returns used to
    // leave Connecting stuck forever and block further task switches.
    try {
      let history =
        cached && cached.length > 0
          ? cached
          : await loadChatHistory(s.session_id, s.work_path);
      if (historyEpochRef.current !== epoch) return;
      // Apply scroll policy *before* setLines so the lines-effect auto-follow
      // does not race and yank the viewport to the bottom.
      const savedScroll = sessionScrollRef.current.get(s.session_id);
      if (!savedScroll || savedScroll.pinBottom) {
        autoScrollEnabledRef.current = true;
        userScrollIntentRef.current = false;
      } else {
        autoScrollEnabledRef.current = false;
        userScrollIntentRef.current = true;
      }
      setLines(history);
      linesRef.current = history;
      // Resume at the leave position (or bottom if first visit / was pinned).
      restoreSessionScroll(s.session_id);

      if (s.project_root) {
        try {
          await invoke<string>("set_project_root", {
            projectRoot: s.project_root,
          });
        } catch {
          /* path may still work via reconnect metadata */
        }
      }
      // reconnect_session focuses an already-live agent or spawns one —
      // does not kill other parallel agents.
      const info = await invoke<SessionInfo>("reconnect_session", {
        sessionId: s.session_id,
        autoApprove: permissionMode === "always-approve",
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

      // Prefer freshest in-memory cache (background events may have updated it).
      const cached2 = sessionLinesCacheRef.current.get(s.session_id);
      if (cached2 && cached2.length > 0) {
        const prev = linesRef.current;
        const historyChanged =
          cached2.length !== prev.length ||
          cached2.some(
            (l, i) => l.id !== prev[i]?.id || l.kind !== prev[i]?.kind,
          );
        if (historyChanged) {
          setLines(cached2);
          linesRef.current = cached2;
          restoreSessionScroll(s.session_id);
        }
      } else {
        // Re-load history after reconnect in case first load raced.
        const history2 = await loadChatHistory(
          s.session_id,
          info.work_path ?? s.work_path,
        );
        if (historyEpochRef.current !== epoch) return;
        if (history2.length > 0) {
          const prev = linesRef.current;
          const historyChanged =
            history2.length !== prev.length ||
            history2.some(
              (l, i) => l.id !== prev[i]?.id || l.kind !== prev[i]?.kind,
            );
          if (historyChanged) {
            setLines(history2);
            linesRef.current = history2;
            restoreSessionScroll(s.session_id);
          }
        }
      }

      // Sync busy from backend in case we missed events while away.
      try {
        const stillBusy = await invoke<boolean>("is_session_busy", {
          sessionId: s.session_id,
        });
        if (historyEpochRef.current === epoch) {
          setSessionBusyState(s.session_id, stillBusy);
        }
      } catch {
        /* keep map value */
      }

      // Keep list order stable: only refresh session metadata/titles.
      await refreshSessions();
      await refreshModels();
    } catch (e) {
      setError(String(e));
      // Keep restored history visible even if reconnect fails.
      setAgentStatus("failed");
    } finally {
      // Always release the connecting lock for this activation attempt.
      // A superseded epoch means a newer activate owns the UI; still clear
      // if we are the latest so we never stick on Connecting forever.
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
    if (connecting) return;
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
      sessionScrollRef.current.delete(s.session_id);
      sessionContextTokensRef.current.delete(s.session_id);
      sessionLinesCacheRef.current.delete(s.session_id);
      sessionBusyMapRef.current.delete(s.session_id);
      setSessionBusyMap((prev) => {
        if (!(s.session_id in prev)) return prev;
        const next = { ...prev };
        delete next[s.session_id];
        return next;
      });
      clearSessionUnread(s.session_id);

      if (wasActive) {
        setSession(null);
        sessionIdRef.current = null;
        workPathRef.current = null;
        setLines([]);
        linesRef.current = [];
        setPendingPerm(null);
        setAttachments([]);
        clearComposer();
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
          const displayName = attachmentDisplayName({
            name: f.name,
            path: f.path,
          });
          next.push({
            path: f.path,
            name: displayName,
            mime: f.mime ?? null,
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

  const cancelEditUser = useCallback(() => {
    setEditingUserId(null);
    setEditDraft("");
  }, []);

  const beginEditUser = useCallback(
    (line: Extract<ChatLine, { kind: "user" }>) => {
      if (busy || connecting) return;
      setEditingUserId(line.id);
      setEditDraft(line.text ?? "");
      // Focus after paint so the textarea exists.
      requestAnimationFrame(() => {
        const el = editTextareaRef.current;
        if (!el) return;
        el.focus();
        el.style.height = "auto";
        el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        // Place caret at end.
        const len = el.value.length;
        el.setSelectionRange(len, len);
      });
    },
    [busy, connecting],
  );

  /**
   * Re-send from an edited user bubble: keep history up to that message,
   * replace its text, drop everything after, and start a new turn.
   */
  const onResendEditedUser = async () => {
    if (!editingUserId || busy || connecting) return;
    const text = editDraft.trim();
    const idx = linesRef.current.findIndex(
      (l) => l.kind === "user" && l.id === editingUserId,
    );
    if (idx < 0) {
      cancelEditUser();
      return;
    }
    const original = linesRef.current[idx];
    if (original.kind !== "user") {
      cancelEditUser();
      return;
    }
    const keepAtts = original.attachments ?? [];
    if (!text && keepAtts.length === 0) return;

    // Truncate transcript: keep messages before this user bubble, then the
    // edited user message (attachments preserved; text updated).
    const kept = linesRef.current.slice(0, idx);
    const updatedUser: ChatLine = {
      ...original,
      text: text || original.text,
      at: new Date().toISOString(),
    };
    const next: ChatLine[] = [
      ...kept,
      updatedUser,
      {
        id: nextLineId("waiting"),
        kind: "waiting",
        text: "Grokx is thinking…",
      },
    ];
    setLines(next);
    linesRef.current = next;
    if (sessionIdRef.current) {
      sessionLinesCacheRef.current.set(sessionIdRef.current, next);
    }
    setEditingUserId(null);
    setEditDraft("");
    // Persist truncated + edited history immediately (don't wait for debounce).
    if (sessionIdRef.current) {
      void persistChatHistory(
        sessionIdRef.current,
        next,
        workPathRef.current,
      );
    }

    turnStartedAtRef.current = Date.now();
    verbalNudgeUsedRef.current = false;
    const sid = sessionIdRef.current;
    if (sid) setSessionBusyState(sid, true);
    else setBusy(true);
    enableAutoScroll();

    // Prompt text: edited text, or empty if image-only (engine gets attachments).
    const promptText = text;
    const attPayload = keepAtts.map((a) => ({
      path: a.path,
      name: a.name,
      mime: a.mime ?? null,
      size: a.size ?? null,
    }));

    try {
      await invoke("send_prompt_rich", {
        payload: {
          text: promptText,
          attachments: attPayload,
          model: modelId || null,
          effort: effortId || null,
        },
      });
    } catch (e) {
      if (sid) setSessionBusyState(sid, false);
      else setBusy(false);
      clearWaiting();
      push({ kind: "error", text: String(e) });
      finishTurnCollapse(true);
    }
  };

  const onSend = async () => {
    // If editing a past message, that flow owns send.
    if (editingUserId) {
      await onResendEditedUser();
      return;
    }
    const text = (composerRef.current?.getValue() ?? "").trim();
    if ((!text && attachments.length === 0) || busy) return;
    const pendingAttachments = attachments;
    clearComposer();
    setAttachments([]);
    turnStartedAtRef.current = Date.now();
    // Fresh user turn: allow one auto-nudge again if the model only talks.
    verbalNudgeUsedRef.current = false;
    const sid = sessionIdRef.current;
    // New prompt clears Stop guard so this turn can show Working.
    if (sid) userStoppedSessionRef.current = null;
    if (sid) setSessionBusyState(sid, true);
    else setBusy(true);
    // New user turn: resume gentle auto-follow from the bottom.
    enableAutoScroll();
    const chatAtts: ChatAttachment[] = pendingAttachments.map((a) => {
      const name = attachmentDisplayName(a);
      let previewSrc: string | null = a.previewUrl ?? null;
      if (!previewSrc && a.path && isImageAttachment({ name, mime: a.mime })) {
        try {
          previewSrc = convertFileSrc(a.path);
        } catch {
          previewSrc = null;
        }
      }
      return {
        path: a.path,
        name,
        mime: a.mime ?? null,
        size: a.size ?? null,
        previewSrc,
      };
    });
    // User bubble always keeps original attachment names (Word/docx etc.).
    // Text is the typed prompt; files render as chips under the bubble.
    const display = text;
    push({
      kind: "user",
      text: display,
      at: new Date().toISOString(),
      attachments: chatAtts.length ? chatAtts : undefined,
    });
    // Immediate left-side feedback so the UI doesn't look frozen.
    push({ kind: "waiting", text: "Grokx is thinking…" });
    try {
      await invoke("send_prompt_rich", {
        payload: {
          text,
          attachments: pendingAttachments.map((a) => ({
            path: a.path,
            name: attachmentDisplayName(a),
            mime: a.mime ?? null,
            size: a.size ?? null,
          })),
          model: modelId || null,
          effort: effortId || null,
        },
      });
    } catch (e) {
      if (sid) setSessionBusyState(sid, false);
      else setBusy(false);
      clearWaiting();
      push({ kind: "error", text: String(e) });
      finishTurnCollapse(true);
    }
  };

  /**
   * Stop button: end the active task's in-flight work immediately.
   * - UI leaves Working right away
   * - Backend sends session/cancel and unblocks the prompt RPC
   * - Auto-nudge is suppressed so we do not restart after stop
   */
  const onCancel = async () => {
    const sid = sessionIdRef.current;
    // Suppress verbal auto-continue after a user stop.
    verbalNudgeUsedRef.current = true;
    autoNudgeInFlightRef.current = false;
    if (sid) userStoppedSessionRef.current = sid;

    // Optimistic UI: stop spinner / dock badge before RPC returns.
    if (sid) setSessionBusyState(sid, false);
    else setBusy(false);
    setPendingPerm(null);
    clearWaiting();

    try {
      await invoke("cancel_turn");
    } catch (e) {
      // Still settle the turn in the transcript.
      push({
        kind: "system",
        text: `Stop requested · ${String(e)}`,
      });
    } finally {
      // Collapse thinking/tools and show cancelled end state.
      finishTurnCollapse(false);
      // Ensure a cancelled system line is visible if bridge event was missed.
      setLines((prev) => {
        const lastUser = (() => {
          for (let i = prev.length - 1; i >= 0; i--) {
            if (prev[i].kind === "user") return i;
          }
          return -1;
        })();
        const tail = lastUser >= 0 ? prev.slice(lastUser + 1) : prev;
        const hasCancelNote = tail.some(
          (l) =>
            (l.kind === "system" || l.kind === "error") &&
            /cancel|stop|stopped|中止|停止/i.test(l.text),
        );
        if (hasCancelNote) return prev;
        const next: ChatLine[] = [
          ...prev,
          {
            id: nextLineId("system"),
            kind: "system",
            text: "Turn stopped",
          },
        ];
        linesRef.current = next;
        return next;
      });
      if (sid) setSessionBusyState(sid, false);
      else setBusy(false);
      void flushPersistHistory();
    }
  };

  /** Windowed chat rows: same ChatLine plus height estimate for virtualization. */
  const virtualChatItems = useMemo(
    () =>
      lines.map((line) => ({
        ...line,
        estimateHeight: estimateChatLineHeight(line),
      })),
    [lines],
  );

  /** Drag the vertical split between sidebar ↔ chat or chat ↔ Outputs. */
  const onPanelResizeStart = useCallback(
    (kind: "sidebar" | "right", e: ReactMouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      panelDragRef.current = {
        kind,
        startX: e.clientX,
        startW: kind === "sidebar" ? sidebarWidth : rightWidth,
      };
      document.body.classList.add("resizing-panels");
    },
    [sidebarWidth, rightWidth],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = panelDragRef.current;
      if (!drag) return;
      if (drag.kind === "sidebar") {
        const next = clampWidth(
          drag.startW + (e.clientX - drag.startX),
          SIDEBAR_W_MIN,
          SIDEBAR_W_MAX,
        );
        setSidebarWidth(next);
      } else {
        // Right edge: drag handle is on the left of the rail; move left → wider.
        const next = clampWidth(
          drag.startW - (e.clientX - drag.startX),
          RIGHT_W_MIN,
          RIGHT_W_MAX,
        );
        setRightWidth(next);
      }
    };
    const onUp = () => {
      if (!panelDragRef.current) return;
      const kind = panelDragRef.current.kind;
      panelDragRef.current = null;
      document.body.classList.remove("resizing-panels");
      if (kind === "sidebar") {
        writeStoredWidth("grokx.sidebarWidth", sidebarWidthRef.current);
      } else {
        writeStoredWidth("grokx.rightWidth", rightWidthRef.current);
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.classList.remove("resizing-panels");
    };
  }, []);

  /** Absolute root for the Files tab (task cwd or project folder). */
  const filesRootPath = useMemo(() => {
    if (!session) return null;
    if (filesRootKind === "project") {
      return session.project_root || session.work_path || null;
    }
    return session.work_path || session.project_root || null;
  }, [session, filesRootKind]);

  /** Bases for resolving relative markdown images / media. */
  const chatMediaBases = useMemo(
    () => [session?.work_path, session?.project_root, projectRoot],
    [session?.work_path, session?.project_root, projectRoot],
  );

  const refreshGitStatus = useCallback(async () => {
    const root =
      session?.project_root || session?.work_path || projectRoot || null;
    if (!root) {
      setGitInfo(null);
      setGitError(null);
      return;
    }
    setGitLoading(true);
    setGitError(null);
    try {
      const info = await invoke<GitStatusInfo>("git_status", { path: root });
      setGitInfo(info);
    } catch (e) {
      setGitInfo(null);
      setGitError(String(e));
    } finally {
      setGitLoading(false);
    }
  }, [session?.project_root, session?.work_path, projectRoot]);

  // Load git summary when overview is visible / session changes.
  useEffect(() => {
    if (view !== "workspace" || !outputsOpen) return;
    if (outputsTab !== "overview") return;
    void refreshGitStatus();
  }, [
    view,
    outputsOpen,
    outputsTab,
    session?.session_id,
    session?.project_root,
    session?.work_path,
    refreshGitStatus,
  ]);

  // Soft-refresh git after a turn finishes (agent may have committed).
  useEffect(() => {
    if (busy) return;
    if (view !== "workspace" || outputsTab !== "overview") return;
    if (!session) return;
    const t = window.setTimeout(() => {
      void refreshGitStatus();
    }, 600);
    return () => window.clearTimeout(t);
  }, [busy, view, outputsTab, session?.session_id, refreshGitStatus]);

  const loadFilesDir = useCallback(
    async (path: string) => {
      setFilesLoading(true);
      setFilesError(null);
      try {
        const rows = await invoke<DirEntry[]>("list_directory", {
          path,
          maxEntries: 200,
        });
        setFilesBrowsePath(path);
        setFilesEntries(rows);
      } catch (e) {
        setFilesError(String(e));
        setFilesEntries([]);
      } finally {
        setFilesLoading(false);
      }
    },
    [],
  );

  const refreshFilesTab = useCallback(() => {
    const root = filesRootPath;
    if (!root) {
      setFilesEntries([]);
      setFilesBrowsePath(null);
      setFilesError(null);
      return;
    }
    // Stay under the current root when refreshing mid-browse.
    const target =
      filesBrowsePath &&
      (filesBrowsePath === root ||
        filesBrowsePath.startsWith(root + "/") ||
        filesBrowsePath.startsWith(root + "\\"))
        ? filesBrowsePath
        : root;
    void loadFilesDir(target);
  }, [filesRootPath, filesBrowsePath, loadFilesDir]);

  // Load / refresh Files when tab opens or session / root kind changes.
  useEffect(() => {
    if (outputsTab !== "files") return;
    if (!filesRootPath) {
      setFilesEntries([]);
      setFilesBrowsePath(null);
      setFilesError(session ? null : "Open a task to browse files");
      return;
    }
    // Reset browse path when root kind / session root changes.
    void loadFilesDir(filesRootPath);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-root on session/root change
  }, [outputsTab, filesRootPath, session?.session_id]);

  // After a turn finishes, refresh file list if Files tab is open.
  useEffect(() => {
    if (outputsTab !== "files" || busy || !filesBrowsePath) return;
    // Soft refresh when leaving busy (agent may have written files).
    const t = window.setTimeout(() => {
      void loadFilesDir(filesBrowsePath);
    }, 400);
    return () => window.clearTimeout(t);
  }, [busy, outputsTab, filesBrowsePath, loadFilesDir]);

  const onOpenFilesPath = useCallback(async (path: string) => {
    try {
      await invoke("open_path", { path });
    } catch (e) {
      setFilesError(String(e));
    }
  }, []);

  const onFilesEntryClick = useCallback(
    (ent: DirEntry) => {
      if (ent.is_dir) {
        void loadFilesDir(ent.path);
      } else {
        void onOpenFilesPath(ent.path);
      }
    },
    [loadFilesDir, onOpenFilesPath],
  );

  const filesCanGoUp = useMemo(() => {
    if (!filesBrowsePath || !filesRootPath) return false;
    const parent = parentDir(filesBrowsePath);
    if (!parent) return false;
    // Stay inside the selected root.
    return (
      parent === filesRootPath ||
      parent.startsWith(filesRootPath + "/") ||
      parent.startsWith(filesRootPath + "\\")
    );
  }, [filesBrowsePath, filesRootPath]);

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
      // After allow, tools continue — keep Working until turn_finished.
      if (decision !== "deny") {
        setBusy(true);
      }
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

  const layoutStyle = {
    ["--sidebar-w" as string]: `${sidebarWidth}px`,
    ["--right-w" as string]: `${rightWidth}px`,
  } as CSSProperties;

  return (
    <div
      className={`layout${outputsOpen ? "" : " layout-outputs-collapsed"}${
        view === "settings" ? " layout-settings" : ""
      }`}
      style={layoutStyle}
    >
      <aside className="sidebar">
        {/* Full sidebar chrome under traffic lights — drag to move the window. */}
        <div
          className="sidebar-titlebar"
          onMouseDown={onTitlebarMouseDown}
        >
          <div className="brand-row">
            <button
              type="button"
              className="brand brand-btn"
              title="Back to workspace"
              onClick={() => setView("workspace")}
            >
              Grokx
            </button>
          </div>
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
        </nav>

        {/*
          Projects = fixed folders; tasks nest under the selected project.
          Tasks = temporary sessions (default sandbox) only.
        */}
        <div className="section-label-row">
          <span className="section-label">Projects</span>
          <button
            type="button"
            className="session-add-btn"
            title="Open project folder (fixed path)"
            disabled={connecting}
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
          {projects.map((p) => {
            const isExpanded = expandedProjectIds.has(p.project_id);
            const isSelected = p.project_id === selectedProjectId;
            const nested = sessionsByProjectId.get(p.project_id) ?? [];
            // When project is collapsed, still surface child task activity.
            let nestedWorking = 0;
            let nestedUnread = 0;
            for (const s of nested) {
              const childActive = s.session_id === session?.session_id;
              if (
                sessionBusyMap[s.session_id] ||
                (childActive && busy)
              ) {
                nestedWorking += 1;
              }
              if (sessionUnreadMap[s.session_id] && !childActive) {
                nestedUnread += 1;
              }
            }
            const projectWorking = nestedWorking > 0;
            const projectUnread = nestedUnread > 0;
            // Show unread on the project row only while collapsed.
            const showProjectUnread = projectUnread && !isExpanded;
            return (
              <div key={p.project_id} className="project-block">
                <div
                  className={`project-row${isSelected ? " active" : ""}${
                    isExpanded ? " expanded" : ""
                  }${projectWorking ? " working" : ""}${
                    showProjectUnread ? " unread" : ""
                  }`}
                  onClick={() => void onSelectProject(p)}
                  title={
                    projectWorking
                      ? `Working · ${nestedWorking} task${
                          nestedWorking === 1 ? "" : "s"
                        }\n${p.root_path}`
                      : showProjectUnread
                        ? `Unread · ${nestedUnread} task${
                            nestedUnread === 1 ? "" : "s"
                          }\n${p.root_path}`
                        : isExpanded
                          ? `Expanded · click to collapse\n${p.root_path}`
                          : `Project (fixed path)\n${p.root_path}\nClick to expand nested tasks`
                  }
                >
                  <div className="project-row-main">
                    {projectWorking ? (
                      <span
                        className="session-working-spin project-working-spin"
                        title={
                          nestedWorking === 1
                            ? "1 task working"
                            : `${nestedWorking} tasks working`
                        }
                        aria-label={
                          nestedWorking === 1
                            ? "1 task working"
                            : `${nestedWorking} tasks working`
                        }
                      />
                    ) : (
                      <span className="project-icon" aria-hidden>
                        <IconFolder size={15} />
                      </span>
                    )}
                    <div className="project-title">
                      {p.name}
                      {showProjectUnread && (
                        <span
                          className="session-unread-dot"
                          title={
                            nestedUnread === 1
                              ? "1 unread task"
                              : `${nestedUnread} unread tasks`
                          }
                          aria-label="Unread activity in project"
                        />
                      )}
                    </div>
                    <span
                      className={`project-count${
                        projectWorking ? " project-count-working" : ""
                      }`}
                      title={
                        projectWorking
                          ? `${nestedWorking} working · ${nested.length} total`
                          : undefined
                      }
                    >
                      {projectWorking
                        ? `${nestedWorking}/${nested.length}`
                        : nested.length}
                    </span>
                    <button
                      type="button"
                      className="session-action-btn project-add-task-btn"
                      title="New task under this project"
                      disabled={connecting}
                      onClick={(e) => void onNewProjectTask(p, e)}
                    >
                      <IconPlus size={12} />
                    </button>
                    <button
                      type="button"
                      className="session-action-btn session-delete-btn project-delete-btn"
                      title="Remove project from Grokx (keeps source folder)"
                      onClick={(e) => void onDeleteProject(p, e)}
                    >
                      <IconTrash size={12} />
                    </button>
                  </div>
                </div>
                {isExpanded && (
                  <div className="project-tasks">
                    {nested.length === 0 && (
                      <div className="session-empty session-empty-nested">
                        No tasks · + under project
                      </div>
                    )}
                    {nested.map((s) => {
                      const isActive = s.session_id === session?.session_id;
                      const isWorking = Boolean(
                        sessionBusyMap[s.session_id] ||
                          (isActive && busy),
                      );
                      const isUnread = Boolean(
                        sessionUnreadMap[s.session_id] && !isActive,
                      );
                      return (
                        <div
                          key={s.session_id}
                          className={`session-row nested task-row${
                            isActive ? " active" : ""
                          }${isWorking ? " working" : ""}${
                            isUnread ? " unread" : ""
                          }`}
                          onClick={() => void onActivateSession(s)}
                          onDoubleClick={(e) => startRename(s, e)}
                          title={
                            isWorking
                              ? `Working…\n${s.work_path || "~/.grokx/tasks/…"}`
                              : isUnread
                                ? `Unread activity\nTask under ${p.name}\n${s.work_path || "~/.grokx/tasks/…"}`
                                : `Task under ${p.name}\n${s.work_path || "~/.grokx/tasks/…"}`
                          }
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
                                {isWorking ? (
                                  <span
                                    className="session-working-spin"
                                    title="Working"
                                    aria-label="Working"
                                  />
                                ) : (
                                  <span className="task-icon" aria-hidden>
                                    <IconTask size={13} />
                                  </span>
                                )}
                                <div className="session-title">
                                  {s.title || s.session_id.slice(0, 8)}
                                  {isUnread && (
                                    <span
                                      className="session-unread-dot"
                                      title="Unread"
                                      aria-label="Unread activity"
                                    />
                                  )}
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
                            </>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Temporary tasks only (not bound to a user Project) */}
        <div className="section-label-row">
          <span className="section-label">Tasks</span>
          <button
            type="button"
            className="session-add-btn"
            title="New temporary task (not under a Project)"
            disabled={connecting}
            onClick={() => void onNewStandaloneTask()}
          >
            <IconPlus size={16} />
          </button>
        </div>
        <div className="session-list">
          {temporarySessions.length === 0 && (
            <div className="session-empty">
              No temporary tasks · + to start
            </div>
          )}
          {temporarySessions.map((s) => {
            const isActive = s.session_id === session?.session_id;
            const isWorking = Boolean(
              sessionBusyMap[s.session_id] || (isActive && busy),
            );
            const isUnread = Boolean(
              sessionUnreadMap[s.session_id] && !isActive,
            );
            return (
              <div
                key={s.session_id}
                className={`session-row task-row${isActive ? " active" : ""}${
                  isWorking ? " working" : ""
                }${isUnread ? " unread" : ""}`}
                onClick={() => void onActivateSession(s)}
                onDoubleClick={(e) => startRename(s, e)}
                title={
                  isWorking
                    ? `Working…\nTemporary task\n${s.work_path || "~/.grokx/tasks/…"}`
                    : isUnread
                      ? `Unread activity\nTemporary task\n${s.work_path || "~/.grokx/tasks/…"}`
                      : `Temporary task\n${s.work_path || "~/.grokx/tasks/…"}\nClick to switch · double-click or ✎ to rename`
                }
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
                      {isWorking ? (
                        <span
                          className="session-working-spin"
                          title="Working"
                          aria-label="Working"
                        />
                      ) : (
                        <span className="task-icon" aria-hidden>
                          <IconTask size={13} />
                        </span>
                      )}
                      <div className="session-title">
                        {s.title || s.session_id.slice(0, 8)}
                        {isUnread && (
                          <span
                            className="session-unread-dot"
                            title="Unread"
                            aria-label="Unread activity"
                          />
                        )}
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
                  </>
                )}
              </div>
            );
          })}
        </div>

        <div className="sidebar-bottom">
          <button
            type="button"
            className={`nav-item sidebar-settings-btn${
              view === "settings" ? " active" : ""
            }`}
            title="Settings · model, API key, engine"
            onClick={() => {
              setView("settings");
              void loadSettings();
            }}
          >
            <span className="nav-glyph">
              <IconSettings size={16} />
            </span>
            Settings
          </button>
          <div className="sidebar-meta">
            <span className="sidebar-version">v{appVersion}</span>
            <button
              type="button"
              className="sidebar-github-btn"
              title="Open source on GitHub"
              aria-label="Open Grokx on GitHub"
              onClick={() => {
                void openUrl(GROKX_GITHUB_URL).catch((err) => {
                  console.error("Failed to open GitHub:", err);
                });
              }}
            >
              <IconGithub size={14} />
            </button>
          </div>
        </div>
      </aside>

      <div
        className="panel-resizer panel-resizer-sidebar"
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize sidebar"
        title="Drag to resize sidebar"
        onMouseDown={(e) => onPanelResizeStart("sidebar", e)}
      />

      {view === "settings" ? (
        <main className="main settings-main">
          <header className="topbar settings-topbar" onMouseDown={onTitlebarMouseDown}>
            <div className="topbar-main">
              <h1 className="topbar-title">Settings</h1>
              <p className="topbar-sub">
                System · model and engine (set once)
              </p>
            </div>
            <div className="topbar-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setView("workspace")}
              >
                Back to workspace
              </button>
            </div>
          </header>

          <div className="settings-page">
            <div className="settings-grid">
              <section className="card settings-card">
                <h3>Model</h3>
                <p className="muted" style={{ marginBottom: 12 }}>
                  Configure API endpoint, key, and default model. Daily chat does
                  not need this page; after save
                  {cfgSyncGrok ? " it syncs to the engine config," : ""} reconnect
                  to apply.
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
                      value={
                        efforts.some((e) => e.id === cfgEffort)
                          ? cfgEffort
                          : "medium"
                      }
                      onChange={(e) => setCfgEffort(e.target.value)}
                      title="Reasoning effort for Grok (Low · Medium · High · Extra high)"
                    >
                      {(efforts.length
                        ? efforts
                        : [
                            { id: "low", label: "Low" },
                            { id: "medium", label: "Medium" },
                            { id: "high", label: "High" },
                            { id: "xhigh", label: "Extra high" },
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
                    onClick={() => void onNewTask()}
                    disabled={connecting}
                  >
                    {connecting ? "Connecting…" : "New task"}
                  </button>
                </div>
                <div className="field">
                  <label>Tool permission (next connect)</label>
                  <select
                    className="settings-select"
                    value={permissionMode}
                    onChange={(e) =>
                      void setPermissionModeAndSave(
                        normalizePermissionMode(e.target.value),
                      )
                    }
                  >
                    <option value="ask">Needs approval — confirm each tool</option>
                    <option value="auto">
                      Auto — engine classifier (fewer prompts)
                    </option>
                    <option value="always-approve">
                      Full trust — always approve all tools
                    </option>
                  </select>
                </div>
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
            <header className="topbar" onMouseDown={onTitlebarMouseDown}>
              <div className="topbar-main">
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
              <div className="topbar-actions">
                {/* Status is non-interactive — whole top strip moves the window. */}
                <button
                  type="button"
                  className={`status-pill${connected || busy ? "" : " status-pill-action"}`}
                  title={
                    connected || busy
                      ? busy
                        ? "Agent is working"
                        : "Agent ready"
                      : "Click to reconnect agent"
                  }
                  onClick={() => {
                    if (!connected && !busy && !connecting) {
                      void onConnect();
                    }
                  }}
                  disabled={connecting || busy || connected}
                >
                  <span className={`status-dot ${statusClass}`} />
                  {connecting
                    ? "Connecting…"
                    : busy
                      ? "Working"
                      : connected
                        ? "Ready"
                        : agentStatus}
                </button>
                <button
                  type="button"
                  className="icon-btn topbar-outputs-toggle"
                  title={outputsOpen ? "Hide outputs panel" : "Show outputs panel"}
                  onClick={() => setOutputsOpen((v) => !v)}
                >
                  {outputsOpen ? (
                    <IconChevronRight size={16} />
                  ) : (
                    <IconChevronLeft size={16} />
                  )}
                </button>
              </div>
            </header>

            <div className="chat-pane">
              {/* Overlay (not in scroll flow) so show/hide never changes scrollHeight. */}
              {stickyUserId && stickyUserText != null && (
                <button
                  type="button"
                  className="user-sticky-bar"
                  title="Jump to your message above"
                  onClick={() => jumpToUserMessage(stickyUserId)}
                >
                  <span className="user-sticky-label">Your message</span>
                  <span className="user-sticky-text">{stickyUserText}</span>
                  <span className="user-sticky-jump">Jump ↑</span>
                </button>
              )}
              <div className="chat-scroll" ref={chatScrollRef}>
              {lines.length === 0 ? (
                <div className="chat-inner">
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
                </div>
              ) : (
              <VirtualChatList
                className="chat-inner"
                items={virtualChatItems}
                scrollerRef={chatScrollRef}
                overscanPx={900}
                footer={<div ref={bottomRef} />}
                renderItem={(line, i) => {
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
                            {line.durationMs > 0 && (
                              <span className="trace-duration">
                                {formatDuration(line.durationMs)}
                              </span>
                            )}
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
                                        <ChatMarkdown mediaBases={chatMediaBases}>
                                          {item.text}
                                        </ChatMarkdown>
                                      </div>
                                    </div>
                                  );
                                }
                                return (
                                  <div
                                    key={item.id}
                                    className={`msg-chip trace-item${
                                      item.kind === "tool" &&
                                      (item.count ?? 1) > 1
                                        ? " msg-chip-merged"
                                        : ""
                                    }`}
                                    title={
                                      item.kind === "tool" &&
                                      (item.count ?? 1) > 1
                                        ? `${item.text} · repeated ${item.count} times`
                                        : undefined
                                    }
                                  >
                                    <span className="chip-icon">
                                      <ChipIcon kind={item.kind} />
                                    </span>
                                    <span>
                                      {item.kind === "tool"
                                        ? formatToolChipLabel(item)
                                        : item.text}
                                    </span>
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
                    const label =
                      line.kind === "tool"
                        ? formatToolChipLabel(line)
                        : line.text;
                    return (
                      <div
                        key={line.id}
                        className={`msg-chip${
                          line.kind === "tool" && (line.count ?? 1) > 1
                            ? " msg-chip-merged"
                            : ""
                        }`}
                        title={
                          line.kind === "tool" && (line.count ?? 1) > 1
                            ? `${line.text} · repeated ${line.count} times`
                            : undefined
                        }
                      >
                        <span className="chip-icon">
                          <ChipIcon kind={line.kind} />
                        </span>
                        <span>{label}</span>
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
                    const streaming =
                      busy && i === lines.length - 1;
                    const canCopy = Boolean(line.text.trim()) && !streaming;
                    const copiedMd =
                      copiedMsg?.id === line.id && copiedMsg.format === "md";
                    const copiedPlain =
                      copiedMsg?.id === line.id &&
                      copiedMsg.format === "plain";
                    return (
                      <div key={line.id} className="msg msg-assistant">
                        <div className="msg-assistant-wrap">
                          <div className="msg-body md-body">
                            <ChatMarkdown mediaBases={chatMediaBases}>
                              {line.text}
                            </ChatMarkdown>
                            {streaming && (
                              <span className="stream-caret" aria-hidden />
                            )}
                          </div>
                          {canCopy && (
                            <div className="msg-actions">
                              <button
                                type="button"
                                className={`msg-copy-btn${
                                  copiedMd ? " msg-copy-btn-done" : ""
                                }`}
                                title={
                                  copiedMd
                                    ? "Copied as Markdown"
                                    : "Copy as Markdown"
                                }
                                aria-label={
                                  copiedMd
                                    ? "Copied as Markdown"
                                    : "Copy reply as Markdown"
                                }
                                onClick={() =>
                                  void copyAssistantText(
                                    line.id,
                                    line.text,
                                    "md",
                                  )
                                }
                              >
                                {copiedMd ? (
                                  <IconCheck size={14} />
                                ) : (
                                  <IconCopy size={14} />
                                )}
                                <span>
                                  {copiedMd ? "Copied" : "Markdown"}
                                </span>
                              </button>
                              <button
                                type="button"
                                className={`msg-copy-btn${
                                  copiedPlain ? " msg-copy-btn-done" : ""
                                }`}
                                title={
                                  copiedPlain
                                    ? "Copied as plain text"
                                    : "Copy as plain text"
                                }
                                aria-label={
                                  copiedPlain
                                    ? "Copied as plain text"
                                    : "Copy reply as plain text"
                                }
                                onClick={() =>
                                  void copyAssistantText(
                                    line.id,
                                    line.text,
                                    "plain",
                                  )
                                }
                              >
                                {copiedPlain ? (
                                  <IconCheck size={14} />
                                ) : (
                                  <IconCopy size={14} />
                                )}
                                <span>
                                  {copiedPlain ? "Copied" : "Text"}
                                </span>
                              </button>
                              {(line.tokens != null ||
                                line.tokensPerSec != null) && (
                                <span
                                  className="msg-metrics"
                                  title={
                                    line.streamMs != null
                                      ? `Estimated ~${line.tokens ?? "?"} tokens over ${(line.streamMs / 1000).toFixed(1)}s of streaming (not API usage)`
                                      : "Estimated tokens from reply length (not API usage)"
                                  }
                                >
                                  {line.tokens != null && (
                                    <span className="msg-metric">
                                      ~{line.tokens} tok
                                    </span>
                                  )}
                                  {line.tokensPerSec != null && (
                                    <span className="msg-metric">
                                      {formatTokensPerSec(line.tokensPerSec)}{" "}
                                      tok/s
                                    </span>
                                  )}
                                </span>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  }
                  if (line.kind === "thought") {
                    return (
                      <div key={line.id} className="msg msg-thought">
                        <div className="msg-body md-body thought-md">
                          <ChatMarkdown mediaBases={chatMediaBases}>
                            {line.text}
                          </ChatMarkdown>
                        </div>
                      </div>
                    );
                  }
                  if (line.kind === "user") {
                    const timeLabel = formatMessageTime(line.at);
                    const atts = line.attachments ?? [];
                    const imgs = atts.filter(
                      (a) =>
                        isImageAttachment(a) && (a.previewSrc || a.path),
                    );
                    const files = atts.filter((a) => !isImageAttachment(a));
                    const isEditing = editingUserId === line.id;
                    const canEdit = !busy && !connecting && !isEditing;
                    return (
                      <div
                        key={line.id}
                        className={`msg msg-user${
                          highlightUserId === line.id ? " msg-user-highlight" : ""
                        }${isEditing ? " msg-user-editing" : ""}`}
                        data-user-msg={line.id}
                        ref={(el) => {
                          if (el) userMsgEls.current.set(line.id, el);
                          else userMsgEls.current.delete(line.id);
                        }}
                      >
                        <div className="msg-user-stack">
                          {isEditing ? (
                            <div className="msg-body msg-user-edit-body">
                              {imgs.length > 0 && (
                                <div className="msg-user-thumbs">
                                  {imgs.map((a) => {
                                    const src =
                                      a.previewSrc ||
                                      (a.path ? convertFileSrc(a.path) : "");
                                    return src ? (
                                      <span
                                        key={a.path || a.name}
                                        className="msg-user-thumb"
                                      >
                                        <img src={src} alt={a.name} />
                                      </span>
                                    ) : null;
                                  })}
                                </div>
                              )}
                              {files.length > 0 && (
                                <div className="msg-user-files">
                                  {files.map((a) => {
                                    const label = attachmentDisplayName(a);
                                    return (
                                      <span
                                        key={a.path || label}
                                        className="msg-user-file-chip"
                                        title={a.path || label}
                                      >
                                        📎 {label}
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                              <textarea
                                ref={editTextareaRef}
                                className="msg-user-edit-input"
                                value={editDraft}
                                rows={2}
                                placeholder="Edit your message…"
                                onChange={(e) => {
                                  setEditDraft(e.target.value);
                                  const el = e.target;
                                  el.style.height = "auto";
                                  el.style.height = `${Math.min(
                                    el.scrollHeight,
                                    200,
                                  )}px`;
                                }}
                                onKeyDown={(e) => {
                                  if (e.key === "Escape") {
                                    e.preventDefault();
                                    cancelEditUser();
                                  } else if (
                                    e.key === "Enter" &&
                                    (e.metaKey || e.ctrlKey)
                                  ) {
                                    e.preventDefault();
                                    void onResendEditedUser();
                                  }
                                }}
                              />
                              <div className="msg-user-edit-actions">
                                <button
                                  type="button"
                                  className="msg-user-edit-cancel"
                                  onClick={cancelEditUser}
                                >
                                  Cancel
                                </button>
                                <button
                                  type="button"
                                  className="msg-user-edit-send"
                                  disabled={
                                    !editDraft.trim() &&
                                    (line.attachments?.length ?? 0) === 0
                                  }
                                  title="Send edited message and restart from here (⌘↵)"
                                  onClick={() => void onResendEditedUser()}
                                >
                                  <IconSend size={13} />
                                  Send
                                </button>
                              </div>
                            </div>
                          ) : (
                            <>
                              <div className="msg-body">
                                {imgs.length > 0 && (
                                  <div className="msg-user-thumbs">
                                    {imgs.map((a) => {
                                      const src =
                                        a.previewSrc ||
                                        (a.path ? convertFileSrc(a.path) : "");
                                      return (
                                        <a
                                          key={a.path || a.name}
                                          className="msg-user-thumb"
                                          href={src || undefined}
                                          title={a.name}
                                          onClick={(e) => {
                                            e.preventDefault();
                                            if (a.path) {
                                              void openUrl(
                                                a.path.startsWith("file:")
                                                  ? a.path
                                                  : `file://${a.path}`,
                                              ).catch(() => {});
                                            }
                                          }}
                                        >
                                          {src ? (
                                            <img src={src} alt={a.name} />
                                          ) : (
                                            <span className="msg-user-file-chip">
                                              {a.name}
                                            </span>
                                          )}
                                        </a>
                                      );
                                    })}
                                  </div>
                                )}
                                {files.length > 0 && (
                                  <div className="msg-user-files">
                                    {files.map((a) => {
                                      const label = attachmentDisplayName(a);
                                      return (
                                        <button
                                          key={a.path || label}
                                          type="button"
                                          className="msg-user-file-chip"
                                          title={a.path || label}
                                          onClick={() => {
                                            if (!a.path) return;
                                            void invoke("open_path", {
                                              path: a.path,
                                            }).catch(() => {
                                              void openUrl(
                                                a.path.startsWith("file:")
                                                  ? a.path
                                                  : `file://${a.path}`,
                                              ).catch(() => {});
                                            });
                                          }}
                                        >
                                          📎 {label}
                                        </button>
                                      );
                                    })}
                                  </div>
                                )}
                                {line.text ? (
                                  <div className="msg-user-text">
                                    {line.text}
                                  </div>
                                ) : null}
                                {!line.text &&
                                  files.length === 0 &&
                                  imgs.length === 0 && (
                                    <div className="msg-user-text muted">
                                      (empty)
                                    </div>
                                  )}
                              </div>
                              <div className="msg-user-meta">
                                {canEdit && (
                                  <button
                                    type="button"
                                    className="msg-user-edit-btn"
                                    title="Edit and re-send from this message"
                                    aria-label="Edit message"
                                    onClick={() => beginEditUser(line)}
                                  >
                                    <IconPen size={12} />
                                    Edit
                                  </button>
                                )}
                                {timeLabel && (
                                  <time
                                    className="msg-user-time"
                                    dateTime={line.at}
                                    title={
                                      line.at
                                        ? new Date(line.at).toLocaleString()
                                        : undefined
                                    }
                                  >
                                    {timeLabel}
                                  </time>
                                )}
                              </div>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div key={line.id} className={`msg msg-${line.kind}`}>
                      <div className="msg-body">{line.text}</div>
                    </div>
                  );
                }}
              />
              )}
              </div>
              {showScrollToBottom && (
                <button
                  type="button"
                  className="scroll-to-bottom-btn"
                  title="Scroll to bottom"
                  aria-label="Scroll to bottom"
                  onClick={jumpToBottom}
                >
                  <IconChevronDown size={18} />
                </button>
              )}
            </div>

            <div className="composer-dock">
              {attachments.length > 0 && (
                <div className="attach-row">
                  {attachments.map((a) => {
                    const label = attachmentDisplayName(a);
                    const isImg = isImageAttachment(a);
                    return (
                      <div
                        key={a.path}
                        className={`attach-chip${
                          isImg ? " attach-chip-image" : ""
                        }`}
                        title={label}
                      >
                        {isImg && (a.previewUrl || a.path) ? (
                          <img
                            className="attach-thumb"
                            src={
                              a.previewUrl ||
                              (a.path ? convertFileSrc(a.path) : "")
                            }
                            alt={label}
                          />
                        ) : (
                          <span className="attach-icon" aria-hidden>
                            📄
                          </span>
                        )}
                        <span className="attach-name">{label}</span>
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
                    );
                  })}
                </div>
              )}
              <ComposerInput
                ref={composerRef}
                disabled={!session || (busy && !pendingPerm)}
                placeholder={
                  session
                    ? "Describe what this task should do… (paste text or images)"
                    : "Click Tasks + to create a task and start chatting…"
                }
                onPaste={(e) => {
                  void onComposerPaste(e);
                }}
                onSubmit={() => {
                  void onSend();
                }}
                onDraftChange={onComposerDraftChange}
                onDraftSettled={onComposerDraftSettled}
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
                  <select
                    className={`composer-select access-select access-mode-${permissionMode}`}
                    value={permissionMode}
                    onChange={(e) =>
                      void setPermissionModeAndSave(
                        normalizePermissionMode(e.target.value),
                      )
                    }
                    title={
                      permissionMode === "always-approve"
                        ? "Full trust: all tools auto-approved (saved). New task/reconnect applies."
                        : permissionMode === "auto"
                          ? "Auto: engine may auto-allow low-risk tools (saved). New task/reconnect applies."
                          : "Needs approval: confirm each tool (saved). New task/reconnect applies."
                    }
                    aria-label="Tool permission mode"
                  >
                    <option value="ask">Needs approval</option>
                    <option value="auto">Auto</option>
                    <option value="always-approve">Full trust</option>
                  </select>
                  {session && (
                    <div
                      className={contextMeterClass}
                      title={
                        contextFromEngine
                          ? `Context: ${contextUsed.toLocaleString()} / ${contextWindow.toLocaleString()} tokens (engine-reported for this task)`
                          : `Context (estimated from this task’s chat): ~${contextUsed.toLocaleString()} / ${contextWindow.toLocaleString()} tokens · set window in Settings`
                      }
                    >
                      <div className="context-meter-track" aria-hidden>
                        <div
                          className="context-meter-fill"
                          style={{ width: `${contextPct}%` }}
                        />
                      </div>
                      <span className="context-meter-label">
                        {formatTokenCount(contextUsed)}/
                        {formatTokenCount(contextWindow)}
                        {contextFromEngine ? "" : " ~"}
                      </span>
                    </div>
                  )}
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
                    value={
                      efforts.some((e) => e.id === effortId) ? effortId : "medium"
                    }
                    onChange={(e) => setEffortId(e.target.value)}
                    title="Reasoning effort (Grok: Low · Medium · High · Extra high)"
                    disabled={busy}
                  >
                    {(efforts.length
                      ? efforts
                      : [
                          { id: "low", label: "Low" },
                          { id: "medium", label: "Medium" },
                          { id: "high", label: "High" },
                          { id: "xhigh", label: "Extra high" },
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
                        (!composerHasText && attachments.length === 0)
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

          {outputsOpen && (
            <>
              <div
                className="panel-resizer panel-resizer-right"
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize outputs panel"
                title="Drag to resize outputs"
                onMouseDown={(e) => onPanelResizeStart("right", e)}
              />
              <aside className="right">
              <div className="right-header" onMouseDown={onTitlebarMouseDown}>
                <h2>Outputs</h2>
              </div>

              <div className="outputs-tabs" role="tablist" aria-label="Outputs">
                <button
                  type="button"
                  role="tab"
                  aria-selected={outputsTab === "overview"}
                  className={`outputs-tab${
                    outputsTab === "overview" ? " active" : ""
                  }`}
                  onClick={() => setOutputsTab("overview")}
                >
                  Overview
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={outputsTab === "files"}
                  className={`outputs-tab${
                    outputsTab === "files" ? " active" : ""
                  }`}
                  onClick={() => setOutputsTab("files")}
                  title="Browse this task's workspace and project files"
                >
                  Files
                </button>
              </div>

              {error && !session && outputsTab === "overview" && (
                <div className="error-banner" style={{ marginBottom: 12 }}>
                  {error}
                </div>
              )}

              {outputsTab === "overview" && (
                <>
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
                        Temporary workspace under ~/.grokx/tasks/. Project
                        sources via ./project.
                      </p>
                    </div>
                  )}

                  {session && (
                    <div className="card git-card">
                      <div className="files-card-head">
                        <h3>Git</h3>
                        <button
                          type="button"
                          className="files-icon-btn"
                          title="Refresh git status"
                          disabled={gitLoading}
                          onClick={() => void refreshGitStatus()}
                        >
                          <IconRefresh size={14} />
                        </button>
                      </div>
                      {gitLoading && !gitInfo && (
                        <p className="muted">Loading…</p>
                      )}
                      {gitError && (
                        <p className="files-error">{gitError}</p>
                      )}
                      {gitInfo && !gitInfo.is_repo && (
                        <p className="muted">
                          {gitInfo.note || "Not a git repository"}
                          <br />
                          <span className="mono" title={gitInfo.path}>
                            {shortPath(gitInfo.path)}
                          </span>
                        </p>
                      )}
                      {gitInfo && gitInfo.is_repo && (
                        <>
                          <dl className="kv">
                            <dt>Branch</dt>
                            <dd className="mono">
                              {gitInfo.branch || "—"}
                              {gitInfo.dirty ? (
                                <span className="git-dirty-pill">dirty</span>
                              ) : (
                                <span className="git-clean-pill">clean</span>
                              )}
                            </dd>
                            <dt>HEAD</dt>
                            <dd className="mono" title={gitInfo.head || ""}>
                              {gitInfo.head_short || "—"}
                            </dd>
                            {gitInfo.upstream && (
                              <>
                                <dt>Upstream</dt>
                                <dd className="mono">{gitInfo.upstream}</dd>
                              </>
                            )}
                            <dt>Changes</dt>
                            <dd>
                              {gitInfo.staged +
                                gitInfo.unstaged +
                                gitInfo.untracked ===
                              0
                                ? "none"
                                : `${gitInfo.staged} staged · ${gitInfo.unstaged} unstaged · ${gitInfo.untracked} untracked`}
                            </dd>
                          </dl>
                          {gitInfo.changes.length > 0 && (
                            <div className="git-changes">
                              <div className="git-section-label">
                                This working tree
                              </div>
                              <ul className="git-change-list">
                                {gitInfo.changes.map((line) => (
                                  <li key={line} className="mono">
                                    {line}
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                          {gitInfo.recent.length > 0 && (
                            <div className="git-recent">
                              <div className="git-section-label">
                                Recent commits
                              </div>
                              <ul className="git-commit-list">
                                {gitInfo.recent.map((c) => (
                                  <li key={c.hash}>
                                    <span className="git-hash mono">
                                      {c.short}
                                    </span>
                                    <span
                                      className="git-subject"
                                      title={c.subject}
                                    >
                                      {c.subject}
                                    </span>
                                    <span className="git-meta muted">
                                      {c.relative}
                                    </span>
                                  </li>
                                ))}
                              </ul>
                            </div>
                          )}
                        </>
                      )}
                      {!session.project_root && !session.work_path && (
                        <p className="muted">No project path for git.</p>
                      )}
                    </div>
                  )}

                  {!session && !pendingPerm && (
                    <div className="card">
                      <h3>Outputs</h3>
                      <p className="muted">
                        Permissions and task details show up here after you open
                        a project from the sidebar.
                      </p>
                    </div>
                  )}
                </>
              )}

              {outputsTab === "files" && (
                <div className="card files-card">
                  <div className="files-card-head">
                    <h3>Session files</h3>
                    <button
                      type="button"
                      className="files-icon-btn"
                      title="Refresh"
                      disabled={!filesRootPath || filesLoading}
                      onClick={() => refreshFilesTab()}
                    >
                      <IconRefresh size={14} />
                    </button>
                  </div>

                  {!session ? (
                    <p className="muted">Open a task to browse its directory.</p>
                  ) : (
                    <>
                      <div className="files-root-toggle" role="group">
                        <button
                          type="button"
                          className={`files-root-btn${
                            filesRootKind === "task" ? " active" : ""
                          }`}
                          disabled={!session.work_path}
                          onClick={() => setFilesRootKind("task")}
                          title={session.work_path || "No task cwd"}
                        >
                          Task
                        </button>
                        <button
                          type="button"
                          className={`files-root-btn${
                            filesRootKind === "project" ? " active" : ""
                          }`}
                          disabled={!session.project_root}
                          onClick={() => setFilesRootKind("project")}
                          title={session.project_root || "No project"}
                        >
                          Project
                        </button>
                      </div>

                      <div className="files-path-bar" title={filesBrowsePath || ""}>
                        <button
                          type="button"
                          className="files-icon-btn"
                          title="Go up"
                          disabled={!filesCanGoUp || filesLoading}
                          onClick={() => {
                            const p = filesBrowsePath
                              ? parentDir(filesBrowsePath)
                              : null;
                            if (p) void loadFilesDir(p);
                          }}
                        >
                          ↑
                        </button>
                        <button
                          type="button"
                          className="files-path-text mono"
                          title="Open in Finder / Explorer"
                          disabled={!filesBrowsePath}
                          onClick={() => {
                            if (filesBrowsePath) {
                              void onOpenFilesPath(filesBrowsePath);
                            }
                          }}
                        >
                          {filesBrowsePath
                            ? shortPath(filesBrowsePath)
                            : "—"}
                        </button>
                      </div>

                      {filesError && (
                        <p className="files-error">{filesError}</p>
                      )}
                      {filesLoading && (
                        <p className="muted files-loading">Loading…</p>
                      )}

                      {!filesLoading && !filesError && filesEntries.length === 0 && (
                        <p className="muted">Empty folder</p>
                      )}

                      <ul className="files-list">
                        {filesEntries.map((ent) => (
                          <li key={ent.path}>
                            <button
                              type="button"
                              className={`files-entry${
                                ent.is_dir ? " is-dir" : ""
                              }`}
                              title={ent.path}
                              onClick={() => onFilesEntryClick(ent)}
                              onDoubleClick={() => {
                                if (ent.is_dir) {
                                  void loadFilesDir(ent.path);
                                } else {
                                  void onOpenFilesPath(ent.path);
                                }
                              }}
                            >
                              <span className="files-entry-icon" aria-hidden>
                                {ent.is_dir ? (
                                  <IconFolder size={14} />
                                ) : (
                                  <IconFile size={14} />
                                )}
                              </span>
                              <span className="files-entry-name">{ent.name}</span>
                              {!ent.is_dir && ent.size != null && (
                                <span className="files-entry-meta">
                                  {formatBytes(ent.size)}
                                </span>
                              )}
                            </button>
                          </li>
                        ))}
                      </ul>

                      <p className="muted files-hint">
                        Click a file to open · folder to enter · path bar opens
                        in Finder
                      </p>
                    </>
                  )}
                </div>
              )}
            </aside>
            </>
          )}
        </>
      )}
    </div>
  );
}
