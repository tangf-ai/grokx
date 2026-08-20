//! Cross-platform session process listing and control.
//!
//! Listing uses `sysinfo` (Windows / macOS / Linux). Signals:
//! - Unix: `kill -TERM|-KILL|-STOP|-CONT`
//! - Windows: `taskkill` for stop/kill; `NtSuspendProcess` / `NtResumeProcess` for pause.

use std::path::Path;

use serde::Serialize;
use sysinfo::{Pid, ProcessStatus, ProcessesToUpdate, System};
#[cfg(windows)]
use tracing::warn;

use crate::CoreError;

/// A process started under the session agent (tool shells, servers, etc.).
#[derive(Debug, Clone, Serialize)]
pub struct SessionProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub command: String,
    pub etime: String,
    pub state: String,
    pub cpu: String,
    pub mem: String,
    /// Depth under the agent (1 = direct child).
    pub depth: u32,
    /// Working directory when available.
    pub cwd: Option<String>,
    pub paused: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct ProcSnap {
    pub pid: u32,
    pub ppid: u32,
    pub etime: String,
    pub cpu: String,
    pub mem: String,
    pub state: String,
    pub command: String,
    pub cwd: Option<String>,
    pub paused: bool,
}

pub(crate) fn process_exists(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    if sys.process(Pid::from_u32(pid)).is_some() {
        return true;
    }
    #[cfg(unix)]
    {
        std::process::Command::new("kill")
            .args(["-0", &pid.to_string()])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    }
    #[cfg(windows)]
    {
        windows_process_exists(pid)
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}

pub(crate) fn process_snapshot(pid: u32) -> Option<ProcSnap> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::Some(&[Pid::from_u32(pid)]), true);
    let total_mem = sys.total_memory().max(1);
    sys.process(Pid::from_u32(pid))
        .map(|p| snap_from_sysinfo(p, total_mem))
        .or_else(|| unix_ps_snapshot(pid))
}

pub(crate) fn process_cwd(pid: u32) -> Option<String> {
    process_snapshot(pid).and_then(|s| s.cwd)
}

pub(crate) fn list_all_processes() -> Vec<ProcSnap> {
    let mut sys = System::new();
    sys.refresh_processes(ProcessesToUpdate::All, true);
    let total_mem = sys.total_memory().max(1);
    let mut out: Vec<ProcSnap> = sys
        .processes()
        .values()
        .map(|p| snap_from_sysinfo(p, total_mem))
        .collect();
    if out.is_empty() {
        out = unix_list_all_processes();
    }
    out
}

fn snap_from_sysinfo(p: &sysinfo::Process, total_mem: u64) -> ProcSnap {
    let pid = p.pid().as_u32();
    let ppid = p.parent().map(|x| x.as_u32()).unwrap_or(0);
    let command = {
        let cmd = p
            .cmd()
            .iter()
            .map(|s| s.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ");
        if cmd.trim().is_empty() {
            p.name().to_string_lossy().into_owned()
        } else {
            cmd
        }
    };
    let mem_pct = (p.memory() as f64 / total_mem as f64) * 100.0;
    let status = p.status();
    let paused = is_paused_status(status);
    ProcSnap {
        pid,
        ppid,
        etime: format_etime(p.run_time()),
        cpu: format!("{:.1}", p.cpu_usage()),
        mem: format!("{mem_pct:.1}"),
        state: status_label(status),
        command,
        cwd: p.cwd().map(|c| c.display().to_string()),
        paused,
    }
}

fn is_paused_status(status: ProcessStatus) -> bool {
    matches!(status, ProcessStatus::Stop | ProcessStatus::Tracing)
}

fn status_label(status: ProcessStatus) -> String {
    match status {
        ProcessStatus::Idle => "I".into(),
        ProcessStatus::Run => "R".into(),
        ProcessStatus::Sleep => "S".into(),
        ProcessStatus::Stop => "T".into(),
        ProcessStatus::Zombie => "Z".into(),
        ProcessStatus::Tracing => "T".into(),
        ProcessStatus::Dead => "X".into(),
        ProcessStatus::Parked => "P".into(),
        other => format!("{other:?}"),
    }
}

fn format_etime(secs: u64) -> String {
    let days = secs / 86_400;
    let hours = (secs % 86_400) / 3_600;
    let mins = (secs % 3_600) / 60;
    let s = secs % 60;
    if days > 0 {
        format!("{days}-{hours:02}:{mins:02}:{s:02}")
    } else if hours > 0 {
        format!("{hours:02}:{mins:02}:{s:02}")
    } else {
        format!("{mins:02}:{s:02}")
    }
}

pub(crate) fn snap_to_info(
    pid: u32,
    command_fallback: Option<String>,
    depth: u32,
) -> Option<SessionProcessInfo> {
    let snap = process_snapshot(pid);
    let command = snap
        .as_ref()
        .map(|s| s.command.clone())
        .or(command_fallback)?;
    let paused = snap.as_ref().map(|s| s.paused).unwrap_or(false);
    Some(SessionProcessInfo {
        pid,
        ppid: snap.as_ref().map(|s| s.ppid).unwrap_or(0),
        command,
        etime: snap
            .as_ref()
            .map(|s| s.etime.clone())
            .unwrap_or_else(|| "—".into()),
        state: snap
            .as_ref()
            .map(|s| s.state.clone())
            .unwrap_or_else(|| "?".into()),
        cpu: snap
            .as_ref()
            .map(|s| s.cpu.clone())
            .unwrap_or_else(|| "0".into()),
        mem: snap
            .as_ref()
            .map(|s| s.mem.clone())
            .unwrap_or_else(|| "0".into()),
        depth,
        cwd: snap.as_ref().and_then(|s| s.cwd.clone()),
        paused,
    })
}

pub(crate) fn list_descendant_processes(agent_pid: u32) -> Vec<SessionProcessInfo> {
    if agent_pid == 0 {
        return Vec::new();
    }
    let all = list_all_processes();
    let mut by_ppid: std::collections::HashMap<u32, Vec<&ProcSnap>> =
        std::collections::HashMap::new();
    for p in &all {
        by_ppid.entry(p.ppid).or_default().push(p);
    }
    let mut out = Vec::new();
    let mut stack: Vec<(u32, u32)> = vec![(agent_pid, 0)];
    while let Some((parent, depth)) = stack.pop() {
        if let Some(children) = by_ppid.get(&parent) {
            for c in children {
                let d = depth + 1;
                out.push(SessionProcessInfo {
                    pid: c.pid,
                    ppid: c.ppid,
                    command: c.command.clone(),
                    etime: c.etime.clone(),
                    state: c.state.clone(),
                    cpu: c.cpu.clone(),
                    mem: c.mem.clone(),
                    depth: d,
                    cwd: c.cwd.clone(),
                    paused: c.paused,
                });
                stack.push((c.pid, d));
            }
        }
    }
    out.sort_by(|a, b| a.depth.cmp(&b.depth).then(a.pid.cmp(&b.pid)));
    out
}

pub(crate) fn include_related_orphans(opt_in: bool) -> bool {
    opt_in
}

pub(crate) fn orphans_opt_in() -> bool {
    matches!(
        std::env::var("GROKX_OUTPUTS_ORPHANS").as_deref(),
        Ok("1") | Ok("true") | Ok("TRUE")
    )
}

pub(crate) fn orphan_matches_session(
    work_path: &Path,
    project_root: &Path,
    cwd: Option<&str>,
    command: &str,
) -> bool {
    let work_s = work_path.display().to_string();
    let proj_s = project_root.display().to_string();
    if work_s.len() < 8 && proj_s.len() < 8 {
        return false;
    }
    let work_norm = work_s.trim_end_matches(['/', '\\']).to_string();
    let proj_norm = proj_s.trim_end_matches(['/', '\\']).to_string();

    let cwd_match = cwd
        .map(|c| {
            let c = c.trim_end_matches(['/', '\\']);
            (!work_norm.is_empty()
                && (c == work_norm || c.starts_with(&format!("{work_norm}/")) || c.starts_with(&format!("{work_norm}\\"))))
                || (!proj_norm.is_empty()
                    && (c == proj_norm
                        || c.starts_with(&format!("{proj_norm}/"))
                        || c.starts_with(&format!("{proj_norm}\\"))))
        })
        .unwrap_or(false);

    let cmd_work_match = !work_norm.is_empty() && command.contains(&work_norm);
    cwd_match || cmd_work_match
}

pub(crate) fn find_related_orphans(
    work_path: &Path,
    project_root: &Path,
    skip_pids: &std::collections::HashSet<u32>,
) -> Vec<SessionProcessInfo> {
    let work_s = work_path.display().to_string();
    let proj_s = project_root.display().to_string();
    if work_s.len() < 8 && proj_s.len() < 8 {
        return Vec::new();
    }
    let self_pid = std::process::id();

    let mut out = Vec::new();
    for p in list_all_processes() {
        if skip_pids.contains(&p.pid) || p.pid == self_pid {
            continue;
        }
        let cmd = &p.command;
        if cmd.contains("grokx-desktop")
            || cmd.contains("tauri.js")
            || cmd.contains("vite")
            || cmd.contains("/grok agent")
            || cmd.contains("runtime/grok")
            || cmd.contains("grok.exe")
        {
            continue;
        }
        if cmd.starts_with("/System/")
            || cmd.starts_with("/usr/libexec/")
            || cmd.starts_with("/sbin/")
            || cmd.contains("cloudflared")
            || cmd.contains("Cursor Helper")
            || cmd.contains("Google Chrome")
        {
            continue;
        }

        if !orphan_matches_session(work_path, project_root, p.cwd.as_deref(), cmd) {
            continue;
        }

        let looks_like_server = cmd.contains(" web ")
            || cmd.contains(" serve")
            || cmd.contains("uvicorn")
            || cmd.contains("flask")
            || cmd.contains("django")
            || cmd.contains("next ")
            || cmd.contains("vite")
            || cmd.contains("--port")
            || cmd.contains("0.0.0.0")
            || cmd.contains("127.0.0.1")
            || cmd.contains("mykg web")
            || cmd.contains("npm run")
            || cmd.contains("pnpm ")
            || cmd.contains("yarn ");

        if !looks_like_server
            && !(cmd.contains("python")
                || cmd.contains("node")
                || cmd.contains("uv ")
                || cmd.contains("cargo ")
                || cmd.contains("ruby")
                || cmd.contains("java"))
        {
            continue;
        }

        out.push(SessionProcessInfo {
            pid: p.pid,
            ppid: p.ppid,
            command: p.command.clone(),
            etime: p.etime.clone(),
            state: p.state.clone(),
            cpu: p.cpu.clone(),
            mem: p.mem.clone(),
            depth: 1,
            cwd: p.cwd.clone(),
            paused: p.paused,
        });
    }
    out
}

pub(crate) fn signal_process(pid: u32, kind: &str) -> Result<(), CoreError> {
    match kind {
        "term" | "kill" | "stop" | "cont" => {}
        other => {
            return Err(CoreError::Message(format!("unknown signal {other}")));
        }
    }
    #[cfg(unix)]
    {
        unix_signal(pid, kind)
    }
    #[cfg(windows)]
    {
        windows_signal(pid, kind)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = pid;
        Err(CoreError::Message(format!(
            "process control is not supported on this platform ({kind})"
        )))
    }
}

pub(crate) fn signal_process_tree(root: u32, kind: &str) -> Result<(), CoreError> {
    let mut pids: Vec<u32> = list_descendant_processes(root)
        .into_iter()
        .map(|p| p.pid)
        .collect();
    pids.push(root);
    pids.reverse();
    let mut last_err: Option<CoreError> = None;
    for pid in pids {
        if let Err(e) = signal_process(pid, kind) {
            last_err = Some(e);
        }
    }
    if process_exists(root) {
        if let Some(e) = last_err {
            return Err(e);
        }
    }
    Ok(())
}

pub(crate) fn spawn_restarted(command: &str, cwd: &Path) -> Result<u32, CoreError> {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let child = std::process::Command::new("cmd")
            .args(["/C", command])
            .current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| CoreError::Message(format!("restart failed: {e}")))?;
        let pid = child.id();
        std::mem::forget(child);
        Ok(pid)
    }
    #[cfg(not(windows))]
    {
        let child = std::process::Command::new("sh")
            .arg("-c")
            .arg(command)
            .current_dir(cwd)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .map_err(|e| CoreError::Message(format!("restart failed: {e}")))?;
        let pid = child.id();
        std::mem::forget(child);
        Ok(pid)
    }
}

#[cfg(unix)]
fn unix_signal(pid: u32, kind: &str) -> Result<(), CoreError> {
    let flag = match kind {
        "term" => "-TERM",
        "kill" => "-KILL",
        "stop" => "-STOP",
        "cont" => "-CONT",
        other => {
            return Err(CoreError::Message(format!("unknown signal {other}")));
        }
    };
    let status = std::process::Command::new("kill")
        .args([flag, &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map_err(|e| CoreError::Message(format!("kill {pid}: {e}")))?;
    if status.success() || kind == "kill" {
        Ok(())
    } else if !process_exists(pid) {
        Ok(())
    } else {
        Err(CoreError::Message(format!(
            "kill {flag} {pid} failed ({status})"
        )))
    }
}

#[cfg(unix)]
fn unix_ps_snapshot(pid: u32) -> Option<ProcSnap> {
    let out = std::process::Command::new("ps")
        .args([
            "-p",
            &pid.to_string(),
            "-o",
            "pid=,ppid=,etime=,pcpu=,pmem=,state=,command=",
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    parse_ps_line(&String::from_utf8_lossy(&out.stdout))
}

#[cfg(not(unix))]
fn unix_ps_snapshot(_pid: u32) -> Option<ProcSnap> {
    None
}

#[cfg(unix)]
fn unix_list_all_processes() -> Vec<ProcSnap> {
    let out = match std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid=,etime=,pcpu=,pmem=,state=,command="])
        .output()
    {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(parse_ps_line)
        .collect()
}

#[cfg(not(unix))]
fn unix_list_all_processes() -> Vec<ProcSnap> {
    Vec::new()
}

pub(crate) fn parse_ps_line(line: &str) -> Option<ProcSnap> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let mut parts = line.split_whitespace();
    let pid: u32 = parts.next()?.parse().ok()?;
    let ppid: u32 = parts.next()?.parse().ok()?;
    let etime = parts.next()?.to_string();
    let cpu = parts.next()?.to_string();
    let mem = parts.next()?.to_string();
    let state = parts.next()?.to_string();
    let command = parts.collect::<Vec<_>>().join(" ");
    if command.is_empty() {
        return None;
    }
    let paused = state.starts_with('T');
    Some(ProcSnap {
        pid,
        ppid,
        etime,
        cpu,
        mem,
        state,
        command,
        cwd: None,
        paused,
    })
}

#[cfg(windows)]
fn windows_process_exists(pid: u32) -> bool {
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            return false;
        }
        CloseHandle(handle);
        true
    }
}

#[cfg(windows)]
fn windows_signal(pid: u32, kind: &str) -> Result<(), CoreError> {
    match kind {
        "term" => windows_taskkill(pid, false),
        "kill" => windows_taskkill(pid, true),
        "stop" => windows_suspend(pid),
        "cont" => windows_resume(pid),
        other => Err(CoreError::Message(format!("unknown signal {other}"))),
    }
}

#[cfg(windows)]
fn windows_taskkill(pid: u32, force: bool) -> Result<(), CoreError> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut cmd = std::process::Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string()]);
    if force {
        cmd.arg("/F");
    }
    cmd.stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .creation_flags(CREATE_NO_WINDOW);
    let status = cmd
        .status()
        .map_err(|e| CoreError::Message(format!("taskkill {pid}: {e}")))?;
    if status.success() || force || !process_exists(pid) {
        Ok(())
    } else {
        Err(CoreError::Message(format!(
            "taskkill {pid} failed ({status})"
        )))
    }
}

#[cfg(windows)]
fn windows_suspend(pid: u32) -> Result<(), CoreError> {
    windows_nt_suspend_resume(pid, true)
}

#[cfg(windows)]
fn windows_resume(pid: u32) -> Result<(), CoreError> {
    windows_nt_suspend_resume(pid, false)
}

#[cfg(windows)]
fn windows_nt_suspend_resume(pid: u32, suspend: bool) -> Result<(), CoreError> {
    unsafe {
        let handle = OpenProcess(PROCESS_SUSPEND_RESUME, 0, pid);
        if handle.is_null() {
            if !process_exists(pid) {
                return Ok(());
            }
            return Err(CoreError::Message(format!(
                "OpenProcess({pid}) for suspend/resume failed"
            )));
        }
        let status = if suspend {
            NtSuspendProcess(handle)
        } else {
            NtResumeProcess(handle)
        };
        CloseHandle(handle);
        if status == 0 {
            Ok(())
        } else {
            warn!(pid, status, suspend, "NtSuspend/ResumeProcess failed");
            Err(CoreError::Message(format!(
                "Windows {} {pid} failed (ntstatus {status})",
                if suspend { "pause" } else { "resume" }
            )))
        }
    }
}

#[cfg(windows)]
const PROCESS_QUERY_LIMITED_INFORMATION: u32 = 0x1000;
#[cfg(windows)]
const PROCESS_SUSPEND_RESUME: u32 = 0x0800;

#[cfg(windows)]
#[link(name = "kernel32")]
extern "system" {
    fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
    fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(windows)]
#[link(name = "ntdll")]
extern "system" {
    fn NtSuspendProcess(handle: *mut std::ffi::c_void) -> i32;
    fn NtResumeProcess(handle: *mut std::ffi::c_void) -> i32;
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ps_line_basic() {
        let s = parse_ps_line(" 123  1 01:02 0.1 0.2 S /bin/sleep 10").unwrap();
        assert_eq!(s.pid, 123);
        assert_eq!(s.ppid, 1);
        assert_eq!(s.command, "/bin/sleep 10");
        assert!(!s.paused);
    }

    #[test]
    fn related_orphan_match_requires_explicit_opt_in() {
        assert!(!include_related_orphans(false));
        assert!(include_related_orphans(true));
    }

    #[test]
    fn orphan_path_match_does_not_claim_unrelated_home_tools() {
        let work = Path::new("/Users/me/.grokx/tasks/abc");
        let project = Path::new("/Users/me/Work/myapp");
        assert!(orphan_matches_session(
            work,
            project,
            Some("/Users/me/.grokx/tasks/abc"),
            "python server.py",
        ));
        assert!(!orphan_matches_session(
            work,
            project,
            Some("/Users/me/Work/other"),
            "python -m http.server",
        ));
        assert!(!orphan_matches_session(
            work,
            project,
            Some("/Users/me"),
            "code /Users/me/Work/myapp",
        ));
    }

    #[test]
    fn format_etime_minutes() {
        assert_eq!(format_etime(62), "01:02");
        assert_eq!(format_etime(3661), "01:01:01");
    }

    #[test]
    fn sysinfo_sees_current_process() {
        let self_pid = std::process::id();
        assert!(process_exists(self_pid), "sysinfo should see this test process");
        let snap = process_snapshot(self_pid).expect("snapshot of self");
        assert_eq!(snap.pid, self_pid);
        assert!(!snap.command.is_empty());
    }
}
