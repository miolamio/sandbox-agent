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

#[tokio::test]
async fn deleted_profile_marks_server_stale() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    put_profile(
        &test_app.app,
        "mock",
        "gone",
        json!({ "process": { "env": { "A": "1" } } }),
    )
    .await;
    let (status, _) = acp(
        &test_app.app,
        "/v1/acp/srv-gone?agent=mock&profile=gone",
        initialize_payload(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        server_entry(&test_app.app, "srv-gone").await["profileStale"],
        false
    );

    let (status, _, body) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v1/config/profiles/mock/gone",
        None,
        &[],
    )
    .await;
    assert!(
        status.is_success(),
        "delete profile: {status} {}",
        String::from_utf8_lossy(&body)
    );

    let entry = server_entry(&test_app.app, "srv-gone").await;
    assert_eq!(entry["profile"], "gone");
    assert_eq!(entry["profileStale"], true);

    // New and restored sessions need the profile; other requests still reach
    // the running process.
    for (id, method) in [
        (2, "session/new"),
        (3, "session/load"),
        (4, "session/resume"),
    ] {
        let (status, body) = acp(
            &test_app.app,
            "/v1/acp/srv-gone",
            rpc(
                id,
                method,
                json!({ "sessionId": "s1", "cwd": "/tmp", "mcpServers": [] }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method}: {body}");
    }
    let (status, body) = acp(
        &test_app.app,
        "/v1/acp/srv-gone",
        rpc(5, "mock/env", json!({ "names": ["A"] })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(body["result"]["env"]["A"], "1");
}

fn session_profile() -> Value {
    json!({
        "session": {
            "systemPrompt": { "mode": "replace", "text": "You are a reviewer." },
            "mcpServers": [
                { "name": "fs", "command": "node", "args": ["fs.js"], "env": [] },
                { "name": "shared", "command": "profile-cmd", "args": [], "env": [] }
            ],
            "plugins": [{ "path": "/opt/mods/first" }]
        }
    })
}

#[tokio::test]
async fn session_settings_reach_new_load_and_resume() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    put_profile(&test_app.app, "mock", "sess", session_profile()).await;
    let (status, _) = acp(
        &test_app.app,
        "/v1/acp/srv-sess?agent=mock&profile=sess",
        initialize_payload(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    let (status, body) = acp(
        &test_app.app,
        "/v1/acp/srv-sess",
        rpc(2, "session/new", json!({
            "cwd": "/tmp",
            "mcpServers": [{ "name": "shared", "command": "client-cmd", "args": [], "env": [] }],
            "_meta": { "client.example/trace": "t1", "claudeCode": { "options": { "model": "x" } } }
        })),
    )
    .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let params = &body["result"]["echoed"]["params"];
    assert_eq!(params["_meta"]["systemPrompt"], "You are a reviewer.");
    assert_eq!(params["_meta"]["client.example/trace"], "t1");
    assert_eq!(params["_meta"]["claudeCode"]["options"]["model"], "x");
    assert_eq!(
        params["_meta"]["claudeCode"]["options"]["plugins"],
        json!([{ "type": "local", "path": "/opt/mods/first" }])
    );
    let names: Vec<&str> = params["mcpServers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, vec!["fs", "shared"]);
    assert_eq!(params["mcpServers"][1]["command"], "client-cmd");

    for (id, method) in [(3, "session/load"), (4, "session/resume")] {
        let (status, body) = acp(
            &test_app.app,
            "/v1/acp/srv-sess",
            rpc(
                id,
                method,
                json!({ "sessionId": "s1", "cwd": "/tmp", "mcpServers": [] }),
            ),
        )
        .await;
        assert_eq!(status, StatusCode::OK, "{method}: {body}");
        let params = &body["result"]["echoed"]["params"];
        assert_eq!(
            params["_meta"]["systemPrompt"], "You are a reviewer.",
            "{method}"
        );
        assert_eq!(params["mcpServers"][0]["name"], "fs", "{method}");
        assert_eq!(params["sessionId"], "s1", "{method}");
    }

    let (status, body) = acp(
        &test_app.app,
        "/v1/acp/srv-sess",
        rpc(
            5,
            "session/prompt",
            json!({ "sessionId": "s1", "prompt": [] }),
        ),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body["result"]["echoed"]["params"].get("_meta").is_none(),
        "{body}"
    );
}

#[tokio::test]
async fn new_sessions_get_the_updated_session_part() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    put_profile(&test_app.app, "mock", "sess", session_profile()).await;
    let (status, _) = acp(
        &test_app.app,
        "/v1/acp/srv-upd?agent=mock&profile=sess",
        initialize_payload(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);

    put_profile(
        &test_app.app,
        "mock",
        "sess",
        json!({ "session": { "systemPrompt": { "mode": "append", "text": "Updated." } } }),
    )
    .await;
    let (_, body) = acp(
        &test_app.app,
        "/v1/acp/srv-upd",
        rpc(2, "session/new", json!({ "cwd": "/tmp", "mcpServers": [] })),
    )
    .await;
    assert_eq!(
        body["result"]["echoed"]["params"]["_meta"]["systemPrompt"],
        json!({ "append": "Updated." })
    );
    assert_eq!(
        server_entry(&test_app.app, "srv-upd").await["profileStale"],
        false
    );
}

#[tokio::test]
async fn servers_without_profile_pass_session_requests_through() {
    let test_app = TestApp::new(AuthConfig::disabled());
    install_mock(&test_app.app).await;
    let (status, _) = acp(
        &test_app.app,
        "/v1/acp/srv-raw?agent=mock",
        initialize_payload(),
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let params = json!({ "cwd": "/tmp", "mcpServers": [] });
    let (_, body) = acp(
        &test_app.app,
        "/v1/acp/srv-raw",
        rpc(2, "session/new", params.clone()),
    )
    .await;
    assert_eq!(body["result"]["echoed"]["params"], params);
}
