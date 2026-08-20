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

/// Product-side auto vs ask. Full trust is handled by skipping the ACP gate.
pub fn evaluate(policy: &Policy, tool_name: &str, risk: PermissionRisk) -> AutoDecision {
    match policy.mode {
        PermissionMode::Strict => AutoDecision::Ask,
        PermissionMode::Standard => {
            if is_read_like(tool_name) && risk != PermissionRisk::High {
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
        PermissionMode::FullTrust => AutoDecision::Allow,
    }
}

/// Infer risk from the tool name / summary when ACP does not send one.
pub fn classify_risk(tool_name: &str, summary: Option<&str>) -> PermissionRisk {
    let blob = format!(
        "{} {}",
        tool_name,
        summary.unwrap_or("")
    )
    .to_ascii_lowercase();
    if is_shell_like(&blob) {
        PermissionRisk::High
    } else if is_read_like(tool_name) {
        PermissionRisk::Low
    } else {
        PermissionRisk::Medium
    }
}

pub fn is_read_like(tool: &str) -> bool {
    let lower = tool.trim().to_ascii_lowercase().replace('-', "_");
    matches!(
        lower.as_str(),
        "read_file"
            | "read"
            | "grep"
            | "glob"
            | "list_dir"
            | "list_directory"
            | "ls"
            | "search"
            | "codebase_search"
            | "glob_file_search"
            | "find"
    ) || lower.starts_with("read_")
        || lower.ends_with("_read")
}

fn is_edit_like(tool: &str) -> bool {
    matches!(
        tool,
        "search_replace" | "write" | "Edit" | "Write" | "MultiEdit"
    )
}

fn is_shell_like(blob: &str) -> bool {
    blob.contains("terminal")
        || blob.contains("bash")
        || blob.contains("shell")
        || blob.contains("execute")
        || blob.contains("run_terminal")
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

    #[test]
    fn ui_ask_always_asks() {
        let policy = Policy {
            mode: PermissionMode::from_ui("ask"),
        };
        assert_eq!(
            evaluate(&policy, "read_file", PermissionRisk::Low),
            AutoDecision::Ask
        );
        assert_eq!(
            evaluate(&policy, "run_terminal_command", PermissionRisk::High),
            AutoDecision::Ask
        );
    }

    #[test]
    fn ui_auto_allows_read_like_and_asks_shell() {
        let policy = Policy {
            mode: PermissionMode::from_ui("auto"),
        };
        assert_eq!(
            evaluate(&policy, "read_file", PermissionRisk::Low),
            AutoDecision::Allow
        );
        assert_eq!(
            evaluate(&policy, "Grep", PermissionRisk::Low),
            AutoDecision::Allow
        );
        assert_eq!(
            evaluate(&policy, "run_terminal_command", PermissionRisk::High),
            AutoDecision::Ask
        );
        assert_eq!(
            evaluate(&policy, "Write", PermissionRisk::Medium),
            AutoDecision::Ask
        );
    }

    #[test]
    fn ui_full_trust_allows_everything() {
        let policy = Policy {
            mode: PermissionMode::from_ui("always-approve"),
        };
        assert_eq!(
            evaluate(&policy, "Bash", PermissionRisk::High),
            AutoDecision::Allow
        );
        assert_eq!(
            evaluate(&policy, "Write", PermissionRisk::Medium),
            AutoDecision::Allow
        );
    }

    #[test]
    fn classify_risk_reads_low_shell_high() {
        assert_eq!(classify_risk("read_file", None), PermissionRisk::Low);
        assert_eq!(classify_risk("list_dir", None), PermissionRisk::Low);
        assert_eq!(
            classify_risk("run_terminal_command", Some("npm start")),
            PermissionRisk::High
        );
        assert_eq!(classify_risk("Write", None), PermissionRisk::Medium);
    }
}
