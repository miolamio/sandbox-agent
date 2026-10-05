//! Test hooks of the built-in mock agent (`sandbox-agent mock-agent-process`).
use super::turn_events::bootstrap_mock;
use super::*;

#[tokio::test]
async fn mock_env_hook_reports_agent_process_env() {
    let mut options = docker_support::TestAppOptions::default();
    options
        .env
        .insert("MOCK_ENV_PROBE".to_string(), "from-server".to_string());
    let test_app = TestApp::with_options(AuthConfig::disabled(), options, |_| {});
    bootstrap_mock(&test_app.app, "mock-env").await;

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/mock-env",
        Some(json!({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "mock/env",
            "params": { "names": ["MOCK_ENV_PROBE", "MOCK_ENV_MISSING"] }
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    assert_eq!(
        parse_json(&body)["result"]["env"],
        json!({ "MOCK_ENV_PROBE": "from-server", "MOCK_ENV_MISSING": null })
    );
}
