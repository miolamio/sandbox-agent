//! Shutdown of the agent process tree and of the standalone adapter binary.
#![cfg(unix)]

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::time::{Duration, Instant};

use acp_http_adapter::process::AdapterRuntime;
use acp_http_adapter::registry::LaunchSpec;
use futures::StreamExt;
use serde_json::json;

/// Agent stub that starts two descendants, records every PID and ignores
/// SIGTERM itself. The first descendant (`sleep`) dies on SIGTERM; the second
/// ignores it as well, so only SIGKILL to the whole group gets rid of it.
fn agent_script(dir: &Path) -> String {
    let dir = dir.display();
    format!(
        "sleep 293 & echo $! > '{dir}/child.pid'\n\
         sh -c \"trap '' TERM; exec sleep 294\" & echo $! > '{dir}/stubborn.pid'\n\
         trap '' TERM\n\
         echo $$ > '{dir}/agent.pid'\n\
         while read -r line; do :; done\n"
    )
}

fn pid_alive(pid: u32) -> bool {
    Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stderr(Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

async fn wait_until_gone(pid: u32, limit: Duration) -> bool {
    let deadline = Instant::now() + limit;
    while Instant::now() < deadline {
        if !pid_alive(pid) {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    !pid_alive(pid)
}

/// Waits until the stub wrote all its PID files and returns
/// `[agent, child, stubborn]`.
async fn read_pids(dir: &Path) -> [u32; 3] {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let read = |name: &str| -> Option<u32> {
            std::fs::read_to_string(dir.join(name))
                .ok()?
                .trim()
                .parse()
                .ok()
        };
        if let (Some(agent), Some(child), Some(stubborn)) =
            (read("agent.pid"), read("child.pid"), read("stubborn.pid"))
        {
            return [agent, child, stubborn];
        }
        assert!(Instant::now() < deadline, "agent stub never wrote its pids");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

/// Kills leftovers so a failing test does not leak `sleep` processes.
fn kill_all(pids: &[u32]) {
    for pid in pids {
        let _ = Command::new("kill")
            .args(["-KILL", &pid.to_string()])
            .stderr(Stdio::null())
            .status();
    }
}

async fn assert_all_gone(pids: [u32; 3]) {
    let names = ["agent", "agent child", "agent child ignoring SIGTERM"];
    let mut survivors = Vec::new();
    for (pid, name) in pids.iter().zip(names) {
        // The stub ignores SIGTERM, so it only goes away with the SIGKILL that
        // follows the 1 s grace period; leave room for that plus polling.
        if !wait_until_gone(*pid, Duration::from_secs(3)).await {
            survivors.push(format!("{name} (pid {pid})"));
        }
    }
    kill_all(&pids);
    assert!(
        survivors.is_empty(),
        "outlived the shutdown: {}",
        survivors.join(", ")
    );
}

#[tokio::test]
async fn runtime_shutdown_kills_the_whole_agent_process_tree() {
    let dir = tempfile::tempdir().expect("tempdir");
    let runtime = AdapterRuntime::start(
        LaunchSpec {
            program: PathBuf::from("sh"),
            args: vec!["-c".to_string(), agent_script(dir.path())],
            env: Default::default(),
        },
        Duration::from_secs(5),
    )
    .await
    .expect("start runtime");
    let pids = read_pids(dir.path()).await;

    let started = Instant::now();
    tokio::time::timeout(Duration::from_secs(5), runtime.shutdown())
        .await
        .expect("shutdown is bounded");
    let elapsed = started.elapsed();

    assert_all_gone(pids).await;
    assert!(
        elapsed < Duration::from_secs(3),
        "shutdown must not wait long for a process ignoring SIGTERM, took {elapsed:?}"
    );
}

struct Adapter {
    child: Child,
    base_url: String,
}

impl Drop for Adapter {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Adapter {
    fn signal(&self, signal: &str) {
        let status = Command::new("kill")
            .args([&format!("-{signal}"), &self.child.id().to_string()])
            .status()
            .expect("run kill");
        assert!(status.success(), "kill -{signal} failed");
    }

    async fn wait_exit(&mut self, limit: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + limit;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().expect("try_wait") {
                return Some(status);
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        None
    }
}

fn spawn_adapter(dir: &Path, shutdown_timeout_ms: u64) -> Adapter {
    let port = TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .expect("pick port")
        .port();
    let target = json!({
        "cmd": "sh",
        "args": ["-c", agent_script(dir)],
        "env": {}
    });
    let registry = json!({
        "id": "stub-agent",
        "distribution": {
            "binary": {
                "linux-x86_64": target,
                "linux-aarch64": target,
                "darwin-x86_64": target,
                "darwin-aarch64": target,
            }
        }
    });
    let child = Command::new(env!("CARGO_BIN_EXE_acp-http-adapter"))
        .args([
            "--host",
            "127.0.0.1",
            "--port",
            &port.to_string(),
            "--registry-json",
            &registry.to_string(),
            "--shutdown-timeout-ms",
            &shutdown_timeout_ms.to_string(),
        ])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn adapter");
    Adapter {
        child,
        base_url: format!("http://127.0.0.1:{port}"),
    }
}

/// Waits for health and opens an SSE stream that stays open until the
/// adapter goes away. Returns the task reading it.
async fn open_sse(adapter: &Adapter) -> tokio::task::JoinHandle<()> {
    let client = reqwest::Client::new();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let ok = client
            .get(format!("{}/v1/health", adapter.base_url))
            .send()
            .await
            .map(|response| response.status().is_success())
            .unwrap_or(false);
        if ok {
            break;
        }
        assert!(Instant::now() < deadline, "adapter never became healthy");
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let response = client
        .get(format!("{}/v1/rpc", adapter.base_url))
        .header("accept", "text/event-stream")
        .send()
        .await
        .expect("open sse");
    assert!(response.status().is_success());
    let mut stream = response.bytes_stream();
    tokio::spawn(async move { while let Some(Ok(_)) = stream.next().await {} })
}

#[tokio::test]
async fn sigterm_with_open_sse_exits_within_budget_and_kills_agent_tree() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut adapter = spawn_adapter(dir.path(), 1500);
    let _sse = open_sse(&adapter).await;
    let pids = read_pids(dir.path()).await;

    let started = Instant::now();
    adapter.signal("TERM");
    let status = adapter.wait_exit(Duration::from_secs(6)).await;
    let elapsed = started.elapsed();

    assert_all_gone(pids).await;
    let status = status.unwrap_or_else(|| panic!("adapter still running after SIGTERM"));
    assert_eq!(status.code(), Some(0), "budget expiry is a clean exit");
    assert!(
        elapsed < Duration::from_millis(3000),
        "shutdown must end when the 1.5 s budget runs out, took {elapsed:?}"
    );
}

#[tokio::test]
async fn second_sigterm_exits_immediately_with_code_1() {
    let dir = tempfile::tempdir().expect("tempdir");
    let mut adapter = spawn_adapter(dir.path(), 30_000);
    let _sse = open_sse(&adapter).await;
    let pids = read_pids(dir.path()).await;

    adapter.signal("TERM");
    // The agent tree goes away first, while the open stream keeps the adapter
    // draining.
    assert_all_gone(pids).await;
    assert!(
        adapter.child.try_wait().expect("try_wait").is_none(),
        "adapter should still be draining the open stream"
    );

    let started = Instant::now();
    adapter.signal("TERM");
    let status = adapter.wait_exit(Duration::from_secs(5)).await;
    let elapsed = started.elapsed();
    let status = status.unwrap_or_else(|| panic!("second SIGTERM did not stop the adapter"));
    assert_eq!(status.code(), Some(1), "second signal exits with code 1");
    assert!(
        elapsed < Duration::from_secs(1),
        "second signal must exit immediately, took {elapsed:?}"
    );
}
