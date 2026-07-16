//! Session / task metadata persistence.
//!
//! Product model:
//! - **Project** = concrete workspace path (stable, user-chosen)
//! - **Session** (UI: Task) = temporary workspace under `~/.grokx/tasks/<id>`
//!   with a `project` symlink into the project root for source access
//!
//! Persistence:
//! - App data: `sessions-index.json` (project + session list)
//! - Per task: `~/.grokx/tasks/<id>/meta.json` + `chat-history.json`

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use chrono::{DateTime, Utc};
use domain::{Project, ProjectId, SessionId, SessionMeta};
use serde::{Deserialize, Serialize};
use thiserror::Error;
use uuid::Uuid;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("session not found: {0:?}")]
    SessionNotFound(SessionId),
    #[error("project not found: {0:?}")]
    ProjectNotFound(ProjectId),
    #[error("session title cannot be empty")]
    EmptyTitle,
    #[error("io error: {0}")]
    Io(#[from] std::io::Error),
    #[error("json error: {0}")]
    Json(#[from] serde_json::Error),
}

/// On-disk snapshot of the in-memory store.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
struct StoreSnapshot {
    #[serde(default)]
    projects: Vec<Project>,
    #[serde(default)]
    sessions: Vec<SessionMeta>,
}

/// Written into each task directory for recovery if the app index is missing.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TaskDirMeta {
    pub session_id: String,
    pub project_id: String,
    pub project_root: String,
    pub project_name: String,
    pub title: String,
    pub model: Option<String>,
    pub work_path: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Flattened row for UI session / task lists.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionListItem {
    pub session_id: SessionId,
    pub project_id: ProjectId,
    pub project_root: String,
    pub project_name: String,
    /// Temporary task cwd (`~/.grokx/tasks/<id>`).
    pub work_path: String,
    pub engine_session_id: Option<String>,
    pub title: String,
    pub updated_at: chrono::DateTime<Utc>,
    pub created_at: chrono::DateTime<Utc>,
}

/// Project row for the Projects layer (parent of sessions).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProjectListItem {
    pub project_id: ProjectId,
    pub name: String,
    pub root_path: String,
    pub session_count: usize,
    pub created_at: chrono::DateTime<Utc>,
    pub updated_at: chrono::DateTime<Utc>,
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
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
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
                    work_path: s.work_path.clone(),
                    engine_session_id: s.engine_session_id.clone(),
                    title: s.title.clone(),
                    updated_at: s.updated_at,
                    created_at: s.created_at,
                }
            })
            .collect();
        // Stable order: newest-created first. Do NOT sort by updated_at —
        // clicking/activating a task must not reshuffle the sidebar list.
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        items
    }

    pub fn list_projects(&self) -> Vec<&Project> {
        let mut items: Vec<_> = self.projects.values().collect();
        items.sort_by(|a, b| a.name.cmp(&b.name));
        items
    }

    /// Projects with session counts. Order by project created_at (stable).
    pub fn list_project_items(&self) -> Vec<ProjectListItem> {
        let mut items: Vec<ProjectListItem> = self
            .projects
            .values()
            .map(|p| {
                let sessions: Vec<_> = self
                    .sessions
                    .values()
                    .filter(|s| s.project_id == p.id)
                    .collect();
                let updated_at = sessions
                    .iter()
                    .map(|s| s.updated_at)
                    .max()
                    .unwrap_or(p.created_at);
                ProjectListItem {
                    project_id: p.id.clone(),
                    name: p.name.clone(),
                    root_path: p.root_path.clone(),
                    session_count: sessions.len(),
                    created_at: p.created_at,
                    updated_at,
                }
            })
            .collect();
        // Stable: newest project first (not last-opened session).
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
        items
    }

    pub fn list_session_items_for_project(&self, project_id: &ProjectId) -> Vec<SessionListItem> {
        let mut items: Vec<SessionListItem> = self
            .sessions
            .values()
            .filter(|s| &s.project_id == project_id)
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
                    work_path: s.work_path.clone(),
                    engine_session_id: s.engine_session_id.clone(),
                    title: s.title.clone(),
                    updated_at: s.updated_at,
                    created_at: s.created_at,
                }
            })
            .collect();
        // Stable order: newest-created first (clicking a task must not reorder).
        items.sort_by(|a, b| b.created_at.cmp(&a.created_at));
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

    pub fn rename_session(&mut self, id: &SessionId, title: impl Into<String>) -> Result<(), StoreError> {
        let title = title.into().trim().to_string();
        if title.is_empty() {
            return Err(StoreError::EmptyTitle);
        }
        let s = self
            .sessions
            .get_mut(id)
            .ok_or_else(|| StoreError::SessionNotFound(id.clone()))?;
        s.title = title;
        // Keep created_at (list order) and updated_at stable on rename.
        Ok(())
    }

    /// Remove a session from the store. Returns its work_path for disk cleanup.
    pub fn delete_session(&mut self, id: &SessionId) -> Result<SessionMeta, StoreError> {
        self.sessions
            .remove(id)
            .ok_or_else(|| StoreError::SessionNotFound(id.clone()))
    }

    /// Load projects + sessions from the app data index file.
    pub fn load_from_file(path: &Path) -> Result<Self, StoreError> {
        if !path.is_file() {
            return Ok(Self::new());
        }
        let raw = std::fs::read_to_string(path)?;
        let snap: StoreSnapshot = serde_json::from_str(&raw)?;
        let mut store = Self::new();
        for p in snap.projects {
            store.projects.insert(p.id.clone(), p);
        }
        for s in snap.sessions {
            store.sessions.insert(s.id.clone(), s);
        }
        Ok(store)
    }

    /// Persist projects + sessions to the app data index file.
    pub fn save_to_file(&self, path: &Path) -> Result<(), StoreError> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let snap = StoreSnapshot {
            projects: self.projects.values().cloned().collect(),
            sessions: self.sessions.values().cloned().collect(),
        };
        let raw = serde_json::to_string_pretty(&snap)?;
        let tmp = path.with_extension("json.tmp");
        std::fs::write(&tmp, raw)?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Write `meta.json` into a task work directory (for recovery).
    pub fn write_task_dir_meta(&self, session_id: &SessionId) -> Result<(), StoreError> {
        let s = self.get_session(session_id)?;
        if s.work_path.is_empty() {
            return Ok(());
        }
        let project = self.projects.get(&s.project_id);
        let meta = TaskDirMeta {
            session_id: s.id.0.to_string(),
            project_id: s.project_id.0.to_string(),
            project_root: project
                .map(|p| p.root_path.clone())
                .unwrap_or_default(),
            project_name: project
                .map(|p| p.name.clone())
                .unwrap_or_else(|| "unknown".into()),
            title: s.title.clone(),
            model: s.model.clone(),
            work_path: s.work_path.clone(),
            created_at: s.created_at,
            updated_at: s.updated_at,
        };
        let dir = PathBuf::from(&s.work_path);
        std::fs::create_dir_all(&dir)?;
        let path = dir.join("meta.json");
        let tmp = dir.join("meta.json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(&meta)?)?;
        std::fs::rename(&tmp, &path)?;
        Ok(())
    }

    /// Scan `~/.grokx/tasks/*` and import any tasks missing from the index.
    /// Recovers sessions after reinstall / wiped app data if task dirs remain.
    pub fn import_from_tasks_root(&mut self, tasks_root: &Path) -> usize {
        if !tasks_root.is_dir() {
            return 0;
        }
        let mut imported = 0;
        let rd = match std::fs::read_dir(tasks_root) {
            Ok(r) => r,
            Err(_) => return 0,
        };
        for entry in rd.flatten() {
            let path = entry.path();
            if !path.is_dir() {
                continue;
            }
            let dir_name = path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let sid = match Uuid::parse_str(&dir_name) {
                Ok(u) => SessionId(u),
                Err(_) => continue,
            };
            if self.sessions.contains_key(&sid) {
                // Refresh work_path if empty / missing.
                if let Ok(s) = self.get_session_mut(&sid) {
                    if s.work_path.is_empty() {
                        s.work_path = path.display().to_string();
                    }
                }
                continue;
            }

            // Prefer meta.json; fall back to chat-history presence.
            let meta_path = path.join("meta.json");
            let chat_path = path.join("chat-history.json");
            if !meta_path.is_file() && !chat_path.is_file() {
                continue;
            }

            let title_from_chat = first_user_title_from_chat(&chat_path);

            let (project_root, project_name, title, model, created_at, updated_at, project_id) =
                if meta_path.is_file() {
                    match std::fs::read_to_string(&meta_path)
                        .ok()
                        .and_then(|r| serde_json::from_str::<TaskDirMeta>(&r).ok())
                    {
                        Some(m) => {
                            let pid = Uuid::parse_str(&m.project_id)
                                .map(ProjectId)
                                .unwrap_or_else(|_| ProjectId::new());
                            let title = if m.title == "New task"
                                || m.title == "Restored task"
                                || m.title.is_empty()
                            {
                                title_from_chat
                                    .clone()
                                    .unwrap_or_else(|| m.title.clone())
                            } else {
                                m.title
                            };
                            (
                                m.project_root,
                                m.project_name,
                                title,
                                m.model,
                                m.created_at,
                                m.updated_at,
                                pid,
                            )
                        }
                        None => continue,
                    }
                } else {
                    // Infer from project symlink + file mtime.
                    let project_link = path.join("project");
                    let project_root = std::fs::read_link(&project_link)
                        .ok()
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(dirs_home_workspace);
                    let mtime = std::fs::metadata(&chat_path)
                        .and_then(|m| m.modified())
                        .ok()
                        .map(DateTime::<Utc>::from)
                        .unwrap_or_else(Utc::now);
                    (
                        project_root.clone(),
                        PathBuf::from(&project_root)
                            .file_name()
                            .map(|s| s.to_string_lossy().into_owned())
                            .unwrap_or_else(|| "Workspace".into()),
                        title_from_chat.unwrap_or_else(|| "Restored task".into()),
                        None,
                        mtime,
                        mtime,
                        ProjectId::new(),
                    )
                };

            // Ensure project exists (match by root when possible).
            let project_id = if let Some(existing) = self.find_project_by_root(&project_root) {
                existing.id.clone()
            } else {
                let p = Project {
                    id: project_id,
                    root_path: project_root,
                    name: project_name,
                    created_at,
                };
                let id = p.id.clone();
                self.upsert_project(p);
                id
            };

            self.upsert_session(SessionMeta {
                id: sid,
                project_id,
                engine_session_id: None,
                title,
                model,
                work_path: path.display().to_string(),
                created_at,
                updated_at,
            });
            imported += 1;
        }
        imported
    }
}

fn dirs_home_workspace() -> String {
    directories::UserDirs::new()
        .map(|u| {
            u.home_dir()
                .join(".grokx")
                .join("workspace")
                .display()
                .to_string()
        })
        .unwrap_or_else(|| "~/.grokx/workspace".into())
}

/// Best-effort title from the first user message in chat-history.json.
fn first_user_title_from_chat(chat_path: &Path) -> Option<String> {
    let raw = std::fs::read_to_string(chat_path).ok()?;
    let val: serde_json::Value = serde_json::from_str(&raw).ok()?;
    let arr = val.as_array()?;
    for item in arr {
        if item.get("kind").and_then(|k| k.as_str()) != Some("user") {
            continue;
        }
        let text = item.get("text").and_then(|t| t.as_str())?.trim();
        if text.is_empty() {
            continue;
        }
        return Some(clamp_title(text));
    }
    None
}

/// Placeholder titles that should be replaced after the first real exchange.
pub fn is_placeholder_title(title: &str) -> bool {
    let t = title.trim();
    t.is_empty() || t == "New task" || t == "Restored task"
}

/// Build a short sidebar title from the first user message and optional first assistant reply.
pub fn summarize_session_title(user_text: &str, assistant_text: Option<&str>) -> String {
    let user = clamp_title(user_text);
    let Some(asst) = assistant_text.map(str::trim).filter(|s| !s.is_empty()) else {
        return user;
    };
    // Prefer a compact "topic · takeaway" when both sides exist.
    let asst_one = clamp_title(asst);
    if user.is_empty() {
        return asst_one;
    }
    // If assistant starts with a short heading-like line, blend; else keep user-focused.
    if asst_one.chars().count() <= 24 {
        let blended = format!("{user} · {asst_one}");
        return clamp_title(&blended);
    }
    user
}

fn clamp_title(text: &str) -> String {
    let one_line = text
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty())
        .unwrap_or("")
        .trim();
    // Strip common URL noise for titles when the line is mostly a link + short verb.
    let cleaned = one_line
        .replace("https://", "")
        .replace("http://", "");
    let source = if cleaned.chars().count() < one_line.chars().count().saturating_sub(8) {
        // Kept most of the non-url content
        cleaned.trim()
    } else {
        one_line
    };
    let mut t = source.chars().take(40).collect::<String>();
    if source.chars().count() > 40 {
        t.push('…');
    }
    t
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
            work_path: "/tmp/tasks/old".into(),
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
            work_path: "/tmp/tasks/new".into(),
            created_at: t1,
            updated_at: t1,
        });

        let list = store.list_sessions();
        assert_eq!(list.len(), 2);
        // Newest-created first (not last-touched).
        assert_eq!(list[0].session_id, s_new);
        assert_eq!(list[0].project_root, "/tmp/b");
        assert_eq!(list[1].session_id, s_old);
        assert_eq!(list[1].project_name, "a");
        assert_eq!(list[1].engine_session_id.as_deref(), Some("eng-old"));

        // Touching the older session must not reorder the list.
        store.touch_session(&s_old).unwrap();
        let list2 = store.list_sessions();
        assert_eq!(list2[0].session_id, s_new);
        assert_eq!(list2[1].session_id, s_old);
    }

    #[test]
    fn summarize_session_title_prefers_user_topic() {
        assert!(is_placeholder_title("New task"));
        assert!(is_placeholder_title("Restored task"));
        assert!(!is_placeholder_title("本体与语义层"));

        let t = summarize_session_title(
            "https://mp.weixin.qq.com/s/abc 总结下本体和语义层",
            Some("AI 问数对不上，多半是语义层和本体没建好。"),
        );
        assert!(!t.is_empty());
        assert!(t.chars().count() <= 41);
        assert!(t.contains("总结") || t.contains("本体") || t.contains("语义"));
    }

    #[test]
    fn rename_session_updates_title() {
        let mut store = SessionStore::new();
        let pid = ProjectId::new();
        let sid = SessionId::new();
        let now = Utc::now();
        store.upsert_project(Project {
            id: pid.clone(),
            root_path: "/tmp/a".into(),
            name: "a".into(),
            created_at: now,
        });
        store.upsert_session(SessionMeta {
            id: sid.clone(),
            project_id: pid,
            engine_session_id: None,
            title: "old name".into(),
            model: None,
            work_path: "/tmp/tasks/sid".into(),
            created_at: now,
            updated_at: now,
        });
        store.rename_session(&sid, "  Renamed task  ").unwrap();
        assert_eq!(store.get_session(&sid).unwrap().title, "Renamed task");
        assert!(matches!(
            store.rename_session(&sid, "   "),
            Err(StoreError::EmptyTitle)
        ));
    }
}
