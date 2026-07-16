use serde::{Deserialize, Serialize};

use crate::SessionId;

/// High-level turn state for a single user prompt cycle.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TurnState {
    Idle,
    Streaming,
    WaitingPermission,
    RunningTools,
    Completed,
    Error,
    Cancelled,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TurnSnapshot {
    pub session_id: SessionId,
    pub state: TurnState,
    pub error: Option<String>,
}

/// Events the UI should render. Produced by the ACP bridge, consumed by app-core.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum AppEvent {
    AgentStatus {
        status: AgentConnectionStatus,
        detail: Option<String>,
    },
    MessageDelta {
        session_id: SessionId,
        text: String,
    },
    ThoughtDelta {
        session_id: SessionId,
        text: String,
    },
    ToolStarted {
        session_id: SessionId,
        tool: crate::ToolCall,
    },
    ToolUpdated {
        session_id: SessionId,
        tool: crate::ToolCall,
    },
    PermissionNeeded {
        session_id: SessionId,
        request: crate::PermissionRequest,
    },
    PlanUpdated {
        session_id: SessionId,
        steps: Vec<String>,
    },
    TurnFinished {
        session_id: SessionId,
        state: TurnState,
    },
    AgentError {
        message: String,
    },
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentConnectionStatus {
    MissingBinary,
    Starting,
    Ready,
    Reconnecting,
    Failed,
}
