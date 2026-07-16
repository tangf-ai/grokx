//! set_project → connect_workspace (fake agent) → list_sessions shows live row.

use std::path::PathBuf;
use std::time::Duration;

use agent_process::{resolve_engine, spawn_agent_stdio, SpawnOptions};
use app_config::UserSettings;
use app_core::AppCore;
use acp_bridge::{AcpClient, ConnectOptions};
use domain::SessionId;
use tokio::time::timeout;

fn fake_agent_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../acp-bridge/tests/fixtures/fake_agent.py")
}

fn install_fake_grok_shim(label: &str) -> PathBuf {
    let script = fake_agent_script();
    assert!(script.is_file(), "fixture missing: {}", script.display());
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../target/test-shims")
        .join(label);
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let shim = dir.join("grok");
    let python = which_python();
    let body = format!(
        "#!/bin/sh\nexport FAKE_AGENT_PERMISSION=0\nexec \"{python}\" \"{}\"\n",
        script.display()
    );
    std::fs::write(&shim, body).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = std::fs::metadata(&shim).unwrap().permissions();
        perms.set_mode(0o755);
        std::fs::set_permissions(&shim, perms).unwrap();
    }
    assert!(shim.is_file());
    shim
}

fn which_python() -> String {
    for c in ["/usr/bin/python3", "/opt/homebrew/bin/python3"] {
        if PathBuf::from(c).is_file() {
            return c.into();
        }
    }
    "python3".into()
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fake_shim_handshake_via_spawn_agent_stdio() {
    let shim = install_fake_grok_shim("handshake");
    let settings = UserSettings {
        custom_engine_path: Some(shim.display().to_string()),
        prefer_bundled_engine: false,
        model: None,
    };
    let engine = resolve_engine(&settings, None, false).expect("resolve custom shim");
    let child = spawn_agent_stdio(
        engine,
        SpawnOptions {
            agent_args: vec!["--always-approve".into()],
            ..Default::default()
        },
    )
    .expect("spawn");

    let client = timeout(
        Duration::from_secs(8),
        AcpClient::connect(
            child.child,
            SessionId::new(),
            ConnectOptions {
                cwd: "/tmp".into(),
                auto_approve: true,
                rpc_timeout: Duration::from_secs(5),
                ..Default::default()
            },
        ),
    )
    .await
    .expect("handshake timeout")
    .expect("handshake");

    assert_eq!(
        client.handle.engine_session_id().await.as_deref(),
        Some("fake-engine-session-1")
    );
    client.shutdown().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn connect_workspace_lists_session_with_project_metadata() {
    let shim = install_fake_grok_shim("connect-list");

    let core = AppCore::bootstrap().expect("bootstrap");
    {
        let mut settings = core.settings.write().await;
        settings.custom_engine_path = Some(shim.display().to_string());
        settings.prefer_bundled_engine = false;
    }

    let resolved = core
        .resolve_runtime(None, false)
        .await
        .expect("resolve_runtime custom shim");
    assert_eq!(resolved.path, shim);

    let project = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    core.set_project_root(project.clone())
        .await
        .expect("set_project_root");
    assert!(core.list_sessions().await.is_empty());

    let session_id = timeout(
        Duration::from_secs(15),
        core.connect_workspace(project.clone(), None, false, true),
    )
    .await
    .expect("connect timed out")
    .expect("connect_workspace against fake agent");

    let list = core.list_sessions().await;
    assert_eq!(
        list.len(),
        1,
        "expected one session after connect, got {list:?}"
    );
    assert_eq!(list[0].session_id, session_id);
    assert_eq!(list[0].project_root, project.display().to_string());
    assert_eq!(
        list[0].engine_session_id.as_deref(),
        Some("fake-engine-session-1")
    );
    assert!(!list[0].project_name.is_empty());

    // Second connect (same project) appends another session row — exercises
    // store after a live connect without relying on reconnect_session kill races.
    let session_id2 = timeout(
        Duration::from_secs(15),
        core.connect_workspace(project.clone(), None, false, true),
    )
    .await
    .expect("second connect timed out")
    .expect("second connect");
    let list2 = core.list_sessions().await;
    assert!(
        list2.len() >= 2,
        "second connect should add a session row, got {}",
        list2.len()
    );
    assert_eq!(list2[0].session_id, session_id2);
    assert_eq!(list2[0].project_root, project.display().to_string());
    assert!(
        list2.iter().any(|s| s.session_id == session_id),
        "original session still listed"
    );

    core.disconnect().await;
}
