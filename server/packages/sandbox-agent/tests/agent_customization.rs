use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use http_body_util::BodyExt;
use sandbox_agent::router::{build_router, AppState, AuthConfig};
use sandbox_agent_agent_management::agents::AgentManager;
use serde_json::{json, Value};
use tower::util::ServiceExt;

async fn get_agent(agent: &str) -> Value {
    let install_dir = tempfile::tempdir().expect("tempdir");
    let manager = AgentManager::new(install_dir.path()).expect("agent manager");
    let app = build_router(AppState::new(AuthConfig::disabled(), manager));
    let response = app
        .oneshot(
            Request::builder()
                .method(Method::GET)
                .uri(format!("/v1/agents/{agent}"))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    serde_json::from_slice(&bytes).expect("json")
}

#[tokio::test]
async fn claude_reports_session_customization() {
    assert_eq!(
        get_agent("claude").await["customization"],
        json!({
            "process": { "env": true, "args": false },
            "session": {
                "systemPrompt": ["replace", "append"],
                "mcpServers": true,
                "skills": false,
                "plugins": true,
                "pluginConfigs": true
            }
        })
    );
}

#[tokio::test]
async fn codex_reports_process_env_and_mcp_servers_only() {
    assert_eq!(
        get_agent("codex").await["customization"],
        json!({
            "process": { "env": true, "args": false },
            "session": {
                "systemPrompt": [],
                "mcpServers": true,
                "skills": false,
                "plugins": false,
                "pluginConfigs": false
            }
        })
    );
}
