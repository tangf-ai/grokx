use std::path::PathBuf;
use std::time::Duration;

use app_core::AppCore;

#[tokio::main]
async fn main() {
    eprintln!("bootstrap…");
    let core = AppCore::bootstrap().expect("bootstrap");
    let mut rx = core.take_event_receiver().await.expect("events");
    tokio::spawn(async move {
        while let Some(ev) = rx.recv().await {
            eprintln!("EV {ev:?}");
        }
    });

    eprintln!("resolve…");
    match core.resolve_runtime(None, true).await {
        Ok(e) => eprintln!("engine {} ({:?})", e.path.display(), e.source),
        Err(e) => {
            eprintln!("resolve failed: {e}");
            std::process::exit(1);
        }
    }

    eprintln!("connect…");
    let connect =
        core.connect_workspace(PathBuf::from("/Users/tangf/Work/grokx"), None, true, true);
    match tokio::time::timeout(Duration::from_secs(25), connect).await {
        Ok(Ok(sid)) => eprintln!("OK session {}", sid.0),
        Ok(Err(e)) => {
            eprintln!("connect err: {e}");
            std::process::exit(2);
        }
        Err(_) => {
            eprintln!("connect TIMEOUT");
            std::process::exit(3);
        }
    }

    eprintln!("prompt…");
    if let Err(e) = core.send_prompt("Reply with exactly: pong".into()).await {
        eprintln!("prompt err: {e}");
        std::process::exit(4);
    }

    tokio::time::sleep(Duration::from_secs(40)).await;
    core.disconnect().await;
    eprintln!("done");
}
