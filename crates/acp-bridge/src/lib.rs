//! ACP bridge: maps agent JSON-RPC traffic into [`domain::AppEvent`] values.
//!
//! Full client implementation (stdio framing + request correlation) lands next.
//! This crate currently defines the public surface and event mapping helpers.

use domain::{AppEvent, SessionId, ToolCall, ToolCallId, ToolCallStatus, TurnState};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("invalid ACP payload: {0}")]
    InvalidPayload(String),
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
}

/// Placeholder client until the full ACP session loop is wired.
#[derive(Debug, Default)]
pub struct AcpClient {
    pub session_id: Option<SessionId>,
}

impl AcpClient {
    pub fn new() -> Self {
        Self::default()
    }
}

/// Map a subset of ACP `session/update` payloads into app events.
/// Returns an empty list when the update type is unknown (forward-compatible).
pub fn map_session_update(session_id: SessionId, update: &Value) -> Vec<AppEvent> {
    let kind = update
        .get("sessionUpdate")
        .or_else(|| update.get("session_update"))
        .and_then(|v| v.as_str())
        .unwrap_or("");

    match kind {
        "agent_message_chunk" => {
            let text = extract_text(update).unwrap_or_default();
            if text.is_empty() {
                vec![]
            } else {
                vec![AppEvent::MessageDelta { session_id, text }]
            }
        }
        "agent_thought_chunk" => {
            let text = extract_text(update).unwrap_or_default();
            if text.is_empty() {
                vec![]
            } else {
                vec![AppEvent::ThoughtDelta { session_id, text }]
            }
        }
        "tool_call" => {
            let tool = ToolCall {
                id: ToolCallId(
                    update
                        .get("toolCallId")
                        .or_else(|| update.get("tool_call_id"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("unknown")
                        .to_string(),
                ),
                title: update
                    .get("title")
                    .and_then(|v| v.as_str())
                    .unwrap_or("tool")
                    .to_string(),
                kind: update
                    .get("kind")
                    .and_then(|v| v.as_str())
                    .unwrap_or("other")
                    .to_string(),
                status: ToolCallStatus::Running,
                input: update.get("rawInput").cloned().or_else(|| update.get("input").cloned()),
                output_preview: None,
            };
            vec![AppEvent::ToolStarted { session_id, tool }]
        }
        "plan" => {
            let steps = update
                .get("entries")
                .and_then(|v| v.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|e| {
                            e.get("content")
                                .or_else(|| e.get("title"))
                                .and_then(|v| v.as_str())
                                .map(|s| s.to_string())
                        })
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            vec![AppEvent::PlanUpdated { session_id, steps }]
        }
        _ => vec![],
    }
}

fn extract_text(update: &Value) -> Option<String> {
    update
        .get("content")
        .and_then(|c| {
            if let Some(s) = c.as_str() {
                Some(s.to_string())
            } else {
                c.get("text").and_then(|t| t.as_str()).map(|s| s.to_string())
            }
        })
        .or_else(|| {
            update
                .get("text")
                .and_then(|t| t.as_str())
                .map(|s| s.to_string())
        })
}

/// Convenience for UI: terminal turn event.
pub fn turn_finished(session_id: SessionId, state: TurnState) -> AppEvent {
    AppEvent::TurnFinished { session_id, state }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn maps_message_chunk() {
        let sid = SessionId::new();
        let events = map_session_update(
            sid.clone(),
            &json!({
                "sessionUpdate": "agent_message_chunk",
                "content": { "text": "hello" }
            }),
        );
        assert_eq!(events.len(), 1);
        match &events[0] {
            AppEvent::MessageDelta { text, .. } => assert_eq!(text, "hello"),
            other => panic!("unexpected {other:?}"),
        }
    }
}
