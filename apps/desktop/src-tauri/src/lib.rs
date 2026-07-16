use std::path::PathBuf;
use std::sync::Arc;

use agent_process::EngineSource;
use app_config::{PublicUserSettings, SettingsUpdate};
use app_core::AppCore;
use base64::Engine as _;
use domain::{
    AppEvent, PermissionDecision, ProjectId, PromptAttachment, PromptRequest, ReasoningEffort,
    SessionId,
};
use serde::{Deserialize, Serialize};
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
    /// Temporary task cwd (`~/.grokx/tasks/<id>`).
    work_path: Option<String>,
    status: String,
}

#[derive(Debug, Serialize)]
struct SessionListRow {
    session_id: String,
    project_id: String,
    project_root: String,
    project_name: String,
    work_path: String,
    title: String,
    engine_session_id: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct ProjectListRow {
    project_id: String,
    name: String,
    root_path: String,
    session_count: usize,
    updated_at: String,
}

#[derive(Debug, Serialize)]
struct ModelOption {
    id: String,
    name: String,
}

#[derive(Debug, Serialize)]
struct EffortOption {
    id: String,
    label: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AttachmentInput {
    path: String,
    name: Option<String>,
    mime: Option<String>,
    size: Option<u64>,
}

/// Browser clipboard paste of image/file bytes (base64).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PastedAttachmentInput {
    /// Raw base64 (no data: URL prefix).
    data_base64: String,
    mime: Option<String>,
    name: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SendPromptInput {
    text: String,
    #[serde(default)]
    attachments: Vec<AttachmentInput>,
    model: Option<String>,
    effort: Option<String>,
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

fn parse_project_id(s: &str) -> Result<ProjectId, String> {
    let u = Uuid::parse_str(s).map_err(|e| format!("invalid project id: {e}"))?;
    Ok(ProjectId(u))
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

/// Create/select `~/.grokx/workspace` so a task can start without folder picker.
#[tauri::command]
async fn ensure_default_project(core: State<'_, CoreState>) -> Result<String, String> {
    let path = core
        .0
        .ensure_default_project()
        .await
        .map_err(|e| e.to_string())?;
    Ok(path.display().to_string())
}

/// Native folder picker for opening a project (fixed path). No free-text path needed.
#[tauri::command]
async fn pick_project_dir(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_dialog::DialogExt;
    let folder = app
        .dialog()
        .file()
        .set_title("Open project")
        .blocking_pick_folder();
    let Some(folder) = folder else {
        return Ok(None);
    };
    let path = folder
        .into_path()
        .map_err(|e| format!("invalid folder path: {e}"))?;
    Ok(Some(path.display().to_string()))
}

#[tauri::command]
async fn list_sessions(core: State<'_, CoreState>) -> Result<Vec<SessionListRow>, String> {
    let items = core.0.list_sessions().await;
    Ok(items
        .into_iter()
        .map(|s| SessionListRow {
            session_id: s.session_id.0.to_string(),
            project_id: s.project_id.0.to_string(),
            project_root: s.project_root,
            project_name: s.project_name,
            work_path: s.work_path,
            title: s.title,
            engine_session_id: s.engine_session_id,
            created_at: s.created_at.to_rfc3339(),
            updated_at: s.updated_at.to_rfc3339(),
        })
        .collect())
}

#[tauri::command]
async fn list_projects(core: State<'_, CoreState>) -> Result<Vec<ProjectListRow>, String> {
    let items = core.0.list_projects().await;
    Ok(items
        .into_iter()
        .map(|p| ProjectListRow {
            project_id: p.project_id.0.to_string(),
            name: p.name,
            root_path: p.root_path,
            session_count: p.session_count,
            updated_at: p.updated_at.to_rfc3339(),
        })
        .collect())
}

#[tauri::command]
async fn list_sessions_for_project(
    core: State<'_, CoreState>,
    project_id: String,
) -> Result<Vec<SessionListRow>, String> {
    let pid = parse_project_id(&project_id)?;
    let items = core.0.list_sessions_for_project(&pid).await;
    Ok(items
        .into_iter()
        .map(|s| SessionListRow {
            session_id: s.session_id.0.to_string(),
            project_id: s.project_id.0.to_string(),
            project_root: s.project_root,
            project_name: s.project_name,
            work_path: s.work_path,
            title: s.title,
            engine_session_id: s.engine_session_id,
            created_at: s.created_at.to_rfc3339(),
            updated_at: s.updated_at.to_rfc3339(),
        })
        .collect())
}

#[tauri::command]
async fn rename_session(
    core: State<'_, CoreState>,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let sid = parse_session_id(&session_id)?;
    core.0
        .rename_session(&sid, title)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_session(
    core: State<'_, CoreState>,
    session_id: String,
) -> Result<(), String> {
    let sid = parse_session_id(&session_id)?;
    core.0
        .delete_session(&sid)
        .await
        .map_err(|e| e.to_string())
}

/// Persist chat transcript JSON for a task (under its work_path).
#[tauri::command]
async fn save_chat_history(
    core: State<'_, CoreState>,
    session_id: String,
    json: String,
    work_path: Option<String>,
) -> Result<(), String> {
    let sid = parse_session_id(&session_id)?;
    core.0
        .save_chat_history(&sid, json, work_path)
        .await
        .map_err(|e| e.to_string())
}

/// Load chat transcript JSON for a task, if any.
#[tauri::command]
async fn load_chat_history(
    core: State<'_, CoreState>,
    session_id: String,
    work_path: Option<String>,
) -> Result<Option<String>, String> {
    let sid = parse_session_id(&session_id)?;
    core.0
        .load_chat_history(&sid, work_path)
        .await
        .map_err(|e| e.to_string())
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

    let work_path = core
        .0
        .current_work_path()
        .await
        .map(|p| p.display().to_string());
    Ok(SessionInfo {
        session_id: session_id.0.to_string(),
        project_root: Some(root.display().to_string()),
        work_path,
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
    let work_path = core
        .0
        .current_work_path()
        .await
        .map(|p| p.display().to_string());
    Ok(SessionInfo {
        session_id: new_id.0.to_string(),
        project_root,
        work_path,
        status: format!("{:?}", core.0.connection_status().await),
    })
}

#[tauri::command]
async fn send_prompt(core: State<'_, CoreState>, text: String) -> Result<(), String> {
    core.0.send_prompt(text).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn send_prompt_rich(
    core: State<'_, CoreState>,
    payload: SendPromptInput,
) -> Result<(), String> {
    let effort = payload
        .effort
        .as_deref()
        .and_then(ReasoningEffort::parse);
    let attachments = payload
        .attachments
        .into_iter()
        .map(|a| {
            let path = std::path::PathBuf::from(&a.path);
            let name = a.name.unwrap_or_else(|| {
                path.file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| a.path.clone())
            });
            let size = a.size.or_else(|| std::fs::metadata(&path).ok().map(|m| m.len()));
            PromptAttachment {
                path: a.path,
                name,
                mime: a.mime,
                size,
            }
        })
        .collect();
    core.0
        .send_prompt_request(PromptRequest {
            text: payload.text,
            attachments,
            model: payload.model,
            effort,
        })
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_models(core: State<'_, CoreState>) -> Result<Vec<ModelOption>, String> {
    let models = core.0.available_models().await;
    Ok(models
        .into_iter()
        .map(|m| ModelOption {
            id: m.id,
            name: m.name,
        })
        .collect())
}

#[tauri::command]
async fn current_model(core: State<'_, CoreState>) -> Result<Option<String>, String> {
    Ok(core.0.current_model().await)
}

#[tauri::command]
async fn set_model(core: State<'_, CoreState>, model_id: String) -> Result<(), String> {
    core.0.set_model(model_id).await.map_err(|e| e.to_string())
}

#[tauri::command]
fn list_efforts() -> Vec<EffortOption> {
    AppCore::effort_options()
        .into_iter()
        .map(|e| EffortOption {
            id: e.as_str().to_string(),
            label: e.label().to_string(),
        })
        .collect()
}

#[tauri::command]
async fn get_settings(core: State<'_, CoreState>) -> Result<PublicUserSettings, String> {
    Ok(core.0.public_settings().await)
}

#[tauri::command]
async fn save_settings(
    core: State<'_, CoreState>,
    update: SettingsUpdate,
) -> Result<PublicUserSettings, String> {
    core.0
        .update_settings(update)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn pick_attachments(app: AppHandle) -> Result<Vec<AttachmentInput>, String> {
    use tauri_plugin_dialog::DialogExt;
    let files = app
        .dialog()
        .file()
        .set_title("Attach files")
        .add_filter(
            "Common",
            &[
                "png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "md", "json", "rs", "ts",
                "tsx", "js", "py", "go", "toml", "yaml", "yml", "csv", "html", "css",
            ],
        )
        .blocking_pick_files();
    let Some(files) = files else {
        return Ok(vec![]);
    };
    let mut out = Vec::new();
    for f in files {
        let path = f
            .into_path()
            .map_err(|e| format!("invalid path: {e}"))?;
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.display().to_string());
        let size = std::fs::metadata(&path).ok().map(|m| m.len());
        let mime = mime_guess::from_path(&path)
            .first()
            .map(|m| m.essence_str().to_string());
        out.push(AttachmentInput {
            path: path.display().to_string(),
            name: Some(name),
            mime,
            size,
        });
    }
    Ok(out)
}

fn mime_to_ext(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" | "image/jpg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/bmp" => "bmp",
        "image/svg+xml" => "svg",
        "application/pdf" => "pdf",
        "text/plain" => "txt",
        "text/markdown" => "md",
        "application/json" => "json",
        _ if mime.starts_with("image/") => "png",
        _ => "bin",
    }
}

/// Save a clipboard-pasted image/file into a temp path for the agent to read.
#[tauri::command]
async fn save_pasted_attachment(
    payload: PastedAttachmentInput,
) -> Result<AttachmentInput, String> {
    let mime = payload
        .mime
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("application/octet-stream")
        .to_string();

    // Accept data URL prefix if the frontend forgot to strip it.
    let b64 = payload
        .data_base64
        .trim()
        .rsplit(',')
        .next()
        .unwrap_or("")
        .trim();
    if b64.is_empty() {
        return Err("empty paste payload".into());
    }

    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(b64))
        .map_err(|e| format!("invalid base64: {e}"))?;

    if bytes.is_empty() {
        return Err("empty paste bytes".into());
    }
    // 25 MiB guard
    if bytes.len() > 25 * 1024 * 1024 {
        return Err("pasted file too large (max 25MB)".into());
    }

    let ext = mime_to_ext(&mime);
    let name = payload
        .name
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .unwrap_or_else(|| {
            let stamp = chrono_like_stamp();
            format!("paste-{stamp}.{ext}")
        });

    let dir = std::env::temp_dir().join("grokx-pastes");
    std::fs::create_dir_all(&dir).map_err(|e| format!("create paste dir: {e}"))?;
    let safe_name = name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>();
    let path = dir.join(format!(
        "{}-{}",
        &Uuid::new_v4().to_string()[..8],
        if safe_name.is_empty() {
            format!("paste.{ext}")
        } else {
            safe_name
        }
    ));
    std::fs::write(&path, &bytes).map_err(|e| format!("write paste file: {e}"))?;

    Ok(AttachmentInput {
        path: path.display().to_string(),
        name: Some(
            path.file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or(name),
        ),
        mime: Some(mime),
        size: Some(bytes.len() as u64),
    })
}

fn chrono_like_stamp() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    secs.to_string()
}

/// Read an image from the OS clipboard (macOS screenshot / Cmd+C image).
/// Returns None when the clipboard has no image.
#[tauri::command]
async fn read_clipboard_image() -> Result<Option<AttachmentInput>, String> {
    tokio::task::spawn_blocking(|| {
        let mut clipboard = arboard::Clipboard::new().map_err(|e| format!("clipboard: {e}"))?;
        let img = match clipboard.get_image() {
            Ok(i) => i,
            Err(_) => return Ok(None),
        };
        if img.width == 0 || img.height == 0 {
            return Ok(None);
        }
        let rgba = image::RgbaImage::from_raw(
            img.width as u32,
            img.height as u32,
            img.bytes.into_owned(),
        )
        .ok_or_else(|| "invalid clipboard image buffer".to_string())?;
        let mut png_bytes: Vec<u8> = Vec::new();
        {
            let dyn_img = image::DynamicImage::ImageRgba8(rgba);
            dyn_img
                .write_to(
                    &mut std::io::Cursor::new(&mut png_bytes),
                    image::ImageFormat::Png,
                )
                .map_err(|e| format!("encode png: {e}"))?;
        }
        if png_bytes.is_empty() {
            return Ok(None);
        }
        let dir = std::env::temp_dir().join("grokx-pastes");
        std::fs::create_dir_all(&dir).map_err(|e| format!("create paste dir: {e}"))?;
        let path = dir.join(format!(
            "{}-clipboard-{}.png",
            &Uuid::new_v4().to_string()[..8],
            chrono_like_stamp()
        ));
        std::fs::write(&path, &png_bytes).map_err(|e| format!("write clipboard image: {e}"))?;
        Ok(Some(AttachmentInput {
            path: path.display().to_string(),
            name: Some(
                path.file_name()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "clipboard.png".into()),
            ),
            mime: Some("image/png".into()),
            size: Some(png_bytes.len() as u64),
        }))
    })
    .await
    .map_err(|e| format!("clipboard task: {e}"))?
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
    let work_path = core
        .0
        .current_work_path()
        .await
        .map(|p| p.display().to_string());
    Ok(SessionInfo {
        session_id,
        project_root,
        work_path,
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

/// Headless smoke used by verification: same logic as Tauri commands, no window.
///
/// Env: `GROKX_HEADLESS_CHECK=1` → print JSON for app_version + resolve_engine and exit.
pub async fn headless_check() -> Result<(), String> {
    let version = app_version();
    let core = AppCore::bootstrap().map_err(|e| e.to_string())?;
    let resource = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
    let allow_path = true;
    let engine = core
        .resolve_runtime(Some(resource.as_path()), allow_path)
        .await
        .map_err(|e| e.to_string())?;
    let source = match engine.source {
        EngineSource::Bundled => "bundled",
        EngineSource::Custom => "custom",
        EngineSource::Path => "path",
    };
    let payload = serde_json::json!({
        "app_version": version,
        "resolve_engine": {
            "path": engine.path.display().to_string(),
            "source": source,
            "status": format!("{:?}", core.connection_status().await),
        }
    });
    println!("{payload}");
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if std::env::var("GROKX_HEADLESS_CHECK").ok().as_deref() == Some("1") {
        if let Err(err) = tauri::async_runtime::block_on(headless_check()) {
            eprintln!("headless_check failed: {err}");
            std::process::exit(1);
        }
        return;
    }

    let core = AppCore::bootstrap().expect("failed to bootstrap app core");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(CoreState(core.clone()))
        .setup(move |app| {
            spawn_event_forwarder(app.handle().clone(), core);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            resolve_engine,
            set_project_root,
            ensure_default_project,
            pick_project_dir,
            list_sessions,
            list_projects,
            list_sessions_for_project,
            rename_session,
            delete_session,
            save_chat_history,
            load_chat_history,
            connect_workspace,
            reconnect_session,
            send_prompt,
            send_prompt_rich,
            list_models,
            current_model,
            set_model,
            list_efforts,
            get_settings,
            save_settings,
            pick_attachments,
            save_pasted_attachment,
            read_clipboard_image,
            cancel_turn,
            resolve_permission,
            permission_is_pending,
            session_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running grokx desktop");
}
