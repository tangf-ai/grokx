use std::path::PathBuf;
use std::time::Duration;
use app_core::AppCore;

#[tokio::main]
async fn main() {
    let shim = PathBuf::from("/Users/tangf/Work/grokx/target/acp-smoke-shim/grok");
    assert!(shim.is_file(), "missing {}", shim.display());
    let core = AppCore::bootstrap().unwrap();
    {
        let mut s = core.settings.write().await;
        s.custom_engine_path = Some(shim.display().to_string());
        s.prefer_bundled_engine = false;
    }
    let mut rx = core.take_event_receiver().await.unwrap();
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            eprintln!("EV {ev:?}");
        }
    });
    let eng = core.resolve_runtime(None, false).await.unwrap();
    eprintln!("engine {} {:?}", eng.path.display(), eng.source);
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    core.set_project_root(root.clone()).await.unwrap();
    let sid = tokio::time::timeout(
        Duration::from_secs(12),
        core.connect_workspace(root, None, false, true),
    )
    .await
    .expect("timeout")
    .expect("connect");
    eprintln!("connected {}", sid.0);
    let list = core.list_sessions().await;
    eprintln!("sessions={} eng={:?}", list.len(), list[0].engine_session_id);
    core.send_prompt("hi".into()).await.unwrap();
    tokio::time::sleep(Duration::from_millis(800)).await;
    core.disconnect().await;
    eprintln!("smoke complete");
}
