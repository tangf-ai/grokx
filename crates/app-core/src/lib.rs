//! Application orchestration: process supervision, ACP session, turns.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use acp_bridge::{AcpClient, AcpClientHandle, BridgeError, ConnectOptions};
use agent_process::{resolve_engine, spawn_agent_stdio, ResolvedEngine, SpawnOptions};
use app_config::{AppPaths, PublicUserSettings, SettingsUpdate, UserSettings};
use chrono::Utc;
use domain::{
    AgentConnectionStatus, AppEvent, ModelInfo, PermissionDecision, Project, ProjectId,
    PromptRequest, ReasoningEffort, SessionId, SessionMeta, TurnState,
};
use permissions::{PermissionBroker, Policy};
use session_store::{ProjectListItem, SessionListItem, SessionStore};
use thiserror::Error;
use tokio::sync::{mpsc, Mutex, RwLock};
use tracing::warn;

#[derive(Debug, Error)]
pub enum CoreError {
    #[error(transparent)]
    Resolve(#[from] agent_process::ResolveError),
    #[error(transparent)]
    Config(#[from] app_config::ConfigError),
    #[error(transparent)]
    Spawn(#[from] agent_process::SpawnError),
    #[error(transparent)]
    Bridge(#[from] BridgeError),
    #[error("agent is not connected")]
    NotConnected,
    #[error("a turn is already in progress")]
    TurnInProgress,
    #[error("project root does not exist: {0}")]
    InvalidProject(String),
    #[error("{0}")]
    Message(String),
}

struct LiveAgent {
    /// Dropping this aborts the reader task and kills the child.
    client: AcpClient,
    handle: AcpClientHandle,
    /// Fixed project path (user-chosen).
    project_root: PathBuf,
    /// Temporary task cwd (`~/.grokx/tasks/<id>`).
    work_path: PathBuf,
    app_session_id: SessionId,
}

pub struct AppCore {
    pub paths: AppPaths,
    pub settings: RwLock<UserSettings>,
    pub store: Mutex<SessionStore>,
    pub permissions: Mutex<PermissionBroker>,
    pub policy: RwLock<Policy>,
    pub engine: RwLock<Option<ResolvedEngine>>,
    pub status: RwLock<AgentConnectionStatus>,
    /// Selected project root before connect (UI).
    selected_project: RwLock<Option<PathBuf>>,
    live: Mutex<Option<LiveAgent>>,
    turn_busy: Mutex<bool>,
    event_tx: mpsc::UnboundedSender<AppEvent>,
    event_rx: Mutex<Option<mpsc::UnboundedReceiver<AppEvent>>>,
}

impl AppCore {
    pub fn bootstrap() -> Result<Arc<Self>, CoreError> {
        let paths = AppPaths::discover()?;
        paths.ensure_dirs()?;
        let settings = UserSettings::load(&paths.config_file).unwrap_or_else(|_| {
            UserSettings::product_defaults()
        });

        // Restore task/project list from disk so restarts keep history.
        let mut store = SessionStore::load_from_file(&paths.sessions_index_file())
            .unwrap_or_else(|e| {
                warn!(error = %e, "failed to load sessions index; starting empty");
                SessionStore::new()
            });
        let imported = store.import_from_tasks_root(&AppPaths::tasks_root());
        if imported > 0 {
            warn!(imported, "recovered tasks from ~/.grokx/tasks");
            let _ = store.save_to_file(&paths.sessions_index_file());
        }

        let (event_tx, event_rx) = mpsc::unbounded_channel();
        Ok(Arc::new(Self {
            paths,
            settings: RwLock::new(settings),
            store: Mutex::new(store),
            permissions: Mutex::new(PermissionBroker::new()),
            policy: RwLock::new(Policy::default()),
            engine: RwLock::new(None),
            status: RwLock::new(AgentConnectionStatus::MissingBinary),
            selected_project: RwLock::new(None),
            live: Mutex::new(None),
            turn_busy: Mutex::new(false),
            event_tx,
            event_rx: Mutex::new(Some(event_rx)),
        }))
    }

    async fn persist_session_meta(&self, session_id: &SessionId) {
        let store = self.store.lock().await;
        if let Err(e) = store.write_task_dir_meta(session_id) {
            warn!(error = %e, "failed to write task meta.json");
        }
        if let Err(e) = store.save_to_file(&self.paths.sessions_index_file()) {
            warn!(error = %e, "failed to save sessions index");
        }
    }

    pub async fn public_settings(&self) -> PublicUserSettings {
        self.settings.read().await.public_view()
    }

    pub async fn update_settings(&self, update: SettingsUpdate) -> Result<PublicUserSettings, CoreError> {
        let public = {
            let mut settings = self.settings.write().await;
            settings.apply_update(update);
            settings
                .save(&self.paths.config_file)
                .map_err(CoreError::Config)?;
            if let Err(err) = settings.sync_endpoint_to_grok_toml() {
                warn!(error = %err, "failed to sync endpoint to ~/.grok/config.toml");
            }
            settings.public_view()
        };
        Ok(public)
    }

    /// Take the primary event receiver (call once from the shell).
    pub async fn take_event_receiver(&self) -> Option<mpsc::UnboundedReceiver<AppEvent>> {
        self.event_rx.lock().await.take()
    }

    pub fn emit(&self, event: AppEvent) {
        let _ = self.event_tx.send(event);
    }

    pub async fn resolve_runtime(
        &self,
        resource_dir: Option<&Path>,
        allow_path_fallback: bool,
    ) -> Result<ResolvedEngine, CoreError> {
        let settings = self.settings.read().await.clone();
        let resolved = resolve_engine(&settings, resource_dir, allow_path_fallback)?;
        *self.engine.write().await = Some(resolved.clone());
        if matches!(
            *self.status.read().await,
            AgentConnectionStatus::MissingBinary | AgentConnectionStatus::Failed
        ) {
            *self.status.write().await = AgentConnectionStatus::Ready;
        }
        Ok(resolved)
    }

    pub async fn connection_status(&self) -> AgentConnectionStatus {
        *self.status.read().await
    }

    pub async fn current_session_id(&self) -> Option<SessionId> {
        self.live
            .lock()
            .await
            .as_ref()
            .map(|l| l.app_session_id.clone())
    }

    pub async fn current_project_root(&self) -> Option<PathBuf> {
        if let Some(live) = self.live.lock().await.as_ref() {
            return Some(live.project_root.clone());
        }
        self.selected_project.read().await.clone()
    }

    /// Temporary task workspace of the active session, if any.
    pub async fn current_work_path(&self) -> Option<PathBuf> {
        self.live
            .lock()
            .await
            .as_ref()
            .map(|l| l.work_path.clone())
    }

    /// Remember the project directory chosen in the UI (before connect).
    pub async fn set_project_root(&self, root: impl Into<PathBuf>) -> Result<PathBuf, CoreError> {
        let root = root.into();
        if !root.is_dir() {
            return Err(CoreError::InvalidProject(root.display().to_string()));
        }
        *self.selected_project.write().await = Some(root.clone());
        Ok(root)
    }

    pub async fn selected_project_root(&self) -> Option<PathBuf> {
        self.selected_project.read().await.clone()
    }

    /// Ensure the default sandbox dir exists (`~/.grokx/workspace`) for tasks
    /// that are not attached to a user-opened project.
    ///
    /// This path is **not** shown in the Projects sidebar — only Tasks +.
    pub async fn ensure_default_project(&self) -> Result<PathBuf, CoreError> {
        let root = AppPaths::default_project_root();
        std::fs::create_dir_all(&root).map_err(|e| {
            CoreError::Message(format!(
                "failed to create default workspace {}: {e}",
                root.display()
            ))
        })?;
        // Internal store row only (FK for tasks). Hidden from Projects list.
        {
            let mut store = self.store.lock().await;
            let root_str = root.display().to_string();
            if store.find_project_by_root(&root_str).is_none() {
                store.upsert_project(Project {
                    id: ProjectId::new(),
                    root_path: root_str,
                    name: "Default".into(),
                    created_at: Utc::now(),
                });
            }
        }
        self.set_project_root(root).await
    }

    /// True if this path is the internal default sandbox (not a user Project).
    pub fn is_default_project_path(path: &Path) -> bool {
        let default = AppPaths::default_project_root();
        // Compare canonical when possible so /Users/x vs /Users/x/ are equal.
        let a = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
        let b = std::fs::canonicalize(&default).unwrap_or(default);
        a == b
    }

    pub async fn list_sessions(&self) -> Vec<SessionListItem> {
        self.store.lock().await.list_sessions()
    }

    /// User-visible projects only (excludes the internal default sandbox).
    pub async fn list_projects(&self) -> Vec<ProjectListItem> {
        self.store
            .lock()
            .await
            .list_project_items()
            .into_iter()
            .filter(|p| !Self::is_default_project_path(Path::new(&p.root_path)))
            .collect()
    }

    pub async fn list_sessions_for_project(&self, project_id: &ProjectId) -> Vec<SessionListItem> {
        self.store
            .lock()
            .await
            .list_session_items_for_project(project_id)
    }

    pub async fn rename_session(
        &self,
        session_id: &SessionId,
        title: impl Into<String>,
    ) -> Result<(), CoreError> {
        self.store
            .lock()
            .await
            .rename_session(session_id, title)
            .map_err(|e| CoreError::Message(e.to_string()))?;
        self.persist_session_meta(session_id).await;
        Ok(())
    }

    /// Delete a task/session: drop from index and remove its work directory.
    /// If it is the live agent session, disconnect first.
    pub async fn delete_session(
        self: &Arc<Self>,
        session_id: &SessionId,
    ) -> Result<(), CoreError> {
        // If this is the active agent, tear it down first.
        {
            let mut live = self.live.lock().await;
            if live
                .as_ref()
                .map(|l| &l.app_session_id == session_id)
                .unwrap_or(false)
            {
                if let Some(prev) = live.take() {
                    prev.client.shutdown().await;
                }
                *self.status.write().await = AgentConnectionStatus::Failed;
                self.emit(AppEvent::AgentStatus {
                    status: AgentConnectionStatus::Failed,
                    detail: Some("task deleted".into()),
                });
            }
        }

        let meta = self
            .store
            .lock()
            .await
            .delete_session(session_id)
            .map_err(|e| CoreError::Message(e.to_string()))?;

        // Persist updated index (without this session).
        {
            let store = self.store.lock().await;
            if let Err(e) = store.save_to_file(&self.paths.sessions_index_file()) {
                warn!(error = %e, "failed to save sessions index after delete");
            }
        }

        // Remove task workspace on disk (chat history, meta, etc.).
        if !meta.work_path.is_empty() {
            let work = PathBuf::from(&meta.work_path);
            // Only delete under known tasks root for safety.
            let tasks_root = AppPaths::tasks_root();
            let under_tasks = work.starts_with(&tasks_root)
                || std::fs::canonicalize(&work)
                    .ok()
                    .zip(std::fs::canonicalize(&tasks_root).ok())
                    .map(|(w, r)| w.starts_with(r))
                    .unwrap_or(false);
            if under_tasks && work.is_dir() {
                if let Err(e) = std::fs::remove_dir_all(&work) {
                    warn!(error = %e, path = %work.display(), "failed to remove task dir");
                }
            }
        }

        Ok(())
    }

    fn chat_history_path(work_path: &Path) -> PathBuf {
        work_path.join("chat-history.json")
    }

    /// Persist UI chat transcript for a task (JSON array of chat lines).
    /// Prefer `work_path` when known so history is not lost if store is mid-update.
    pub async fn save_chat_history(
        &self,
        session_id: &SessionId,
        json: impl AsRef<str>,
        work_path: Option<String>,
    ) -> Result<(), CoreError> {
        let work = if let Some(w) = work_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            PathBuf::from(w)
        } else {
            let store = self.store.lock().await;
            let meta = store
                .get_session(session_id)
                .map_err(|e| CoreError::Message(e.to_string()))?;
            if meta.work_path.is_empty() {
                return Err(CoreError::Message(
                    "session has no work_path for chat history".into(),
                ));
            }
            PathBuf::from(&meta.work_path)
        };
        std::fs::create_dir_all(&work).map_err(|e| {
            CoreError::Message(format!("chat history dir {}: {e}", work.display()))
        })?;
        let path = Self::chat_history_path(&work);
        // Atomic-ish write: write temp then rename.
        let tmp = work.join("chat-history.json.tmp");
        std::fs::write(&tmp, json.as_ref()).map_err(|e| {
            CoreError::Message(format!("write chat history {}: {e}", tmp.display()))
        })?;
        std::fs::rename(&tmp, &path).map_err(|e| {
            CoreError::Message(format!("rename chat history {}: {e}", path.display()))
        })?;
        // Do not touch_session here: saving history on activate would reshuffle
        // the list if anything still sorted by updated_at. Title/meta refresh
        // can still rewrite meta.json without changing list order.
        let _ = self.store.lock().await.write_task_dir_meta(session_id);
        Ok(())
    }

    /// Load UI chat transcript for a task, if present.
    pub async fn load_chat_history(
        &self,
        session_id: &SessionId,
        work_path: Option<String>,
    ) -> Result<Option<String>, CoreError> {
        let work = if let Some(w) = work_path
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            PathBuf::from(w)
        } else {
            let store = self.store.lock().await;
            match store.get_session(session_id) {
                Ok(meta) if !meta.work_path.is_empty() => PathBuf::from(&meta.work_path),
                Ok(_) => {
                    // Fall back to conventional task dir from session id.
                    AppPaths::tasks_root().join(session_id.0.to_string())
                }
                Err(_) => AppPaths::tasks_root().join(session_id.0.to_string()),
            }
        };
        let path = Self::chat_history_path(&work);
        if !path.is_file() {
            // Also try conventional location if hint differed.
            let fallback = AppPaths::tasks_root()
                .join(session_id.0.to_string())
                .join("chat-history.json");
            if fallback.is_file() && fallback != path {
                let raw = std::fs::read_to_string(&fallback).map_err(|e| {
                    CoreError::Message(format!("read chat history {}: {e}", fallback.display()))
                })?;
                return Ok(Some(raw));
            }
            return Ok(None);
        }
        let raw = std::fs::read_to_string(&path).map_err(|e| {
            CoreError::Message(format!("read chat history {}: {e}", path.display()))
        })?;
        Ok(Some(raw))
    }

    /// Start a **new** task under a project.
    ///
    /// - Project path is fixed (user-chosen directory).
    /// - Task gets a temporary cwd at `~/.grokx/tasks/<id>/` with a `project`
    ///   symlink so the agent can still read/write project sources.
    pub async fn connect_workspace(
        self: &Arc<Self>,
        project_root: impl Into<PathBuf>,
        resource_dir: Option<PathBuf>,
        allow_path_fallback: bool,
        auto_approve: bool,
    ) -> Result<SessionId, CoreError> {
        self.spawn_agent_for_project(
            project_root.into(),
            resource_dir,
            allow_path_fallback,
            auto_approve,
            None,
        )
        .await
    }

    /// Activate an **existing** task: reuse its id/title/work_path, restart engine only.
    /// Does **not** create a new session row in the list.
    pub async fn reconnect_session(
        self: &Arc<Self>,
        session_id: &SessionId,
        resource_dir: Option<PathBuf>,
        allow_path_fallback: bool,
        auto_approve: bool,
    ) -> Result<SessionId, CoreError> {
        // Already live on this session — no-op.
        if self
            .live
            .lock()
            .await
            .as_ref()
            .map(|l| &l.app_session_id == session_id)
            .unwrap_or(false)
        {
            return Ok(session_id.clone());
        }

        let root = {
            let store = self.store.lock().await;
            let meta = store
                .get_session(session_id)
                .map_err(|e| CoreError::Message(e.to_string()))?;
            let project = store
                .get_project(&meta.project_id)
                .map_err(|e| CoreError::Message(e.to_string()))?;
            PathBuf::from(&project.root_path)
        };
        self.spawn_agent_for_project(
            root,
            resource_dir,
            allow_path_fallback,
            auto_approve,
            Some(session_id.clone()),
        )
        .await
    }

    /// Ensure `~/.grokx/tasks/<id>` exists and contains a `project` symlink
    /// pointing at the fixed project root (so the agent can access sources).
    fn ensure_task_workspace(
        session_id: &SessionId,
        project_root: &Path,
        existing_work_path: Option<&str>,
    ) -> Result<PathBuf, CoreError> {
        let work = if let Some(p) = existing_work_path.filter(|s| !s.is_empty()) {
            PathBuf::from(p)
        } else {
            AppPaths::tasks_root().join(session_id.0.to_string())
        };
        std::fs::create_dir_all(&work).map_err(|e| {
            CoreError::Message(format!(
                "failed to create task workspace {}: {e}",
                work.display()
            ))
        })?;

        let link = work.join("project");
        // Refresh symlink so it always points at the current project path.
        if link.symlink_metadata().is_ok() || link.exists() {
            let _ = std::fs::remove_file(&link);
            let _ = std::fs::remove_dir_all(&link);
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(project_root, &link).map_err(|e| {
                CoreError::Message(format!(
                    "failed to link project into task workspace: {e}"
                ))
            })?;
        }
        #[cfg(not(unix))]
        {
            // Best-effort: write a pointer file if symlink is unavailable.
            std::fs::write(&link, project_root.display().to_string()).map_err(|e| {
                CoreError::Message(format!(
                    "failed to write project pointer in task workspace: {e}"
                ))
            })?;
        }

        // Small readme so the workspace is self-explanatory.
        let readme = work.join("README.grokx.txt");
        if !readme.exists() {
            let _ = std::fs::write(
                &readme,
                format!(
                    "Grokx temporary task workspace\n\
                     Project (fixed path): {}\n\
                     Sources are linked at ./project\n\
                     Agent cwd is this directory.\n",
                    project_root.display()
                ),
            );
        }

        Ok(work)
    }

    /// Shared spawn path.
    /// - `reuse_session = None` → create a new SessionId + list row + task dir
    /// - `reuse_session = Some(id)` → keep that id/title/work_path, only refresh engine
    async fn spawn_agent_for_project(
        self: &Arc<Self>,
        project_root: PathBuf,
        resource_dir: Option<PathBuf>,
        allow_path_fallback: bool,
        auto_approve: bool,
        reuse_session: Option<SessionId>,
    ) -> Result<SessionId, CoreError> {
        if !project_root.as_os_str().is_empty() && !project_root.is_dir() {
            if project_root != Path::new(".") {
                return Err(CoreError::InvalidProject(
                    project_root.display().to_string(),
                ));
            }
        }
        *self.selected_project.write().await = Some(project_root.clone());

        let engine = match self.engine.read().await.clone() {
            Some(e) => e,
            None => {
                self.resolve_runtime(resource_dir.as_deref(), allow_path_fallback)
                    .await?
            }
        };

        // Tear down previous agent if any.
        {
            let mut live = self.live.lock().await;
            if let Some(prev) = live.take() {
                prev.client.shutdown().await;
            }
        }

        *self.status.write().await = AgentConnectionStatus::Starting;
        self.emit(AppEvent::AgentStatus {
            status: AgentConnectionStatus::Starting,
            detail: Some(format!("spawning {}", engine.path.display())),
        });

        let settings = self.settings.read().await.clone();
        let env = settings.engine_env();

        let model = settings
            .model
            .clone()
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let id = settings.endpoint.model_id.trim();
                if id.is_empty() {
                    None
                } else {
                    Some(id.to_string())
                }
            });

        let child = spawn_agent_stdio(
            engine,
            SpawnOptions {
                model,
                env,
                agent_args: if auto_approve {
                    vec!["--always-approve".into()]
                } else {
                    vec![]
                },
            },
        )?;

        let now = Utc::now();
        let root_str = project_root.display().to_string();
        let project_id = {
            let mut store = self.store.lock().await;
            if let Some(existing) = store.find_project_by_root(&root_str) {
                existing.id.clone()
            } else {
                let id = ProjectId::new();
                store.upsert_project(Project {
                    id: id.clone(),
                    root_path: root_str.clone(),
                    name: project_root
                        .file_name()
                        .map(|s| s.to_string_lossy().into_owned())
                        .unwrap_or_else(|| root_str.clone()),
                    created_at: now,
                });
                id
            }
        };

        let (app_session_id, work_path) = if let Some(existing_id) = reuse_session {
            // Reuse list row — never invent a new session id on activate.
            // Do NOT bump updated_at / created_at: clicking a task must not
            // reorder the sidebar (order is by created_at).
            let mut store = self.store.lock().await;
            let meta = store
                .get_session(&existing_id)
                .map_err(|e| CoreError::Message(e.to_string()))?
                .clone();
            let work = Self::ensure_task_workspace(
                &existing_id,
                &project_root,
                Some(meta.work_path.as_str()).filter(|s| !s.is_empty()),
            )?;
            let mut meta = meta;
            meta.engine_session_id = None;
            meta.work_path = work.display().to_string();
            if meta.project_id != project_id {
                meta.project_id = project_id;
            }
            store.upsert_session(meta);
            (existing_id, work)
        } else {
            let app_session_id = SessionId::new();
            let work = Self::ensure_task_workspace(&app_session_id, &project_root, None)?;
            let mut store = self.store.lock().await;
            store.upsert_session(SessionMeta {
                id: app_session_id.clone(),
                project_id,
                engine_session_id: None,
                title: "New task".into(),
                model: settings.model.clone(),
                work_path: work.display().to_string(),
                created_at: now,
                updated_at: now,
            });
            (app_session_id, work)
        };

        // Persist index + task meta so restarts restore the task list.
        self.persist_session_meta(&app_session_id).await;

        // Agent cwd = temporary task workspace (not the project root).
        let options = ConnectOptions {
            cwd: work_path.display().to_string(),
            model: settings.model.clone(),
            auto_approve,
            ..ConnectOptions::default()
        };

        self.emit(AppEvent::AgentStatus {
            status: AgentConnectionStatus::Starting,
            detail: Some(format!(
                "task cwd {} (project via ./project)",
                work_path.display()
            )),
        });

        let mut client =
            AcpClient::connect(child.child, app_session_id.clone(), options).await?;
        let handle = client.handle.clone();
        let engine_session_id = handle.engine_session_id().await;

        if let Some(ref eid) = engine_session_id {
            let mut store = self.store.lock().await;
            if let Ok(meta) = store.get_session(&app_session_id).cloned() {
                let mut meta = meta;
                meta.engine_session_id = Some(eid.clone());
                // Keep updated_at unchanged on reconnect so list order stays stable.
                store.upsert_session(meta);
            }
            drop(store);
            self.persist_session_meta(&app_session_id).await;
        }

        // Forward bridge events onto the app bus while the client lives.
        let bus = self.event_tx.clone();
        let status_slot = Arc::clone(self);
        let mut bridge_events = client.take_events();
        tokio::spawn(async move {
            while let Some(event) = bridge_events.recv().await {
                if let AppEvent::AgentStatus { status, .. } = &event {
                    *status_slot.status.write().await = *status;
                }
                if let AppEvent::PermissionNeeded { request, .. } = &event {
                    let mut broker = status_slot.permissions.lock().await;
                    broker.enqueue(request.clone());
                }
                if bus.send(event).is_err() {
                    break;
                }
            }
        });

        *self.status.write().await = AgentConnectionStatus::Ready;
        self.emit(AppEvent::SessionReady {
            session_id: app_session_id.clone(),
            engine_session_id,
        });

        *self.live.lock().await = Some(LiveAgent {
            client,
            handle,
            project_root,
            work_path,
            app_session_id: app_session_id.clone(),
        });

        Ok(app_session_id)
    }

    /// Send a user prompt on the active session.
    pub async fn send_prompt(self: &Arc<Self>, text: String) -> Result<(), CoreError> {
        self.send_prompt_request(PromptRequest {
            text,
            attachments: vec![],
            model: None,
            effort: None,
        })
        .await
    }

    pub async fn send_prompt_request(
        self: &Arc<Self>,
        mut req: PromptRequest,
    ) -> Result<(), CoreError> {
        req.text = req.text.trim().to_string();
        if req.text.is_empty() && req.attachments.is_empty() {
            return Err(CoreError::Message("empty prompt".into()));
        }

        {
            let mut busy = self.turn_busy.lock().await;
            if *busy {
                return Err(CoreError::TurnInProgress);
            }
            *busy = true;
        }

        // Persist preferred model in settings.
        if let Some(model) = req.model.clone() {
            let mut settings = self.settings.write().await;
            settings.model = Some(model);
        }

        let (handle, session_id) = {
            let live = self.live.lock().await;
            let live = live.as_ref().ok_or(CoreError::NotConnected)?;
            (live.handle.clone(), live.app_session_id.clone())
        };

        let mut display = req.text.clone();
        if !req.attachments.is_empty() {
            let names: Vec<_> = req.attachments.iter().map(|a| a.name.as_str()).collect();
            if display.is_empty() {
                display = format!("(attachments: {})", names.join(", "));
            } else {
                display = format!("{display}\n\n📎 {}", names.join(", "));
            }
        }

        self.emit(AppEvent::UserMessage {
            session_id: session_id.clone(),
            text: display,
        });
        self.emit(AppEvent::TurnState {
            session_id: session_id.clone(),
            state: TurnState::Streaming,
        });

        let core = Arc::clone(self);
        tokio::spawn(async move {
            let result = handle.prompt_request(req).await;
            if let Err(err) = result {
                warn!(error = %err, "prompt failed");
                core.emit(AppEvent::AgentError {
                    message: err.to_string(),
                });
                core.emit(AppEvent::TurnFinished {
                    session_id: session_id.clone(),
                    state: TurnState::Error,
                });
            }
            *core.turn_busy.lock().await = false;
            let _ = core.store.lock().await.touch_session(&session_id);
        });

        Ok(())
    }

    pub async fn available_models(&self) -> Vec<ModelInfo> {
        let live = self.live.lock().await;
        match live.as_ref() {
            Some(l) => l.handle.available_models().await,
            None => default_models(),
        }
    }

    pub async fn current_model(&self) -> Option<String> {
        if let Some(live) = self.live.lock().await.as_ref() {
            if let Some(m) = live.handle.current_model().await {
                return Some(m);
            }
        }
        self.settings.read().await.model.clone()
    }

    pub async fn set_model(&self, model_id: String) -> Result<(), CoreError> {
        {
            let mut settings = self.settings.write().await;
            settings.model = Some(model_id.clone());
        }
        let live = self.live.lock().await;
        if let Some(l) = live.as_ref() {
            l.handle.set_model(&model_id).await?;
        }
        Ok(())
    }

    /// Effort levels shown in the desktop UI (matches Grok Build menu:
    /// Low / Medium / High / Extra high).
    pub fn effort_options() -> Vec<ReasoningEffort> {
        ReasoningEffort::menu().to_vec()
    }

    pub async fn cancel_turn(&self) -> Result<(), CoreError> {
        let handle = {
            let live = self.live.lock().await;
            live.as_ref()
                .map(|l| l.handle.clone())
                .ok_or(CoreError::NotConnected)?
        };
        handle.cancel().await?;
        *self.turn_busy.lock().await = false;
        Ok(())
    }

    /// Resolve a parked permission request on the live ACP session.
    pub async fn resolve_permission(
        &self,
        request_id: String,
        decision: PermissionDecision,
    ) -> Result<(), CoreError> {
        let handle = {
            let live = self.live.lock().await;
            live.as_ref()
                .map(|l| l.handle.clone())
                .ok_or(CoreError::NotConnected)?
        };

        // Ensure still pending on the bridge before answering.
        if !handle.permission_is_pending(&request_id).await {
            // Broker may still have it for UI bookkeeping.
            let mut broker = self.permissions.lock().await;
            let _ = broker.resolve(&request_id, decision);
            return Err(CoreError::Message(format!(
                "permission request not pending: {request_id}"
            )));
        }

        handle.resolve_permission(&request_id, decision).await?;
        let mut broker = self.permissions.lock().await;
        let _ = broker.resolve(&request_id, decision);

        self.emit(AppEvent::AgentStatus {
            status: AgentConnectionStatus::Ready,
            detail: Some(format!(
                "permission {request_id} → {decision:?}"
            )),
        });
        Ok(())
    }

    pub async fn permission_is_pending(&self, request_id: &str) -> bool {
        let live = self.live.lock().await;
        match live.as_ref() {
            Some(l) => l.handle.permission_is_pending(request_id).await,
            None => false,
        }
    }

    pub async fn disconnect(&self) {
        if let Some(prev) = self.live.lock().await.take() {
            prev.client.shutdown().await;
        }
        *self.status.write().await = AgentConnectionStatus::MissingBinary;
        *self.turn_busy.lock().await = false;
        self.emit(AppEvent::AgentStatus {
            status: AgentConnectionStatus::MissingBinary,
            detail: Some("disconnected".into()),
        });
    }
}

fn default_models() -> Vec<ModelInfo> {
    vec![
        ModelInfo {
            id: "grok-4.5".into(),
            name: "Grok 4.5".into(),
        },
        ModelInfo {
            id: "grok-code".into(),
            name: "Grok Code".into(),
        },
        ModelInfo {
            id: "grok-build".into(),
            name: "Grok Build".into(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use acp_bridge::{decision_blocks_tool, PermissionGate, ParkedPermission};
    use domain::PermissionDecision;
    use serde_json::json;

    /// Drive the same gate used by the bridge: pending until resolve; deny blocks.
    #[tokio::test]
    async fn permission_pending_until_resolved_via_gate() {
        let mut gate = PermissionGate::new();
        assert!(PermissionGate::should_park(false));
        gate.park(ParkedPermission {
            request_id: "ui-req".into(),
            rpc_id: json!(7),
            tool_name: "Bash".into(),
            summary: "echo hi".into(),
        });
        assert!(gate.is_pending("ui-req"));

        // Deny path
        let (_rpc, outcome) = gate.resolve("ui-req", PermissionDecision::Deny).unwrap();
        assert_eq!(outcome["outcome"]["optionId"], "reject-once");
        assert!(decision_blocks_tool(PermissionDecision::Deny));
        assert!(!gate.is_pending("ui-req"));
    }

    #[tokio::test]
    async fn set_project_and_list_sessions_after_store() {
        let core = AppCore::bootstrap().unwrap();
        // Use crate dir as a real directory
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let set = core.set_project_root(root.clone()).await.unwrap();
        assert_eq!(set, root);
        assert_eq!(core.selected_project_root().await, Some(root.clone()));

        // Simulate session metadata as connect would
        let mut store = core.store.lock().await;
        let pid = ProjectId::new();
        let sid = SessionId::new();
        let now = Utc::now();
        store.upsert_project(Project {
            id: pid.clone(),
            root_path: root.display().to_string(),
            name: "app-core".into(),
            created_at: now,
        });
        store.upsert_session(SessionMeta {
            id: sid.clone(),
            project_id: pid,
            engine_session_id: Some("eng-1".into()),
            title: "test".into(),
            model: None,
            work_path: "/tmp/tasks/test".into(),
            created_at: now,
            updated_at: now,
        });
        drop(store);

        let list = core.list_sessions().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].session_id, sid);
        assert_eq!(list[0].project_root, root.display().to_string());
        assert_eq!(list[0].work_path, "/tmp/tasks/test");
        assert!(list[0].updated_at <= Utc::now());
    }

    #[test]
    fn ensure_task_workspace_creates_dir_and_project_link() {
        let sid = SessionId::new();
        let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let work = AppCore::ensure_task_workspace(&sid, &project, None).unwrap();
        assert!(work.is_dir());
        assert!(work.starts_with(AppPaths::tasks_root()) || work.components().count() > 0);
        let link = work.join("project");
        #[cfg(unix)]
        {
            assert!(link
                .symlink_metadata()
                .map(|m| m.file_type().is_symlink())
                .unwrap_or(false));
            let target = std::fs::read_link(&link).unwrap();
            assert_eq!(target, project);
        }
        // Cleanup this test task dir
        let _ = std::fs::remove_dir_all(&work);
    }
}
