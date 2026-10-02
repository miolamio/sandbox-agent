//! Turn lifecycle notifications (`_sandboxagent/session/*`) published on the
//! ACP event stream, observed by a second SSE subscriber (an orchestrator) that
//! did not send the prompt. Uses the built-in `mock` agent and its prompt-text
//! test hooks (`sandbox-agent mock-agent-process`).
use super::*;

const ASYNC_PROMPT_HEADER: &str = "x-sandboxagent-async-prompt";
const TURN_STARTED: &str = "_sandboxagent/session/turn_started";
const TURN_ENDED: &str = "_sandboxagent/session/turn_ended";
const AWAITING_INPUT: &str = "_sandboxagent/session/awaiting_input";
const INPUT_RESOLVED: &str = "_sandboxagent/session/input_resolved";

pub(super) fn prompt(id: u64, session_id: &str, text: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "session/prompt",
        "params": {
            "sessionId": session_id,
            "prompt": [{"type": "text", "text": text}]
        }
    })
}

/// Creates the server with the built-in mock agent (installing its launcher first).
pub(super) async fn bootstrap_mock(app: &docker_support::DockerApp, server_id: &str) {
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
        "install mock: {status} {:?}",
        String::from_utf8_lossy(&body)
    );
    bootstrap_server(app, server_id, "mock").await;
}

fn method_of(event: &Value) -> &str {
    event.get("method").and_then(Value::as_str).unwrap_or("")
}

/// An open SSE subscription that yields `(event id, payload)` pairs.
struct Observer {
    stream: futures::stream::BoxStream<'static, reqwest::Result<Vec<u8>>>,
    buffer: String,
}

impl Observer {
    async fn open(app: &docker_support::DockerApp, server_id: &str) -> Self {
        let response = reqwest::Client::new()
            .get(app.http_url(&format!("/v1/acp/{server_id}")))
            .header("accept", "text/event-stream")
            .send()
            .await
            .expect("sse response");
        assert_eq!(response.status(), StatusCode::OK);
        Self {
            stream: response
                .bytes_stream()
                .map(|chunk| chunk.map(|bytes| bytes.to_vec()))
                .boxed(),
            buffer: String::new(),
        }
    }

    async fn next(&mut self) -> (u64, Value) {
        tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                while let Some(end) = self.buffer.find("\n\n") {
                    let event = self.buffer[..end].to_string();
                    self.buffer.drain(..end + 2);
                    if event.contains("data:") {
                        return (parse_sse_event_id(&event), parse_sse_data(&event));
                    }
                }
                let chunk = self
                    .stream
                    .next()
                    .await
                    .expect("SSE stream ended")
                    .expect("stream chunk");
                self.buffer
                    .push_str(&String::from_utf8_lossy(&chunk).replace("\r\n", "\n"));
            }
        })
        .await
        .expect("timed out waiting for SSE event")
    }

    /// Reads events until one matches `predicate`; returns all events read.
    async fn until(&mut self, predicate: impl Fn(&Value) -> bool) -> Vec<(u64, Value)> {
        let mut events = Vec::new();
        loop {
            let event = self.next().await;
            let done = predicate(&event.1);
            events.push(event);
            if done {
                return events;
            }
        }
    }

    async fn until_turn_ended(&mut self, request_id: u64) -> Vec<(u64, Value)> {
        self.until(|event| {
            method_of(event) == TURN_ENDED && event["params"]["requestId"] == request_id
        })
        .await
    }
}

fn find<'a>(events: &'a [(u64, Value)], predicate: impl Fn(&Value) -> bool) -> &'a (u64, Value) {
    events
        .iter()
        .find(|(_, event)| predicate(event))
        .unwrap_or_else(|| panic!("no matching event in {events:#?}"))
}

#[tokio::test]
async fn sse_observer_sees_prompt_completion() {
    let test_app = TestApp::new(AuthConfig::disabled());
    bootstrap_mock(&test_app.app, "turn-sync").await;
    let mut observer = Observer::open(&test_app.app, "turn-sync").await;

    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/turn-sync",
        Some(prompt(2, "s-1", "hello")),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    let post_response = parse_json(&body);
    assert_eq!(post_response["result"]["stopReason"], "end_turn");
    let meta = &post_response["result"]["_meta"]["sandboxagent.dev"];
    assert_eq!(meta["sessionId"], "s-1");

    let events = observer.until_turn_ended(2).await;
    let (started_seq, started) = find(&events, |e| method_of(e) == TURN_STARTED);
    assert_eq!(
        started["params"],
        json!({"sessionId": "s-1", "requestId": 2})
    );
    let (response_seq, response) = find(&events, |e| e["id"] == 2 && e.get("method").is_none());
    assert_eq!(response["result"]["stopReason"], "end_turn");
    let (ended_seq, ended) = events.last().expect("turn_ended");
    assert_eq!(
        ended["params"],
        json!({"sessionId": "s-1", "requestId": 2, "outcome": "completed", "stopReason": "end_turn"})
    );
    assert!(started_seq < response_seq && response_seq < ended_seq);
    assert_eq!(
        meta["sequence"], *ended_seq,
        "_meta.sequence is the turn_ended event id"
    );
}

#[tokio::test]
async fn async_prompt_turn_events_follow_agent_output() {
    let test_app = TestApp::new(AuthConfig::disabled());
    bootstrap_mock(&test_app.app, "turn-async").await;
    let mut observer = Observer::open(&test_app.app, "turn-async").await;

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/turn-async",
        Some(prompt(3, "s-1", "hello")),
        &[(ASYNC_PROMPT_HEADER, "1")],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let events = observer.until_turn_ended(3).await;
    let turn: Vec<&str> = events
        .iter()
        .skip_while(|(_, e)| method_of(e) != TURN_STARTED)
        .map(|(_, e)| {
            if e.get("method").is_some() {
                method_of(e)
            } else {
                "<response>"
            }
        })
        .collect();
    // The mock echoes every message it reads before answering.
    assert_eq!(
        turn,
        vec![TURN_STARTED, "mock/echo", "<response>", TURN_ENDED]
    );
    let (_, response) = find(&events, |e| e["id"] == 3);
    assert_eq!(
        response["result"]["_meta"]["sandboxagent.dev"]["sequence"],
        events.last().expect("turn_ended").0
    );
}

#[tokio::test]
async fn sse_observer_sees_agent_exit_after_crash() {
    let test_app = TestApp::new(AuthConfig::disabled());
    bootstrap_mock(&test_app.app, "turn-crash").await;
    let mut observer = Observer::open(&test_app.app, "turn-crash").await;

    let started = std::time::Instant::now();
    let (status, _, body) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/turn-crash",
        Some(prompt(4, "s-1", "__mock_exit__")),
        &[],
    )
    .await;
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "POST must not hang"
    );
    assert_eq!(
        parse_json(&body)["type"],
        "urn:sandbox-agent:error:agent_process_exited",
        "status {status}"
    );

    let events = observer
        .until(|e| method_of(e) == "_adapter/agent_exited")
        .await;
    let (ended_seq, ended) = find(&events, |e| method_of(e) == TURN_ENDED);
    assert_eq!(
        ended["params"],
        json!({"sessionId": "s-1", "requestId": 4, "outcome": "agent_exited"})
    );
    assert!(*ended_seq < events.last().expect("agent_exited").0);
}

#[tokio::test]
async fn async_prompt_timeout_ends_turn_with_timeout() {
    let mut options = docker_support::TestAppOptions::default();
    options.env.insert(
        "SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS".to_string(),
        "1500".to_string(),
    );
    let test_app = TestApp::with_options(AuthConfig::disabled(), options, |_| {});
    bootstrap_mock(&test_app.app, "turn-timeout").await;
    let mut observer = Observer::open(&test_app.app, "turn-timeout").await;

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/turn-timeout",
        Some(prompt(5, "s-1", "__mock_never_respond__")),
        &[(ASYNC_PROMPT_HEADER, "1")],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let events = observer.until_turn_ended(5).await;
    let (error_seq, error) = find(&events, |e| e["id"] == 5);
    assert_eq!(
        error["error"]["message"],
        "timed out waiting for agent response"
    );
    let (ended_seq, ended) = events.last().expect("turn_ended");
    assert_eq!(ended["params"]["outcome"], "timeout");
    assert_eq!(*ended_seq, error_seq + 1);
    assert_eq!(
        error["error"]["data"]["_meta"]["sandboxagent.dev"],
        json!({"sessionId": "s-1", "sequence": ended_seq})
    );
}

#[tokio::test]
async fn delete_ends_pending_turn_as_cancelled() {
    let test_app = TestApp::new(AuthConfig::disabled());
    bootstrap_mock(&test_app.app, "turn-delete").await;
    let mut observer = Observer::open(&test_app.app, "turn-delete").await;

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/turn-delete",
        Some(prompt(6, "s-1", "__mock_never_respond__")),
        &[(ASYNC_PROMPT_HEADER, "1")],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);
    observer.until(|e| method_of(e) == TURN_STARTED).await;

    let (status, _, _) = send_request(
        &test_app.app,
        Method::DELETE,
        "/v1/acp/turn-delete",
        None,
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::NO_CONTENT);

    let events = observer.until_turn_ended(6).await;
    assert_eq!(
        events.last().expect("turn_ended").1["params"],
        json!({"sessionId": "s-1", "requestId": 6, "outcome": "cancelled"})
    );
}

#[tokio::test]
async fn cancel_ends_turn_as_cancelled_and_sessions_are_tracked_separately() {
    let test_app = TestApp::new(AuthConfig::disabled());
    bootstrap_mock(&test_app.app, "turn-cancel").await;
    let mut observer = Observer::open(&test_app.app, "turn-cancel").await;

    // Session A waits for a cancel; session B finishes while A is still running.
    for payload in [
        prompt(7, "s-a", "__mock_wait_cancel__"),
        prompt(8, "s-b", "hello"),
    ] {
        let (status, _, _) = send_request(
            &test_app.app,
            Method::POST,
            "/v1/acp/turn-cancel",
            Some(payload),
            &[(ASYNC_PROMPT_HEADER, "1")],
        )
        .await;
        assert_eq!(status, StatusCode::ACCEPTED);
    }

    let events = observer.until_turn_ended(8).await;
    assert_eq!(
        events.last().expect("turn_ended").1["params"],
        json!({"sessionId": "s-b", "requestId": 8, "outcome": "completed", "stopReason": "end_turn"})
    );
    assert!(
        !events
            .iter()
            .any(|(_, e)| method_of(e) == TURN_ENDED && e["params"]["requestId"] == 7),
        "session A is still running"
    );

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/turn-cancel",
        Some(json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "s-a"}})),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let events = observer.until_turn_ended(7).await;
    assert_eq!(
        events.last().expect("turn_ended").1["params"],
        json!({"sessionId": "s-a", "requestId": 7, "outcome": "cancelled", "stopReason": "cancelled"})
    );
}

#[tokio::test]
async fn permission_request_emits_awaiting_input_until_client_answers() {
    let test_app = TestApp::new(AuthConfig::disabled());
    bootstrap_mock(&test_app.app, "turn-permission").await;
    let mut observer = Observer::open(&test_app.app, "turn-permission").await;

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/turn-permission",
        Some(prompt(9, "s-1", "__mock_request_permission__")),
        &[(ASYNC_PROMPT_HEADER, "1")],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let events = observer.until(|e| method_of(e) == AWAITING_INPUT).await;
    let (request_seq, request) = find(&events, |e| method_of(e) == "session/request_permission");
    let permission_id = request["id"].clone();
    let (awaiting_seq, awaiting) = events.last().expect("awaiting_input");
    assert_eq!(*awaiting_seq, request_seq + 1);
    assert_eq!(
        awaiting["params"],
        json!({"sessionId": "s-1", "requestId": permission_id, "kind": "permission"})
    );

    let (status, _, _) = send_request(
        &test_app.app,
        Method::POST,
        "/v1/acp/turn-permission",
        Some(json!({
            "jsonrpc": "2.0",
            "id": permission_id,
            "result": {"outcome": {"outcome": "selected", "optionId": "allow-once"}}
        })),
        &[],
    )
    .await;
    assert_eq!(status, StatusCode::ACCEPTED);

    let events = observer.until_turn_ended(9).await;
    let (resolved_seq, resolved) = find(&events, |e| method_of(e) == INPUT_RESOLVED);
    assert_eq!(
        resolved["params"],
        json!({"sessionId": "s-1", "requestId": permission_id})
    );
    let (update_seq, _) = find(&events, |e| method_of(e) == "session/update");
    let (ended_seq, ended) = events.last().expect("turn_ended");
    assert!(resolved_seq < update_seq && update_seq < ended_seq);
    assert_eq!(ended["params"]["outcome"], "completed");
}
