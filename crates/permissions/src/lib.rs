//! Permission policy evaluation and in-memory approval broker.

use std::collections::HashMap;

use domain::{PermissionDecision, PermissionMode, PermissionRequest, PermissionRisk};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum PermissionError {
    #[error("unknown permission request id: {0}")]
    UnknownRequest(String),
}

#[derive(Debug, Clone)]
pub struct Policy {
    pub mode: PermissionMode,
}

impl Default for Policy {
    fn default() -> Self {
        Self {
            mode: PermissionMode::Standard,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AutoDecision {
    Allow,
    Ask,
    Deny,
}

/// Very small policy skeleton — expand with path/command rules later.
pub fn evaluate(policy: &Policy, tool_name: &str, risk: PermissionRisk) -> AutoDecision {
    match policy.mode {
        PermissionMode::Strict => AutoDecision::Ask,
        PermissionMode::Standard => {
            if is_read_like(tool_name) && risk == PermissionRisk::Low {
                AutoDecision::Allow
            } else {
                AutoDecision::Ask
            }
        }
        PermissionMode::TrustedProject => {
            if risk == PermissionRisk::High {
                AutoDecision::Ask
            } else if is_read_like(tool_name) || is_edit_like(tool_name) {
                AutoDecision::Allow
            } else {
                AutoDecision::Ask
            }
        }
    }
}

fn is_read_like(tool: &str) -> bool {
    matches!(
        tool,
        "read_file" | "grep" | "list_dir" | "Read" | "Grep" | "Glob"
    )
}

fn is_edit_like(tool: &str) -> bool {
    matches!(
        tool,
        "search_replace" | "write" | "Edit" | "Write" | "MultiEdit"
    )
}

#[derive(Debug, Default)]
pub struct PermissionBroker {
    pending: HashMap<String, PermissionRequest>,
    session_allows: HashMap<String, bool>,
}

impl PermissionBroker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn enqueue(&mut self, mut request: PermissionRequest) -> String {
        if request.id.is_empty() {
            request.id = Uuid::new_v4().to_string();
        }
        let id = request.id.clone();
        self.pending.insert(id.clone(), request);
        id
    }

    pub fn resolve(
        &mut self,
        id: &str,
        decision: PermissionDecision,
    ) -> Result<PermissionRequest, PermissionError> {
        let req = self
            .pending
            .remove(id)
            .ok_or_else(|| PermissionError::UnknownRequest(id.to_string()))?;

        if decision == PermissionDecision::AllowSession {
            self.session_allows.insert(req.tool_name.clone(), true);
        }
        Ok(req)
    }

    pub fn session_allowed(&self, tool_name: &str) -> bool {
        self.session_allows.get(tool_name).copied().unwrap_or(false)
    }

    pub fn is_pending(&self, id: &str) -> bool {
        self.pending.contains_key(id)
    }

    pub fn pending_count(&self) -> usize {
        self.pending.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use domain::PermissionRequest;

    #[test]
    fn enqueue_stays_pending_until_resolve() {
        let mut broker = PermissionBroker::new();
        let id = broker.enqueue(PermissionRequest {
            id: "p1".into(),
            tool_call_id: None,
            tool_name: "Bash".into(),
            summary: "ls".into(),
            detail: None,
            risk: PermissionRisk::Medium,
        });
        assert!(broker.is_pending(&id));
        assert_eq!(broker.pending_count(), 1);
        broker.resolve(&id, PermissionDecision::Deny).unwrap();
        assert!(!broker.is_pending(&id));
    }
}
