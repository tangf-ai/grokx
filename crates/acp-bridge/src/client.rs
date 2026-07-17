use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use std::path::Path;

use base64::{engine::general_purpose::STANDARD as B64, Engine as _};
use domain::{
    AgentConnectionStatus, AppEvent, ModelInfo, PermissionDecision, PromptRequest,
    ReasoningEffort, SessionId, TurnState,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;
use tracing::{debug, warn};

use crate::map::{map_permission_request, map_session_update, permission_meta, turn_finished};
use crate::permission_gate::{
    permission_outcome_value, ParkedPermission, PermissionGate,
};
use crate::BridgeError;

/// Default timeout for short ACP RPCs (initialize, set_model, cancel, …).
const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(120);
/// `session/prompt` can run tools for a long time; do not treat that as a failed turn.
const PROMPT_RPC_TIMEOUT: Duration = Duration::from_secs(60 * 60 * 6);

/// Options when connecting to a spawned agent process.
#[derive(Debug, Clone)]
pub struct ConnectOptions {
    pub cwd: String,
    pub model: Option<String>,
    pub rpc_timeout: Duration,
    /// Auto-allow permission requests (dev / trusted only).
    pub auto_approve: bool,
}

impl Default for ConnectOptions {
    fn default() -> Self {
        Self {
            cwd: ".".into(),
            model: None,
            rpc_timeout: DEFAULT_RPC_TIMEOUT,
            auto_approve: false,
        }
    }
}

struct Pending {
    tx: oneshot::Sender<Result<Value, BridgeError>>,
}

struct Shared {
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, Pending>>,
    next_id: AtomicU64,
    /// Engine-side ACP session id (string from `session/new`).
    engine_session_id: Mutex<Option<String>>,
    /// App-side session id used in UI events.
    app_session_id: Mutex<SessionId>,
    options: ConnectOptions,
    events: mpsc::UnboundedSender<AppEvent>,
    /// Permission RPCs waiting for UI when auto_approve is false.
    permission_gate: Mutex<PermissionGate>,
    available_models: Mutex<Vec<ModelInfo>>,
    current_model: Mutex<Option<String>>,
}

/// Live ACP connection. Clone-friendly handle for commands; reader task owns the process pipes.
#[derive(Clone)]
pub struct AcpClientHandle {
    shared: Arc<Shared>,
}

/// Owns the child process and the event stream receiver.
pub struct AcpClient {
    pub handle: AcpClientHandle,
    events: Option<mpsc::UnboundedReceiver<AppEvent>>,
    child: Child,
    reader_task: tokio::task::JoinHandle<()>,
}

impl AcpClient {
    /// Take the event receiver (once). Forward it to the app event bus.
    pub fn take_events(&mut self) -> mpsc::UnboundedReceiver<AppEvent> {
        self.events
            .take()
            .expect("ACP event receiver already taken")
    }

    /// Take ownership of a spawned child with piped stdio and run the ACP handshake.
    pub async fn connect(
        mut child: Child,
        app_session_id: SessionId,
        options: ConnectOptions,
    ) -> Result<Self, BridgeError> {
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| BridgeError::Message("child stdin missing".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| BridgeError::Message("child stdout missing".into()))?;

        // Drain stderr so the child cannot block on a full pipe.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    debug!(target: "acp.stderr", "{line}");
                }
            });
        }

        let (events_tx, events_rx) = mpsc::unbounded_channel();
        let _ = events_tx.send(AppEvent::AgentStatus {
            status: AgentConnectionStatus::Starting,
            detail: Some("ACP handshake".into()),
        });

        let shared = Arc::new(Shared {
            stdin: Mutex::new(stdin),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(1),
            engine_session_id: Mutex::new(None),
            app_session_id: Mutex::new(app_session_id),
            options: options.clone(),
            events: events_tx,
            permission_gate: Mutex::new(PermissionGate::new()),
            available_models: Mutex::new(Vec::new()),
            current_model: Mutex::new(options.model.clone()),
        });

        let reader_shared = Arc::clone(&shared);
        let reader_task = tokio::spawn(async move {
            if let Err(err) = read_loop(reader_shared.clone(), stdout).await {
                warn!(error = %err, "ACP reader stopped");
                let _ = reader_shared.events.send(AppEvent::AgentError {
                    message: err.to_string(),
                });
                let _ = reader_shared.events.send(AppEvent::AgentStatus {
                    status: AgentConnectionStatus::Failed,
                    detail: Some(err.to_string()),
                });
            }
        });

        let handle = AcpClientHandle { shared };
        handle.handshake().await?;

        Ok(Self {
            handle,
            events: Some(events_rx),
            child,
            reader_task,
        })
    }

    pub async fn shutdown(mut self) {
        self.reader_task.abort();
        let _ = self.child.kill().await;
    }
}

impl AcpClientHandle {
    async fn handshake(&self) -> Result<(), BridgeError> {
        let init = self
            .request(
                "initialize",
                json!({
                    "protocolVersion": 1,
                    "clientInfo": {
                        "name": "grokx",
                        "version": env!("CARGO_PKG_VERSION")
                    },
                    "clientCapabilities": {
                        "fs": { "readTextFile": false, "writeTextFile": false },
                        "terminal": false
                    }
                }),
            )
            .await?;

        // Prefer reusing CLI-side credentials (auth.json / env). Only call
        // authenticate when the agent advertises methods and session/new fails.
        let auth_methods = init
            .get("authMethods")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let mut result = self
            .request(
                "session/new",
                json!({
                    "cwd": self.shared.options.cwd,
                    "mcpServers": []
                }),
            )
            .await;

        if let Err(BridgeError::Rpc { message, .. }) = &result {
            if message.to_lowercase().contains("auth") && !auth_methods.is_empty() {
                // Try each advertised method id (e.g. xai.api_key, grok.com).
                for method in &auth_methods {
                    let id = method
                        .get("id")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    if id.is_empty() {
                        continue;
                    }
                    let _ = self
                        .request("authenticate", json!({ "methodId": id }))
                        .await;
                }
                result = self
                    .request(
                        "session/new",
                        json!({
                            "cwd": self.shared.options.cwd,
                            "mcpServers": []
                        }),
                    )
                    .await;
            }
        }

        let result = result?;

        let engine_id = result
            .get("sessionId")
            .or_else(|| result.get("session_id"))
            .and_then(|v| v.as_str())
            .ok_or_else(|| {
                BridgeError::InvalidPayload(format!(
                    "session/new missing sessionId: {result}"
                ))
            })?
            .to_string();

        *self.shared.engine_session_id.lock().await = Some(engine_id);
        self.ingest_models_from_session_new(&result).await;

        let _ = self.shared.events.send(AppEvent::AgentStatus {
            status: AgentConnectionStatus::Ready,
            detail: Some("ACP session ready".into()),
        });

        Ok(())
    }

    async fn ingest_models_from_session_new(&self, result: &Value) {
        let mut models = Vec::new();
        if let Some(arr) = result
            .pointer("/models/availableModels")
            .or_else(|| result.pointer("/availableModels"))
            .and_then(|v| v.as_array())
        {
            for m in arr {
                let id = m
                    .get("modelId")
                    .or_else(|| m.get("id"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    continue;
                }
                let name = m
                    .get("name")
                    .and_then(|v| v.as_str())
                    .unwrap_or(&id)
                    .to_string();
                models.push(ModelInfo { id, name });
            }
        }
        if models.is_empty() {
            // Sensible defaults when engine doesn't advertise models.
            models.extend([
                ModelInfo {
                    id: "grok-4.5".into(),
                    name: "Grok 4.5".into(),
                },
                ModelInfo {
                    id: "grok-code".into(),
                    name: "Grok Code".into(),
                },
                ModelInfo {
                    id: "grok-build".into(),
                    name: "Grok Build".into(),
                },
            ]);
        }
        let current = result
            .pointer("/models/currentModelId")
            .or_else(|| result.get("currentModelId"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
            .or_else(|| self.shared.options.model.clone())
            .or_else(|| models.first().map(|m| m.id.clone()));
        *self.shared.available_models.lock().await = models;
        *self.shared.current_model.lock().await = current;
    }

    pub async fn engine_session_id(&self) -> Option<String> {
        self.shared.engine_session_id.lock().await.clone()
    }

    pub async fn app_session_id(&self) -> SessionId {
        self.shared.app_session_id.lock().await.clone()
    }

    pub async fn available_models(&self) -> Vec<ModelInfo> {
        self.shared.available_models.lock().await.clone()
    }

    pub async fn current_model(&self) -> Option<String> {
        self.shared.current_model.lock().await.clone()
    }

    /// Best-effort model switch for the live session.
    pub async fn set_model(&self, model_id: &str) -> Result<(), BridgeError> {
        let engine_session_id = self
            .engine_session_id()
            .await
            .ok_or_else(|| BridgeError::Message("no engine session".into()))?;
        let res = self
            .request(
                "session/set_model",
                json!({
                    "sessionId": engine_session_id,
                    "modelId": model_id
                }),
            )
            .await;
        // Some agents may not support set_model; keep local selection either way.
        *self.shared.current_model.lock().await = Some(model_id.to_string());
        if let Err(err) = res {
            debug!(error = %err, model = model_id, "session/set_model failed (kept local selection)");
        }
        Ok(())
    }

    /// Send a user prompt (text + optional attachments) and stream until complete.
    pub async fn prompt(&self, text: &str) -> Result<(), BridgeError> {
        self.prompt_request(PromptRequest {
            text: text.to_string(),
            attachments: vec![],
            model: None,
            effort: None,
        })
        .await
    }

    pub async fn prompt_request(&self, req: PromptRequest) -> Result<(), BridgeError> {
        let engine_session_id = self
            .engine_session_id()
            .await
            .ok_or_else(|| BridgeError::Message("no engine session".into()))?;
        let app_session_id = self.app_session_id().await;

        if let Some(model) = req.model.as_deref().filter(|s| !s.is_empty()) {
            let _ = self.set_model(model).await;
        }

        let prompt_blocks = build_prompt_blocks(&req)?;
        if prompt_blocks.is_empty() {
            return Err(BridgeError::Message("empty prompt".into()));
        }

        let effort = req.effort.unwrap_or(ReasoningEffort::Medium);
        let mut params = json!({
            "sessionId": engine_session_id,
            "prompt": prompt_blocks,
            "_meta": {
                "reasoningEffort": effort.as_str(),
                "x.ai/effort": effort.as_str(),
            }
        });
        if let Some(model) = req.model.as_ref().or(self.current_model().await.as_ref()) {
            params["_meta"]["modelId"] = json!(model);
        }

        let _ = self.shared.events.send(AppEvent::TurnState {
            session_id: app_session_id.clone(),
            state: TurnState::Streaming,
        });

        // Long-running tools must not hit the short RPC timeout or the UI
        // will show Ready while the engine is still working.
        let result = self
            .request_with_timeout("session/prompt", params, PROMPT_RPC_TIMEOUT)
            .await;

        match result {
            Ok(_) => {
                // If a permission is still parked, the prompt did not truly end.
                let still_waiting = !self
                    .shared
                    .permission_gate
                    .lock()
                    .await
                    .pending_ids()
                    .is_empty();
                if still_waiting {
                    let _ = self.shared.events.send(AppEvent::TurnState {
                        session_id: app_session_id,
                        state: TurnState::WaitingPermission,
                    });
                } else {
                    let _ = self
                        .shared
                        .events
                        .send(turn_finished(app_session_id, TurnState::Completed));
                }
                Ok(())
            }
            Err(err @ BridgeError::Timeout) => {
                // Keep the turn open: the agent may still be running tools.
                // Surface a warning but do not mark the turn finished.
                let _ = self.shared.events.send(AppEvent::AgentError {
                    message: format!(
                        "prompt RPC wait timed out after {}s — agent may still be working; status stays busy until a later update",
                        PROMPT_RPC_TIMEOUT.as_secs()
                    ),
                });
                let _ = self.shared.events.send(AppEvent::TurnState {
                    session_id: app_session_id,
                    state: TurnState::RunningTools,
                });
                Err(err)
            }
            Err(err) => {
                let _ = self.shared.events.send(AppEvent::AgentError {
                    message: err.to_string(),
                });
                let _ = self
                    .shared
                    .events
                    .send(turn_finished(app_session_id, TurnState::Error));
                Err(err)
            }
        }
    }

    pub async fn cancel(&self) -> Result<(), BridgeError> {
        let engine_session_id = match self.engine_session_id().await {
            Some(id) => id,
            None => return Ok(()),
        };
        let _ = self
            .request(
                "session/cancel",
                json!({ "sessionId": engine_session_id }),
            )
            .await;
        let app_session_id = self.app_session_id().await;
        let _ = self
            .shared
            .events
            .send(turn_finished(app_session_id, TurnState::Cancelled));
        Ok(())
    }

    /// Whether a permission request is still waiting for a UI decision.
    pub async fn permission_is_pending(&self, request_id: &str) -> bool {
        self.shared
            .permission_gate
            .lock()
            .await
            .is_pending(request_id)
    }

    pub async fn pending_permission_ids(&self) -> Vec<String> {
        self.shared.permission_gate.lock().await.pending_ids()
    }

    /// Apply a UI permission decision to the live ACP session.
    pub async fn resolve_permission(
        &self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), BridgeError> {
        let (rpc_id, outcome) = {
            let mut gate = self.shared.permission_gate.lock().await;
            gate.resolve(request_id, decision)?
        };
        write_response(&self.shared, rpc_id, outcome).await?;
        let app_session_id = self.app_session_id().await;
        let _ = self.shared.events.send(AppEvent::TurnState {
            session_id: app_session_id,
            state: if matches!(decision, PermissionDecision::Deny) {
                TurnState::RunningTools
            } else {
                TurnState::RunningTools
            },
        });
        Ok(())
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, BridgeError> {
        self.request_with_timeout(method, params, self.shared.options.rpc_timeout)
            .await
    }

    async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        wait: Duration,
    ) -> Result<Value, BridgeError> {
        let id = self.shared.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.shared
            .pending
            .lock()
            .await
            .insert(id, Pending { tx });

        let msg = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.write_message(&msg).await?;

        match timeout(wait, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(BridgeError::ChannelClosed),
            Err(_) => {
                // Leave the pending entry in place if the agent answers later —
                // only remove if still there so we don't double-complete.
                self.shared.pending.lock().await.remove(&id);
                Err(BridgeError::Timeout)
            }
        }
    }

    async fn write_message(&self, msg: &Value) -> Result<(), BridgeError> {
        let mut line = serde_json::to_vec(msg)?;
        line.push(b'\n');
        let mut stdin = self.shared.stdin.lock().await;
        stdin.write_all(&line).await?;
        stdin.flush().await?;
        Ok(())
    }
}

async fn read_loop(shared: Arc<Shared>, stdout: ChildStdout) -> Result<(), BridgeError> {
    let mut lines = BufReader::new(stdout).lines();
    while let Some(line) = lines.next_line().await? {
        if line.trim().is_empty() {
            continue;
        }
        let value: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(err) => {
                warn!(%line, error = %err, "skip non-json ACP line");
                continue;
            }
        };
        handle_incoming(Arc::clone(&shared), value).await?;
    }
    Err(BridgeError::ProcessExited)
}

async fn handle_incoming(shared: Arc<Shared>, value: Value) -> Result<(), BridgeError> {
    let has_method = value
        .get("method")
        .and_then(|m| m.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false);

    // JSON-RPC response: has id, has result/error, no method.
    if value.get("id").is_some() && !has_method {
        if let Some(id) = parse_id(value.get("id")) {
            if let Some(pending) = shared.pending.lock().await.remove(&id) {
                let result = if let Some(err) = value.get("error") {
                    let code = err.get("code").and_then(|c| c.as_i64()).unwrap_or(-1);
                    let message = err
                        .get("message")
                        .and_then(|m| m.as_str())
                        .unwrap_or("unknown error")
                        .to_string();
                    Err(BridgeError::Rpc { code, message })
                } else {
                    Ok(value.get("result").cloned().unwrap_or(Value::Null))
                };
                let _ = pending.tx.send(result);
            }
        } else {
            // Non-numeric ids (e.g. agent echo) — ignore.
            debug!(id = ?value.get("id"), "ACP response with non-numeric id");
        }
        return Ok(());
    }

    // Notification or server-initiated request (may include string ids like "skills-reload").
    let method = value
        .get("method")
        .and_then(|m| m.as_str())
        .unwrap_or("");
    let params = value.get("params").cloned().unwrap_or(Value::Null);
    let id = value.get("id").cloned();
    let app_session_id = shared.app_session_id.lock().await.clone();
    let method_norm = method.trim_start_matches('_');

    match method_norm {
        "session/update" => {
            let update = params
                .get("update")
                .cloned()
                .unwrap_or(params.clone());
            for event in map_session_update(app_session_id, &update, Some(&params)) {
                let _ = shared.events.send(event);
            }
        }
        "session/request_permission" | "request_permission" => {
            let Some(rpc_id) = id else {
                return Ok(());
            };
            let request_id = uuid::Uuid::new_v4().to_string();
            let (tool_name, summary) = permission_meta(&params);
            let event =
                map_permission_request(app_session_id.clone(), &params, request_id.clone());

            if PermissionGate::should_park(shared.options.auto_approve) {
                shared.permission_gate.lock().await.park(ParkedPermission {
                    request_id: request_id.clone(),
                    rpc_id,
                    tool_name,
                    summary,
                });
                let _ = shared.events.send(event);
                let _ = shared.events.send(AppEvent::TurnState {
                    session_id: app_session_id,
                    state: TurnState::WaitingPermission,
                });
                // Do NOT write a response — agent waits until resolve_permission.
            } else {
                let _ = shared.events.send(event);
                let result = permission_outcome_value(PermissionDecision::AllowOnce);
                let _ = write_response(&shared, rpc_id, result).await;
            }
        }
        "" => {}
        other => {
            debug!(method = other, "ACP agent→client method");
            // Answer any request so the agent never blocks on the client.
            if let Some(req_id) = id {
                // skills-reload style: { result: { reloaded: 0 } } observed from agent
                // when it talks to itself; as a client we just ack {}.
                let _ = write_response(&shared, req_id, json!({})).await;
            }
        }
    }

    Ok(())
}

async fn write_response(
    shared: &Shared,
    id: Value,
    result: Value,
) -> Result<(), BridgeError> {
    // If caller passed a full error object under "error", send as RPC error.
    let msg = if result.get("error").is_some() && result.get("outcome").is_none() {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": result.get("error").cloned().unwrap_or(json!({"code": -32000, "message": "error"})),
        })
    } else {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": result,
        })
    };
    let mut line = serde_json::to_vec(&msg)?;
    line.push(b'\n');
    let mut stdin = shared.stdin.lock().await;
    stdin.write_all(&line).await?;
    stdin.flush().await?;
    Ok(())
}

fn parse_id(id: Option<&Value>) -> Option<u64> {
    let id = id?;
    if let Some(n) = id.as_u64() {
        return Some(n);
    }
    if let Some(n) = id.as_i64() {
        return Some(n as u64);
    }
    if let Some(s) = id.as_str() {
        return s.parse().ok();
    }
    None
}

fn build_prompt_blocks(req: &PromptRequest) -> Result<Vec<Value>, BridgeError> {
    let mut blocks = Vec::new();
    let text = req.text.trim();
    if !text.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }

    let mut file_notes = Vec::new();
    for att in &req.attachments {
        let path = Path::new(&att.path);
        if !path.is_file() {
            return Err(BridgeError::Message(format!(
                "attachment not found: {}",
                att.path
            )));
        }
        let mime = att
            .mime
            .clone()
            .or_else(|| {
                mime_guess::from_path(path)
                    .first()
                    .map(|m| m.essence_str().to_string())
            })
            .unwrap_or_else(|| "application/octet-stream".into());

        if mime.starts_with("image/") {
            let bytes = std::fs::read(path).map_err(BridgeError::Io)?;
            // Cap very large images in the JSON payload (~8MB binary).
            if bytes.len() > 8 * 1024 * 1024 {
                return Err(BridgeError::Message(format!(
                    "image too large (max 8MB): {}",
                    att.name
                )));
            }
            let data = B64.encode(&bytes);
            blocks.push(json!({
                "type": "image",
                "mimeType": mime,
                "data": data,
            }));
        } else if mime.starts_with("text/")
            || matches!(
                path.extension().and_then(|e| e.to_str()).unwrap_or(""),
                "md" | "json" | "toml" | "yaml" | "yml" | "rs" | "ts" | "tsx" | "js" | "py"
                    | "go" | "java" | "c" | "cpp" | "h" | "css" | "html" | "txt" | "csv"
                    | "sh" | "sql" | "xml"
            )
        {
            let content = std::fs::read_to_string(path).map_err(BridgeError::Io)?;
            let clipped = if content.len() > 200_000 {
                format!(
                    "{}\n\n… [truncated, {} bytes total]",
                    &content[..200_000],
                    content.len()
                )
            } else {
                content
            };
            blocks.push(json!({
                "type": "text",
                "text": format!("Attached file `{}`:\n```\n{}\n```", att.name, clipped)
            }));
        } else {
            // Non-text binary: pass path reference for the agent to open.
            file_notes.push(format!("{} ({mime})", att.path));
        }
    }

    if !file_notes.is_empty() {
        blocks.push(json!({
            "type": "text",
            "text": format!(
                "Attached files (open on disk):\n{}",
                file_notes
                    .iter()
                    .map(|s| format!("- `{s}`"))
                    .collect::<Vec<_>>()
                    .join("\n")
            )
        }));
    }

    // Ensure we always have at least a path note if only binary files.
    if blocks.is_empty() && !req.attachments.is_empty() {
        blocks.push(json!({
            "type": "text",
            "text": format!(
                "Please review these attachments: {}",
                req.attachments
                    .iter()
                    .map(|a| a.path.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            )
        }));
    }

    Ok(blocks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_numeric_and_string_ids() {
        assert_eq!(parse_id(Some(&json!(3))), Some(3));
        assert_eq!(parse_id(Some(&json!("12"))), Some(12));
        assert_eq!(parse_id(Some(&json!(null))), None);
    }
}
