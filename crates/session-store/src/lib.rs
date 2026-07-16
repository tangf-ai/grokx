//! Session metadata persistence.
//!
//! V1 uses an in-memory store so the monorepo compiles without SQLite setup.
//! Replace with SQLite migrations under `src/migrations/` before shipping.

use std::collections::HashMap;

use chrono::Utc;
use domain::{Project, ProjectId, SessionId, SessionMeta};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("session not found: {0:?}")]
    SessionNotFound(SessionId),
    #[error("project not found: {0:?}")]
    ProjectNotFound(ProjectId),
}

#[derive(Debug, Default)]
pub struct SessionStore {
    projects: HashMap<ProjectId, Project>,
    sessions: HashMap<SessionId, SessionMeta>,
}

impl SessionStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upsert_project(&mut self, project: Project) {
        self.projects.insert(project.id.clone(), project);
    }

    pub fn upsert_session(&mut self, session: SessionMeta) {
        self.sessions.insert(session.id.clone(), session);
    }

    pub fn get_session(&self, id: &SessionId) -> Result<&SessionMeta, StoreError> {
        self.sessions
            .get(id)
            .ok_or_else(|| StoreError::SessionNotFound(id.clone()))
    }

    pub fn list_sessions_for_project(&self, project_id: &ProjectId) -> Vec<&SessionMeta> {
        let mut items: Vec<_> = self
            .sessions
            .values()
            .filter(|s| &s.project_id == project_id)
            .collect();
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        items
    }

    pub fn touch_session(&mut self, id: &SessionId) -> Result<(), StoreError> {
        let s = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| StoreError::SessionNotFound(id.clone()))?;
        s.updated_at = Utc::now();
        Ok(())
    }
}
