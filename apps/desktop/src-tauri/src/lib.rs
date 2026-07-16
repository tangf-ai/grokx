use std::path::PathBuf;
use std::sync::Arc;

use agent_process::EngineSource;
use app_core::AppCore;
use domain::{AppEvent, PermissionDecision, SessionId};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

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

#[derive(Debug, Serialize)]
struct SessionListRow {
    session_id: String,
    project_root: String,
    project_name: String,
    title: String,
    engine_session_id: Option<String>,
    updated_at: String,
}

fn resource_dir(app: &AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().or_else(|| {
        Some(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"))
    })
}

fn parse_session_id(s: &str) -> Result<SessionId, String> {
    let u = Uuid::parse_str(s).map_err(|e| format!("invalid session id: {e}"))?;
    Ok(SessionId(u))
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
async fn set_project_root(
    core: State<'_, CoreState>,
    project_root: String,
) -> Result<String, String> {
    let path = core
        .0
        .set_project_root(PathBuf::from(project_root))
        .await
        .map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

#[tauri::command]
async fn list_sessions(core: State<'_, CoreState>) -> Result<Vec<SessionListRow>, String> {
    let items = core.0.list_sessions().await;
    Ok(items
        .into_iter()
        .map(|s| SessionListRow {
            session_id: s.session_id.0.to_string(),
            project_root: s.project_root,
            project_name: s.project_name,
            title: s.title,
            engine_session_id: s.engine_session_id,
            updated_at: s.updated_at.to_rfc3339(),
        })
        .collect())
}

#[tauri::command]
async fn connect_workspace(
    app: AppHandle,
    core: State<'_, CoreState>,
    project_root: Option<String>,
    auto_approve: Option<bool>,
) -> Result<SessionInfo, String> {
    let selected = core.0.selected_project_root().await;
    let root = project_root
        .map(PathBuf::from)
        .or(selected)
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    let allow_path = cfg!(debug_assertions);
    // Default OFF for real permission flow; UI can opt into auto-approve.
    let auto_approve = auto_approve.unwrap_or(false);

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
async fn reconnect_session(
    app: AppHandle,
    core: State<'_, CoreState>,
    session_id: String,
    auto_approve: Option<bool>,
) -> Result<SessionInfo, String> {
    let sid = parse_session_id(&session_id)?;
    let allow_path = cfg!(debug_assertions);
    let auto_approve = auto_approve.unwrap_or(false);
    let new_id = core
        .0
        .reconnect_session(&sid, resource_dir(&app), allow_path, auto_approve)
        .await
        .map_err(|e| e.to_string())?;
    let project_root = core
        .0
        .current_project_root()
        .await
        .map(|p| p.display().to_string());
    Ok(SessionInfo {
        session_id: new_id.0.to_string(),
        project_root,
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
async fn resolve_permission(
    core: State<'_, CoreState>,
    request_id: String,
    decision: String,
) -> Result<(), String> {
    let decision = match decision.as_str() {
        "allow_once" | "allow" | "AllowOnce" => PermissionDecision::AllowOnce,
        "allow_session" | "AllowSession" => PermissionDecision::AllowSession,
        "deny" | "Deny" => PermissionDecision::Deny,
        other => return Err(format!("unknown decision: {other}")),
    };
    core.0
        .resolve_permission(request_id, decision)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn permission_is_pending(
    core: State<'_, CoreState>,
    request_id: String,
) -> Result<bool, String> {
    Ok(core.0.permission_is_pending(&request_id).await)
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
            if let Err(err) = app.emit("agent-event", &event) {
                tracing::warn!("emit agent-event failed: {err}");
            }
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
            set_project_root,
            list_sessions,
            connect_workspace,
            reconnect_session,
            send_prompt,
            cancel_turn,
            resolve_permission,
            permission_is_pending,
            session_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running grokx desktop");
}
