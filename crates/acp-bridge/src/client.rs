use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use domain::{
    AgentConnectionStatus, AppEvent, PermissionDecision, SessionId, TurnState,
};
use serde_json::{json, Value};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout};
use tokio::sync::{mpsc, oneshot, Mutex};
use tokio::time::timeout;
use tracing::{debug, warn};

use crate::map::{map_permission_request, map_session_update, turn_finished};
use crate::BridgeError;

const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(120);

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

        let _ = self.shared.events.send(AppEvent::AgentStatus {
            status: AgentConnectionStatus::Ready,
            detail: Some("ACP session ready".into()),
        });

        Ok(())
    }

    pub async fn engine_session_id(&self) -> Option<String> {
        self.shared.engine_session_id.lock().await.clone()
    }

    pub async fn app_session_id(&self) -> SessionId {
        self.shared.app_session_id.lock().await.clone()
    }

    /// Send a user prompt and stream updates until the prompt RPC completes.
    pub async fn prompt(&self, text: &str) -> Result<(), BridgeError> {
        let engine_session_id = self
            .engine_session_id()
            .await
            .ok_or_else(|| BridgeError::Message("no engine session".into()))?;
        let app_session_id = self.app_session_id().await;

        let _ = self.shared.events.send(AppEvent::TurnState {
            session_id: app_session_id.clone(),
            state: TurnState::Streaming,
        });

        let result = self
            .request(
                "session/prompt",
                json!({
                    "sessionId": engine_session_id,
                    "prompt": [{ "type": "text", "text": text }]
                }),
            )
            .await;

        match result {
            Ok(_) => {
                let _ = self
                    .shared
                    .events
                    .send(turn_finished(app_session_id, TurnState::Completed));
                Ok(())
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

    async fn request(&self, method: &str, params: Value) -> Result<Value, BridgeError> {
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

        match timeout(self.shared.options.rpc_timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(BridgeError::ChannelClosed),
            Err(_) => {
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
            for event in map_session_update(app_session_id, &update) {
                let _ = shared.events.send(event);
            }
        }
        "session/request_permission" | "request_permission" => {
            let event = map_permission_request(app_session_id, &params);
            let _ = shared.events.send(event);
            if let Some(req_id) = id {
                let result = permission_outcome(PermissionDecision::AllowOnce);
                let _ = write_response(&shared, req_id, result).await;
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

fn permission_outcome(decision: PermissionDecision) -> Value {
    let option_id = match decision {
        PermissionDecision::AllowOnce => "allow-once",
        PermissionDecision::AllowSession => "allow-always",
        PermissionDecision::Deny => "reject-once",
    };
    json!({
        "outcome": {
            "outcome": "selected",
            "optionId": option_id
        }
    })
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
