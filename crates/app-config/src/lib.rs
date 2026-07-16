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
            config_file: data_dir.join("settings.json"),
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

    /// Default path of the Grok CLI config that the engine reads.
    pub fn grok_cli_config() -> PathBuf {
        directories::UserDirs::new()
            .map(|u| u.home_dir().join(".grok").join("config.toml"))
            .unwrap_or_else(|| PathBuf::from("~/.grok/config.toml"))
    }
}

/// LLM endpoint / model parameters used by the desktop app and engine.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ModelEndpointSettings {
    /// Model id (e.g. grok-4.5).
    pub model_id: String,
    /// Display name.
    pub name: Option<String>,
    /// OpenAI-compatible base URL, e.g. https://api.x.ai/v1
    pub base_url: Option<String>,
    /// API key (stored locally; never log).
    pub api_key: Option<String>,
    /// Env var name to read key from instead of api_key (optional).
    pub env_key: Option<String>,
    /// chat_completions | responses | anthropic_messages (engine field).
    pub api_backend: Option<String>,
    pub context_window: Option<u64>,
    /// Default reasoning effort for new turns.
    pub default_effort: Option<String>,
}

impl Default for ModelEndpointSettings {
    fn default() -> Self {
        Self {
            model_id: "grok-4.5".into(),
            name: Some("Grok 4.5".into()),
            base_url: None,
            api_key: None,
            env_key: None,
            api_backend: Some("chat_completions".into()),
            context_window: Some(500_000),
            default_effort: Some("medium".into()),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UserSettings {
    /// Optional override for the grok binary (debug / power users).
    pub custom_engine_path: Option<String>,
    /// Prefer bundled runtime when no custom path is set.
    pub prefer_bundled_engine: bool,
    /// Last selected model id (composer).
    pub model: Option<String>,
    /// Last selected effort.
    pub effort: Option<String>,
    /// LLM endpoint configuration.
    #[serde(default)]
    pub endpoint: ModelEndpointSettings,
    /// Also write endpoint into ~/.grok/config.toml so the engine picks it up.
    #[serde(default = "default_true")]
    pub sync_to_grok_config: bool,
}

fn default_true() -> bool {
    true
}

impl Default for UserSettings {
    fn default() -> Self {
        Self::product_defaults()
    }
}

impl UserSettings {
    pub fn product_defaults() -> Self {
        Self {
            custom_engine_path: None,
            prefer_bundled_engine: true,
            model: Some("grok-4.5".into()),
            effort: Some("medium".into()),
            endpoint: ModelEndpointSettings::default(),
            sync_to_grok_config: true,
        }
    }

    pub fn load(path: impl AsRef<Path>) -> Result<Self, ConfigError> {
        let path = path.as_ref();
        if !path.is_file() {
            return Ok(Self::product_defaults());
        }
        let raw = std::fs::read_to_string(path)?;
        let mut s: Self = serde_json::from_str(&raw)?;
        if s.endpoint.model_id.is_empty() {
            s.endpoint.model_id = "grok-4.5".into();
        }
        Ok(s)
    }

    pub fn save(&self, path: impl AsRef<Path>) -> Result<(), ConfigError> {
        let path = path.as_ref();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let raw = serde_json::to_string_pretty(self)?;
        std::fs::write(path, raw)?;
        Ok(())
    }

    /// Public view for UI: mask api_key.
    pub fn public_view(&self) -> PublicUserSettings {
        let key = self.endpoint.api_key.as_deref().unwrap_or("");
        let (has_key, key_hint) = if key.is_empty() {
            (false, None)
        } else {
            let hint = if key.len() <= 8 {
                "••••".to_string()
            } else {
                format!("••••{}", &key[key.len().saturating_sub(4)..])
            };
            (true, Some(hint))
        };
        PublicUserSettings {
            custom_engine_path: self.custom_engine_path.clone(),
            prefer_bundled_engine: self.prefer_bundled_engine,
            model: self.model.clone(),
            effort: self.effort.clone(),
            sync_to_grok_config: self.sync_to_grok_config,
            endpoint: PublicEndpointSettings {
                model_id: self.endpoint.model_id.clone(),
                name: self.endpoint.name.clone(),
                base_url: self.endpoint.base_url.clone(),
                has_api_key: has_key,
                api_key_hint: key_hint,
                env_key: self.endpoint.env_key.clone(),
                api_backend: self.endpoint.api_backend.clone(),
                context_window: self.endpoint.context_window,
                default_effort: self.endpoint.default_effort.clone(),
            },
            grok_config_path: AppPaths::grok_cli_config().display().to_string(),
        }
    }

    /// Env vars to inject when spawning the engine.
    pub fn engine_env(&self) -> Vec<(String, String)> {
        let mut env = Vec::new();
        if let Some(key) = self
            .endpoint
            .api_key
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            env.push(("XAI_API_KEY".into(), key.to_string()));
            env.push(("GROK_CODE_XAI_API_KEY".into(), key.to_string()));
        } else if let Some(env_key) = self
            .endpoint
            .env_key
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            // If user points at an env var name, pass through if present in process env.
            if let Ok(v) = std::env::var(env_key) {
                env.push(("XAI_API_KEY".into(), v));
            }
        }
        if let Some(base) = self
            .endpoint
            .base_url
            .as_ref()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
        {
            env.push(("GROK_MODELS_BASE_URL".into(), base.to_string()));
        }
        env
    }

    /// Merge endpoint fields into ~/.grok/config.toml without wiping other keys.
    pub fn sync_endpoint_to_grok_toml(&self) -> Result<(), ConfigError> {
        if !self.sync_to_grok_config {
            return Ok(());
        }
        let path = AppPaths::grok_cli_config();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let existing = if path.is_file() {
            std::fs::read_to_string(&path)?
        } else {
            String::new()
        };
        let merged = merge_model_into_toml(&existing, &self.endpoint, self.model.as_deref());
        std::fs::write(path, merged)?;
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicEndpointSettings {
    pub model_id: String,
    pub name: Option<String>,
    pub base_url: Option<String>,
    pub has_api_key: bool,
    pub api_key_hint: Option<String>,
    pub env_key: Option<String>,
    pub api_backend: Option<String>,
    pub context_window: Option<u64>,
    pub default_effort: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicUserSettings {
    pub custom_engine_path: Option<String>,
    pub prefer_bundled_engine: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub sync_to_grok_config: bool,
    pub endpoint: PublicEndpointSettings,
    pub grok_config_path: String,
}

/// Patch used by the UI save form.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct SettingsUpdate {
    pub custom_engine_path: Option<String>,
    pub prefer_bundled_engine: Option<bool>,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub sync_to_grok_config: Option<bool>,
    pub endpoint_model_id: Option<String>,
    pub endpoint_name: Option<String>,
    pub endpoint_base_url: Option<String>,
    /// Empty string clears; omit to keep existing.
    pub endpoint_api_key: Option<String>,
    pub clear_api_key: Option<bool>,
    pub endpoint_env_key: Option<String>,
    pub endpoint_api_backend: Option<String>,
    pub endpoint_context_window: Option<u64>,
    pub endpoint_default_effort: Option<String>,
}

impl UserSettings {
    pub fn apply_update(&mut self, u: SettingsUpdate) {
        if let Some(v) = u.custom_engine_path {
            self.custom_engine_path = empty_to_none(v);
        }
        if let Some(v) = u.prefer_bundled_engine {
            self.prefer_bundled_engine = v;
        }
        if let Some(v) = u.model {
            self.model = empty_to_none(v);
            if let Some(ref m) = self.model {
                self.endpoint.model_id = m.clone();
            }
        }
        if let Some(v) = u.effort {
            self.effort = empty_to_none(v.clone());
            self.endpoint.default_effort = empty_to_none(v);
        }
        if let Some(v) = u.sync_to_grok_config {
            self.sync_to_grok_config = v;
        }
        if let Some(v) = u.endpoint_model_id {
            if !v.trim().is_empty() {
                self.endpoint.model_id = v.trim().to_string();
                self.model = Some(self.endpoint.model_id.clone());
            }
        }
        if let Some(v) = u.endpoint_name {
            self.endpoint.name = empty_to_none(v);
        }
        if let Some(v) = u.endpoint_base_url {
            self.endpoint.base_url = empty_to_none(v);
        }
        if u.clear_api_key == Some(true) {
            self.endpoint.api_key = None;
        } else if let Some(v) = u.endpoint_api_key {
            // Ignore masked placeholders from UI.
            if !v.trim().is_empty() && !v.contains('•') && !v.contains('*') {
                self.endpoint.api_key = Some(v.trim().to_string());
            }
        }
        if let Some(v) = u.endpoint_env_key {
            self.endpoint.env_key = empty_to_none(v);
        }
        if let Some(v) = u.endpoint_api_backend {
            self.endpoint.api_backend = empty_to_none(v);
        }
        if let Some(v) = u.endpoint_context_window {
            self.endpoint.context_window = Some(v);
        }
        if let Some(v) = u.endpoint_default_effort {
            self.endpoint.default_effort = empty_to_none(v.clone());
            self.effort = empty_to_none(v);
        }
    }
}

fn empty_to_none(s: String) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        None
    } else {
        Some(t.to_string())
    }
}

/// Minimal TOML merge: set [models].default and [model."id"] fields.
fn merge_model_into_toml(
    existing: &str,
    endpoint: &ModelEndpointSettings,
    default_model: Option<&str>,
) -> String {
    let model_id = if endpoint.model_id.trim().is_empty() {
        "grok-4.5"
    } else {
        endpoint.model_id.trim()
    };
    let default = default_model.unwrap_or(model_id);

    let mut lines: Vec<String> = existing.lines().map(|s| s.to_string()).collect();
    if !lines.is_empty() && !lines.last().map(|s| s.is_empty()).unwrap_or(false) {
        lines.push(String::new());
    }

    // Ensure [models] default=
    upsert_toml_section_key(&mut lines, "models", "default", &format!("\"{default}\""));

    let section = format!("model.\"{model_id}\"");
    upsert_toml_section_key(
        &mut lines,
        &section,
        "model",
        &format!("\"{model_id}\""),
    );
    if let Some(name) = endpoint.name.as_ref().filter(|s| !s.trim().is_empty()) {
        upsert_toml_section_key(
            &mut lines,
            &section,
            "name",
            &format!("\"{}\"", escape_toml_str(name)),
        );
    }
    if let Some(base) = endpoint.base_url.as_ref().filter(|s| !s.trim().is_empty()) {
        upsert_toml_section_key(
            &mut lines,
            &section,
            "base_url",
            &format!("\"{}\"", escape_toml_str(base.trim())),
        );
    }
    if let Some(key) = endpoint.api_key.as_ref().filter(|s| !s.trim().is_empty()) {
        upsert_toml_section_key(
            &mut lines,
            &section,
            "api_key",
            &format!("\"{}\"", escape_toml_str(key.trim())),
        );
    }
    if let Some(env_key) = endpoint.env_key.as_ref().filter(|s| !s.trim().is_empty()) {
        upsert_toml_section_key(
            &mut lines,
            &section,
            "env_key",
            &format!("\"{}\"", escape_toml_str(env_key.trim())),
        );
    }
    if let Some(backend) = endpoint
        .api_backend
        .as_ref()
        .filter(|s| !s.trim().is_empty())
    {
        upsert_toml_section_key(
            &mut lines,
            &section,
            "api_backend",
            &format!("\"{}\"", escape_toml_str(backend.trim())),
        );
    }
    if let Some(cw) = endpoint.context_window {
        upsert_toml_section_key(&mut lines, &section, "context_window", &cw.to_string());
    }

    let mut out = lines.join("\n");
    if !out.ends_with('\n') {
        out.push('\n');
    }
    out
}

fn escape_toml_str(s: &str) -> String {
    s.replace('\\', "\\\\").replace('"', "\\\"")
}

/// Insert or replace `key = value` under `[section]` (section may contain quotes).
fn upsert_toml_section_key(lines: &mut Vec<String>, section: &str, key: &str, value: &str) {
    let header = format!("[{section}]");
    let header_alt = if section.starts_with("model.\"") {
        // also accept [model.id] form without quotes for simple ids
        None
    } else {
        None
    };

    let mut section_start = None;
    let mut section_end = lines.len();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        let matches_header = t == header
            || header_alt
                .as_ref()
                .map(|h: &String| t == h.as_str())
                .unwrap_or(false);
        if matches_header {
            section_start = Some(i);
            continue;
        }
        if section_start.is_some() && t.starts_with('[') && t.ends_with(']') {
            section_end = i;
            break;
        }
    }

    let assign = format!("{key} = {value}");
    if let Some(start) = section_start {
        // find key in section
        let mut found = None;
        for i in (start + 1)..section_end {
            let t = lines[i].trim();
            if t.starts_with('#') || t.is_empty() {
                continue;
            }
            if let Some((k, _)) = t.split_once('=') {
                if k.trim() == key {
                    found = Some(i);
                    break;
                }
            }
        }
        if let Some(i) = found {
            lines[i] = assign;
        } else {
            // insert after header, skip blank
            let mut insert_at = start + 1;
            while insert_at < section_end && lines[insert_at].trim().is_empty() {
                insert_at += 1;
            }
            lines.insert(insert_at, assign);
        }
    } else {
        if !lines.is_empty() && !lines.last().map(|s| s.trim().is_empty()).unwrap_or(true) {
            lines.push(String::new());
        }
        lines.push(header);
        lines.push(assign);
        lines.push(String::new());
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_writes_model_section() {
        let ep = ModelEndpointSettings {
            model_id: "grok-4.5".into(),
            name: Some("Grok 4.5".into()),
            base_url: Some("http://127.0.0.1:8080/v1".into()),
            api_key: Some("sk-test".into()),
            env_key: None,
            api_backend: Some("chat_completions".into()),
            context_window: Some(128000),
            default_effort: Some("high".into()),
        };
        let out = merge_model_into_toml("", &ep, Some("grok-4.5"));
        assert!(out.contains("[models]"));
        assert!(out.contains("default = \"grok-4.5\""));
        assert!(out.contains("[model.\"grok-4.5\"]"));
        assert!(out.contains("base_url = \"http://127.0.0.1:8080/v1\""));
        assert!(out.contains("api_key = \"sk-test\""));
        assert!(out.contains("context_window = 128000"));
    }

    #[test]
    fn apply_update_keeps_key_when_masked() {
        let mut s = UserSettings::product_defaults();
        s.endpoint.api_key = Some("sk-real-secret".into());
        s.apply_update(SettingsUpdate {
            endpoint_api_key: Some("••••cret".into()),
            ..Default::default()
        });
        assert_eq!(s.endpoint.api_key.as_deref(), Some("sk-real-secret"));
        s.apply_update(SettingsUpdate {
            endpoint_api_key: Some("sk-new".into()),
            ..Default::default()
        });
        assert_eq!(s.endpoint.api_key.as_deref(), Some("sk-new"));
    }

    #[test]
    fn public_view_masks_key() {
        let mut s = UserSettings::product_defaults();
        s.endpoint.api_key = Some("sk-abcdefghij".into());
        let v = s.public_view();
        assert!(v.endpoint.has_api_key);
        assert!(v
            .endpoint
            .api_key_hint
            .as_deref()
            .unwrap()
            .starts_with("••••"));
        assert!(!v
            .endpoint
            .api_key_hint
            .as_deref()
            .unwrap()
            .contains("sk-abcd"));
    }
}
