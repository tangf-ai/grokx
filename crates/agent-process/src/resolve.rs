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

/// Candidate relative paths for the bundled engine inside a Tauri app.
///
/// Tauri puts configured resources under `resource_dir`, but depending on how
/// `bundle.resources` is declared the layout may be either:
/// - `Resources/runtime/grok`            (ideal)
/// - `Resources/resources/runtime/grok`  (when source path includes `resources/`)
fn bundled_candidates(resource_dir: &Path) -> Vec<PathBuf> {
    let rel = bundled_runtime_relative(); // e.g. "runtime/grok"
    let mut out = vec![
        resource_dir.join(rel),
        resource_dir.join("resources").join(rel),
    ];
    // Also try next to the current executable (macOS .app Contents/MacOS/../Resources/...)
    if let Ok(exe) = std::env::current_exe() {
        if let Some(mac_os) = exe.parent() {
            // Contents/MacOS -> Contents/Resources
            if let Some(contents) = mac_os.parent() {
                let resources = contents.join("Resources");
                out.push(resources.join(rel));
                out.push(resources.join("resources").join(rel));
            }
            // Loose binary next to engine (dev / portable layouts)
            out.push(mac_os.join("grok"));
            out.push(mac_os.join("runtime").join("grok"));
        }
    }
    out
}

fn first_existing_file(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates.into_iter().find(|p| p.is_file())
}

/// Resolve which `grok` binary to run.
///
/// Order:
/// 1. `settings.custom_engine_path` when set and present
/// 2. Bundled runtime (several layout candidates)
/// 3. PATH lookup when allowed / when bundled preference is off
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
        // Stale custom path: fall through to bundled/PATH instead of hard-failing
        // when a packaged runtime is available.
        if !settings.prefer_bundled_engine && !allow_path_fallback {
            return Err(ResolveError::MissingCustom(custom.to_string()));
        }
    }

    if settings.prefer_bundled_engine {
        let mut candidates = Vec::new();
        if let Some(dir) = resource_dir {
            candidates.extend(bundled_candidates(dir));
        } else {
            // Still try executable-relative layouts when resource_dir is unknown.
            candidates.extend(bundled_candidates(Path::new(".")));
        }
        if let Some(path) = first_existing_file(candidates) {
            return Ok(ResolvedEngine {
                path,
                source: EngineSource::Bundled,
            });
        }
    }

    if allow_path_fallback || !settings.prefer_bundled_engine {
        if let Ok(path) = which::which("grok") {
            return Ok(ResolvedEngine {
                path,
                source: EngineSource::Path,
            });
        }
    }

    // Last-chance PATH for packaged apps when bundled lookup failed
    // (e.g. resource_dir API returned unexpected path). Helps local installs
    // that already have `~/.grok/bin` on PATH.
    if let Ok(path) = which::which("grok") {
        return Ok(ResolvedEngine {
            path,
            source: EngineSource::Path,
        });
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

        let mut settings = UserSettings::product_defaults();
        settings.custom_engine_path = Some(bin.to_string_lossy().into());
        settings.prefer_bundled_engine = true;
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
    fn uses_bundled_nested_resources_layout() {
        // Matches Tauri packing `resources/runtime/*` under
        // Contents/Resources/resources/runtime/grok
        let resources = tempfile_dir();
        let runtime_dir = resources.join("resources").join("runtime");
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
