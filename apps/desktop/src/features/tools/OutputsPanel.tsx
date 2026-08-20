import type { Dispatch, ReactNode, SetStateAction } from "react";
import {
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFolder,
  IconRefresh,
  IconStop,
} from "../../icons";
import {
  onTitlebarDoubleClick,
  onTitlebarMouseDown,
} from "../../windowDrag";
import { SideChat, type SideChatMessage } from "../../components/SideChat";
import { formatBytes, parentDir, shortPath } from "../../lib/paths";
import {
  shortProcessLabel,
  type SessionProcNode,
} from "../../lib/processTree";

export type OutputsTab = "chat" | "overview" | "files";
export type FilesRootKind = "task" | "project";

export type OutputsDirEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size?: number | null;
  modified?: string | null;
};

export type OutputsGitCommit = {
  hash: string;
  short: string;
  subject: string;
  author: string;
  relative: string;
};

export type OutputsGitInfo = {
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
  recent: OutputsGitCommit[];
  note?: string | null;
};

export type OutputsPendingPerm = {
  id: string;
  summary: string;
  tool_name: string;
  detail?: string | null;
};

export type OutputsSession = {
  session_id: string;
  project_root?: string | null;
  work_path?: string | null;
};

type Props = {
  outputsTab: OutputsTab;
  setRightTab: (tab: OutputsTab) => void;
  sideChatSessionId: string | null;
  connected: boolean;
  sideChatMessages: SideChatMessage[];
  updateSideChatMessages: (
    updater: (prev: SideChatMessage[]) => SideChatMessage[],
  ) => void;
  error: string | null;
  session: OutputsSession | null;
  pendingPerm: OutputsPendingPerm | null;
  onPermission: (decision: "allow_once" | "deny") => void;
  procsSectionOpen: boolean;
  setProcsSectionOpen: Dispatch<SetStateAction<boolean>>;
  procsLoading: boolean;
  refreshSessionProcesses: () => void;
  procsError: string | null;
  processTree: SessionProcNode[];
  expandedProcPids: Set<number>;
  setExpandedProcPids: Dispatch<SetStateAction<Set<number>>>;
  procActionPid: number | null;
  stopSessionProcess: (pid: number) => void;
  gitLoading: boolean;
  refreshGitStatus: () => void;
  gitError: string | null;
  gitInfo: OutputsGitInfo | null;
  filesRootPath: string | null;
  filesLoading: boolean;
  refreshFilesTab: () => void;
  filesRootKind: FilesRootKind;
  setFilesRootKind: Dispatch<SetStateAction<FilesRootKind>>;
  filesBrowsePath: string | null;
  filesCanGoUp: boolean;
  loadFilesDir: (path: string) => void;
  onOpenFilesPath: (path: string) => void;
  filesError: string | null;
  filesEntries: OutputsDirEntry[];
  onFilesEntryClick: (ent: OutputsDirEntry) => void;
};

export function OutputsPanel(props: Props) {
  const {
    outputsTab,
    setRightTab,
    sideChatSessionId,
    connected,
    sideChatMessages,
    updateSideChatMessages,
    error,
    session,
    pendingPerm,
    onPermission,
    procsSectionOpen,
    setProcsSectionOpen,
    procsLoading,
    refreshSessionProcesses,
    procsError,
    processTree,
    expandedProcPids,
    setExpandedProcPids,
    procActionPid,
    stopSessionProcess,
    gitLoading,
    refreshGitStatus,
    gitError,
    gitInfo,
    filesRootPath,
    filesLoading,
    refreshFilesTab,
    filesRootKind,
    setFilesRootKind,
    filesBrowsePath,
    filesCanGoUp,
    loadFilesDir,
    onOpenFilesPath,
    filesError,
    filesEntries,
    onFilesEntryClick,
  } = props;

  return (
<aside
  className={`right${
    outputsTab === "chat" ? " right-chat-mode" : ""
  }`}
>
<div
  className="right-header"
  onMouseDown={onTitlebarMouseDown}
  onDoubleClick={onTitlebarDoubleClick}
>
  <h2>{outputsTab === "chat" ? "Side chat" : "Outputs"}</h2>
</div>

<div
  className="outputs-tabs"
  role="tablist"
  aria-label="Right panel"
>
  <button
    type="button"
    role="tab"
    aria-selected={outputsTab === "chat"}
    className={`outputs-tab${
      outputsTab === "chat" ? " active" : ""
    }`}
    onClick={() => setRightTab("chat")}
    title="Side chat — does not add to main context"
  >
    Chat
  </button>
  <button
    type="button"
    role="tab"
    aria-selected={outputsTab === "overview"}
    className={`outputs-tab${
      outputsTab === "overview" ? " active" : ""
    }`}
    onClick={() => setRightTab("overview")}
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
    onClick={() => setRightTab("files")}
    title="Browse this task's workspace and project files"
  >
    Files
  </button>
</div>

{outputsTab === "chat" && (
  <SideChat
    sessionId={sideChatSessionId}
    connected={connected}
    messages={sideChatMessages}
    onMessagesChange={updateSideChatMessages}
    active={outputsTab === "chat"}
  />
)}

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
      <div
        className={`card proc-card${
          procsSectionOpen ? " proc-card-open" : " proc-card-collapsed"
        }`}
      >
        <div className="files-card-head proc-card-head">
          <button
            type="button"
            className="proc-section-toggle"
            aria-expanded={procsSectionOpen}
            title={
              procsSectionOpen
                ? "Collapse processes"
                : "Expand processes"
            }
            onClick={() => setProcsSectionOpen((v) => !v)}
          >
            <span className="proc-section-chevron" aria-hidden>
              {procsSectionOpen ? (
                <IconChevronDown size={16} />
              ) : (
                <IconChevronRight size={16} />
              )}
            </span>
            <h3>
              Processes
              {processTree.length > 0
                ? ` · ${processTree.length}`
                : ""}
            </h3>
          </button>
          <button
            type="button"
            className="files-icon-btn"
            title="Refresh processes started by this task"
            disabled={procsLoading}
            onClick={(e) => {
              e.stopPropagation();
              void refreshSessionProcesses();
            }}
          >
            <IconRefresh size={14} />
          </button>
        </div>
        {!procsSectionOpen && processTree.length > 0 && (
          <div className="proc-collapsed-summary muted">
            {processTree.slice(0, 3).map((p) => {
              const label = shortProcessLabel(p.command);
              const childN = p.children.length;
              return (
                <span
                  key={p.pid}
                  className="proc-chip"
                  title={
                    childN > 0
                      ? `${p.command}\n(+${childN} child process${
                          childN === 1 ? "" : "es"
                        })`
                      : p.command
                  }
                >
                  {label}
                  {childN > 0 ? ` · +${childN}` : ""}
                  {p.paused ? " · paused" : ""}
                </span>
              );
            })}
            {processTree.length > 3 && (
              <span className="proc-chip">
                +{processTree.length - 3}
              </span>
            )}
          </div>
        )}
        {procsSectionOpen && (
          <>
            <p className="muted proc-hint">
              One row per service · expand for details · Stop ends
              the whole tree.
            </p>
            {procsError && (
              <p className="files-error">{procsError}</p>
            )}
            {procsLoading && processTree.length === 0 && (
              <p className="muted">Scanning…</p>
            )}
            {!procsLoading &&
              processTree.length === 0 &&
              !procsError && (
                <p className="muted">
                  No related processes. Long-lived tools like{" "}
                  <code>mykg web</code> show up here.
                </p>
              )}
            {processTree.length > 0 && (
              <ul className="proc-list">
                {processTree.map((root) => {
                  const renderNode = (
                    p: SessionProcNode,
                    nest: number,
                  ): ReactNode => {
                    const busyRow = procActionPid === p.pid;
                    const rowOpen = expandedProcPids.has(p.pid);
                    const label = shortProcessLabel(p.command);
                    const childN = p.children.length;
                    const tip = [
                      p.command,
                      p.cwd ? `cwd: ${p.cwd}` : null,
                      `pid ${p.pid} · ${p.etime} · ${
                        p.paused ? "paused" : p.state
                      }`,
                      childN > 0
                        ? `${childN} child process${
                            childN === 1 ? "" : "es"
                          } (expand)`
                        : null,
                    ]
                      .filter(Boolean)
                      .join("\n");
                    return (
                      <li
                        key={p.pid}
                        className={`proc-row${
                          p.paused ? " proc-paused" : ""
                        }${rowOpen ? " proc-row-open" : ""}${
                          nest > 0 ? " proc-row-child" : ""
                        }`}
                        style={
                          nest > 0
                            ? {
                                marginLeft: Math.min(nest, 3) * 12,
                              }
                            : undefined
                        }
                      >
                        <button
                          type="button"
                          className="proc-row-summary"
                          title={tip}
                          aria-expanded={rowOpen}
                          onClick={() => {
                            setExpandedProcPids((prev) => {
                              const next = new Set(prev);
                              if (next.has(p.pid))
                                next.delete(p.pid);
                              else next.add(p.pid);
                              return next;
                            });
                          }}
                        >
                          <span
                            className="proc-row-chevron"
                            aria-hidden
                          >
                            {rowOpen ? (
                              <IconChevronDown size={14} />
                            ) : (
                              <IconChevronRight size={14} />
                            )}
                          </span>
                          <span className="proc-label">
                            {label}
                            {nest === 0 && childN > 0 && (
                              <span className="proc-child-count muted">
                                {" "}
                                · {childN + 1} procs
                              </span>
                            )}
                            {nest > 0 && (
                              <span className="proc-child-tag muted">
                                {" "}
                                child
                              </span>
                            )}
                          </span>
                          <span
                            className={`proc-status-pill${
                              p.paused ? " paused" : ""
                            }`}
                          >
                            {p.paused ? "paused" : "running"}
                          </span>
                          <span className="proc-pid muted">
                            {p.pid}
                          </span>
                        </button>
                        {rowOpen && (
                          <div className="proc-row-detail">
                            <div
                              className="proc-cmd mono"
                              title={p.command}
                            >
                              {p.command}
                            </div>
                            <div className="proc-meta muted">
                              <span>pid {p.pid}</span>
                              <span>·</span>
                              <span>ppid {p.ppid}</span>
                              <span>·</span>
                              <span>{p.etime}</span>
                              <span>·</span>
                              <span>
                                {p.paused ? "paused" : p.state}
                              </span>
                              {p.cwd && (
                                <>
                                  <span>·</span>
                                  <span title={p.cwd}>
                                    {shortPath(p.cwd)}
                                  </span>
                                </>
                              )}
                            </div>
                            {/* Controls only on the root service row. */}
                            {nest === 0 && (
                              <div className="proc-actions">
                                <button
                                  type="button"
                                  className="btn btn-ghost proc-btn proc-btn-danger"
                                  disabled={busyRow}
                                  title="Stop this service and its child processes"
                                  onClick={() =>
                                    void stopSessionProcess(p.pid)
                                  }
                                >
                                  <IconStop size={12} />
                                  Stop
                                </button>
                              </div>
                            )}
                            {p.children.length > 0 && (
                              <ul className="proc-list proc-list-nested">
                                {p.children.map((c) =>
                                  renderNode(c, nest + 1),
                                )}
                              </ul>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  };
                  return renderNode(root, 0);
                })}
              </ul>
            )}
          </>
        )}
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
  );
}
