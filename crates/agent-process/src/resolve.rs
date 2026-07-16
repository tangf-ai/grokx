use std::path::{Path, PathBuf};

use app_config::{bundled_runtime_relative, UserSettings};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum ResolveError {
    #[error("no engine binary found (bundled missing and no custom/PATH fallback)")]
    NotFound,
    #[error("configured engine path does not exist: {0}")]
    MissingCustom(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EngineSource {
    Custom,
    Bundled,
    Path,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedEngine {
    pub path: PathBuf,
    pub source: EngineSource,
}

/// Resolve which `grok` binary to run.
///
/// Order:
/// 1. `settings.custom_engine_path` when set
/// 2. Bundled runtime under `resource_dir`
/// 3. Optional PATH lookup when `allow_path_fallback` is true (dev only recommended)
pub fn resolve_engine(
    settings: &UserSettings,
    resource_dir: Option<&Path>,
    allow_path_fallback: bool,
) -> Result<ResolvedEngine, ResolveError> {
    if let Some(custom) = settings.custom_engine_path.as_deref() {
        let path = PathBuf::from(custom);
        if path.is_file() {
            return Ok(ResolvedEngine {
                path,
                source: EngineSource::Custom,
            });
        }
        return Err(ResolveError::MissingCustom(custom.to_string()));
    }

    if settings.prefer_bundled_engine {
        if let Some(dir) = resource_dir {
            let bundled = dir.join(bundled_runtime_relative());
            if bundled.is_file() {
                return Ok(ResolvedEngine {
                    path: bundled,
                    source: EngineSource::Bundled,
                });
            }
        }
    }

    if allow_path_fallback {
        if let Ok(path) = which::which("grok") {
            return Ok(ResolvedEngine {
                path,
                source: EngineSource::Path,
            });
        }
    }

    // If prefer_bundled is false, still try PATH before failing.
    if !settings.prefer_bundled_engine {
        if let Ok(path) = which::which("grok") {
            return Ok(ResolvedEngine {
                path,
                source: EngineSource::Path,
            });
        }
    }

    Err(ResolveError::NotFound)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn prefers_custom_path() {
        let dir = tempfile_dir();
        let bin = dir.join("custom-grok");
        touch(&bin);

        let settings = UserSettings {
            custom_engine_path: Some(bin.to_string_lossy().into()),
            prefer_bundled_engine: true,
            model: None,
        };
        let resolved = resolve_engine(&settings, None, false).unwrap();
        assert_eq!(resolved.source, EngineSource::Custom);
        assert_eq!(resolved.path, bin);
    }

    #[test]
    fn uses_bundled_when_present() {
        let resources = tempfile_dir();
        let runtime_dir = resources.join("runtime");
        std::fs::create_dir_all(&runtime_dir).unwrap();
        let bin = runtime_dir.join(if cfg!(windows) { "grok.exe" } else { "grok" });
        touch(&bin);

        let settings = UserSettings::product_defaults();
        let resolved = resolve_engine(&settings, Some(&resources), false).unwrap();
        assert_eq!(resolved.source, EngineSource::Bundled);
        assert_eq!(resolved.path, bin);
    }

    #[test]
    fn prefers_bundled_over_path_fallback() {
        let resources = tempfile_dir();
        let runtime_dir = resources.join("runtime");
        std::fs::create_dir_all(&runtime_dir).unwrap();
        let bin = runtime_dir.join(if cfg!(windows) { "grok.exe" } else { "grok" });
        touch(&bin);

        let settings = UserSettings::product_defaults();
        // Even with PATH fallback enabled, bundled wins when present.
        let resolved = resolve_engine(&settings, Some(&resources), true).unwrap();
        assert_eq!(resolved.source, EngineSource::Bundled);
        assert_eq!(resolved.path, bin);
    }

    fn tempfile_dir() -> PathBuf {
        let mut dir = std::env::temp_dir();
        dir.push(format!("grokx-test-{}", uuid_like()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(path: &Path) {
        let mut f = std::fs::File::create(path).unwrap();
        f.write_all(b"x").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(path).unwrap().permissions();
            perms.set_mode(0o755);
            std::fs::set_permissions(path, perms).unwrap();
        }
    }

    fn uuid_like() -> String {
        use std::time::{SystemTime, UNIX_EPOCH};
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
            .to_string()
    }
}
