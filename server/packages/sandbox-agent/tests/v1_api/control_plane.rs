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
/// host can read it). `exec` keeps the PID of the wrapper.
fn setup_pid_recording_stub(install_dir: &Path) {
    super::acp_transport::setup_stub_artifacts(install_dir, "codex");
    let agent_processes = install_dir.join("agent_processes");
    let launcher = agent_processes.join("codex-acp");
    let real = agent_processes.join("codex-acp-real");
    fs::rename(&launcher, &real).expect("move stub launcher");
    let pid_file = install_dir.join("codex-acp.pid");
    write_executable(
        &launcher,
        &format!(
            "#!/usr/bin/env sh\ncase \"${{1:-}}\" in\n  --help|--version|version|-V) ;;\n  *) echo $$ > \"{}\" ;;\nesac\nexec \"{}\" \"$@\"\n",
            pid_file.display(),
            real.display()
        ),
    );
}

fn read_agent_pid(test_app: &TestApp) -> u32 {
    let raw = fs::read_to_string(test_app.install_path().join("codex-acp.pid"))
        .expect("agent pid file written by stub launcher");
    raw.trim().parse().expect("numeric agent pid")
}

/// `Some(true)` if `pid` is alive inside the container, `Some(false)` if it is
/// gone, `None` if the container itself is no longer reachable.
fn agent_alive(container_id: &str, pid: u32) -> Option<bool> {
    let script = format!("if kill -0 {pid} 2>/dev/null; then echo alive; else echo dead; fi");
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
    bootstrap_server(&test_app.app, "s1", "codex").await;
    let pid = read_agent_pid(&test_app);
    assert_eq!(agent_alive(&container_id, pid), Some(true));

    // A follow-mode log stream never ends on its own, so it keeps the server
    // in the drain phase until the drain timeout or a second signal.
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes",
        Some(json!({
            "command": "sh",
            "args": ["-c", "echo started; sleep 60"],
            "tty": false,
            "interactive": false
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let process = parse_json(&body);
    let process_id = process["id"].as_str().expect("process id").to_string();
    let process_pid = process["pid"].as_u64().expect("process pid") as u32;
    assert_eq!(agent_alive(&container_id, process_pid), Some(true));
    let logs = reqwest::Client::new()
        .get(test_app.app.http_url(&format!(
            "/v1/processes/{process_id}/logs?stream=stdout&follow=true"
        )))
        .header("accept", "text/event-stream")
        .send()
        .await
        .expect("logs sse response");
    assert_eq!(logs.status(), StatusCode::OK);
    let _logs_stream = logs.bytes_stream();

    let output = docker(&["kill", "--signal", "INT", &container_id]);
    assert!(output.status.success(), "docker kill INT failed");

    // Agent and user processes must be gone while the server is still draining.
    assert_eq!(
        wait_until_dead(&container_id, pid, Duration::from_secs(5)).await,
        Some(false),
        "agent process must be killed during shutdown while the server drains"
    );
    assert_eq!(
        wait_until_dead(&container_id, process_pid, Duration::from_secs(5)).await,
        Some(false),
        "user process must be killed during shutdown while the server drains"
    );
    assert!(
        container_running(&container_id),
        "server should still be draining the open log stream"
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
/// `--shutdown-timeout-ms` budget, even with a never-ending log stream open.
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

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/processes",
        Some(json!({
            "command": "sh",
            "args": ["-c", "trap '' TERM; echo started; while :; do sleep 0.1; done"],
            "tty": false,
            "interactive": false
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let process_id = parse_json(&body)["id"]
        .as_str()
        .expect("process id")
        .to_string();
    let logs = reqwest::Client::new()
        .get(test_app.app.http_url(&format!(
            "/v1/processes/{process_id}/logs?stream=stdout&follow=true"
        )))
        .header("accept", "text/event-stream")
        .send()
        .await
        .expect("logs sse response");
    assert_eq!(logs.status(), StatusCode::OK);
    let _logs_stream = logs.bytes_stream();

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
