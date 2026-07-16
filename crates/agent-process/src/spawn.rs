use std::process::Stdio;

use domain::AgentConnectionStatus;
use thiserror::Error;
use tokio::process::{Child, Command};

use crate::ResolvedEngine;

#[derive(Debug, Error)]
pub enum SpawnError {
    #[error("failed to spawn engine at {path}: {source}")]
    Io {
        path: String,
        #[source]
        source: std::io::Error,
    },
}

/// Handle for a running `grok agent stdio` process.
pub struct AgentChild {
    pub child: Child,
    pub engine: ResolvedEngine,
    pub status: AgentConnectionStatus,
}

#[derive(Debug, Clone, Default)]
pub struct SpawnOptions {
    pub model: Option<String>,
    /// Extra env vars (e.g. isolated engine data dir).
    pub env: Vec<(String, String)>,
    /// Extra args inserted after `agent` and before `stdio`
    /// (e.g. `--always-approve`).
    pub agent_args: Vec<String>,
}

/// Spawn `grok agent stdio` with stdin/stdout piped for ACP.
///
/// Final argv: `grok agent [agent_args...] [--model <id>] stdio`
pub fn spawn_agent_stdio(
    engine: ResolvedEngine,
    options: SpawnOptions,
) -> Result<AgentChild, SpawnError> {
    let mut cmd = Command::new(&engine.path);
    cmd.arg("agent");
    for arg in &options.agent_args {
        cmd.arg(arg);
    }
    if let Some(model) = &options.model {
        cmd.arg("--model").arg(model);
    }
    cmd.arg("stdio");
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    for (k, v) in &options.env {
        cmd.env(k, v);
    }

    let child = cmd.spawn().map_err(|source| SpawnError::Io {
        path: engine.path.display().to_string(),
        source,
    })?;

    Ok(AgentChild {
        child,
        engine,
        status: AgentConnectionStatus::Starting,
    })
}
