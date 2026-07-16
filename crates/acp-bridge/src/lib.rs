//! ACP bridge: JSON-RPC over stdio + mapping into [`domain::AppEvent`].
//!
//! Wire protocol follows the Agent Client Protocol used by `grok agent stdio`
//! (newline-delimited JSON-RPC 2.0).

mod client;
mod map;

pub use client::{AcpClient, AcpClientHandle, ConnectOptions};
pub use map::{map_session_update, turn_finished};

use thiserror::Error;

#[derive(Debug, Error)]
pub enum BridgeError {
    #[error("invalid ACP payload: {0}")]
    InvalidPayload(String),
    #[error("agent RPC error {code}: {message}")]
    Rpc { code: i64, message: String },
    #[error("agent process ended unexpectedly")]
    ProcessExited,
    #[error("request timed out waiting for agent response")]
    Timeout,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
    #[error("channel closed")]
    ChannelClosed,
    #[error("{0}")]
    Message(String),
}
