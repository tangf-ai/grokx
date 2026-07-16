use serde::{Deserialize, Serialize};

use crate::ToolCallId;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionMode {
    /// Reads auto; writes and shell require approval.
    Standard,
    /// Most actions require approval.
    Strict,
    /// Project-local writes auto; dangerous shell still gated.
    TrustedProject,
}

impl Default for PermissionMode {
    fn default() -> Self {
        Self::Standard
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionDecision {
    AllowOnce,
    Deny,
    AllowSession,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PermissionRequest {
    pub id: String,
    pub tool_call_id: Option<ToolCallId>,
    pub tool_name: String,
    pub summary: String,
    pub detail: Option<String>,
    pub risk: PermissionRisk,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PermissionRisk {
    Low,
    Medium,
    High,
}
