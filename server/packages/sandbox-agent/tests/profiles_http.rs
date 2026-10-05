use std::sync::Arc;

use axum::body::Body;
use axum::http::{Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use sandbox_agent::profiles::{AgentProfile, ProfileStore};
use sandbox_agent::router::{
    build_router, AppState, AuthConfig, BrandingMode, DEFAULT_ACP_REQUEST_TIMEOUT,
};
use sandbox_agent_agent_management::agents::AgentManager;
use serde_json::{json, Value};
use tower::util::ServiceExt;

struct Harness {
    app: Router,
    state_dir: tempfile::TempDir,
    _install_dir: tempfile::TempDir,
}

fn harness(file_profiles: Vec<Value>) -> Harness {
    let install_dir = tempfile::tempdir().expect("install dir");
    let state_dir = tempfile::tempdir().expect("state dir");
    let store = Arc::new(ProfileStore::load(state_dir.path().join("profiles")));
    let file_profiles: Vec<AgentProfile> = file_profiles
        .into_iter()
        .map(|value| serde_json::from_value(value).expect("file profile"))
        .collect();
    store
        .install_file_profiles(file_profiles)
        .expect("file profiles");
    let manager = AgentManager::new(install_dir.path()).expect("agent manager");
    let state = AppState::with_profile_store(
        AuthConfig::disabled(),
        manager,
        BrandingMode::SandboxAgent,
        DEFAULT_ACP_REQUEST_TIMEOUT,
        store,
    );
    Harness {
        app: build_router(state),
        state_dir,
        _install_dir: install_dir,
    }
}

async fn call(app: &Router, method: Method, uri: &str, body: Option<Value>) -> (StatusCode, Value) {
    let mut builder = Request::builder().method(method).uri(uri);
    let body = match body {
        Some(value) => {
            builder = builder.header("content-type", "application/json");
            Body::from(value.to_string())
        }
        None => Body::empty(),
    };
    let response = app
        .clone()
        .oneshot(builder.body(body).expect("request"))
        .await
        .expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let value = if bytes.is_empty() {
        Value::Null
    } else {
        serde_json::from_slice(&bytes).expect("json body")
    };
    (status, value)
}

#[tokio::test]
async fn profiles_crud_masks_secrets_and_keeps_masked_values() {
    let h = harness(Vec::new());
    let (status, body) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/base",
        Some(json!({
            "process": { "env": { "TOKEN": "s3cret" } },
            "session": {
                "systemPrompt": { "mode": "append", "text": "Be brief." },
                "mcpServers": [{
                    "type": "http", "name": "gh", "url": "https://example.com/mcp",
                    "headers": [{ "name": "Authorization", "value": "Bearer s3cret-header" }]
                }]
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!body.to_string().contains("s3cret"), "{body}");
    assert_eq!(body["source"], "api");
    assert_eq!(body["stored"]["process"]["env"]["TOKEN"], "***");
    assert_eq!(body["hasValue"]["process.env.TOKEN"], true);
    assert_eq!(
        body["stored"]["session"]["mcpServers"][0]["headers"][0]["value"],
        "***"
    );
    assert_eq!(
        body["hasValue"]["session.mcpServers.gh.headers.Authorization"],
        true
    );

    let (status, body) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/review",
        Some(json!({ "extends": "base", "session": { "systemPrompt": { "mode": "replace", "text": "Review only." } } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, body) = call(&h.app, Method::GET, "/v1/config/profiles/mock/review", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body["stored"]["extends"], "base");
    assert!(body["stored"]["process"].is_null());
    assert_eq!(body["resolved"]["process"]["env"]["TOKEN"], "***");
    assert_eq!(
        body["resolved"]["session"]["systemPrompt"],
        json!({ "mode": "replace", "text": "Review only." })
    );
    assert_eq!(body["hasValue"]["process.env.TOKEN"], true);

    let (status, body) = call(&h.app, Method::GET, "/v1/config/profiles", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["profiles"],
        json!([
            { "agent": "mock", "name": "base", "source": "api" },
            { "agent": "mock", "name": "review", "source": "api", "extends": "base" }
        ])
    );

    let (status, _) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/base",
        Some(json!({ "process": { "env": { "TOKEN": "***", "EXTRA": "x" } } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let on_disk = std::fs::read_to_string(h.state_dir.path().join("profiles/mock/base.json"))
        .expect("profile file");
    assert!(on_disk.contains("s3cret"), "{on_disk}");
    assert!(on_disk.contains("EXTRA"), "{on_disk}");

    let (status, body) = call(
        &h.app,
        Method::DELETE,
        "/v1/config/profiles/mock/base",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");
    let (status, _) = call(
        &h.app,
        Method::DELETE,
        "/v1/config/profiles/mock/review",
        None,
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, body) = call(&h.app, Method::GET, "/v1/config/profiles/mock/review", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(body["type"], "urn:sandbox-agent:error:not_found");
}

#[tokio::test]
async fn profiles_put_rejects_invalid_profiles() {
    let h = harness(Vec::new());
    let cases = [
        (
            "/v1/config/profiles/mock/a",
            json!({ "extends": "ghost" }),
            json!(["extends"]),
        ),
        (
            "/v1/config/profiles/mock/a",
            json!({ "extends": "codex/base" }),
            json!(["extends"]),
        ),
        (
            "/v1/config/profiles/codex/a",
            json!({ "session": { "systemPrompt": { "mode": "replace", "text": "x" }, "skills": ["review"] } }),
            json!(["session.systemPrompt", "session.skills"]),
        ),
        ("/v1/config/profiles/mock/-bad", json!({}), json!(["name"])),
        (
            "/v1/config/profiles/mock/a",
            json!({ "process": { "env": { "T": "***" } } }),
            json!(["process.env.T"]),
        ),
    ];
    for (uri, body, fields) in cases {
        let (status, problem) = call(&h.app, Method::PUT, uri, Some(body.clone())).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{uri} {body} -> {problem}");
        assert_eq!(
            problem["type"], "urn:sandbox-agent:error:profile_invalid",
            "{problem}"
        );
        assert_eq!(problem["details"]["fields"], fields, "{uri} {body}");
    }

    let (status, problem) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/a",
        Some(json!({ "sesion": {} })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(problem["type"], "urn:sandbox-agent:error:profile_invalid");

    let (status, problem) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/nope/a",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(problem["type"], "urn:sandbox-agent:error:unsupported_agent");

    let (status, problem) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/b",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{problem}");
    let (status, problem) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/c",
        Some(json!({ "extends": "b" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{problem}");
    let (status, problem) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/b",
        Some(json!({ "extends": "c" })),
    )
    .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(
        problem["detail"].as_str().unwrap().contains("cycle"),
        "{problem}"
    );
}

#[tokio::test]
async fn file_profiles_are_listed_and_read_only() {
    let h = harness(vec![
        json!({ "agent": "mock", "name": "ops", "process": { "env": { "A": "1" } } }),
    ]);
    let (status, body) = call(&h.app, Method::GET, "/v1/config/profiles", None).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        body["profiles"],
        json!([{ "agent": "mock", "name": "ops", "source": "file" }])
    );

    let (status, problem) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/ops",
        Some(json!({})),
    )
    .await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(problem["type"], "urn:sandbox-agent:error:profile_read_only");

    let (status, problem) =
        call(&h.app, Method::DELETE, "/v1/config/profiles/mock/ops", None).await;
    assert_eq!(status, StatusCode::CONFLICT);
    assert_eq!(problem["type"], "urn:sandbox-agent:error:profile_read_only");

    let (status, body) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/child",
        Some(json!({ "extends": "ops" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["resolved"]["process"]["env"]["A"], "***");
}

#[tokio::test]
async fn profile_secrets_never_leave_the_server() {
    let h = harness(Vec::new());
    let (status, body) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/base",
        Some(json!({
            "process": { "env": { "TOKEN": "s3cret-env" } },
            "session": {
                "pluginConfigs": { "tool": { "apiKey": "s3cret-plugin" } },
                "mcpServers": [{
                    "name": "fs", "command": "mcp-fs", "args": [],
                    "env": [{ "name": "FS_TOKEN", "value": "s3cret-mcp-env" }]
                }]
            }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!body.to_string().contains("s3cret"), "{body}");
    let (status, body) = call(
        &h.app,
        Method::PUT,
        "/v1/config/profiles/mock/child",
        Some(json!({ "extends": "base" })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert!(!body.to_string().contains("s3cret"), "{body}");
    assert_eq!(body["resolved"]["process"]["env"]["TOKEN"], "***");

    for uri in [
        "/v1/config/profiles/mock/base",
        "/v1/config/profiles/mock/child",
        "/v1/config/profiles",
    ] {
        let (status, body) = call(&h.app, Method::GET, uri, None).await;
        assert_eq!(status, StatusCode::OK, "{uri}");
        assert!(!body.to_string().contains("s3cret"), "{uri}: {body}");
    }
    let (_, body) = call(&h.app, Method::GET, "/v1/config/profiles/mock/child", None).await;
    assert_eq!(body["resolved"]["process"]["env"]["TOKEN"], "***");
    assert_eq!(body["resolved"]["session"]["pluginConfigs"]["tool"], "***");
    assert_eq!(
        body["resolved"]["session"]["mcpServers"][0]["env"][0]["value"],
        "***"
    );
    assert_eq!(body["hasValue"]["session.pluginConfigs.tool"], true);
    assert_eq!(body["hasValue"]["session.mcpServers.fs.env.FS_TOKEN"], true);
}

#[tokio::test]
async fn invalid_put_body_does_not_echo_values() {
    let h = harness(Vec::new());
    let bodies = [
        json!({ "process": { "env": "s3cret" } }).to_string(),
        r#"{"process":{"env":{"TOKEN":"s3cret"}},"s3cret": 1}"#.to_string(),
        r#"{"process":{"env":{"TOKEN":"s3cret" "#.to_string(),
        r#"{"process":{"env":{"TOKEN":s3cret}}}"#.to_string(),
    ];
    for raw in bodies {
        let request = Request::builder()
            .method(Method::PUT)
            .uri("/v1/config/profiles/mock/a")
            .header("content-type", "application/json")
            .body(Body::from(raw.clone()))
            .expect("request");
        let response = h.app.clone().oneshot(request).await.expect("response");
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{raw}");
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let text = String::from_utf8_lossy(&bytes);
        assert!(!text.contains("s3cret"), "{raw} -> {text}");
        let problem: Value = serde_json::from_slice(&bytes).expect("problem json");
        assert_eq!(
            problem["type"], "urn:sandbox-agent:error:profile_invalid",
            "{problem}"
        );
        assert!(
            problem["detail"]
                .as_str()
                .unwrap()
                .contains("line 1 column"),
            "{problem}"
        );
    }
}

#[tokio::test]
async fn put_requires_json_content_type() {
    let h = harness(Vec::new());
    for content_type in [
        None,
        Some("text/plain"),
        Some("application/x-www-form-urlencoded"),
    ] {
        let mut builder = Request::builder()
            .method(Method::PUT)
            .uri("/v1/config/profiles/mock/a");
        if let Some(value) = content_type {
            builder = builder.header("content-type", value);
        }
        let request = builder.body(Body::from("{}")).expect("request");
        let response = h.app.clone().oneshot(request).await.expect("response");
        assert_eq!(
            response.status(),
            StatusCode::UNSUPPORTED_MEDIA_TYPE,
            "{content_type:?}"
        );
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        let problem: Value = serde_json::from_slice(&bytes).expect("problem json");
        assert_eq!(
            problem["type"], "urn:sandbox-agent:error:unsupported_media_type",
            "{problem}"
        );
    }
    let (status, _) = call(&h.app, Method::GET, "/v1/config/profiles/mock/a", None).await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    let request = Request::builder()
        .method(Method::PUT)
        .uri("/v1/config/profiles/mock/a")
        .header("content-type", "application/json; charset=utf-8")
        .body(Body::from("{}"))
        .expect("request");
    let response = h.app.clone().oneshot(request).await.expect("response");
    assert_eq!(response.status(), StatusCode::OK);
}

#[tokio::test]
async fn default_app_state_keeps_profiles_in_memory() {
    let install_dir = tempfile::tempdir().expect("install dir");
    let state_dir = tempfile::tempdir().expect("state dir");
    // Only this test reads the state-dir env; the others build explicit stores.
    std::env::set_var("SANDBOX_AGENT_STATE_DIR", state_dir.path());
    let manager = AgentManager::new(install_dir.path()).expect("agent manager");
    let app = build_router(AppState::new(AuthConfig::disabled(), manager));
    let (status, body) = call(
        &app,
        Method::PUT,
        "/v1/config/profiles/mock/base",
        Some(json!({ "process": { "env": { "A": "1" } } })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let (status, _) = call(&app, Method::GET, "/v1/config/profiles/mock/base", None).await;
    assert_eq!(status, StatusCode::OK);
    let entries: Vec<_> = std::fs::read_dir(state_dir.path())
        .expect("state dir")
        .collect();
    assert!(
        entries.is_empty(),
        "AppState::new wrote to the state dir: {entries:?}"
    );
}
