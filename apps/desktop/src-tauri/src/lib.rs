use std::path::PathBuf;
use std::sync::Arc;

use agent_process::EngineSource;
use app_core::AppCore;
use domain::AppEvent;
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

struct CoreState(Arc<AppCore>);

#[derive(Debug, Serialize)]
struct EngineInfo {
    path: String,
    source: String,
    status: String,
}

#[derive(Debug, Serialize)]
struct SessionInfo {
    session_id: String,
    project_root: Option<String>,
    status: String,
}

fn resource_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().or_else(|| {
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"))
    })
}

#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
async fn resolve_engine(
    app: AppHandle,
    core: State<'_, CoreState>,
) -> Result<EngineInfo, String> {
    let resource_dir = resource_dir(&app);
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

#[tauri::command]
async fn connect_workspace(
    app: AppHandle,
    core: State<'_, CoreState>,
    project_root: Option<String>,
    auto_approve: Option<bool>,
) -> Result<SessionInfo, String> {
    let root = project_root
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let allow_path = cfg!(debug_assertions);
    // Dev default: auto-approve so the first chat loop is usable.
    let auto_approve = auto_approve.unwrap_or(cfg!(debug_assertions));

    let session_id = core
        .0
        .connect_workspace(
            root.clone(),
            resource_dir(&app),
            allow_path,
            auto_approve,
        )
        .await
        .map_err(|e| e.to_string())?;

    Ok(SessionInfo {
        session_id: session_id.0.to_string(),
        project_root: Some(root.display().to_string()),
        status: format!("{:?}", core.0.connection_status().await),
    })
}

#[tauri::command]
async fn send_prompt(core: State<'_, CoreState>, text: String) -> Result<(), String> {
    core.0.send_prompt(text).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn cancel_turn(core: State<'_, CoreState>) -> Result<(), String> {
    core.0.cancel_turn().await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn session_info(core: State<'_, CoreState>) -> Result<SessionInfo, String> {
    let session_id = core
        .0
        .current_session_id()
        .await
        .map(|s| s.0.to_string())
        .unwrap_or_default();
    let project_root = core
        .0
        .current_project_root()
        .await
        .map(|p| p.display().to_string());
    Ok(SessionInfo {
        session_id,
        project_root,
        status: format!("{:?}", core.0.connection_status().await),
    })
}

fn spawn_event_forwarder(app: AppHandle, core: Arc<AppCore>) {
    tauri::async_runtime::spawn(async move {
        let Some(mut rx) = core.take_event_receiver().await else {
            return;
        };
        while let Some(event) = rx.recv().await {
            // Serialize domain events as JSON for the webview.
            if let Err(err) = app.emit("agent-event", &event) {
                tracing::warn!("emit agent-event failed: {err}");
            }
            // Keep a typed path for debugging without breaking the UI contract.
            let _ = std::mem::discriminant(&event);
            let _: &AppEvent = &event;
        }
    });
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let core = AppCore::bootstrap().expect("failed to bootstrap app core");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(CoreState(core.clone()))
        .setup(move |app| {
            spawn_event_forwarder(app.handle().clone(), core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            resolve_engine,
            connect_workspace,
            send_prompt,
            cancel_turn,
            session_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running grokx desktop");
}
