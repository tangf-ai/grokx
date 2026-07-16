//! Application paths, settings, and bundled runtime metadata.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use thiserror::Error;

pub const APP_QUALIFIER: &str = "app";
pub const APP_ORGANIZATION: &str = "grokx";
pub const APP_NAME: &str = "grokx";

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("could not resolve application data directory")]
    NoDataDir,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// Well-known directories for the desktop product (isolated from ~/.grok).
#[derive(Debug, Clone)]
pub struct AppPaths {
    pub data_dir: PathBuf,
    pub config_file: PathBuf,
    pub sessions_db: PathBuf,
    pub logs_dir: PathBuf,
    pub engine_data_dir: PathBuf,
}

impl AppPaths {
    pub fn discover() -> Result<Self, ConfigError> {
        let base = directories::ProjectDirs::from(APP_QUALIFIER, APP_ORGANIZATION, APP_NAME)
            .ok_or(ConfigError::NoDataDir)?;
        let data_dir = base.data_dir().to_path_buf();
        Ok(Self {
            config_file: data_dir.join("config.toml"),
            sessions_db: data_dir.join("sessions.db"),
            logs_dir: data_dir.join("logs"),
            engine_data_dir: data_dir.join("engine-data"),
            data_dir,
        })
    }

    pub fn ensure_dirs(&self) -> Result<(), ConfigError> {
        std::fs::create_dir_all(&self.data_dir)?;
        std::fs::create_dir_all(&self.logs_dir)?;
        std::fs::create_dir_all(&self.engine_data_dir)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UserSettings {
    /// Optional override for the grok binary (debug / power users).
    pub custom_engine_path: Option<String>,
    /// Prefer bundled runtime when no custom path is set.
    pub prefer_bundled_engine: bool,
    pub model: Option<String>,
}

impl UserSettings {
    pub fn product_defaults() -> Self {
        Self {
            custom_engine_path: None,
            prefer_bundled_engine: true,
            model: None,
        }
    }
}

/// Written next to the bundled binary by packaging scripts.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeVersion {
    pub app_version: String,
    pub engine_name: String,
    pub engine_version: String,
    pub engine_commit: String,
    pub engine_channel: String,
}

impl RuntimeVersion {
    pub fn load(path: impl AsRef<Path>) -> Result<Self, ConfigError> {
        let raw = std::fs::read_to_string(path)?;
        Ok(serde_json::from_str(&raw)?)
    }
}

/// Relative resource path used inside the Tauri bundle.
pub fn bundled_runtime_relative() -> &'static str {
    if cfg!(windows) {
        "runtime/grok.exe"
    } else {
        "runtime/grok"
    }
}

pub fn bundled_version_relative() -> &'static str {
    "runtime/version.json"
}
