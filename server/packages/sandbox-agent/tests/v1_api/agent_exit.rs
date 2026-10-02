//! An agent server whose agent process exited is removed: it is no longer
//! listed, its event stream is gone, and requests for it are rejected before
//! they reach any agent, so clients can tell it is gone and start a new one.
//! Uses the built-in `mock` agent and its `__mock_exit__` prompt hook.
use super::turn_events::{bootstrap_mock, prompt};
use super::*;

async fn listed_server_ids(app: &docker_support::DockerApp) -> Vec<String> {
    let (status, _, body) = send_request(app, Method::GET, "/v1/acp", None, &[]).await;
    assert_eq!(status, StatusCode::OK);
    parse_json(&body)["servers"]
        .as_array()
        .expect("servers array")
        .iter()
        .map(|server| server["serverId"].as_str().expect("serverId").to_string())
        .collect()
}

#[tokio::test]
async fn crashed_agent_server_is_removed_and_not_reused() {
    let test_app = TestApp::new(AuthConfig::disabled());
    bootstrap_mock(&test_app.app, "exit-crashed").await;
    bootstrap_server(&test_app.app, "exit-bystander", "mock").await;

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/exit-crashed",
        Some(prompt(2, "s-1", "__mock_exit__")),
        &[],
    )
    .await;
    assert_eq!(
        parse_json(&body)["type"],
        "urn:sandbox-agent:error:agent_process_exited",
        "status {status}"
    );

    // Gone as soon as the exit is reported, not only after a later cleanup.
    let listed = listed_server_ids(&test_app.app).await;
    assert!(
        !listed.contains(&"exit-crashed".to_string()),
        "crashed server still listed: {listed:?}"
    );
    assert!(listed.contains(&"exit-bystander".to_string()));

    // Requests for it are rejected before reaching an agent (no broken pipe).
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/exit-crashed",
        Some(prompt(3, "s-1", "after exit")),
        &[],
    )
    .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "{}",
        String::from_utf8_lossy(&body)
    );
    let (status, _, _) = send_request(
        &test_app.app,
        Method::GET,
        "/v1/acp/exit-crashed",
        None,
        &[("accept", "text/event-stream")],
    )
    .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    // The id can be bootstrapped again with a fresh agent process.
    bootstrap_server(&test_app.app, "exit-crashed", "mock").await;
    assert!(listed_server_ids(&test_app.app)
        .await
        .contains(&"exit-crashed".to_string()));

    // The other server keeps working.
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/exit-bystander",
        Some(initialize_payload()),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
}

#[tokio::test]
async fn agent_server_is_removed_when_agent_exits_mid_async_turn() {
    let test_app = TestApp::new(AuthConfig::disabled());
    bootstrap_mock(&test_app.app, "exit-async").await;

    // Keep a turn open, then crash the agent with a second prompt.
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/exit-async",
        Some(prompt(2, "s-1", "__mock_never_respond__")),
        &[("x-sandboxagent-async-prompt", "1")],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/exit-async",
        Some(prompt(3, "s-2", "__mock_exit__")),
        &[("x-sandboxagent-async-prompt", "1")],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    while listed_server_ids(&test_app.app)
        .await
        .contains(&"exit-async".to_string())
    {
        assert!(
            std::time::Instant::now() < deadline,
            "crashed server still listed"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}
