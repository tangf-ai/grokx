//! Application orchestration: process supervision, ACP session, turns.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use acp_bridge::{AcpClient, AcpClientHandle, BridgeError, ConnectOptions};
use agent_process::{resolve_engine, spawn_agent_stdio, ResolvedEngine, SpawnOptions};
use app_config::{AppPaths, UserSettings};
use chrono::Utc;
use domain::{
    AgentConnectionStatus, AppEvent, PermissionDecision, Project, ProjectId, SessionId,
    SessionMeta, TurnState,
};
use permissions::{PermissionBroker, Policy};
use session_store::{SessionListItem, SessionStore};
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
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        Ok(Arc::new(Self {
            paths,
            settings: RwLock::new(UserSettings::product_defaults()),
            store: Mutex::new(SessionStore::new()),
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

    pub async fn list_sessions(&self) -> Vec<SessionListItem> {
        self.store.lock().await.list_sessions()
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
        if !project_root.as_os_str().is_empty() && !project_root.is_dir() {
            // Allow "." and relative paths that exist after canonicalize attempt.
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
        {
            let mut store = self.store.lock().await;
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
            cwd: root_str,
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
            app_session_id: app_session_id.clone(),
        });

        Ok(app_session_id)
    }

    /// Reconnect by starting a new agent session for a known session's project.
    pub async fn reconnect_session(
        self: &Arc<Self>,
        session_id: &SessionId,
        resource_dir: Option<PathBuf>,
        allow_path_fallback: bool,
        auto_approve: bool,
    ) -> Result<SessionId, CoreError> {
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
        self.connect_workspace(root, resource_dir, allow_path_fallback, auto_approve)
            .await
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
            created_at: now,
            updated_at: now,
        });
        drop(store);

        let list = core.list_sessions().await;
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].session_id, sid);
        assert_eq!(list[0].project_root, root.display().to_string());
        assert!(list[0].updated_at <= Utc::now());
    }
}
