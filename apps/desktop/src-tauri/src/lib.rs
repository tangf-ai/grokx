use std::path::PathBuf;
use std::sync::Arc;

use agent_process::EngineSource;
use app_core::AppCore;
use serde::Serialize;
use tauri::{Manager, State};

struct CoreState(Arc<AppCore>);

#[derive(Debug, Serialize)]
struct EngineInfo {
    path: String,
    source: String,
    status: String,
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
async fn resolve_engine(
    app: tauri::AppHandle,
    core: State<'_, CoreState>,
) -> Result<EngineInfo, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .ok()
        .map(|p| p)
        .or_else(|| {
            // Dev: allow resources next to the tauri crate.
            Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"))
        });

    // In dev, fall back to PATH so local `grok` still works before first bundle.
    let allow_path = cfg!(debug_assertions);

    match core
        .0
        .resolve_runtime(resource_dir.as_deref(), allow_path)
        .await
    {
        Ok(engine) => {
            let source = match engine.source {
                EngineSource::Bundled => "bundled",
                EngineSource::Custom => "custom",
                EngineSource::Path => "path",
            };
            Ok(EngineInfo {
                path: engine.path.display().to_string(),
                source: source.to_string(),
                status: format!("{:?}", core.0.connection_status().await),
            })
        }
        Err(err) => Err(err.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let core = AppCore::bootstrap().expect("failed to bootstrap app core");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(CoreState(core))
        .invoke_handler(tauri::generate_handler![app_version, resolve_engine])
        .run(tauri::generate_context!())
        .expect("error while running grokx desktop");
}
