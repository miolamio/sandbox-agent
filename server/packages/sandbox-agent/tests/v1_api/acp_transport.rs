use super::*;

fn write_stub_native(path: &Path, agent: &str) {
    let script = format!("#!/usr/bin/env sh\necho \"{agent} 0.0.1\"\nexit 0\n");
    write_executable(path, &script);
}

fn write_stub_agent_process(path: &Path, agent: &str) {
    let script = format!(
        r#"#!/usr/bin/env sh
if [ "${{1:-}}" = "--help" ] || [ "${{1:-}}" = "--version" ] || [ "${{1:-}}" = "version" ] || [ "${{1:-}}" = "-V" ]; then
  echo "{agent}-agent-process 0.0.1"
  exit 0
fi

while IFS= read -r line; do
  method=$(printf '%s\n' "$line" | sed -n 's/.*"method"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\([^,}}]*\).*/\1/p')

  if [ -n "$method" ]; then
    printf '{{"jsonrpc":"2.0","method":"server/echo","params":{{"method":"%s"}}}}\n' "$method"
  fi

  if printf '%s\n' "$line" | grep -q '__stub_never_respond__'; then
    continue
  fi

  sleep_s=$(printf '%s\n' "$line" | sed -n 's/.*__stub_sleep_\([0-9][0-9]*\)__.*/\1/p')
  if [ -n "$sleep_s" ]; then
    sleep "$sleep_s"
  fi

  if [ -n "$method" ] && [ -n "$id" ]; then
    printf '{{"jsonrpc":"2.0","id":%s,"result":{{"ok":true,"echoedMethod":"%s"}}}}\n' "$id" "$method"
  elif [ -z "$method" ] && [ -n "$id" ]; then
    printf '{{"jsonrpc":"2.0","method":"server/client_response","params":{{"id":%s}}}}\n' "$id"
  fi
done
"#
    );

    write_executable(path, &script);
}

fn write_strict_pi_agent_process(path: &Path) {
    // This stub intentionally mirrors the strict bootstrap validation behavior
    // observed in pi-acp:
    // - initialize.params.protocolVersion must be numeric
    // - session/new.params.mcpServers must be present (array)
    //
    // The proxy normalization layer should adapt legacy/raw client payloads so
    // requests still succeed against this stricter contract.
    let script = r#"#!/usr/bin/env sh
if [ "${1:-}" = "--help" ] || [ "${1:-}" = "--version" ] || [ "${1:-}" = "version" ] || [ "${1:-}" = "-V" ]; then
  echo "pi-agent-process 0.0.1"
  exit 0
fi

while IFS= read -r line; do
  method=$(printf '%s\n' "$line" | sed -n 's/.*"method"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
  id=$(printf '%s\n' "$line" | sed -n 's/.*"id"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p')

  if [ "$method" = "initialize" ] && [ -n "$id" ]; then
    if printf '%s\n' "$line" | grep -Eq '"protocolVersion"[[:space:]]*:[[:space:]]*"'; then
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32603,"message":"Internal error","data":[{"expected":"number","code":"invalid_type","path":["protocolVersion"],"message":"Invalid input: expected number, received string"}]}}\n' "$id"
    else
      printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true,"echoedMethod":"initialize"}}\n' "$id"
    fi
    continue
  fi

  if [ "$method" = "session/new" ] && [ -n "$id" ]; then
    if printf '%s\n' "$line" | grep -Eq '"mcpServers"[[:space:]]*:[[:space:]]*\['; then
      printf '{"jsonrpc":"2.0","id":%s,"result":{"sessionId":"pi-session","echoedMethod":"session/new"}}\n' "$id"
    else
      printf '{"jsonrpc":"2.0","id":%s,"error":{"code":-32603,"message":"Internal error","data":[{"expected":"array","code":"invalid_type","path":["mcpServers"],"message":"Invalid input: expected array, received undefined"}]}}\n' "$id"
    fi
    continue
  fi

  if [ -n "$method" ] && [ -n "$id" ]; then
    printf '{"jsonrpc":"2.0","id":%s,"result":{"ok":true,"echoedMethod":"%s"}}\n' "$id" "$method"
  fi
done
"#;

    write_executable(path, script);
}

pub(super) fn setup_stub_artifacts(install_dir: &Path, agent: &str) {
    let native = install_dir.join(agent);
    write_stub_native(&native, agent);

    let agent_processes = install_dir.join("agent_processes");
    fs::create_dir_all(&agent_processes).expect("create agent processes dir");
    let launcher = if cfg!(windows) {
        agent_processes.join(format!("{agent}-acp.cmd"))
    } else {
        agent_processes.join(format!("{agent}-acp"))
    };
    write_stub_agent_process(&launcher, agent);
}

fn setup_strict_pi_agent_process_only(install_dir: &Path) {
    let agent_processes = install_dir.join("agent_processes");
    fs::create_dir_all(&agent_processes).expect("create agent processes dir");
    let launcher = if cfg!(windows) {
        agent_processes.join("pi-acp.cmd")
    } else {
        agent_processes.join("pi-acp")
    };
    write_strict_pi_agent_process(&launcher);
}

#[tokio::test]
async fn acp_bootstrap_requires_agent_query() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-a",
        Some(initialize_payload()),
        &[],
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(parse_json(&body)["status"], 400);
}

#[cfg(unix)]
#[tokio::test]
async fn acp_round_trip_and_replay() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    });

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-replay?agent=codex",
        Some(initialize_payload()),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"]["echoedMethod"], "initialize");

    let prompt = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "session/prompt",
        "params": {
            "sessionId": "s-1",
            "prompt": [{"type": "text", "text": "hello"}]
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-replay",
        Some(prompt),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        parse_json(&body)["result"]["echoedMethod"],
        "session/prompt"
    );

    let first_chunk = read_first_sse_data_with_last_id(&test_app.app, "server-replay", 0).await;
    let first_event_id = parse_sse_event_id(&first_chunk);
    let first_event = parse_sse_data(&first_chunk);
    assert_eq!(first_event["method"], "server/echo");

    let second_chunk =
        read_first_sse_data_with_last_id(&test_app.app, "server-replay", first_event_id).await;
    let second_event_id = parse_sse_event_id(&second_chunk);
    assert!(second_event_id > first_event_id);
}

const ASYNC_PROMPT_HEADER: &str = "x-sandboxagent-async-prompt";

fn prompt_payload(id: u64, text: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": {
            "sessionId": "s-1",
            "prompt": [{"type": "text", "text": text}]
        }
    })
}

/// Reads SSE events (replaying from `last_event_id`) until one matches `predicate`.
async fn read_sse_event_matching(
    app: &docker_support::DockerApp,
    server_id: &str,
    last_event_id: u64,
    predicate: impl Fn(&Value) -> bool,
) -> Value {
    let client = reqwest::Client::new();
    let response = client
        .get(app.http_url(&format!("/v1/acp/{server_id}")))
        .header("accept", "text/event-stream")
        .header("last-event-id", last_event_id.to_string())
        .send()
        .await
        .expect("sse response");
    assert_eq!(response.status(), StatusCode::OK);

    let mut stream = response.bytes_stream();
    tokio::time::timeout(Duration::from_secs(5), async move {
        let mut buffer = String::new();
        while let Some(chunk) = stream.next().await {
            let bytes = chunk.expect("stream chunk");
            buffer.push_str(&String::from_utf8_lossy(&bytes).replace("\r\n", "\n"));
            while let Some(end) = buffer.find("\n\n") {
                let event = buffer[..end].to_string();
                buffer.drain(..end + 2);
                if !event.contains("data:") {
                    continue;
                }
                let payload = parse_sse_data(&event);
                if predicate(&payload) {
                    return payload;
                }
            }
        }
        panic!("SSE stream ended before matching event")
    })
    .await
    .expect("timed out waiting for matching sse event")
}

#[cfg(unix)]
#[tokio::test]
async fn acp_async_prompt_opt_in_returns_202_and_delivers_response_over_sse() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    });

    bootstrap_server(&test_app.app, "server-async", "codex").await;

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-async",
        Some(prompt_payload(2, "hello")),
        &[(ASYNC_PROMPT_HEADER, "1")],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    assert!(body.is_empty(), "202 body should be empty: {body:?}");

    let response = read_sse_event_matching(&test_app.app, "server-async", 0, |event| {
        event["id"] == 2 && event.get("method").is_none()
    })
    .await;
    assert_eq!(response["result"]["echoedMethod"], "session/prompt");
}

#[cfg(unix)]
#[tokio::test]
async fn acp_async_prompt_delete_delivers_error_over_sse() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    });

    bootstrap_server(&test_app.app, "server-async-delete", "codex").await;

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-async-delete",
        Some(prompt_payload(3, "__stub_never_respond__")),
        &[(ASYNC_PROMPT_HEADER, "1")],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    // Subscribe before deleting so the terminal error is observed live.
    let reader = read_sse_event_matching(&test_app.app, "server-async-delete", 0, |event| {
        event["id"] == 3 && event.get("error").is_some()
    });
    let deleter = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        send_request(
            &test_app.app,
            Method::DELETE,
            "/v1/acp/server-async-delete",
            None,
            &[],
        )
        .await
    };
    let (error_event, (status, _, _)) = tokio::join!(reader, deleter);
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert_eq!(
        error_event["error"]["message"],
        "agent process stopped before responding"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn acp_delete_closes_open_sse_stream() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    });

    bootstrap_server(&test_app.app, "server-delete-sse", "codex").await;

    let response = reqwest::Client::new()
        .get(test_app.app.http_url("/v1/acp/server-delete-sse"))
        .header("accept", "text/event-stream")
        .send()
        .await
        .expect("sse response");
    assert_eq!(response.status(), StatusCode::OK);
    let mut stream = response.bytes_stream();

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v1/acp/server-delete-sse",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    // Drain replayed events; the stream must end once the runtime is gone.
    tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(chunk) = stream.next().await {
            if chunk.is_err() {
                break;
            }
        }
    })
    .await
    .expect("SSE stream should close after DELETE");
}

#[cfg(unix)]
#[tokio::test]
async fn acp_delete_during_pending_prompt_returns_promptly() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    });

    bootstrap_server(&test_app.app, "server-delete-pending", "codex").await;

    let prompt = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-delete-pending",
        Some(prompt_payload(4, "__stub_never_respond__")),
        &[],
    );
    let deleter = async {
        tokio::time::sleep(Duration::from_millis(300)).await;
        let started = std::time::Instant::now();
        let (status, _, _) = send_request(
            &test_app.app,
            Method::DELETE,
            "/v1/acp/server-delete-pending",
            None,
            &[],
        )
        .await;
        (status, started.elapsed())
    };

    let ((prompt_status, _, _), (delete_status, delete_elapsed)) =
        tokio::time::timeout(Duration::from_secs(10), async {
            tokio::join!(prompt, deleter)
        })
        .await
        .expect("DELETE and pending prompt should both complete");

    assert_eq!(delete_status, StatusCode::NO_CONTENT);
    assert!(
        delete_elapsed < Duration::from_secs(5),
        "DELETE took {delete_elapsed:?}"
    );
    assert!(
        !prompt_status.is_success(),
        "pending prompt should fail after DELETE, got {prompt_status}"
    );
}

/// Starts a stub-agent server with `SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS` and/or
/// `--acp-request-timeout-ms` set.
fn timeout_test_app(env_ms: Option<&str>, flag_ms: Option<&str>) -> TestApp {
    let mut options = docker_support::TestAppOptions::default();
    if let Some(ms) = env_ms {
        options.env.insert(
            "SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS".to_string(),
            ms.to_string(),
        );
    }
    if let Some(ms) = flag_ms {
        options.extra_server_args = vec!["--acp-request-timeout-ms".to_string(), ms.to_string()];
    }
    TestApp::with_options(AuthConfig::disabled(), options, |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    })
}

/// Sends a synchronous prompt and asserts it fails with the timeout problem
/// after `min..max`.
async fn assert_sync_prompt_times_out(
    app: &docker_support::DockerApp,
    server_id: &str,
    id: u64,
    text: &str,
    min: Duration,
    max: Duration,
) {
    let started = std::time::Instant::now();
    let (status, _, body) = send_request(
        app,
        Method::POST,
        &format!("/v1/acp/{server_id}"),
        Some(prompt_payload(id, text)),
        &[],
    )
    .await;
    let elapsed = started.elapsed();
    assert_eq!(
        status,
        StatusCode::GATEWAY_TIMEOUT,
        "body: {:?}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(parse_json(&body)["type"], "urn:sandbox-agent:error:timeout");
    assert!(
        elapsed >= min && elapsed < max,
        "timeout after {elapsed:?}, expected {min:?}..{max:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn acp_request_timeout_env_is_honored() {
    let test_app = timeout_test_app(Some("1500"), None);
    bootstrap_server(&test_app.app, "server-timeout-env", "codex").await;
    assert_sync_prompt_times_out(
        &test_app.app,
        "server-timeout-env",
        2,
        "__stub_never_respond__",
        Duration::from_millis(1400),
        Duration::from_secs(10),
    )
    .await;
}

#[cfg(unix)]
#[tokio::test]
async fn acp_request_timeout_flag_overrides_env() {
    // The env says 60 s; the flag must win with 2.5 s.
    let test_app = timeout_test_app(Some("60000"), Some("2500"));
    bootstrap_server(&test_app.app, "server-timeout-flag", "codex").await;

    // A prompt that finishes under the limit succeeds.
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-timeout-flag",
        Some(prompt_payload(2, "__stub_sleep_1__")),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "body: {:?}",
        String::from_utf8_lossy(&body)
    );
    assert_eq!(
        parse_json(&body)["result"]["echoedMethod"],
        "session/prompt"
    );

    // A prompt that outlives the limit fails with the timeout problem.
    assert_sync_prompt_times_out(
        &test_app.app,
        "server-timeout-flag",
        3,
        "__stub_sleep_8__",
        Duration::from_millis(2400),
        Duration::from_secs(8),
    )
    .await;
}

#[cfg(unix)]
#[tokio::test]
async fn acp_request_timeout_flag_applies_to_async_prompt() {
    let test_app = timeout_test_app(Some("60000"), Some("2500"));
    bootstrap_server(&test_app.app, "server-timeout-async", "codex").await;

    // Under the limit: 202, then the agent's result over SSE.
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-timeout-async",
        Some(prompt_payload(2, "__stub_sleep_1__")),
        &[(ASYNC_PROMPT_HEADER, "1")],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let response = read_sse_event_matching(&test_app.app, "server-timeout-async", 0, |event| {
        event["id"] == 2 && event.get("method").is_none()
    })
    .await;
    assert_eq!(response["result"]["echoedMethod"], "session/prompt");

    // Over the limit: 202, then a JSON-RPC timeout error with the same id over SSE.
    let started = std::time::Instant::now();
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-timeout-async",
        Some(prompt_payload(3, "__stub_sleep_8__")),
        &[(ASYNC_PROMPT_HEADER, "1")],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let error_event = read_sse_event_matching(&test_app.app, "server-timeout-async", 0, |event| {
        event["id"] == 3 && event.get("error").is_some()
    })
    .await;
    let elapsed = started.elapsed();
    assert_eq!(
        error_event["error"]["message"],
        "timed out waiting for agent response"
    );
    assert!(
        elapsed >= Duration::from_millis(2400) && elapsed < Duration::from_secs(8),
        "async timeout after {elapsed:?}"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn pi_initialize_and_session_new_are_normalized() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_strict_pi_agent_process_only(install_dir);
    });

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-pi?agent=pi",
        Some(initialize_payload()),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"]["echoedMethod"], "initialize");

    let session_new = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "session/new",
        "params": {
            "cwd": "/tmp"
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-pi",
        Some(session_new),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(parse_json(&body)["result"]["echoedMethod"], "session/new");
}

#[cfg(unix)]
#[tokio::test]
async fn acp_agent_mismatch_returns_conflict() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
        setup_stub_artifacts(install_dir, "claude");
    });

    bootstrap_server(&test_app.app, "server-mismatch", "codex").await;

    let request = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "session/new",
        "params": {}
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-mismatch?agent=claude",
        Some(request),
        &[],
    )
    .await;

    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(parse_json(&body)["status"], 409);
}

#[tokio::test]
async fn acp_get_unknown_returns_not_found() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) =
        send_request(&test_app.app, Method::GET, "/v1/acp/missing", None, &[]).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(parse_json(&body)["status"], 404);
}

#[tokio::test]
async fn acp_delete_is_idempotent() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v1/acp/server-delete",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v1/acp/server-delete",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let request = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "1.0",
            "clientCapabilities": {}
        }
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-delete",
        Some(request),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(parse_json(&body)["status"], 400);
}

#[cfg(unix)]
#[tokio::test]
async fn acp_list_servers_returns_active_instances() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    });

    bootstrap_server(&test_app.app, "server-1", "codex").await;
    bootstrap_server(&test_app.app, "server-2", "codex").await;

    let (status, _, body) = send_request(&test_app.app, Method::GET, "/v1/acp", None, &[]).await;
    assert_eq!(status, StatusCode::OK);

    let parsed = parse_json(&body);
    let servers = parsed["servers"].as_array().expect("servers array");
    assert!(servers
        .iter()
        .any(|server| server["serverId"] == "server-1"));
    assert!(servers
        .iter()
        .any(|server| server["serverId"] == "server-2"));
}

#[cfg(unix)]
#[tokio::test]
async fn sse_reports_server_generation_header() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    });

    bootstrap_server(&test_app.app, "server-generation", "codex").await;

    let (status, _, body) = send_request(&test_app.app, Method::GET, "/v1/acp", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    let parsed = parse_json(&body);
    let created_at_ms = parsed["servers"]
        .as_array()
        .expect("servers array")
        .iter()
        .find(|server| server["serverId"] == "server-generation")
        .expect("listed server")["createdAtMs"]
        .as_i64()
        .expect("createdAtMs");

    let response = reqwest::Client::new()
        .get(test_app.app.http_url("/v1/acp/server-generation"))
        .header("accept", "text/event-stream")
        .send()
        .await
        .expect("sse response");
    assert_eq!(response.status(), StatusCode::OK);
    let generation = response
        .headers()
        .get("x-sandboxagent-server-generation")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    assert_eq!(generation, Some(created_at_ms.to_string()));
}

#[cfg(unix)]
#[tokio::test]
async fn sandboxagent_methods_are_not_handled_specially() {
    let test_app = TestApp::with_setup(AuthConfig::disabled(), |install_dir| {
        setup_stub_artifacts(install_dir, "codex");
    });

    bootstrap_server(&test_app.app, "server-ext", "codex").await;

    let request = json!({
        "jsonrpc": "2.0",
        "id": 22,
        "method": "_sandboxagent/session/list",
        "params": {}
    });
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-ext",
        Some(request),
        &[],
    )
    .await;

    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        parse_json(&body)["result"]["echoedMethod"],
        "_sandboxagent/session/list"
    );
}

#[tokio::test]
async fn post_requires_json_content_type() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let payload = br#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"1.0","clientCapabilities":{}}}"#
        .to_vec();
    let (status, _, body) = send_request_raw(
        &test_app.app,
        Method::POST,
        "/v1/acp/server-content?agent=mock",
        Some(payload),
        &[],
        Some("text/plain"),
    )
    .await;
    assert_eq!(status, StatusCode::UNSUPPORTED_MEDIA_TYPE);
    assert_eq!(parse_json(&body)["status"], 415);
}

#[tokio::test]
async fn sse_rejects_non_sse_accept() {
    let test_app = TestApp::new(AuthConfig::disabled());

    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/acp/server-a",
        None,
        &[("accept", "application/json")],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_ACCEPTABLE);
    assert_eq!(parse_json(&body)["status"], 406);
}

#[tokio::test]
async fn invalid_last_event_id_returns_bad_request() {
    let test_app = TestApp::new(AuthConfig::disabled());
    let (status, _, body) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/acp/server-a",
        None,
        &[("last-event-id", "not-a-number")],
    )
    .await;

    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(
        parse_json(&body)["detail"],
        "invalid request: Last-Event-ID must be a positive integer"
    );
}
