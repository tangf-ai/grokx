//! Bridge-level integration: fake agent stdio → park permission → resolve → RPC reply.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use acp_bridge::{AcpClient, ConnectOptions};
use domain::{AppEvent, PermissionDecision, SessionId, TurnState};
use tokio::process::Command;
use tokio::time::timeout;

fn fake_agent_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/fake_agent.py")
}

async fn spawn_fake_agent(permission: bool) -> tokio::process::Child {
    let script = fake_agent_script();
    assert!(
        script.is_file(),
        "missing fake agent fixture at {}",
        script.display()
    );
    let mut cmd = Command::new("python3");
    cmd.arg(&script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if permission {
        cmd.env("FAKE_AGENT_PERMISSION", "1");
    } else {
        cmd.env("FAKE_AGENT_PERMISSION", "0");
    }
    cmd.spawn().expect("spawn fake agent")
}

#[tokio::test]
async fn permission_parks_until_resolve_writes_rpc_response() {
    let child = spawn_fake_agent(true).await;
    let app_session = SessionId::new();
    let options = ConnectOptions {
        cwd: "/tmp".into(),
        auto_approve: false,
        rpc_timeout: Duration::from_secs(5),
        ..ConnectOptions::default()
    };

    let mut client = AcpClient::connect(child, app_session.clone(), options)
        .await
        .expect("ACP connect/handshake");
    let handle = client.handle.clone();
    let mut events = client.take_events();

    // Drain handshake events and wait for permission_needed from fake agent.
    let perm_id = timeout(Duration::from_secs(5), async {
        loop {
            let ev = events.recv().await.expect("event channel open");
            match ev {
                AppEvent::PermissionNeeded { request, .. } => break request.id,
                AppEvent::AgentError { message } => panic!("agent error: {message}"),
                _ => {}
            }
        }
    })
    .await
    .expect("timed out waiting for PermissionNeeded");

    // Must still be pending — no auto reply when auto_approve=false.
    assert!(
        handle.permission_is_pending(&perm_id).await,
        "permission should be parked before UI resolve"
    );
    let pending = handle.pending_permission_ids().await;
    assert!(
        pending.contains(&perm_id),
        "pending ids should include {perm_id}, got {pending:?}"
    );

    // Resolve allow — this must write JSON-RPC response to the agent.
    handle
        .resolve_permission(&perm_id, PermissionDecision::AllowOnce)
        .await
        .expect("resolve_permission");

    assert!(
        !handle.permission_is_pending(&perm_id).await,
        "permission must not remain pending after resolve"
    );

    // Prompt should complete only after permission was answered (fake agent waits).
    handle
        .prompt("hi")
        .await
        .expect("prompt after allow should succeed");

    // Collect stream until turn finished.
    let mut saw_message = false;
    let mut saw_finished = false;
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    while tokio::time::Instant::now() < deadline && !saw_finished {
        match timeout(Duration::from_millis(500), events.recv()).await {
            Ok(Some(AppEvent::MessageDelta { text, .. })) if text.contains("pong") => {
                saw_message = true;
            }
            Ok(Some(AppEvent::TurnFinished {
                state: TurnState::Completed,
                ..
            })) => {
                saw_finished = true;
            }
            Ok(Some(_)) => {}
            Ok(None) | Err(_) => break,
        }
    }
    assert!(saw_message, "expected message delta pong from fake agent");
    assert!(saw_finished, "expected turn completed");

    client.shutdown().await;
}

#[tokio::test]
async fn permission_deny_unparks_and_does_not_auto_allow() {
    let child = spawn_fake_agent(true).await;
    let app_session = SessionId::new();
    let options = ConnectOptions {
        cwd: "/tmp".into(),
        auto_approve: false,
        rpc_timeout: Duration::from_secs(5),
        ..ConnectOptions::default()
    };

    let mut client = AcpClient::connect(child, app_session, options)
        .await
        .expect("connect");
    let handle = client.handle.clone();
    let mut events = client.take_events();

    let perm_id = timeout(Duration::from_secs(5), async {
        loop {
            match events.recv().await.expect("events") {
                AppEvent::PermissionNeeded { request, .. } => break request.id,
                AppEvent::AgentError { message } => panic!("{message}"),
                _ => {}
            }
        }
    })
    .await
    .expect("permission event");

    assert!(handle.permission_is_pending(&perm_id).await);
    handle
        .resolve_permission(&perm_id, PermissionDecision::Deny)
        .await
        .expect("deny");
    assert!(!handle.permission_is_pending(&perm_id).await);

    // Deny still answers the RPC so the agent can continue; prompt should work.
    handle.prompt("after deny").await.expect("prompt");
    client.shutdown().await;
}
