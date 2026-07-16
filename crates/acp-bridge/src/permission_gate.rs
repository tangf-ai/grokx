//! Permission request parking: when auto-approve is off, ACP permission
//! JSON-RPC requests stay pending until the UI resolves them.

use std::collections::HashMap;

use domain::PermissionDecision;
use serde_json::{json, Value};
use thiserror::Error;

#[derive(Debug, Error, PartialEq, Eq)]
pub enum GateError {
    #[error("unknown permission request id: {0}")]
    Unknown(String),
    #[error("permission already resolved: {0}")]
    AlreadyResolved(String),
}

#[derive(Debug, Clone)]
pub struct ParkedPermission {
    /// App-facing request id (also used by UI).
    pub request_id: String,
    /// JSON-RPC id from the agent (may be number or string).
    pub rpc_id: Value,
    pub tool_name: String,
    pub summary: String,
}

/// Tracks in-flight permission RPCs that must not be answered until the user decides.
#[derive(Debug, Default)]
pub struct PermissionGate {
    parked: HashMap<String, ParkedPermission>,
    resolved: HashMap<String, PermissionDecision>,
}

impl PermissionGate {
    pub fn new() -> Self {
        Self::default()
    }

    /// Park a permission request. Returns false if auto_approve should answer immediately.
    pub fn should_park(auto_approve: bool) -> bool {
        !auto_approve
    }

    pub fn park(&mut self, entry: ParkedPermission) {
        self.parked.insert(entry.request_id.clone(), entry);
    }

    pub fn is_pending(&self, request_id: &str) -> bool {
        self.parked.contains_key(request_id)
    }

    pub fn pending_ids(&self) -> Vec<String> {
        self.parked.keys().cloned().collect()
    }

    /// Resolve a parked request into an ACP outcome payload + the original rpc id.
    pub fn resolve(
        &mut self,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(Value, Value), GateError> {
        let entry = self
            .parked
            .remove(request_id)
            .ok_or_else(|| {
                if self.resolved.contains_key(request_id) {
                    GateError::AlreadyResolved(request_id.to_string())
                } else {
                    GateError::Unknown(request_id.to_string())
                }
            })?;
        self.resolved.insert(request_id.to_string(), decision);
        Ok((entry.rpc_id, permission_outcome_value(decision)))
    }

    pub fn last_decision(&self, request_id: &str) -> Option<PermissionDecision> {
        self.resolved.get(request_id).copied()
    }
}

pub fn permission_outcome_value(decision: PermissionDecision) -> Value {
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

/// Whether a deny decision should block the tool path (always true for Deny).
pub fn decision_blocks_tool(decision: PermissionDecision) -> bool {
    matches!(decision, PermissionDecision::Deny)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parks_until_allow() {
        assert!(PermissionGate::should_park(false));
        assert!(!PermissionGate::should_park(true));

        let mut gate = PermissionGate::new();
        gate.park(ParkedPermission {
            request_id: "req-1".into(),
            rpc_id: json!(42),
            tool_name: "Bash".into(),
            summary: "run ls".into(),
        });
        assert!(gate.is_pending("req-1"));
        assert!(gate.pending_ids().contains(&"req-1".to_string()));

        let (rpc_id, outcome) = gate
            .resolve("req-1", PermissionDecision::AllowOnce)
            .unwrap();
        assert_eq!(rpc_id, json!(42));
        assert_eq!(outcome["outcome"]["optionId"], "allow-once");
        assert!(!gate.is_pending("req-1"));
        assert!(!decision_blocks_tool(PermissionDecision::AllowOnce));
    }

    #[test]
    fn deny_blocks_and_stays_resolved() {
        let mut gate = PermissionGate::new();
        gate.park(ParkedPermission {
            request_id: "req-deny".into(),
            rpc_id: json!("rpc-9"),
            tool_name: "Write".into(),
            summary: "write file".into(),
        });
        let (_id, outcome) = gate.resolve("req-deny", PermissionDecision::Deny).unwrap();
        assert_eq!(outcome["outcome"]["optionId"], "reject-once");
        assert!(decision_blocks_tool(PermissionDecision::Deny));
        assert_eq!(
            gate.last_decision("req-deny"),
            Some(PermissionDecision::Deny)
        );
        assert_eq!(
            gate.resolve("req-deny", PermissionDecision::AllowOnce),
            Err(GateError::AlreadyResolved("req-deny".into()))
        );
    }
}
