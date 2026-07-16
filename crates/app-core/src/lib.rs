//! Application orchestration: process supervision, ACP session, turns.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use acp_bridge::{AcpClient, AcpClientHandle, BridgeError, ConnectOptions};
use agent_process::{resolve_engine, spawn_agent_stdio, ResolvedEngine, SpawnOptions};
use app_config::{AppPaths, UserSettings};
use chrono::Utc;
use domain::{
    AgentConnectionStatus, AppEvent, Project, ProjectId, SessionId, SessionMeta, TurnState,
};
use permissions::{PermissionBroker, Policy};
use session_store::SessionStore;
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
    #[error("{0}")]
    Message(String),
}

struct LiveAgent {
    /// Dropping this aborts the reader task and kills the child.
    client: AcpClient,
    handle: AcpClientHandle,
    project_root: PathBuf,
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
    live: Mutex<Option<LiveAgent>>,
    turn_busy: Mutex<bool>,
    event_tx: mpsc::UnboundedSender<AppEvent>,
    event_rx: Mutex<Option<mpsc::UnboundedReceiver<AppEvent>>>,
}

impl AppCore {
    pub fn bootstrap() -> Result<Arc<Self>, CoreError> {
        let paths = AppPaths::discover()?;
        paths.ensure_dirs()?;
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        Ok(Arc::new(Self {
            paths,
            settings: RwLock::new(UserSettings::product_defaults()),
            store: Mutex::new(SessionStore::new()),
            permissions: Mutex::new(PermissionBroker::new()),
            policy: RwLock::new(Policy::default()),
            engine: RwLock::new(None),
            status: RwLock::new(AgentConnectionStatus::MissingBinary),
            live: Mutex::new(None),
            turn_busy: Mutex::new(false),
            event_tx,
            event_rx: Mutex::new(Some(event_rx)),
        }))
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
        self.live
            .lock()
            .await
            .as_ref()
            .map(|l| l.project_root.clone())
    }

    /// Start (or restart) the agent for a project workspace.
    pub async fn connect_workspace(
        self: &Arc<Self>,
        project_root: impl Into<PathBuf>,
        resource_dir: Option<PathBuf>,
        allow_path_fallback: bool,
        auto_approve: bool,
    ) -> Result<SessionId, CoreError> {
        let project_root = project_root.into();
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
        // Do not override GROK_HOME by default: agent needs the user's existing
        // auth (~/.grok). Product-specific isolation can be opt-in later.
        let env = vec![];

        let child = spawn_agent_stdio(
            engine,
            SpawnOptions {
                model: settings.model.clone(),
                env,
                agent_args: if auto_approve {
                    vec!["--always-approve".into()]
                } else {
                    vec![]
                },
            },
        )?;

        let app_session_id = SessionId::new();
        let project_id = ProjectId::new();
        let now = Utc::now();
        {
            let mut store = self.store.lock().await;
            store.upsert_project(Project {
                id: project_id.clone(),
                root_path: project_root.display().to_string(),
                name: project_root
                    .file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| project_root.display().to_string()),
                created_at: now,
            });
            store.upsert_session(SessionMeta {
                id: app_session_id.clone(),
                project_id,
                engine_session_id: None,
                title: "New session".into(),
                model: settings.model.clone(),
                created_at: now,
                updated_at: now,
            });
        }

        let options = ConnectOptions {
            cwd: project_root.display().to_string(),
            model: settings.model.clone(),
            auto_approve,
            ..ConnectOptions::default()
        };

        let mut client =
            AcpClient::connect(child.child, app_session_id.clone(), options).await?;
        let handle = client.handle.clone();
        let engine_session_id = handle.engine_session_id().await;

        if let Some(ref eid) = engine_session_id {
            let mut store = self.store.lock().await;
            if let Ok(meta) = store.get_session(&app_session_id).cloned() {
                let mut meta = meta;
                meta.engine_session_id = Some(eid.clone());
                store.upsert_session(meta);
            }
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
            app_session_id: app_session_id.clone(),
        });

        Ok(app_session_id)
    }

    /// Send a user prompt on the active session.
    pub async fn send_prompt(self: &Arc<Self>, text: String) -> Result<(), CoreError> {
        let text = text.trim().to_string();
        if text.is_empty() {
            return Err(CoreError::Message("empty prompt".into()));
        }

        {
            let mut busy = self.turn_busy.lock().await;
            if *busy {
                return Err(CoreError::TurnInProgress);
            }
            *busy = true;
        }

        let (handle, session_id) = {
            let live = self.live.lock().await;
            let live = live.as_ref().ok_or(CoreError::NotConnected)?;
            (live.handle.clone(), live.app_session_id.clone())
        };

        self.emit(AppEvent::UserMessage {
            session_id: session_id.clone(),
            text: text.clone(),
        });
        self.emit(AppEvent::TurnState {
            session_id: session_id.clone(),
            state: TurnState::Streaming,
        });

        let core = Arc::clone(self);
        tokio::spawn(async move {
            let result = handle.prompt(&text).await;
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
