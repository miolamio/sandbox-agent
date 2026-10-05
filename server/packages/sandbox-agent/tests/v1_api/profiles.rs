//! Agent profiles applied by the agent server proxy, observed through the
//! built-in mock agent (`mock/env` hook and its echoed requests).
use super::*;

async fn install_mock(app: &docker_support::DockerApp) {
    let (status, _, body) = send_request(
        app,
        Method::POST,
        "/v1/agents/mock/install",
        Some(json!({})),
        &[],
    )
    .await;
    assert!(
        status.is_success(),
        "install mock: {status} {}",
        String::from_utf8_lossy(&body)
    );
}

async fn put_profile(app: &docker_support::DockerApp, agent: &str, name: &str, body: Value) {
    let (status, _, response) = send_request(
        app,
        Method::PUT,
        &format!("/v1/config/profiles/{agent}/{name}"),
        Some(body),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "put profile: {}",
        String::from_utf8_lossy(&response)
    );
}

async fn acp(app: &docker_support::DockerApp, path: &str, payload: Value) -> (StatusCode, Value) {
    let (status, _, body) = send_request(app, Method::POST, path, Some(payload), &[]).await;
    (status, parse_json(&body))
}

fn rpc(id: u64, method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params })
}

async fn server_entry(app: &docker_support::DockerApp, server_id: &str) -> Value {
    let (status, _, body) = send_request(app, Method::GET, "/v1/acp", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    parse_json(&body)["servers"]
        .as_array()
        .expect("servers")
        .iter()
        .find(|server| server["serverId"] == server_id)
        .cloned()
        .unwrap_or(Value::Null)
}

#[tokio::test]
async fn profile_env_reaches_agent_process_and_profile_is_pinned() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    put_profile(
        &test_app.app,
        "mock",
        "envp",
        json!({ "process": { "env": { "PROFILE_PROBE": "from-profile" } } }),
    )
    .await;

    let (status, body) = acp(
        &test_app.app,
        "/v1/acp/srv-env?agent=mock&profile=envp",
        initialize_payload(),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = acp(
        &test_app.app,
        "/v1/acp/srv-env",
        rpc(2, "mock/env", json!({ "names": ["PROFILE_PROBE"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"]["env"]["PROFILE_PROBE"], "from-profile");

    let (status, body) = acp(
        &test_app.app,
        "/v1/acp/srv-env?profile=other",
        rpc(3, "mock/env", json!({ "names": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    assert_eq!(body["type"], "urn:sandbox-agent:error:profile_mismatch");
    assert_eq!(body["details"]["boundProfile"], "envp");

    let (status, _) = acp(
        &test_app.app,
        "/v1/acp/srv-env?profile=envp",
        rpc(4, "mock/env", json!({ "names": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let entry = server_entry(&test_app.app, "srv-env").await;
    assert_eq!(entry["profile"], "envp");
    assert_eq!(entry["profileStale"], false);
}

#[tokio::test]
async fn server_without_profile_rejects_a_profile() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    put_profile(&test_app.app, "mock", "envp", json!({})).await;
    let (status, _) = acp(
        &test_app.app,
        "/v1/acp/srv-plain?agent=mock",
        initialize_payload(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let (status, body) = acp(
        &test_app.app,
        "/v1/acp/srv-plain?profile=envp",
        rpc(2, "mock/env", json!({ "names": [] })),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(body["details"]["boundProfile"], Value::Null);
    let entry = server_entry(&test_app.app, "srv-plain").await;
    assert!(entry.get("profile").is_none(), "{entry}");
    assert!(entry.get("profileStale").is_none(), "{entry}");
}

#[tokio::test]
async fn unknown_profile_starts_no_server() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    let (status, body) = acp(
        &test_app.app,
        "/v1/acp/srv-ghost?agent=mock&profile=ghost",
        initialize_payload(),
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND, "{body}");
    assert_eq!(server_entry(&test_app.app, "srv-ghost").await, Value::Null);
}

#[tokio::test]
async fn process_change_marks_server_stale() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    put_profile(
        &test_app.app,
        "mock",
        "stale",
        json!({ "process": { "env": { "A": "1" } } }),
    )
    .await;
    let (status, _) = acp(
        &test_app.app,
        "/v1/acp/srv-stale?agent=mock&profile=stale",
        initialize_payload(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        server_entry(&test_app.app, "srv-stale").await["profileStale"],
        false
    );

    put_profile(
        &test_app.app,
        "mock",
        "stale",
        json!({ "process": { "env": { "A": "***" } }, "session": { "systemPrompt": { "mode": "append", "text": "x" } } }),
    )
    .await;
    assert_eq!(
        server_entry(&test_app.app, "srv-stale").await["profileStale"],
        false
    );

    put_profile(
        &test_app.app,
        "mock",
        "stale",
        json!({ "process": { "env": { "A": "2" } } }),
    )
    .await;
    assert_eq!(
        server_entry(&test_app.app, "srv-stale").await["profileStale"],
        true
    );

    let (status, body) = acp(
        &test_app.app,
        "/v1/acp/srv-stale",
        rpc(2, "mock/env", json!({ "names": ["A"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["result"]["env"]["A"], "1",
        "running process keeps its env"
    );
}
