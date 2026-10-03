use super::*;
use std::collections::BTreeMap;

#[tokio::test]
async fn v1_health_removed_legacy_and_opencode_unmounted() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(&test_app.app, Method::GET, "/v1/health", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["status"], "ok");

    let (status, _, _body) =
        send_request(&test_app.app, Method::GET, "/v1/anything", None, &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let (status, _, _) =
        send_request(&test_app.app, Method::GET, "/opencode/session", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn v1_auth_enforced_when_token_configured() {
    let test_app = TestApp::new(AuthConfig::with_token("secret-token".to_string()));

    let (status, _, _) = send_request(&test_app.app, Method::GET, "/v1/health", None, &[]).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/health",
        None,
        &[("authorization", "Bearer secret-token")],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["status"], "ok");
}

#[tokio::test]
async fn v1_filesystem_endpoints_round_trip() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request_raw(
        &test_app.app,
        Method::PUT,
        "/v1/fs/file?path=docs/file.txt",
        Some(b"hello".to_vec()),
        &[],
        Some("application/octet-stream"),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["bytesWritten"], 5);

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/fs/stat?path=docs/file.txt",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["entryType"], "file");

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/fs/entries?path=docs",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let entries = parse_json(&body).as_array().cloned().expect("array");
    assert!(entries.iter().any(|entry| entry["name"] == "file.txt"));

    let (status, headers, body) = send_request_raw(
        &test_app.app,
        Method::GET,
        "/v1/fs/file?path=docs/file.txt",
        None,
        &[],
        None,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or(""),
        "application/octet-stream"
    );
    assert_eq!(String::from_utf8_lossy(&body), "hello");

    let move_body = json!({
        "from": "docs/file.txt",
        "to": "docs/renamed.txt",
        "overwrite": true
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/fs/move",
        Some(move_body),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(parse_json(&body)["to"]
        .as_str()
        .expect("to path")
        .ends_with("docs/renamed.txt"));

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/fs/mkdir?path=docs/nested",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v1/fs/entry?path=docs/nested&recursive=true",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
#[serial]
async fn require_preinstall_blocks_missing_agent() {
    let mut env = BTreeMap::new();
    env.insert(
        "SANDBOX_AGENT_REQUIRE_PREINSTALL".to_string(),
        "true".to_string(),
    );
    let test_app = TestApp::with_options(
        AuthConfig::disabled(),
        docker_support::TestAppOptions {
            env,
            ..Default::default()
        },
        |_| {},
    );

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-a?agent=codex",
        Some(initialize_payload()),
        &[],
    )
    .await;

    assert_eq!(status, StatusCode::NOT_FOUND);
    let parsed = parse_json(&body);
    assert_eq!(parsed["status"], 404);
    assert_eq!(parsed["title"], "Agent Not Installed");
}

#[tokio::test]
#[serial]
async fn lazy_install_runs_on_first_bootstrap() {
    let registry_url = serve_registry_once(json!({
        "agents": [
            {
                "id": "codex-acp",
                "version": "1.2.3",
                "distribution": {
                    "npx": {
                        "package": "@example/codex-acp@1.2.3",
                        "args": [],
                        "env": {}
                    }
                }
            }
        ]
    }));

    let helper_bin_root = tempfile::tempdir().expect("helper bin tempdir");
    let helper_bin = helper_bin_root.path().join("bin");
    fs::create_dir_all(&helper_bin).expect("create helper bin dir");
    write_fake_npm(&helper_bin.join("npm"));

    let mut env = BTreeMap::new();
    env.insert("SANDBOX_AGENT_ACP_REGISTRY_URL".to_string(), registry_url);
    let test_app = TestApp::with_options(
        AuthConfig::disabled(),
        docker_support::TestAppOptions {
            env,
            extra_paths: vec![helper_bin.clone()],
            ..Default::default()
        },
        |install_path| {
            fs::create_dir_all(install_path.join("agent_processes"))
                .expect("create agent processes dir");
            write_executable(&install_path.join("codex"), "#!/usr/bin/env sh\nexit 0\n");
        },
    );

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-lazy?agent=codex",
        Some(json!({
            "jsonrpc": "2.0",
            "method": "initialize",
            "params": {
                "protocolVersion": "1.0",
                "clientCapabilities": {}
            }
        })),
        &[],
    )
    .await;

    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(test_app
        .install_path()
        .join("agent_processes/codex-acp")
        .exists());
}

#[tokio::test]
#[serial]
async fn v1_agents_reports_claude_credentials_with_api_key_helper() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_path| {
        // install_dir is <root>/xdg-data/sandbox-agent/bin; HOME is <root>/home.
        let home = install_path
            .ancestors()
            .nth(3)
            .expect("docker test root")
            .join("home");
        let claude_dir = home.join(".claude");
        fs::create_dir_all(&claude_dir).expect("create .claude dir");
        fs::write(
            claude_dir.join("settings.json"),
            r#"{"apiKeyHelper":"/bin/echo test"}"#,
        )
        .expect("write claude settings");
    });

    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/agents/claude", None, &[]).await;

    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    assert_eq!(parsed["credentialsAvailable"], true, "body: {parsed}");
}

fn docker(args: &[&str]) -> std::process::Output {
    std::process::Command::new(docker_support::docker_bin())
        .args(args)
        .output()
        .expect("run docker")
}

/// Stub `codex` agent whose launcher records the long-lived agent process PID
/// in `<install_dir>/codex-acp.pid` (the install dir is bind-mounted, so the
/// host can read it). `exec` keeps the PID of the wrapper. Before that it
/// starts a `sleep` that stays a child of the agent (a stand-in for a tool or
/// dev server the agent runs) and records its PID in `codex-acp-child.pid`.
fn setup_pid_recording_stub(install_dir: &Path) {
    super::acp_transport::setup_stub_artifacts(install_dir, "codex");
    let agent_processes = install_dir.join("agent_processes");
    let launcher = agent_processes.join("codex-acp");
    let real = agent_processes.join("codex-acp-real");
    fs::rename(&launcher, &real).expect("move stub launcher");
    let pid_file = install_dir.join("codex-acp.pid");
    let child_pid_file = install_dir.join("codex-acp-child.pid");
    write_executable(
        &launcher,
        &format!(
            "#!/usr/bin/env sh\ncase \"${{1:-}}\" in\n  --help|--version|version|-V) ;;\n  *) sleep 293 </dev/null >/dev/null 2>&1 & echo $! >\"{}\"; echo $$ > \"{}\" ;;\nesac\nexec \"{}\" \"$@\"\n",
            child_pid_file.display(),
            pid_file.display(),
            real.display()
        ),
    );
}

fn read_pid_file(test_app: &TestApp, name: &str) -> u32 {
    let raw = fs::read_to_string(test_app.install_path().join(name))
        .unwrap_or_else(|err| panic!("pid file {name} not written: {err}"));
    raw.trim().parse().expect("numeric pid")
}

fn read_agent_pid(test_app: &TestApp) -> u32 {
    read_pid_file(test_app, "codex-acp.pid")
}

/// Waits for a PID file written by a process inside the container.
async fn wait_for_pid_file(test_app: &TestApp, name: &str) -> u32 {
    for _ in 0..100 {
        if let Ok(raw) = fs::read_to_string(test_app.install_path().join(name)) {
            if let Ok(pid) = raw.trim().parse() {
                return pid;
            }
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("pid file {name} never written");
}

/// `Some(true)` if `pid` is alive inside the container, `Some(false)` if it is
/// gone, `None` if the container itself is no longer reachable. A zombie
/// counts as gone: the server runs as PID 1 and does not reap orphans.
fn agent_alive(container_id: &str, pid: u32) -> Option<bool> {
    let script = format!(
        "if [ -r /proc/{pid}/stat ] && read -r _ _ state _ < /proc/{pid}/stat && [ \"$state\" != Z ]; then echo alive; else echo dead; fi"
    );
    let output = docker(&["exec", container_id, "sh", "-c", &script]);
    if !output.status.success() {
        return None;
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "alive" => Some(true),
        "dead" => Some(false),
        _ => None,
    }
}

fn container_running(container_id: &str) -> bool {
    let output = docker(&["inspect", "-f", "{{.State.Running}}", container_id]);
    output.status.success() && String::from_utf8_lossy(&output.stdout).trim() == "true"
}

async fn wait_for_container_exit(container_id: &str, limit: Duration) -> Option<Duration> {
    let started = std::time::Instant::now();
    while started.elapsed() < limit {
        if !container_running(container_id) {
            return Some(started.elapsed());
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    None
}

#[cfg(unix)]
#[tokio::test]
async fn docker_stop_sigterm_shuts_down_promptly_with_open_sse() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), setup_pid_recording_stub);
    bootstrap_server(&test_app.app, "s1", "codex").await;
    let pid = read_agent_pid(&test_app);
    assert_eq!(agent_alive(test_app.container_id(), pid), Some(true));

    let response = reqwest::Client::new()
        .get(test_app.app.http_url("/v1/acp/s1"))
        .header("accept", "text/event-stream")
        .send()
        .await
        .expect("sse response");
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.bytes_stream();
    let sse_task = tokio::spawn(async move {
        let mut saw_data = false;
        loop {
            match stream.next().await {
                Some(Ok(bytes)) => saw_data |= String::from_utf8_lossy(&bytes).contains("data:"),
                Some(Err(err)) => return Err(err.to_string()),
                None => return Ok(saw_data),
            }
        }
    });

    let container_id = test_app.container_id().to_string();
    let started = std::time::Instant::now();
    let output = tokio::task::spawn_blocking(move || docker(&["stop", "-t", "20", &container_id]))
        .await
        .expect("docker stop task");
    let elapsed = started.elapsed();
    assert!(
        output.status.success(),
        "docker stop failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        elapsed < Duration::from_secs(6),
        "docker stop took {elapsed:?}; SIGTERM was not handled"
    );

    let sse_result = tokio::time::timeout(Duration::from_secs(5), sse_task)
        .await
        .expect("SSE stream still open after shutdown")
        .expect("sse task");
    assert_eq!(
        sse_result,
        Ok(true),
        "SSE stream must deliver data and then end cleanly"
    );
}

/// Starts `PUT /v1/fs/file` with a body that never arrives in full, so the
/// request stays in flight and keeps the server's connection drain open.
async fn open_stalled_upload(test_app: &TestApp) -> tokio::net::TcpStream {
    use tokio::io::AsyncWriteExt;

    let base = test_app.app.http_url("");
    let authority = base
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .to_string();
    let mut stream = tokio::net::TcpStream::connect(&authority)
        .await
        .expect("connect for stalled upload");
    let request = format!(
        "PUT /v1/fs/file?path=/tmp/stalled-upload HTTP/1.1\r\nHost: {authority}\r\nContent-Type: application/octet-stream\r\nContent-Length: 1000000\r\n\r\npartial"
    );
    stream
        .write_all(request.as_bytes())
        .await
        .expect("write stalled upload");
    stream
}

/// Opens a followed log stream and returns a task that resolves when the
/// stream ends.
async fn follow_logs(test_app: &TestApp, process_id: &str) -> tokio::task::JoinHandle<()> {
    let logs = reqwest::Client::new()
        .get(test_app.app.http_url(&format!(
            "/v1/processes/{process_id}/logs?stream=stdout&follow=true"
        )))
        .header("accept", "text/event-stream")
        .send()
        .await
        .expect("logs sse response");
    assert_eq!(logs.status(), StatusCode::OK);
    let mut stream = logs.bytes_stream();
    tokio::spawn(async move { while let Some(Ok(_)) = stream.next().await {} })
}

async fn start_process(test_app: &TestApp, script: &str) -> String {
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes",
        Some(json!({
            "command": "sh",
            "args": ["-c", script],
            "tty": false,
            "interactive": false
        })),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "start process: {}",
        String::from_utf8_lossy(&body)
    );
    parse_json(&body)["id"]
        .as_str()
        .expect("process id")
        .to_string()
}

#[cfg(unix)]
#[tokio::test]
async fn sigint_kills_agent_processes_and_second_signal_exits_immediately() {
    let options = docker_support::TestAppOptions {
        env: BTreeMap::from([(
            "SANDBOX_AGENT_SHUTDOWN_TIMEOUT_MS".to_string(),
            "15000".to_string(),
        )]),
        ..Default::default()
    };
    let test_app = TestApp::with_options(AuthConfig::disabled(), options, setup_pid_recording_stub);
    let container_id = test_app.container_id().to_string();
    let dir = test_app.install_path().display().to_string();
    bootstrap_server(&test_app.app, "s1", "codex").await;

    // Every process below records its PID and the PID of a child it started,
    // so the test can check the whole tree: agent, `/v1/processes` and an
    // in-flight `/v1/processes/run`.
    let process_id = start_process(
        &test_app,
        &format!(
            "sleep 301 & echo $! > '{dir}/proc-child.pid'; echo $$ > '{dir}/proc.pid'; echo started; wait"
        ),
    )
    .await;
    let run_script =
        format!("sleep 287 & echo $! > '{dir}/run-child.pid'; echo $$ > '{dir}/run.pid'; wait");
    let run_url = test_app.app.http_url("/v1/processes/run");
    let run = tokio::spawn(async move {
        reqwest::Client::new()
            .post(run_url)
            .json(&json!({
                "command": "sh",
                "args": ["-c", run_script],
                "timeoutMs": 120000
            }))
            .send()
            .await
            .map(|response| response.status())
    });
    let pids = [
        ("agent", read_agent_pid(&test_app)),
        (
            "agent child",
            wait_for_pid_file(&test_app, "codex-acp-child.pid").await,
        ),
        ("process", wait_for_pid_file(&test_app, "proc.pid").await),
        (
            "process child",
            wait_for_pid_file(&test_app, "proc-child.pid").await,
        ),
        ("run", wait_for_pid_file(&test_app, "run.pid").await),
        (
            "run child",
            wait_for_pid_file(&test_app, "run-child.pid").await,
        ),
    ];
    for (name, pid) in pids {
        assert_eq!(
            agent_alive(&container_id, pid),
            Some(true),
            "{name} not running"
        );
    }

    // A followed log stream must end once the processes are stopped; the
    // stalled upload keeps the server in the drain phase until the budget
    // runs out or a second signal arrives.
    let logs = follow_logs(&test_app, &process_id).await;
    let _upload = open_stalled_upload(&test_app).await;

    let output = docker(&["kill", "--signal", "INT", &container_id]);
    assert!(output.status.success(), "docker kill INT failed");

    // The whole tree must be gone while the server is still draining.
    for (name, pid) in pids {
        assert_eq!(
            wait_until_dead(&container_id, pid, Duration::from_secs(5)).await,
            Some(false),
            "{name} (pid {pid}) must be killed during shutdown while the server drains"
        );
    }
    tokio::time::timeout(Duration::from_secs(5), logs)
        .await
        .expect("followed log stream must end after the processes are stopped")
        .expect("logs task");
    let run_status = tokio::time::timeout(Duration::from_secs(5), run)
        .await
        .expect("in-flight run must finish once its process is killed")
        .expect("run task");
    assert!(run_status.is_ok(), "run request failed: {run_status:?}");
    assert!(
        container_running(&container_id),
        "server should still be draining the stalled upload"
    );

    let exit_code = spawn_container_wait(&container_id);
    let output = docker(&["kill", "--signal", "TERM", &container_id]);
    assert!(output.status.success(), "docker kill TERM failed");
    let exited = wait_for_container_exit(&container_id, Duration::from_secs(5)).await;
    assert!(
        exited.is_some_and(|elapsed| elapsed < Duration::from_secs(3)),
        "second signal must exit immediately, waited {exited:?}"
    );
    assert_eq!(
        exit_code.await.expect("docker wait task"),
        Some(1),
        "second signal must exit with code 1"
    );
}

/// The whole shutdown, from the first signal to exit, fits in one
/// `--shutdown-timeout-ms` budget, even with a request that never finishes.
#[cfg(unix)]
#[tokio::test]
async fn sigterm_shutdown_fits_in_one_total_budget() {
    let options = docker_support::TestAppOptions {
        env: BTreeMap::from([(
            "SANDBOX_AGENT_SHUTDOWN_TIMEOUT_MS".to_string(),
            "2000".to_string(),
        )]),
        ..Default::default()
    };
    let test_app = TestApp::with_options(AuthConfig::disabled(), options, setup_pid_recording_stub);
    let container_id = test_app.container_id().to_string();
    bootstrap_server(&test_app.app, "s1", "codex").await;

    let process_id = start_process(
        &test_app,
        "trap '' TERM; echo started; while :; do sleep 0.1; done",
    )
    .await;
    let _logs = follow_logs(&test_app, &process_id).await;
    let _upload = open_stalled_upload(&test_app).await;

    let exit_code = spawn_container_wait(&container_id);
    let output = docker(&["kill", "--signal", "TERM", &container_id]);
    assert!(output.status.success(), "docker kill TERM failed");
    let exited = wait_for_container_exit(&container_id, Duration::from_secs(10)).await;
    assert!(
        exited.is_some_and(|elapsed| elapsed >= Duration::from_millis(1500)
            && elapsed < Duration::from_millis(3500)),
        "shutdown must end when the 2 s budget runs out, took {exited:?}"
    );
    assert_eq!(
        exit_code.await.expect("docker wait task"),
        Some(0),
        "budget expiry is a clean exit"
    );
}

/// Followed log streams end once the processes are stopped, so they do not
/// keep the server alive for the whole budget.
#[cfg(unix)]
#[tokio::test]
async fn sigterm_shutdown_does_not_wait_for_followed_logs() {
    let options = docker_support::TestAppOptions {
        env: BTreeMap::from([(
            "SANDBOX_AGENT_SHUTDOWN_TIMEOUT_MS".to_string(),
            "6000".to_string(),
        )]),
        ..Default::default()
    };
    let test_app = TestApp::with_options(AuthConfig::disabled(), options, setup_pid_recording_stub);
    let container_id = test_app.container_id().to_string();
    bootstrap_server(&test_app.app, "s1", "codex").await;

    // Ignores SIGTERM, so it is only gone after the SIGKILL that follows the
    // 1 s grace period.
    let process_id = start_process(
        &test_app,
        "trap '' TERM; echo started; while :; do sleep 0.1; done",
    )
    .await;
    let logs = follow_logs(&test_app, &process_id).await;

    let exit_code = spawn_container_wait(&container_id);
    let output = docker(&["kill", "--signal", "TERM", &container_id]);
    assert!(output.status.success(), "docker kill TERM failed");
    let exited = wait_for_container_exit(&container_id, Duration::from_secs(10)).await;
    assert!(
        exited.is_some_and(|elapsed| elapsed < Duration::from_millis(3500)),
        "shutdown must not wait for the 6 s budget, took {exited:?}"
    );
    assert_eq!(
        exit_code.await.expect("docker wait task"),
        Some(0),
        "clean shutdown"
    );
    tokio::time::timeout(Duration::from_secs(2), logs)
        .await
        .expect("log stream ended")
        .expect("logs task");
}

/// Polls until `pid` is gone in the container; returns the last state seen.
async fn wait_until_dead(container_id: &str, pid: u32, limit: Duration) -> Option<bool> {
    let mut state = Some(true);
    let deadline = std::time::Instant::now() + limit;
    while std::time::Instant::now() < deadline {
        state = agent_alive(container_id, pid);
        if state != Some(true) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    state
}

/// Starts `docker wait` before the container exits (it runs with `--rm`, so
/// the exit code cannot be inspected afterwards) and resolves to the code.
fn spawn_container_wait(container_id: &str) -> tokio::task::JoinHandle<Option<i32>> {
    let container_id = container_id.to_string();
    let handle = tokio::task::spawn_blocking(move || {
        let output = docker(&["wait", &container_id]);
        String::from_utf8_lossy(&output.stdout).trim().parse().ok()
    });
    // Give `docker wait` a moment to attach before the signal is sent.
    std::thread::sleep(Duration::from_millis(300));
    handle
}
