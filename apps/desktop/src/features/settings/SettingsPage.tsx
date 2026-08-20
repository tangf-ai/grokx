import type { Dispatch, SetStateAction } from "react";
import {
  IconChevronLeft,
  IconFile,
  IconSettings,
  IconTool,
} from "../../icons";
import {
  onTitlebarDoubleClick,
  onTitlebarMouseDown,
} from "../../windowDrag";

export type SettingsSection = "model" | "toml" | "engine";

export type SettingsPermissionMode = "ask" | "auto" | "always-approve";

export type SettingsEngineInfo = {
  path: string;
  source: string;
  status: string;
};

export type SettingsProject = {
  root_path: string;
};

export type SettingsSession = {
  work_path?: string | null;
};

export type SettingsModelOption = { id: string; name: string };
export type SettingsEffortOption = { id: string; label: string };

function isSettingsError(msg: string) {
  return /fail|error|required|invalid|denied|unauthorized|forbidden|timeout|not found|http [45]/i.test(
    msg,
  );
}

type Props = {
  section: SettingsSection;
  onSection: Dispatch<SetStateAction<SettingsSection>>;
  onBack: () => void;
  cfgSyncGrok: boolean;
  setCfgSyncGrok: Dispatch<SetStateAction<boolean>>;
  settingsMsg: string | null;
  cfgBaseUrl: string;
  setCfgBaseUrl: Dispatch<SetStateAction<string>>;
  cfgHasKey: boolean;
  cfgKeyHint: string | null;
  cfgApiKey: string;
  setCfgApiKey: Dispatch<SetStateAction<string>>;
  endpointProbeBusy: boolean;
  savingSettings: boolean;
  onTestEndpoint: () => void;
  onFetchRemoteModels: () => void;
  fetchedRemoteModels: Array<{ id: string; name: string }>;
  cfgModelId: string;
  setCfgModelId: Dispatch<SetStateAction<string>>;
  setCfgName: Dispatch<SetStateAction<string>>;
  applySelectedModel: (id: string) => void;
  models: SettingsModelOption[];
  cfgName: string;
  cfgBackend: string;
  setCfgBackend: Dispatch<SetStateAction<string>>;
  cfgEffort: string;
  setCfgEffort: Dispatch<SetStateAction<string>>;
  efforts: SettingsEffortOption[];
  cfgContext: string;
  setCfgContext: Dispatch<SetStateAction<string>>;
  cfgEnvKey: string;
  setCfgEnvKey: Dispatch<SetStateAction<string>>;
  cfgGrokPath: string;
  onSaveSettings: () => void;
  onClearApiKey: () => void;
  loadSettings: () => void;
  grokTomlPath: string;
  grokTomlExists: boolean;
  grokTomlDirty: boolean;
  grokTomlMsg: string | null;
  grokToml: string;
  setGrokToml: Dispatch<SetStateAction<string>>;
  setGrokTomlDirty: Dispatch<SetStateAction<boolean>>;
  onSaveGrokConfigToml: () => void;
  loadGrokConfigToml: () => void;
  savingGrokToml: boolean;
  error: string | null;
  permissionMode: SettingsPermissionMode;
  onPermissionModeChange: (raw: string) => void;
  cfgEnginePath: string;
  setCfgEnginePath: Dispatch<SetStateAction<string>>;
  engine: SettingsEngineInfo | null;
  agentStatus: string;
  selectedProject: SettingsProject | null;
  session: SettingsSession | null;
  connecting: boolean;
  onOpenProject: () => void;
  onNewTask: () => void;
};

export function SettingsPage(props: Props) {
  const {
    section,
    onSection,
    onBack,
    cfgSyncGrok,
    setCfgSyncGrok,
    settingsMsg,
    cfgBaseUrl,
    setCfgBaseUrl,
    cfgHasKey,
    cfgKeyHint,
    cfgApiKey,
    setCfgApiKey,
    endpointProbeBusy,
    savingSettings,
    onTestEndpoint,
    onFetchRemoteModels,
    fetchedRemoteModels,
    cfgModelId,
    setCfgModelId,
    setCfgName,
    applySelectedModel,
    models,
    cfgName,
    cfgBackend,
    setCfgBackend,
    cfgEffort,
    setCfgEffort,
    efforts,
    cfgContext,
    setCfgContext,
    cfgEnvKey,
    setCfgEnvKey,
    cfgGrokPath,
    onSaveSettings,
    onClearApiKey,
    loadSettings,
    grokTomlPath,
    grokTomlExists,
    grokTomlDirty,
    grokTomlMsg,
    grokToml,
    setGrokToml,
    setGrokTomlDirty,
    onSaveGrokConfigToml,
    loadGrokConfigToml,
    savingGrokToml,
    error,
    permissionMode,
    onPermissionModeChange,
    cfgEnginePath,
    setCfgEnginePath,
    engine,
    agentStatus,
    selectedProject,
    session,
    connecting,
    onOpenProject,
    onNewTask,
  } = props;

  return (
<div className="settings-shell">
  <aside
    className="settings-rail"
    onMouseDown={onTitlebarMouseDown}
    onDoubleClick={onTitlebarDoubleClick}
  >
    <div className="settings-rail-top">
      <button
        type="button"
        className="settings-back-btn"
        onClick={onBack}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <IconChevronLeft size={16} />
        Back to app
      </button>
    </div>
    <nav className="settings-rail-nav" aria-label="Settings">
      <div className="settings-rail-group">Configuration</div>
      <button
        type="button"
        className={`settings-rail-item${
          section === "model" ? " active" : ""
        }`}
        onClick={() => onSection("model")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <IconSettings size={15} />
        Model
      </button>
      <button
        type="button"
        className={`settings-rail-item${
          section === "toml" ? " active" : ""
        }`}
        onClick={() => onSection("toml")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <IconFile size={15} />
        Engine config
      </button>
      <button
        type="button"
        className={`settings-rail-item${
          section === "engine" ? " active" : ""
        }`}
        onClick={() => onSection("engine")}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <IconTool size={15} />
        Project & engine
      </button>
    </nav>
  </aside>

  <main className="settings-content">
    <div className="settings-content-scroll">
      {section === "model" && (
        <>
          <h1 className="settings-page-title">Model</h1>
          <p className="settings-page-lead muted">
            API endpoint, key, and default model. After save
            {cfgSyncGrok ? " syncs to the engine config;" : ""} reconnect
            a task to apply.
          </p>
          {settingsMsg && (
            <div
              className={
                isSettingsError(settingsMsg)
                  ? "error-banner"
                  : "settings-ok"
              }
            >
              {settingsMsg}
            </div>
          )}

          <h2 className="settings-group-title">Connection</h2>
          <div className="settings-group-card">
            <div className="settings-row settings-row-stack">
              <div className="settings-row-text">
                <div className="settings-row-label">Base URL</div>
                <div className="settings-row-desc">
                  OpenAI-compatible root, e.g. https://api.x.ai/v1
                </div>
              </div>
              <input
                className="settings-row-input"
                value={cfgBaseUrl}
                onChange={(e) => setCfgBaseUrl(e.target.value)}
                placeholder="https://api.x.ai/v1 or http://host:port/v1"
              />
            </div>
            <div className="settings-row settings-row-stack">
              <div className="settings-row-text">
                <div className="settings-row-label">
                  API Key
                  {cfgHasKey && cfgKeyHint
                    ? ` · saved ${cfgKeyHint}`
                    : ""}
                </div>
                <div className="settings-row-desc">
                  Leave blank to keep the saved key
                </div>
              </div>
              <input
                className="settings-row-input"
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
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">Probe endpoint</div>
                <div className="settings-row-desc">
                  Test connection or load model ids from the server
                </div>
              </div>
              <div className="btn-row settings-probe-row">
                <button
                  type="button"
                  className="btn"
                  disabled={endpointProbeBusy || savingSettings}
                  onClick={() => void onTestEndpoint()}
                >
                  {endpointProbeBusy ? "Testing…" : "Test connection"}
                </button>
                <button
                  type="button"
                  className="btn"
                  disabled={endpointProbeBusy || savingSettings}
                  onClick={() => void onFetchRemoteModels()}
                >
                  {endpointProbeBusy ? "Fetching…" : "Fetch models"}
                </button>
              </div>
            </div>
          </div>

          <h2 className="settings-group-title">Model</h2>
          <div className="settings-group-card">
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">Model ID</div>
                <div className="settings-row-desc">
                  {fetchedRemoteModels.length > 0
                    ? `${fetchedRemoteModels.length} models loaded — pick one`
                    : "Type an id, or Fetch models to choose"}
                </div>
              </div>
              {fetchedRemoteModels.length > 0 ? (
                <select
                  className="settings-select settings-row-control"
                  value={
                    fetchedRemoteModels.some((m) => m.id === cfgModelId)
                      ? cfgModelId
                      : fetchedRemoteModels[0]?.id || cfgModelId
                  }
                  onChange={(e) => {
                    applySelectedModel(e.target.value);
                  }}
                >
                  {fetchedRemoteModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name && m.name !== m.id
                        ? `${m.name} (${m.id})`
                        : m.id}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  className="settings-row-input settings-row-control"
                  value={cfgModelId}
                  onChange={(e) => {
                    const id = e.target.value;
                    setCfgModelId(id);
                    // Manual typing: keep display name in sync when empty
                    // or still equal to the previous id.
                    setCfgName((prev) => {
                      const p = prev.trim();
                      if (!p || p === cfgModelId) return id;
                      return prev;
                    });
                  }}
                  placeholder="grok-4.5"
                  list="settings-model-suggestions"
                />
              )}
              {fetchedRemoteModels.length === 0 && (
                <datalist id="settings-model-suggestions">
                  {(models.length
                    ? models
                    : [{ id: "grok-4.5", name: "Grok 4.5" }]
                  ).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </datalist>
              )}
            </div>
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">Display name</div>
                <div className="settings-row-desc">
                  Shown in the composer model menu
                </div>
              </div>
              <input
                className="settings-row-input settings-row-control"
                value={cfgName}
                onChange={(e) => setCfgName(e.target.value)}
                placeholder="Grok 4.5"
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">API Backend</div>
                <div className="settings-row-desc">
                  Protocol the endpoint speaks
                </div>
              </div>
              <select
                className="settings-select settings-row-control"
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
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">Default effort</div>
                <div className="settings-row-desc">
                  Reasoning effort for new turns
                </div>
              </div>
              <select
                className="settings-select settings-row-control"
                value={
                  efforts.some((e) => e.id === cfgEffort)
                    ? cfgEffort
                    : "medium"
                }
                onChange={(e) => setCfgEffort(e.target.value)}
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
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">Context window</div>
                <div className="settings-row-desc">
                  Token budget shown in the composer meter
                </div>
              </div>
              <input
                className="settings-row-input settings-row-control"
                value={cfgContext}
                onChange={(e) => setCfgContext(e.target.value)}
                placeholder="500000"
              />
            </div>
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">Env key</div>
                <div className="settings-row-desc">
                  Optional env var name if not storing the key in app
                  settings
                </div>
              </div>
              <input
                className="settings-row-input settings-row-control"
                value={cfgEnvKey}
                onChange={(e) => setCfgEnvKey(e.target.value)}
                placeholder="XAI_API_KEY"
              />
            </div>
          </div>

          <h2 className="settings-group-title">Sync</h2>
          <div className="settings-group-card">
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">
                  Write ~/.grok/config.toml
                </div>
                <div className="settings-row-desc mono">{cfgGrokPath}</div>
              </div>
              <label className="settings-toggle">
                <input
                  type="checkbox"
                  checked={cfgSyncGrok}
                  onChange={(e) => setCfgSyncGrok(e.target.checked)}
                />
                <span className="settings-toggle-ui" />
              </label>
            </div>
          </div>

          <div className="btn-row settings-save-row">
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
        </>
      )}

      {section === "toml" && (
        <>
          <h1 className="settings-page-title">Engine config</h1>
          <p className="settings-page-lead muted">
            Raw Grok Build config the engine reads on connect. Edit and
            save, then reconnect a task to apply.
          </p>
          <div className="settings-group-card settings-toml-card">
            <div className="settings-toml-path mono muted">
              {grokTomlPath || cfgGrokPath}
              {!grokTomlExists ? " · (missing)" : ""}
              {grokTomlDirty ? " · unsaved" : ""}
            </div>
            {grokTomlMsg && (
              <div
                className={
                  /fail|error|must not/i.test(grokTomlMsg)
                    ? "error-banner"
                    : "settings-ok"
                }
                style={{ marginBottom: 8 }}
              >
                {grokTomlMsg}
              </div>
            )}
            <textarea
              className="settings-toml-editor"
              value={grokToml}
              spellCheck={false}
              onChange={(e) => {
                setGrokToml(e.target.value);
                setGrokTomlDirty(true);
              }}
              placeholder={"# ~/.grok/config.toml\n"}
              rows={20}
            />
            <div className="btn-row" style={{ marginTop: 12 }}>
              <button
                className="btn btn-primary"
                onClick={() => void onSaveGrokConfigToml()}
                disabled={savingGrokToml || !grokTomlDirty}
              >
                {savingGrokToml ? "Saving…" : "Save config.toml"}
              </button>
              <button
                className="btn"
                onClick={() => void loadGrokConfigToml()}
                disabled={savingGrokToml}
              >
                Reload file
              </button>
            </div>
          </div>
        </>
      )}

      {section === "engine" && (
        <>
          <h1 className="settings-page-title">Project & engine</h1>
          <p className="settings-page-lead muted">
            Permissions, engine binary, and quick project actions.
          </p>
          {error && <div className="error-banner">{error}</div>}

          <h2 className="settings-group-title">Permissions</h2>
          <div className="settings-group-card">
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">Tool permission</div>
                <div className="settings-row-desc">
                  Applied on the next connect / new task
                </div>
              </div>
              <select
                className="settings-select settings-row-control"
                value={permissionMode}
                onChange={(e) => onPermissionModeChange(e.target.value)}
              >
                <option value="ask">Needs approval</option>
                <option value="auto">Auto</option>
                <option value="always-approve">Full trust</option>
              </select>
            </div>
          </div>

          <h2 className="settings-group-title">Engine</h2>
          <div className="settings-group-card">
            <div className="settings-row settings-row-stack">
              <div className="settings-row-text">
                <div className="settings-row-label">
                  Custom engine path
                </div>
                <div className="settings-row-desc">
                  Optional override for the bundled grok binary
                </div>
              </div>
              <input
                className="settings-row-input"
                value={cfgEnginePath}
                onChange={(e) => setCfgEnginePath(e.target.value)}
                placeholder="/path/to/grok"
              />
            </div>
            {engine && (
              <div className="settings-row settings-row-stack">
                <div className="settings-row-text">
                  <div className="settings-row-label">Runtime</div>
                  <div className="settings-row-desc mono">
                    {engine.source} · {engine.path}
                    <br />
                    Agent: {agentStatus}
                  </div>
                </div>
              </div>
            )}
          </div>

          <h2 className="settings-group-title">Workspace</h2>
          <div className="settings-group-card">
            {selectedProject && (
              <div className="settings-row settings-row-stack">
                <div className="settings-row-text">
                  <div className="settings-row-label">
                    Selected project
                  </div>
                  <div className="settings-row-desc mono">
                    {selectedProject.root_path}
                    {session?.work_path
                      ? `\nTask cwd: ${session.work_path}`
                      : ""}
                  </div>
                </div>
              </div>
            )}
            <div className="settings-row">
              <div className="settings-row-text">
                <div className="settings-row-label">Actions</div>
                <div className="settings-row-desc">
                  Open a project folder or start a temporary task
                </div>
              </div>
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
            </div>
          </div>
        </>
      )}
    </div>
  </main>
</div>
  );
}
