//! Application orchestration: ties process supervision, ACP, permissions, and storage.
//!
//! Full turn lifecycle (prompt → stream → approve → finish) will grow here.
//! For the scaffold we expose a small façade the Tauri layer can depend on.

use std::path::Path;
use std::sync::Arc;

use agent_process::{resolve_engine, ResolvedEngine};
use app_config::{AppPaths, UserSettings};
use domain::{AgentConnectionStatus, AppEvent};
use permissions::{PermissionBroker, Policy};
use session_store::SessionStore;
use thiserror::Error;
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Error)]
pub enum CoreError {
    #[error(transparent)]
    Resolve(#[from] agent_process::ResolveError),
    #[error(transparent)]
    Config(#[from] app_config::ConfigError),
    #[error("{0}")]
    Message(String),
}

pub struct AppCore {
    pub paths: AppPaths,
    pub settings: RwLock<UserSettings>,
    pub store: Mutex<SessionStore>,
    pub permissions: Mutex<PermissionBroker>,
    pub policy: RwLock<Policy>,
    pub engine: RwLock<Option<ResolvedEngine>>,
    pub status: RwLock<AgentConnectionStatus>,
}

impl AppCore {
    pub fn bootstrap() -> Result<Arc<Self>, CoreError> {
        let paths = AppPaths::discover()?;
        paths.ensure_dirs()?;
        Ok(Arc::new(Self {
            paths,
            settings: RwLock::new(UserSettings::product_defaults()),
            store: Mutex::new(SessionStore::new()),
            permissions: Mutex::new(PermissionBroker::new()),
            policy: RwLock::new(Policy::default()),
            engine: RwLock::new(None),
            status: RwLock::new(AgentConnectionStatus::MissingBinary),
        }))
    }

    /// Resolve engine path for the given resource directory (Tauri resource dir).
    pub async fn resolve_runtime(
        &self,
        resource_dir: Option<&Path>,
        allow_path_fallback: bool,
    ) -> Result<ResolvedEngine, CoreError> {
        let settings = self.settings.read().await.clone();
        let resolved = resolve_engine(&settings, resource_dir, allow_path_fallback)?;
        *self.engine.write().await = Some(resolved.clone());
        *self.status.write().await = AgentConnectionStatus::Ready;
        Ok(resolved)
    }

    pub async fn connection_status(&self) -> AgentConnectionStatus {
        *self.status.read().await
    }

    pub fn status_event(status: AgentConnectionStatus, detail: Option<String>) -> AppEvent {
        AppEvent::AgentStatus { status, detail }
    }
}
