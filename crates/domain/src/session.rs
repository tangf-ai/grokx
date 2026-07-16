use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// App-level session identity (may map 1:1 to a Grok ACP session).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct SessionId(pub Uuid);

impl SessionId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for SessionId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
pub struct ProjectId(pub Uuid);

impl ProjectId {
    pub fn new() -> Self {
        Self(Uuid::new_v4())
    }
}

impl Default for ProjectId {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: ProjectId,
    pub root_path: String,
    pub name: String,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionMeta {
    pub id: SessionId,
    pub project_id: ProjectId,
    /// Session id known to the Grok ACP agent, when created.
    pub engine_session_id: Option<String>,
    pub title: String,
    pub model: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
