//! Session metadata persistence.
//!
//! V1 uses an in-memory store so the monorepo compiles without SQLite setup.
//! Replace with SQLite migrations under `src/migrations/` before shipping.

use std::collections::HashMap;

use chrono::Utc;
use domain::{Project, ProjectId, SessionId, SessionMeta};
use serde::{Deserialize, Serialize};
use thiserror::Error;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("session not found: {0:?}")]
    SessionNotFound(SessionId),
    #[error("project not found: {0:?}")]
    ProjectNotFound(ProjectId),
}

/// Flattened row for UI session lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionListItem {
    pub session_id: SessionId,
    pub project_id: ProjectId,
    pub project_root: String,
    pub project_name: String,
    pub engine_session_id: Option<String>,
    pub title: String,
    pub updated_at: chrono::DateTime<Utc>,
    pub created_at: chrono::DateTime<Utc>,
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

    pub fn get_project(&self, id: &ProjectId) -> Result<&Project, StoreError> {
        self.projects
            .get(id)
            .ok_or_else(|| StoreError::ProjectNotFound(id.clone()))
    }

    pub fn get_session(&self, id: &SessionId) -> Result<&SessionMeta, StoreError> {
        self.sessions
            .get(id)
            .ok_or_else(|| StoreError::SessionNotFound(id.clone()))
    }

    pub fn get_session_mut(&mut self, id: &SessionId) -> Result<&mut SessionMeta, StoreError> {
        self.sessions
            .get_mut(id)
            .ok_or_else(|| StoreError::SessionNotFound(id.clone()))
    }

    pub fn find_project_by_root(&self, root: &str) -> Option<&Project> {
        self.projects.values().find(|p| p.root_path == root)
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

    /// All sessions with project metadata, newest first.
    pub fn list_sessions(&self) -> Vec<SessionListItem> {
        let mut items: Vec<SessionListItem> = self
            .sessions
            .values()
            .map(|s| {
                let project = self.projects.get(&s.project_id);
                SessionListItem {
                    session_id: s.id.clone(),
                    project_id: s.project_id.clone(),
                    project_root: project
                        .map(|p| p.root_path.clone())
                        .unwrap_or_default(),
                    project_name: project
                        .map(|p| p.name.clone())
                        .unwrap_or_else(|| "unknown".into()),
                    engine_session_id: s.engine_session_id.clone(),
                    title: s.title.clone(),
                    updated_at: s.updated_at,
                    created_at: s.created_at,
                }
            })
            .collect();
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        items
    }

    pub fn list_projects(&self) -> Vec<&Project> {
        let mut items: Vec<_> = self.projects.values().collect();
        items.sort_by(|a, b| a.name.cmp(&b.name));
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

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn list_sessions_includes_project_and_order() {
        let mut store = SessionStore::new();
        let p1 = ProjectId::new();
        let p2 = ProjectId::new();
        store.upsert_project(Project {
            id: p1.clone(),
            root_path: "/tmp/a".into(),
            name: "a".into(),
            created_at: Utc::now(),
        });
        store.upsert_project(Project {
            id: p2.clone(),
            root_path: "/tmp/b".into(),
            name: "b".into(),
            created_at: Utc::now(),
        });
        let s_old = SessionId::new();
        let s_new = SessionId::new();
        let t0 = Utc::now();
        store.upsert_session(SessionMeta {
            id: s_old.clone(),
            project_id: p1,
            engine_session_id: Some("eng-old".into()),
            title: "old".into(),
            model: None,
            created_at: t0,
            updated_at: t0,
        });
        // Newer session
        std::thread::sleep(std::time::Duration::from_millis(5));
        let t1 = Utc::now();
        store.upsert_session(SessionMeta {
            id: s_new.clone(),
            project_id: p2,
            engine_session_id: None,
            title: "new".into(),
            model: None,
            created_at: t1,
            updated_at: t1,
        });

        let list = store.list_sessions();
        assert_eq!(list.len(), 2);
        assert_eq!(list[0].session_id, s_new);
        assert_eq!(list[0].project_root, "/tmp/b");
        assert_eq!(list[1].session_id, s_old);
        assert_eq!(list[1].project_name, "a");
        assert_eq!(list[1].engine_session_id.as_deref(), Some("eng-old"));
    }
}
