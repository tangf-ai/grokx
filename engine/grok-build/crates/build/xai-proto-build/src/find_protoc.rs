use anyhow::{Context, bail};
use std::env;
use std::path::{Path, PathBuf};
use std::process::Command;

fn is_unix_dotslash_wrapper(path: &Path) -> bool {
    path.file_name().and_then(|n| n.to_str()) == Some("protoc") && path.extension().is_none()
}

/// Git-Bash `command -v` / `cygpath -u` yields `/d/a/...`; MSVC cargo needs `D:\a\...`.
fn unix_style_to_windows(raw: &str) -> Option<PathBuf> {
    let trimmed = raw.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b'/' {
        let drive = (bytes[1] as char).to_ascii_uppercase();
        let rest = trimmed[3..].replace('/', "\\");
        return Some(PathBuf::from(format!("{drive}:\\{rest}")));
    }
    None
}

fn resolve_protoc_env_path(raw: &str) -> PathBuf {
    let path = PathBuf::from(raw);
    if path.exists() {
        return path;
    }
    if cfg!(windows) {
        if let Some(converted) = unix_style_to_windows(raw) {
            if converted.exists() {
                return converted;
            }
        }
    }
    path
}

fn check_protoc_good(protoc: &Path) -> anyhow::Result<()> {
    let output = Command::new(protoc)
        .arg("--version")
        .output()
        .context("Failed to execute protoc")?;

    if !output.status.success() {
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        bail!(
            "protoc --version failed, likely dotslash is missing; \
             try `cargo install dotslash`; stdout: {stdout:?}, stderr: {stderr:?}"
        );
    }
    Ok(())
}

fn is_github_actions() -> bool {
    env::var_os("GITHUB_ACTIONS").is_some()
}

/// Find `protoc` command.
///
/// Search order:
/// 1. `$PROTOC` environment variable (set by Bazel `build_script_env` or user override)
/// 2. `bin/protoc` walking up parent directories (dotslash wrapper for local dev)
/// 3. `protoc` on `$PATH` (system install or other tooling)
///
/// When `bin/protoc` exists but fails to execute (e.g. the dotslash wrapper running
/// in Bazel remote execution where `dotslash` is not installed), the error is not fatal —
/// we fall through to the PATH-based lookup instead.
///
/// Returns `Ok(None)` if not found and not in a strict environment (GitHub Actions).
pub fn find_protoc() -> anyhow::Result<Option<PathBuf>> {
    // 1. Check the PROTOC env var first. This is the standard override used by prost-build
    //    and is set by Bazel cargo_build_script build_script_env to point at a hermetic
    //    protoc binary instead of the dotslash wrapper.
    if let Ok(protoc_env) = env::var("PROTOC") {
        let protoc = resolve_protoc_env_path(&protoc_env);
        if protoc.try_exists()? {
            check_protoc_good(&protoc)?;
            return Ok(Some(protoc));
        }
    }

    // 2. Walk up directories looking for bin/protoc (dotslash wrapper).
    let cwd = env::current_dir()?;
    let mut dir = cwd.clone();
    let mut dir_rel = PathBuf::new();
    loop {
        // Return relative path to make build more deterministic.
        // Unix uses the shebang wrapper `bin/protoc`; Windows cannot execute that
        // text file (Win32 error 193), so skip it and look for `bin/protoc.exe`.
        let candidates = [dir_rel.join("bin/protoc"), dir_rel.join("bin/protoc.exe")];
        let mut wrapper_failed = false;
        for protoc in candidates {
            if !protoc.try_exists()? {
                continue;
            }
            if cfg!(windows) && is_unix_dotslash_wrapper(&protoc) {
                continue;
            }
            match check_protoc_good(&protoc) {
                Ok(()) => return Ok(Some(protoc)),
                Err(e) => {
                    // bin/protoc exists but can't execute — likely the dotslash wrapper
                    // in an environment without dotslash (e.g. Bazel remote execution).
                    // Fall through to PATH-based lookup below.
                    eprintln!(
                        "bin/protoc found at `{}` but failed to execute: {e:#}; \
                         trying protoc from PATH as fallback",
                        protoc.display()
                    );
                    wrapper_failed = true;
                    break;
                }
            }
        }
        if wrapper_failed {
            break;
        }
        if !dir.pop() {
            break;
        }
        dir_rel.push("..");
    }

    // 3. Try protoc from PATH (system install or other tooling).
    for name in ["protoc", "protoc.exe"] {
        if check_protoc_good(Path::new(name)).is_ok() {
            return Ok(Some(PathBuf::from(name)));
        }
    }

    // 4. Not found anywhere.
    if is_github_actions() {
        return Err(anyhow::anyhow!(
            "`protoc` not found (checked $PROTOC env, bin/protoc, and PATH)"
        ));
    }
    eprintln!("`protoc` not found; likely it is missing in docker image");
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::{is_unix_dotslash_wrapper, unix_style_to_windows};
    use std::path::Path;

    #[test]
    fn unix_dotslash_wrapper_is_bare_protoc() {
        assert!(is_unix_dotslash_wrapper(Path::new("bin/protoc")));
        assert!(!is_unix_dotslash_wrapper(Path::new("bin/protoc.exe")));
        assert!(!is_unix_dotslash_wrapper(Path::new("protoc.exe")));
    }

    #[test]
    fn converts_git_bash_path() {
        let converted = unix_style_to_windows("/d/a/grokx/protoc.exe").unwrap();
        assert_eq!(converted, std::path::PathBuf::from(r"D:\a\grokx\protoc.exe"));
    }
}
