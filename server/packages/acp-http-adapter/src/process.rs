use std::collections::{HashMap, VecDeque};
use std::convert::Infallible;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::response::sse::Event;
use futures::{stream, Stream, StreamExt};
use serde_json::{json, Value};
use thiserror::Error;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, oneshot, Mutex};
use tokio_stream::wrappers::BroadcastStream;

use crate::registry::LaunchSpec;

const RING_BUFFER_SIZE: usize = 1024;
const STDERR_TAIL_SIZE: usize = 16;
const EXIT_POLL_INTERVAL: Duration = Duration::from_millis(25);
// Requests that may complete asynchronously when the caller opts in with
// `PostMode::AsyncPrompt`. Their JSON-RPC response is correlated by id and
// delivered through the existing SSE stream instead of the POST response.
const ASYNC_RESPONSE_METHODS: &[&str] = &["session/prompt"];
const AGENT_STOPPED_MESSAGE: &str = "agent process stopped before responding";
const AGENT_TIMEOUT_MESSAGE: &str = "timed out waiting for agent response";

// Requests that start a turn when turn events are enabled.
const TURN_METHODS: &[&str] = &["session/prompt"];
// Agent-to-client requests that make the turn wait for client input.
const PERMISSION_REQUEST_METHOD: &str = "session/request_permission";

/// Published when a `session/prompt` request is sent to the agent.
pub const TURN_STARTED_METHOD: &str = "_sandboxagent/session/turn_started";
/// Published once per turn, after the last agent output of that turn.
pub const TURN_ENDED_METHOD: &str = "_sandboxagent/session/turn_ended";
/// Published right after the agent asks the client for a permission decision.
pub const AWAITING_INPUT_METHOD: &str = "_sandboxagent/session/awaiting_input";
/// Published once per awaited input: when the client answers it, or when the
/// turn ends or the agent stops without an answer.
pub const INPUT_RESOLVED_METHOD: &str = "_sandboxagent/session/input_resolved";
/// `_meta` key under which prompt responses carry `{sessionId, sequence}`.
pub const META_KEY: &str = "sandboxagent.dev";

#[derive(Debug, Error)]
pub enum AdapterError {
    #[error("failed to spawn subprocess: {0}")]
    Spawn(std::io::Error),
    #[error("failed to capture subprocess stdin")]
    MissingStdin,
    #[error("failed to capture subprocess stdout")]
    MissingStdout,
    #[error("failed to capture subprocess stderr")]
    MissingStderr,
    #[error("invalid json-rpc envelope")]
    InvalidEnvelope,
    #[error("failed to serialize json-rpc message: {0}")]
    Serialize(serde_json::Error),
    #[error("failed to write subprocess stdin: {0}")]
    Write(std::io::Error),
    #[error("agent process exited before responding")]
    Exited {
        exit_code: Option<i32>,
        stderr: Option<String>,
    },
    #[error("timeout waiting for response")]
    Timeout,
}

#[derive(Debug)]
pub enum PostOutcome {
    Response(Value),
    Accepted,
}

/// How a JSON-RPC request's response is delivered to the caller.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum PostMode {
    /// Wait for the agent response and return it from `post` (default).
    #[default]
    Sync,
    /// For long-running methods (`session/prompt`), return
    /// `PostOutcome::Accepted` once the request is written to the agent and
    /// deliver the response, timeout, or process-exit error over the stream.
    /// Other methods stay synchronous.
    AsyncPrompt,
}

/// Runtime configuration for [`AdapterRuntime::start_with_options`].
#[derive(Debug, Clone, Copy)]
pub struct RuntimeOptions {
    /// Bounds every request that waits for an agent response.
    pub request_timeout: Duration,
    /// Publish `_sandboxagent/session/*` turn lifecycle notifications on the
    /// stream and add `_meta["sandboxagent.dev"]` to prompt responses.
    pub turn_events: bool,
}

impl RuntimeOptions {
    pub fn new(request_timeout: Duration) -> Self {
        Self {
            request_timeout,
            turn_events: true,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TurnOutcome {
    /// The agent answered the prompt with a result.
    Completed,
    /// The agent answered with a JSON-RPC error, or the prompt could not be
    /// written to the agent.
    Error,
    /// The request timeout passed before the agent answered.
    Timeout,
    /// The agent process exited before answering.
    AgentExited,
    /// The agent answered with `stopReason: "cancelled"`, or the runtime was
    /// shut down (DELETE or server shutdown) before it answered.
    Cancelled,
}

impl TurnOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Error => "error",
            Self::Timeout => "timeout",
            Self::AgentExited => "agent_exited",
            Self::Cancelled => "cancelled",
        }
    }
}

/// A `session/prompt` request in flight.
#[derive(Debug, Clone)]
struct Turn {
    session_id: Value,
    request_id: Value,
}

/// An agent request waiting for the client's answer.
#[derive(Debug, Clone)]
struct PendingInput {
    key: String,
    session_id: Value,
    request_id: Value,
}

#[derive(Debug)]
struct PendingRequest {
    sender: oneshot::Sender<Value>,
    /// The caller is not waiting on `sender`; terminal errors must be
    /// published on the stream instead.
    stream_response: bool,
    /// Set for tracked turns. Whoever removes the request from the pending map
    /// publishes the turn's `turn_ended`, so it is published exactly once.
    turn: Option<Turn>,
}

type PendingMap = HashMap<String, PendingRequest>;
type InputList = Vec<PendingInput>;
type ExitInfo = (Option<i32>, Option<String>);

#[derive(Debug, Clone)]
struct StreamMessage {
    sequence: u64,
    payload: Value,
}

/// Replay ring plus live broadcast, with one sequence for both.
#[derive(Debug, Clone)]
struct EventLog {
    sender: broadcast::Sender<StreamMessage>,
    ring: Arc<Mutex<VecDeque<StreamMessage>>>,
    sequence: Arc<AtomicU64>,
}

impl EventLog {
    fn new() -> Self {
        let (sender, _rx) = broadcast::channel(512);
        Self {
            sender,
            ring: Arc::new(Mutex::new(VecDeque::with_capacity(RING_BUFFER_SIZE))),
            sequence: Arc::new(AtomicU64::new(0)),
        }
    }

    async fn publish(&self, payload: Value) {
        self.publish_batch(move |_| vec![payload]).await;
    }

    /// Publishes the payloads returned by `build` under consecutive sequences,
    /// with nothing interleaved. `build` receives the sequence the first
    /// payload will get, so payloads can reference each other's sequences.
    /// Returns the published payloads.
    async fn publish_batch<F>(&self, build: F) -> Vec<Value>
    where
        F: FnOnce(u64) -> Vec<Value>,
    {
        // Keep sequence allocation, replay insertion, and live publication ordered.
        // Otherwise concurrent timeout, exit, and stdout tasks can publish a newer
        // sequence before an older one and break Last-Event-ID replay.
        let mut guard = self.ring.lock().await;
        let first = self.sequence.load(Ordering::SeqCst) + 1;
        let payloads = build(first);
        let mut sequence = first - 1;
        for payload in &payloads {
            sequence += 1;
            let message = StreamMessage {
                sequence,
                payload: payload.clone(),
            };
            guard.push_back(message.clone());
            while guard.len() > RING_BUFFER_SIZE {
                guard.pop_front();
            }
            let _ = self.sender.send(message);
        }
        self.sequence.store(sequence, Ordering::SeqCst);
        payloads
    }
}

#[derive(Debug)]
pub struct AdapterRuntime {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pending: Arc<Mutex<PendingMap>>,
    inputs: Arc<Mutex<InputList>>,
    events: EventLog,
    request_timeout: Duration,
    turn_events: bool,
    shutting_down: AtomicBool,
    spawned_at: Instant,
    first_stdout: Arc<AtomicBool>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    exit_info: Arc<Mutex<Option<ExitInfo>>>,
}

impl AdapterRuntime {
    /// Starts the agent process with turn events enabled.
    pub async fn start(
        launch: LaunchSpec,
        request_timeout: Duration,
    ) -> Result<Self, AdapterError> {
        Self::start_with_options(launch, RuntimeOptions::new(request_timeout)).await
    }

    pub async fn start_with_options(
        launch: LaunchSpec,
        options: RuntimeOptions,
    ) -> Result<Self, AdapterError> {
        let spawn_start = Instant::now();

        let mut command = Command::new(&launch.program);
        command
            .args(&launch.args)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());

        for (key, value) in &launch.env {
            command.env(key, value);
        }

        tracing::info!(
            program = ?launch.program,
            args = ?launch.args,
            "spawning agent process"
        );

        let mut child = command.spawn().map_err(|err| {
            tracing::error!(
                program = ?launch.program,
                error = %err,
                "failed to spawn agent process"
            );
            AdapterError::Spawn(err)
        })?;

        let pid = child.id().unwrap_or(0);
        let spawn_elapsed = spawn_start.elapsed();
        tracing::info!(
            pid = pid,
            elapsed_ms = spawn_elapsed.as_millis() as u64,
            "agent process spawned"
        );

        let stdin = child.stdin.take().ok_or(AdapterError::MissingStdin)?;
        let stdout = child.stdout.take().ok_or(AdapterError::MissingStdout)?;
        let stderr = child.stderr.take().ok_or(AdapterError::MissingStderr)?;

        let runtime = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            inputs: Arc::new(Mutex::new(Vec::new())),
            events: EventLog::new(),
            request_timeout: options.request_timeout,
            turn_events: options.turn_events,
            shutting_down: AtomicBool::new(false),
            spawned_at: spawn_start,
            first_stdout: Arc::new(AtomicBool::new(false)),
            stderr_tail: Arc::new(Mutex::new(VecDeque::with_capacity(STDERR_TAIL_SIZE))),
            exit_info: Arc::new(Mutex::new(None)),
        };

        runtime.spawn_stdout_loop(stdout);
        runtime.spawn_stderr_loop(stderr);
        runtime.spawn_exit_watcher();

        Ok(runtime)
    }

    pub async fn post(&self, payload: Value) -> Result<PostOutcome, AdapterError> {
        self.post_with_mode(payload, PostMode::Sync).await
    }

    pub async fn post_with_mode(
        &self,
        payload: Value,
        mode: PostMode,
    ) -> Result<PostOutcome, AdapterError> {
        if !payload.is_object() {
            return Err(AdapterError::InvalidEnvelope);
        }

        let method: String = payload
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("<none>")
            .to_string();
        let has_method = payload.get("method").is_some();
        let id = payload.get("id");

        if has_method && id.is_some() {
            let id_value = id.expect("checked");
            let key = id_key(id_value);
            let (tx, rx) = oneshot::channel();
            let stream_response =
                mode == PostMode::AsyncPrompt && ASYNC_RESPONSE_METHODS.contains(&method.as_str());
            let turn =
                (self.turn_events && TURN_METHODS.contains(&method.as_str())).then(|| Turn {
                    session_id: payload
                        .pointer("/params/sessionId")
                        .cloned()
                        .unwrap_or(Value::Null),
                    request_id: id_value.clone(),
                });

            let pending_count = self.pending.lock().await.len();
            tracing::info!(
                method = %method,
                id = %key,
                pending_count = pending_count,
                "post: request → agent (awaiting response)"
            );

            self.pending.lock().await.insert(
                key.clone(),
                PendingRequest {
                    sender: tx,
                    stream_response,
                    turn: turn.clone(),
                },
            );

            // Publish before writing so turn_started precedes all agent output
            // of the turn on the stream.
            if let Some(turn) = &turn {
                self.events.publish(turn_started_notification(turn)).await;
            }

            let write_start = Instant::now();
            if let Err(err) = self.send_to_subprocess(&payload).await {
                tracing::error!(
                    method = %method,
                    id = %key,
                    error = %err,
                    "post: failed to write to agent stdin"
                );
                let removed = self.pending.lock().await.remove(&key);
                if let Some(PendingRequest {
                    turn: Some(turn), ..
                }) = removed
                {
                    finish_turn(&self.events, &self.inputs, &turn, None, TurnOutcome::Error).await;
                }
                return Err(err);
            }
            let write_ms = write_start.elapsed().as_millis() as u64;
            tracing::debug!(
                method = %method,
                id = %key,
                write_ms = write_ms,
                "post: stdin write complete, waiting for response"
            );

            if stream_response {
                self.spawn_async_response_waiter(method, key, id_value.clone(), rx, write_ms);
                return Ok(PostOutcome::Accepted);
            }

            let mut rx = rx;
            let wait_start = Instant::now();
            match tokio::time::timeout(self.request_timeout, &mut rx).await {
                Ok(Ok(response)) => {
                    let wait_ms = wait_start.elapsed().as_millis() as u64;
                    tracing::info!(
                        method = %method,
                        id = %key,
                        response_ms = wait_ms,
                        total_ms = write_ms + wait_ms,
                        "post: got response from agent"
                    );
                    Ok(PostOutcome::Response(response))
                }
                Ok(Err(_)) => {
                    let wait_ms = wait_start.elapsed().as_millis() as u64;
                    tracing::error!(
                        method = %method,
                        id = %key,
                        wait_ms = wait_ms,
                        "post: response channel dropped (agent process may have exited)"
                    );
                    self.pending.lock().await.remove(&key);
                    if let Some((exit_code, stderr)) = self.try_process_exit_info().await {
                        tracing::error!(
                            method = %method,
                            id = %key,
                            exit_code = ?exit_code,
                            stderr = ?stderr,
                            "post: agent process exited before response channel completed"
                        );
                        return Err(AdapterError::Exited { exit_code, stderr });
                    }
                    Err(AdapterError::Timeout)
                }
                Err(_) => {
                    let pending_keys: Vec<String> =
                        self.pending.lock().await.keys().cloned().collect();
                    tracing::error!(
                        method = %method,
                        id = %key,
                        timeout_ms = self.request_timeout.as_millis() as u64,
                        age_ms = self.spawned_at.elapsed().as_millis() as u64,
                        pending_keys = ?pending_keys,
                        first_stdout_seen = self.first_stdout.load(Ordering::Relaxed),
                        "post: TIMEOUT waiting for agent response"
                    );
                    let removed = self.pending.lock().await.remove(&key);
                    let Some(request) = removed else {
                        // The response (or a terminal drain) won the race with
                        // the timeout and already published the turn end; report
                        // the same result to the caller.
                        if let Ok(response) = rx.await {
                            return Ok(PostOutcome::Response(response));
                        }
                        if let Some((exit_code, stderr)) = self.try_process_exit_info().await {
                            return Err(AdapterError::Exited { exit_code, stderr });
                        }
                        return Err(AdapterError::Timeout);
                    };
                    let exit = self.try_process_exit_info().await;
                    if let Some(turn) = &request.turn {
                        let outcome = if exit.is_some() {
                            TurnOutcome::AgentExited
                        } else {
                            TurnOutcome::Timeout
                        };
                        finish_turn(&self.events, &self.inputs, turn, None, outcome).await;
                    }
                    if let Some((exit_code, stderr)) = exit {
                        tracing::error!(
                            method = %method,
                            id = %key,
                            exit_code = ?exit_code,
                            stderr = ?stderr,
                            "post: agent process exited before timeout completed"
                        );
                        return Err(AdapterError::Exited { exit_code, stderr });
                    }
                    Err(AdapterError::Timeout)
                }
            }
        } else {
            if !has_method && self.turn_events {
                if let Some(id) = id {
                    // A client answer to an agent request. Resolve the awaited
                    // input before forwarding, so input_resolved precedes any
                    // agent output caused by the answer.
                    let key = id_key(id);
                    let resolved = {
                        let mut inputs = self.inputs.lock().await;
                        inputs
                            .iter()
                            .position(|input| input.key == key)
                            .map(|index| inputs.remove(index))
                    };
                    if let Some(input) = resolved {
                        self.events
                            .publish(input_resolved_notification(&input))
                            .await;
                    }
                }
            }
            tracing::debug!(
                method = %method,
                "post: notification → agent (fire-and-forget)"
            );
            self.send_to_subprocess(&payload).await?;
            Ok(PostOutcome::Accepted)
        }
    }

    fn spawn_async_response_waiter(
        &self,
        method: String,
        key: String,
        id: Value,
        rx: oneshot::Receiver<Value>,
        write_ms: u64,
    ) {
        let pending = self.pending.clone();
        let inputs = self.inputs.clone();
        let events = self.events.clone();
        let request_timeout = self.request_timeout;

        tracing::info!(
            method = %method,
            id = %key,
            write_ms = write_ms,
            "post: request accepted; response will be delivered over SSE"
        );

        tokio::spawn(async move {
            match tokio::time::timeout(request_timeout, rx).await {
                Ok(Ok(_)) => {
                    // The stdout loop already published the response.
                    tracing::info!(
                        method = %method,
                        id = %key,
                        "post: asynchronous response delivered over SSE"
                    );
                }
                Ok(Err(_)) => {
                    // The exit watcher or shutdown drained this request and
                    // already published a terminal error for it.
                    tracing::warn!(
                        method = %method,
                        id = %key,
                        "post: asynchronous request ended without agent response"
                    );
                }
                Err(_) => {
                    let removed = pending.lock().await.remove(&key);
                    tracing::error!(
                        method = %method,
                        id = %key,
                        timeout_ms = request_timeout.as_millis() as u64,
                        "post: TIMEOUT waiting for asynchronous agent response"
                    );
                    if let Some(request) = removed {
                        let error = json_rpc_error(id, AGENT_TIMEOUT_MESSAGE);
                        match &request.turn {
                            Some(turn) => {
                                finish_turn(
                                    &events,
                                    &inputs,
                                    turn,
                                    Some(error),
                                    TurnOutcome::Timeout,
                                )
                                .await;
                            }
                            None => events.publish(error).await,
                        }
                    }
                }
            }
        });
    }

    async fn subscribe(
        &self,
        last_event_id: Option<u64>,
    ) -> (Vec<(u64, Value)>, u64, broadcast::Receiver<StreamMessage>) {
        // Subscribe before taking the replay snapshot so a concurrently published
        // message appears in at least one source. The watermark drops duplicates.
        let receiver = self.events.sender.subscribe();
        let ring = self.events.ring.lock().await;
        let replay_watermark = ring.back().map(|message| message.sequence).unwrap_or(0);
        let replay = ring
            .iter()
            .filter(|message| last_event_id.is_none_or(|last| message.sequence > last))
            .map(|message| (message.sequence, message.payload.clone()))
            .collect::<Vec<_>>();
        (replay, replay_watermark, receiver)
    }

    pub async fn sse_stream(
        self: Arc<Self>,
        last_event_id: Option<u64>,
    ) -> impl Stream<Item = Result<Event, Infallible>> + Send + 'static {
        self.payload_stream(last_event_id)
            .await
            .map(|(sequence, payload)| {
                Ok(Event::default()
                    .event("message")
                    .id(sequence.to_string())
                    .data(payload.to_string()))
            })
    }

    /// Stream of sequenced raw JSON-RPC payloads (replay followed by live).
    pub async fn payload_stream(
        self: Arc<Self>,
        last_event_id: Option<u64>,
    ) -> impl Stream<Item = (u64, Value)> + Send + 'static {
        let (replay, replay_watermark, rx) = self.subscribe(last_event_id).await;
        let live_stream = BroadcastStream::new(rx).filter_map(move |item| async move {
            match item {
                Ok(message) if message.sequence > replay_watermark => {
                    Some((message.sequence, message.payload))
                }
                _ => None,
            }
        });
        stream::iter(replay).chain(live_stream)
    }

    /// Stream of raw JSON-RPC `Value` payloads (without SSE framing).
    /// Useful for consumers that need to inspect the payload contents
    /// rather than forward them as SSE events.
    pub async fn value_stream(
        self: Arc<Self>,
        last_event_id: Option<u64>,
    ) -> impl Stream<Item = Value> + Send + 'static {
        self.payload_stream(last_event_id)
            .await
            .map(|(_sequence, payload)| payload)
    }

    pub async fn shutdown(&self) {
        if self.shutting_down.swap(true, Ordering::SeqCst) {
            return;
        }

        tracing::info!(
            age_ms = self.spawned_at.elapsed().as_millis() as u64,
            "shutting down agent process"
        );

        fail_pending_requests(
            &self.pending,
            &self.inputs,
            &self.events,
            TurnOutcome::Cancelled,
        )
        .await;
        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(_)) => {}
            Ok(None) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
            }
            Err(_) => {
                let _ = child.kill().await;
            }
        }
    }

    fn spawn_stdout_loop(&self, stdout: tokio::process::ChildStdout) {
        let pending = self.pending.clone();
        let inputs = self.inputs.clone();
        let events = self.events.clone();
        let turn_events = self.turn_events;
        let spawned_at = self.spawned_at;
        let first_stdout = self.first_stdout.clone();

        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            let mut line_count: u64 = 0;

            while let Ok(Some(line)) = lines.next_line().await {
                let trimmed = line.trim();
                if trimmed.is_empty() {
                    continue;
                }

                line_count += 1;

                if !first_stdout.swap(true, Ordering::Relaxed) {
                    tracing::info!(
                        first_stdout_ms = spawned_at.elapsed().as_millis() as u64,
                        line_bytes = trimmed.len(),
                        "agent process: first stdout line received"
                    );
                }

                let payload = match serde_json::from_str::<Value>(trimmed) {
                    Ok(payload) => payload,
                    Err(err) => {
                        tracing::warn!(
                            error = %err,
                            line_number = line_count,
                            raw = %if trimmed.len() > 200 {
                                format!("{}...", &trimmed[..200])
                            } else {
                                trimmed.to_string()
                            },
                            "agent stdout: invalid JSON"
                        );
                        json!({
                            "jsonrpc": "2.0",
                            "method": "_adapter/invalid_stdout",
                            "params": {
                                "error": err.to_string(),
                                "raw": trimmed,
                            }
                        })
                    }
                };

                let is_response = payload.get("id").is_some() && payload.get("method").is_none();
                if is_response {
                    let key = id_key(payload.get("id").expect("checked"));
                    let has_error = payload.get("error").is_some();
                    let matched = pending.lock().await.remove(&key);
                    if let Some(request) = matched {
                        tracing::debug!(
                            id = %key,
                            has_error = has_error,
                            age_ms = spawned_at.elapsed().as_millis() as u64,
                            "agent stdout: response matched to pending request"
                        );
                        match &request.turn {
                            Some(turn) => {
                                // Publish the response and turn_ended first, then
                                // hand the annotated response to a synchronous
                                // caller: by the time the POST returns, every
                                // event of the turn is on the stream, up to the
                                // sequence in `_meta`.
                                let outcome = turn_outcome_from_response(&payload);
                                if let Some(response) =
                                    finish_turn(&events, &inputs, turn, Some(payload), outcome)
                                        .await
                                {
                                    let _ = request.sender.send(response);
                                }
                            }
                            None => {
                                let _ = request.sender.send(payload.clone());
                                // Also broadcast the response so SSE/notification
                                // subscribers see it in order after preceding
                                // notifications.
                                events.publish(payload).await;
                            }
                        }
                        continue;
                    } else {
                        tracing::warn!(
                            id = %key,
                            has_error = has_error,
                            "agent stdout: response has no matching pending request (orphan)"
                        );
                        // Late responses after a timeout or shutdown already got a
                        // terminal error; do not publish a second result.
                        continue;
                    }
                }

                let method = payload
                    .get("method")
                    .and_then(|v| v.as_str())
                    .unwrap_or("<none>");
                tracing::debug!(
                    method = method,
                    line_number = line_count,
                    "agent stdout: notification/event → SSE broadcast"
                );

                if turn_events && method == PERMISSION_REQUEST_METHOD {
                    if let Some(id) = payload.get("id") {
                        let input = PendingInput {
                            key: id_key(id),
                            session_id: payload
                                .pointer("/params/sessionId")
                                .cloned()
                                .unwrap_or(Value::Null),
                            request_id: id.clone(),
                        };
                        let awaiting = awaiting_input_notification(&input);
                        inputs.lock().await.push(input);
                        events.publish_batch(move |_| vec![payload, awaiting]).await;
                        continue;
                    }
                }

                events.publish(payload).await;
            }

            tracing::info!(
                total_lines = line_count,
                age_ms = spawned_at.elapsed().as_millis() as u64,
                "agent stdout: stream ended"
            );
        });
    }

    fn spawn_stderr_loop(&self, stderr: tokio::process::ChildStderr) {
        let spawned_at = self.spawned_at;
        let stderr_tail = self.stderr_tail.clone();

        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            let mut line_count: u64 = 0;

            while let Ok(Some(line)) = lines.next_line().await {
                line_count += 1;
                {
                    let mut tail = stderr_tail.lock().await;
                    tail.push_back(line.clone());
                    while tail.len() > STDERR_TAIL_SIZE {
                        tail.pop_front();
                    }
                }
                tracing::info!(
                    line_number = line_count,
                    age_ms = spawned_at.elapsed().as_millis() as u64,
                    "agent stderr: {}",
                    line
                );
            }

            tracing::debug!(
                total_lines = line_count,
                age_ms = spawned_at.elapsed().as_millis() as u64,
                "agent stderr: stream ended"
            );
        });
    }

    fn spawn_exit_watcher(&self) {
        let child = self.child.clone();
        let events = self.events.clone();
        let spawned_at = self.spawned_at;
        let pending = self.pending.clone();
        let inputs = self.inputs.clone();
        let stderr_tail = self.stderr_tail.clone();
        let exit_info = self.exit_info.clone();

        tokio::spawn(async move {
            // Do not hold the child lock across Child::wait(). The timeout and
            // shutdown paths also need this lock, and wait() may not complete
            // until the agent exits hours later.
            let status = loop {
                let result = {
                    let mut guard = child.lock().await;
                    guard.try_wait()
                };
                match result {
                    Ok(Some(status)) => break Some(status),
                    Ok(None) => tokio::time::sleep(EXIT_POLL_INTERVAL).await,
                    Err(_) => break None,
                }
            };

            let age_ms = spawned_at.elapsed().as_millis() as u64;

            if let Some(status) = status {
                // Record exit info before waking pending callers so post()
                // reports Exited instead of Timeout.
                let stderr = stderr_tail_text(&stderr_tail).await;
                *exit_info.lock().await = Some((status.code(), stderr));
            }

            let pending_count =
                fail_pending_requests(&pending, &inputs, &events, TurnOutcome::AgentExited).await;

            if let Some(status) = status {
                tracing::warn!(
                    success = status.success(),
                    code = status.code(),
                    age_ms = age_ms,
                    pending_requests = pending_count,
                    "agent process exited"
                );

                let payload = json!({
                    "jsonrpc": "2.0",
                    "method": "_adapter/agent_exited",
                    "params": {
                        "success": status.success(),
                        "code": status.code(),
                    }
                });

                events.publish(payload).await;
            } else {
                tracing::error!(
                    age_ms = age_ms,
                    pending_requests = pending_count,
                    "agent process: failed to get exit status"
                );
            }
        });
    }

    async fn send_to_subprocess(&self, payload: &Value) -> Result<(), AdapterError> {
        let method = payload
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("<none>");
        let id = payload.get("id").map(|v| v.to_string()).unwrap_or_default();

        tracing::debug!(
            method = method,
            id = %id,
            bytes = serde_json::to_vec(payload).map(|b| b.len()).unwrap_or(0),
            "stdin: writing message to agent"
        );

        let mut stdin = self.stdin.lock().await;
        let bytes = serde_json::to_vec(payload).map_err(AdapterError::Serialize)?;
        stdin.write_all(&bytes).await.map_err(|err| {
            tracing::error!(method = method, id = %id, error = %err, "stdin: write_all failed");
            AdapterError::Write(err)
        })?;
        stdin.write_all(b"\n").await.map_err(|err| {
            tracing::error!(method = method, id = %id, error = %err, "stdin: newline write failed");
            AdapterError::Write(err)
        })?;
        stdin.flush().await.map_err(|err| {
            tracing::error!(method = method, id = %id, error = %err, "stdin: flush failed");
            AdapterError::Write(err)
        })?;

        tracing::debug!(method = method, id = %id, "stdin: write+flush complete");
        Ok(())
    }

    async fn try_process_exit_info(&self) -> Option<ExitInfo> {
        if let Some(info) = self.exit_info.lock().await.clone() {
            return Some(info);
        }

        let mut child = self.child.lock().await;
        match child.try_wait() {
            Ok(Some(status)) => {
                let exit_code = status.code();
                drop(child);
                let stderr = self.stderr_tail_summary().await;
                Some((exit_code, stderr))
            }
            Ok(None) => None,
            Err(_) => None,
        }
    }

    pub async fn stderr_tail_summary(&self) -> Option<String> {
        stderr_tail_text(&self.stderr_tail).await
    }
}

async fn stderr_tail_text(stderr_tail: &Mutex<VecDeque<String>>) -> Option<String> {
    let tail = stderr_tail.lock().await;
    if tail.is_empty() {
        return None;
    }
    Some(tail.iter().cloned().collect::<Vec<_>>().join("\n"))
}

/// Drain all pending requests. Synchronous callers wake because their sender
/// is dropped; asynchronous (stream-delivered) requests get a JSON-RPC error
/// on the stream. Tracked turns end with `outcome`, and every input still
/// awaited is resolved. Returns the number of drained requests.
async fn fail_pending_requests(
    pending: &Mutex<PendingMap>,
    inputs: &Mutex<InputList>,
    events: &EventLog,
    outcome: TurnOutcome,
) -> usize {
    let mut drained = pending.lock().await.drain().collect::<Vec<_>>();
    drained.sort_by(|left, right| left.0.cmp(&right.0));
    let count = drained.len();
    for (key, request) in drained {
        let error = if request.stream_response {
            serde_json::from_str::<Value>(&key)
                .ok()
                .map(|id| json_rpc_error(id, AGENT_STOPPED_MESSAGE))
        } else {
            None
        };
        match &request.turn {
            Some(turn) => {
                finish_turn(events, inputs, turn, error, outcome).await;
            }
            None => {
                if let Some(error) = error {
                    events.publish(error).await;
                }
            }
        }
        // `request` (and its sender) is dropped only now, so a woken
        // synchronous caller finds the turn end already on the stream.
    }

    let leftover = std::mem::take(&mut *inputs.lock().await);
    if !leftover.is_empty() {
        events
            .publish_batch(move |_| leftover.iter().map(input_resolved_notification).collect())
            .await;
    }
    count
}

/// Publishes the end of `turn` as one uninterrupted run of events:
/// `input_resolved` for each input of the session still awaited, the response
/// (if any) annotated with `_meta["sandboxagent.dev"]`, then `turn_ended`.
/// Returns the annotated response.
async fn finish_turn(
    events: &EventLog,
    inputs: &Mutex<InputList>,
    turn: &Turn,
    response: Option<Value>,
    outcome: TurnOutcome,
) -> Option<Value> {
    let resolved = take_session_inputs(inputs, &turn.session_id).await;
    let stop_reason = response
        .as_ref()
        .and_then(|value| value.pointer("/result/stopReason"))
        .cloned();
    let has_response = response.is_some();
    let published = events
        .publish_batch(|first| {
            let last = first + resolved.len() as u64 + u64::from(has_response);
            let mut batch: Vec<Value> = resolved.iter().map(input_resolved_notification).collect();
            if let Some(mut response) = response {
                attach_turn_meta(&mut response, &turn.session_id, last);
                batch.push(response);
            }
            batch.push(turn_ended_notification(turn, outcome, stop_reason));
            batch
        })
        .await;
    if has_response {
        published.into_iter().rev().nth(1)
    } else {
        None
    }
}

async fn take_session_inputs(inputs: &Mutex<InputList>, session_id: &Value) -> InputList {
    let mut guard = inputs.lock().await;
    let (taken, kept): (InputList, InputList) = std::mem::take(&mut *guard)
        .into_iter()
        .partition(|input| &input.session_id == session_id);
    *guard = kept;
    taken
}

fn turn_outcome_from_response(response: &Value) -> TurnOutcome {
    if response.get("error").is_some() {
        return TurnOutcome::Error;
    }
    match response
        .pointer("/result/stopReason")
        .and_then(Value::as_str)
    {
        Some("cancelled") => TurnOutcome::Cancelled,
        _ => TurnOutcome::Completed,
    }
}

/// Adds `{sessionId, sequence}` under `_meta["sandboxagent.dev"]`: in
/// `result._meta` for results, in `error.data._meta` for errors. `sequence` is
/// the stream sequence of the turn's `turn_ended`. Responses whose `result` or
/// `error.data` is not an object are left unchanged.
fn attach_turn_meta(response: &mut Value, session_id: &Value, sequence: u64) {
    let meta = json!({ "sessionId": session_id, "sequence": sequence });
    let container = if let Some(result) = response.get_mut("result") {
        Some(result)
    } else if let Some(error) = response.get_mut("error").and_then(Value::as_object_mut) {
        let data = error
            .entry("data")
            .or_insert_with(|| Value::Object(Default::default()));
        if data.is_null() {
            *data = Value::Object(Default::default());
        }
        Some(data)
    } else {
        None
    };
    let Some(object) = container.and_then(Value::as_object_mut) else {
        return;
    };
    let meta_object = object
        .entry("_meta")
        .or_insert_with(|| Value::Object(Default::default()));
    if !meta_object.is_object() {
        *meta_object = Value::Object(Default::default());
    }
    if let Some(meta_object) = meta_object.as_object_mut() {
        meta_object.insert(META_KEY.to_string(), meta);
    }
}

fn notification(method: &str, params: Value) -> Value {
    json!({ "jsonrpc": "2.0", "method": method, "params": params })
}

fn turn_started_notification(turn: &Turn) -> Value {
    notification(
        TURN_STARTED_METHOD,
        json!({ "sessionId": turn.session_id, "requestId": turn.request_id }),
    )
}

fn turn_ended_notification(turn: &Turn, outcome: TurnOutcome, stop_reason: Option<Value>) -> Value {
    let mut params = json!({
        "sessionId": turn.session_id,
        "requestId": turn.request_id,
        "outcome": outcome.as_str(),
    });
    if let Some(stop_reason) = stop_reason {
        params["stopReason"] = stop_reason;
    }
    notification(TURN_ENDED_METHOD, params)
}

fn awaiting_input_notification(input: &PendingInput) -> Value {
    notification(
        AWAITING_INPUT_METHOD,
        json!({
            "sessionId": input.session_id,
            "requestId": input.request_id,
            "kind": "permission",
        }),
    )
}

fn input_resolved_notification(input: &PendingInput) -> Value {
    notification(
        INPUT_RESOLVED_METHOD,
        json!({ "sessionId": input.session_id, "requestId": input.request_id }),
    )
}

fn json_rpc_error(id: Value, message: &str) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": -32603,
            "message": message,
        }
    })
}

fn id_key(value: &Value) -> String {
    serde_json::to_string(value).unwrap_or_else(|_| "null".to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use std::collections::HashMap;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;

    use super::*;

    fn sh(script: &str) -> LaunchSpec {
        LaunchSpec {
            program: PathBuf::from("sh"),
            args: vec!["-c".to_string(), script.to_string()],
            env: HashMap::new(),
        }
    }

    fn prompt(id: u64) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/prompt",
            "params": {}
        })
    }

    #[tokio::test]
    async fn post_wakes_when_process_exits_before_response() {
        let temp_dir = tempfile::tempdir().expect("temp dir");
        let script = temp_dir.path().join("exit-agent.sh");
        fs::write(
            &script,
            r#"#!/usr/bin/env sh
while IFS= read -r _line; do
  echo "fatal startup" >&2
  exit 7
done
exit 7
"#,
        )
        .expect("write script");
        fs::set_permissions(&script, fs::Permissions::from_mode(0o755)).expect("chmod script");

        let runtime = AdapterRuntime::start(
            LaunchSpec {
                program: script,
                args: Vec::new(),
                env: HashMap::new(),
            },
            Duration::from_secs(30),
        )
        .await
        .expect("start runtime");

        let started = Instant::now();
        let err = tokio::time::timeout(
            Duration::from_secs(5),
            runtime.post(json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {}
            })),
        )
        .await
        .expect("post should wake before request timeout")
        .expect_err("post should fail when agent exits");

        assert!(started.elapsed() < Duration::from_secs(5));

        match err {
            AdapterError::Exited { exit_code, stderr } => {
                assert_eq!(exit_code, Some(7));
                assert!(
                    stderr
                        .as_deref()
                        .is_some_and(|value| value.contains("fatal startup")),
                    "stderr tail should include agent stderr"
                );
            }
            other => panic!("expected process exit error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn post_returns_when_request_times_out_while_process_is_running() {
        let runtime = AdapterRuntime::start(
            sh("IFS= read -r _line; IFS= read -r _never"),
            Duration::from_millis(200),
        )
        .await
        .expect("start runtime");

        let started = Instant::now();
        let err = tokio::time::timeout(Duration::from_secs(5), runtime.post(prompt(1)))
            .await
            .expect("post should return promptly after request timeout")
            .expect_err("post should time out");

        assert!(matches!(err, AdapterError::Timeout), "got {err:?}");
        assert!(started.elapsed() < Duration::from_secs(2));

        tokio::time::timeout(Duration::from_secs(2), runtime.shutdown())
            .await
            .expect("shutdown should not wait for the running process");
    }

    #[tokio::test]
    async fn synchronous_prompt_without_opt_in_returns_inline_response() {
        let runtime = AdapterRuntime::start(
            sh(concat!(
                "IFS= read -r line; ",
                "printf '%s\\n' ",
                "'{\"jsonrpc\":\"2.0\",\"id\":5,\"result\":{\"ok\":true}}'"
            )),
            Duration::from_secs(2),
        )
        .await
        .expect("start adapter");

        let outcome = runtime.post(prompt(5)).await.expect("response");
        match outcome {
            PostOutcome::Response(value) => assert_eq!(value["result"]["ok"], true),
            other => panic!("expected inline response, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn asynchronous_request_response_is_delivered_on_stream() {
        let runtime = Arc::new(
            AdapterRuntime::start(
                sh(concat!(
                    "IFS= read -r line; ",
                    "printf '%s\\n' ",
                    "'{\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}'"
                )),
                Duration::from_secs(1),
            )
            .await
            .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        let outcome = runtime
            .post_with_mode(prompt(7), PostMode::AsyncPrompt)
            .await
            .expect("accept request");
        assert!(matches!(outcome, PostOutcome::Accepted));

        let (_sequence, response) = next_agent_event(&mut stream).await;
        assert_eq!(response["id"], 7);
        assert_eq!(response["result"]["ok"], true);
    }

    #[tokio::test]
    async fn asynchronous_request_timeout_is_delivered_on_stream() {
        let runtime = Arc::new(
            AdapterRuntime::start(
                sh(concat!(
                    "IFS= read -r line; sleep 0.1; ",
                    "printf '%s\\n' ",
                    "'{\"jsonrpc\":\"2.0\",\"id\":42,\"result\":{\"late\":true}}'"
                )),
                Duration::from_millis(25),
            )
            .await
            .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        let outcome = runtime
            .post_with_mode(prompt(42), PostMode::AsyncPrompt)
            .await
            .expect("accept request");
        assert!(matches!(outcome, PostOutcome::Accepted));

        let (_, response) = next_agent_event(&mut stream).await;
        assert_eq!(response["id"], 42);
        assert_eq!(response["error"]["code"], -32603);
        assert_eq!(
            response["error"]["message"],
            "timed out waiting for agent response"
        );

        let mut saw_late_response = false;
        for _ in 0..2 {
            let Ok(Some((_, event))) =
                tokio::time::timeout(Duration::from_millis(250), stream.next()).await
            else {
                break;
            };
            if event["id"] == 42 && event.get("result").is_some() {
                saw_late_response = true;
            }
        }
        assert!(!saw_late_response);
    }

    #[tokio::test]
    async fn asynchronous_request_process_exit_is_delivered_on_stream() {
        let runtime = Arc::new(
            AdapterRuntime::start(sh("IFS= read -r line; exit 1"), Duration::from_secs(1))
                .await
                .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        let outcome = runtime
            .post_with_mode(prompt(99), PostMode::AsyncPrompt)
            .await
            .expect("accept request");
        assert!(matches!(outcome, PostOutcome::Accepted));

        let (_, response) = next_agent_event(&mut stream).await;
        assert_eq!(response["id"], 99);
        assert_eq!(response["error"]["code"], -32603);
        assert_eq!(
            response["error"]["message"],
            "agent process stopped before responding"
        );
    }

    #[tokio::test]
    async fn asynchronous_request_shutdown_is_delivered_on_stream() {
        let runtime = Arc::new(
            AdapterRuntime::start(sh("IFS= read -r line; sleep 10"), Duration::from_secs(30))
                .await
                .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        let outcome = runtime
            .post_with_mode(prompt(100), PostMode::AsyncPrompt)
            .await
            .expect("accept request");
        assert!(matches!(outcome, PostOutcome::Accepted));

        tokio::time::timeout(Duration::from_secs(1), runtime.shutdown())
            .await
            .expect("shutdown completes");
        let (_, response) = next_agent_event(&mut stream).await;
        assert_eq!(response["id"], 100);
        assert_eq!(
            response["error"]["message"],
            "agent process stopped before responding"
        );
    }

    // ---- Turn lifecycle events (SBA-9) ----

    const UPDATE_S1: &str = r#"{"jsonrpc":"2.0","method":"session/update","params":{"sessionId":"s1","update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}}}}"#;

    fn session_prompt(id: Value, session_id: &str) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/prompt",
            "params": {"sessionId": session_id, "prompt": [{"type": "text", "text": "hello"}]}
        })
    }

    fn permission_request_line(id: &str, session_id: &str) -> String {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "session/request_permission",
            "params": {
                "sessionId": session_id,
                "toolCall": {"toolCallId": "tc-1", "title": "Write"},
                "options": [{"kind": "allow_once", "name": "Allow", "optionId": "allow"}]
            }
        })
        .to_string()
    }

    /// Shell snippet that prints `line` verbatim on stdout.
    fn emit(line: &str) -> String {
        format!("printf '%s\\n' '{line}'; ")
    }

    fn method_of(value: &Value) -> &str {
        value.get("method").and_then(Value::as_str).unwrap_or("")
    }

    type PayloadStream = std::pin::Pin<Box<dyn Stream<Item = (u64, Value)> + Send>>;

    async fn open_stream(runtime: &Arc<AdapterRuntime>) -> PayloadStream {
        Box::pin(runtime.clone().payload_stream(Some(0)).await)
    }

    async fn next_event(stream: &mut PayloadStream) -> (u64, Value) {
        tokio::time::timeout(Duration::from_secs(3), stream.next())
            .await
            .expect("stream event before timeout")
            .expect("stream still open")
    }

    /// Collects events until (and including) the first `turn_ended`.
    async fn collect_turn(stream: &mut PayloadStream) -> Vec<(u64, Value)> {
        let mut events = Vec::new();
        loop {
            let event = next_event(stream).await;
            let done = method_of(&event.1) == TURN_ENDED_METHOD;
            events.push(event);
            if done {
                return events;
            }
        }
    }

    /// Next event that is not a synthetic `_sandboxagent/session/*` notification.
    async fn next_agent_event(stream: &mut PayloadStream) -> (u64, Value) {
        loop {
            let event = next_event(stream).await;
            if !method_of(&event.1).starts_with("_sandboxagent/session/") {
                return event;
            }
        }
    }

    fn methods(events: &[(u64, Value)]) -> Vec<String> {
        events
            .iter()
            .map(|(_, value)| {
                if value.get("method").is_some() {
                    method_of(value).to_string()
                } else if value.get("error").is_some() {
                    "<error>".to_string()
                } else {
                    "<result>".to_string()
                }
            })
            .collect()
    }

    fn assert_sequences_are_consecutive(events: &[(u64, Value)]) {
        for pair in events.windows(2) {
            assert_eq!(pair[1].0, pair[0].0 + 1, "events: {events:?}");
        }
    }

    #[tokio::test]
    async fn sync_prompt_emits_turn_events_around_agent_output() {
        let script = format!(
            "IFS= read -r line; {}{}IFS= read -r _never",
            emit(UPDATE_S1),
            emit(r#"{"jsonrpc":"2.0","id":5,"result":{"stopReason":"end_turn"}}"#)
        );
        let runtime = Arc::new(
            AdapterRuntime::start(sh(&script), Duration::from_secs(2))
                .await
                .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        let outcome = runtime
            .post(session_prompt(json!(5), "s1"))
            .await
            .expect("prompt response");
        let PostOutcome::Response(post_response) = outcome else {
            panic!("expected inline response");
        };

        let events = collect_turn(&mut stream).await;
        assert_eq!(
            methods(&events),
            vec![
                TURN_STARTED_METHOD,
                "session/update",
                "<result>",
                TURN_ENDED_METHOD
            ]
        );
        assert_sequences_are_consecutive(&events);
        assert_eq!(
            events[0].1["params"],
            json!({"sessionId": "s1", "requestId": 5})
        );
        let turn_ended_sequence = events[3].0;
        assert_eq!(
            events[3].1["params"],
            json!({"sessionId": "s1", "requestId": 5, "outcome": "completed", "stopReason": "end_turn"})
        );
        assert_eq!(
            events[2].1["result"]["_meta"][META_KEY],
            json!({"sessionId": "s1", "sequence": turn_ended_sequence})
        );
        assert_eq!(
            post_response, events[2].1,
            "POST and SSE carry the same response"
        );

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn async_prompt_emits_turn_events_and_meta_on_stream() {
        let script = format!(
            "IFS= read -r line; {}{}IFS= read -r _never",
            emit(UPDATE_S1),
            emit(
                r#"{"jsonrpc":"2.0","id":"c-7","result":{"stopReason":"end_turn","_meta":{"agent":"x"}}}"#
            )
        );
        let runtime = Arc::new(
            AdapterRuntime::start(sh(&script), Duration::from_secs(2))
                .await
                .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        let outcome = runtime
            .post_with_mode(session_prompt(json!("c-7"), "s1"), PostMode::AsyncPrompt)
            .await
            .expect("accept");
        assert!(matches!(outcome, PostOutcome::Accepted));

        let events = collect_turn(&mut stream).await;
        assert_eq!(
            methods(&events),
            vec![
                TURN_STARTED_METHOD,
                "session/update",
                "<result>",
                TURN_ENDED_METHOD
            ]
        );
        assert_eq!(events[0].1["params"]["requestId"], "c-7");
        let response = &events[2].1;
        assert_eq!(
            response["result"]["_meta"]["agent"], "x",
            "agent _meta kept"
        );
        assert_eq!(
            response["result"]["_meta"][META_KEY]["sequence"],
            events[3].0
        );
        assert_eq!(events[3].1["params"]["outcome"], "completed");

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn cancelled_stop_reason_ends_turn_as_cancelled() {
        // The agent answers the prompt with stopReason=cancelled once it reads
        // the session/cancel notification.
        let script = format!(
            "IFS= read -r line; IFS= read -r cancel; {}IFS= read -r _never",
            emit(r#"{"jsonrpc":"2.0","id":8,"result":{"stopReason":"cancelled"}}"#)
        );
        let runtime = Arc::new(
            AdapterRuntime::start(sh(&script), Duration::from_secs(2))
                .await
                .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        runtime
            .post_with_mode(session_prompt(json!(8), "s1"), PostMode::AsyncPrompt)
            .await
            .expect("accept");
        runtime
            .post(json!({"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": "s1"}}))
            .await
            .expect("cancel");

        let events = collect_turn(&mut stream).await;
        assert_eq!(
            events.last().expect("turn_ended").1["params"],
            json!({"sessionId": "s1", "requestId": 8, "outcome": "cancelled", "stopReason": "cancelled"})
        );

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn agent_error_response_ends_turn_with_error_and_meta_in_error_data() {
        let script = format!(
            "IFS= read -r line; {}IFS= read -r _never",
            emit(r#"{"jsonrpc":"2.0","id":4,"error":{"code":-32000,"message":"boom"}}"#)
        );
        let runtime = Arc::new(
            AdapterRuntime::start(sh(&script), Duration::from_secs(2))
                .await
                .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        let PostOutcome::Response(post_response) = runtime
            .post(session_prompt(json!(4), "s1"))
            .await
            .expect("response")
        else {
            panic!("expected inline response");
        };

        let events = collect_turn(&mut stream).await;
        let turn_ended = &events.last().expect("turn_ended").1;
        assert_eq!(
            turn_ended["params"],
            json!({"sessionId": "s1", "requestId": 4, "outcome": "error"})
        );
        assert_eq!(
            post_response["error"]["data"]["_meta"][META_KEY],
            json!({"sessionId": "s1", "sequence": events.last().expect("last").0})
        );
        assert_eq!(post_response["error"]["message"], "boom");

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn sync_prompt_timeout_ends_turn_with_timeout() {
        let runtime = Arc::new(
            AdapterRuntime::start(
                sh("IFS= read -r _line; IFS= read -r _never"),
                Duration::from_millis(200),
            )
            .await
            .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        let err = runtime
            .post(session_prompt(json!(1), "s1"))
            .await
            .expect_err("timeout");
        assert!(matches!(err, AdapterError::Timeout), "got {err:?}");

        let events = collect_turn(&mut stream).await;
        assert_eq!(
            methods(&events),
            vec![TURN_STARTED_METHOD, TURN_ENDED_METHOD]
        );
        assert_eq!(
            events[1].1["params"],
            json!({"sessionId": "s1", "requestId": 1, "outcome": "timeout"})
        );

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn async_prompt_timeout_ends_turn_with_timeout_after_error_response() {
        let runtime = Arc::new(
            AdapterRuntime::start(
                sh("IFS= read -r _line; IFS= read -r _never"),
                Duration::from_millis(100),
            )
            .await
            .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        runtime
            .post_with_mode(session_prompt(json!(2), "s1"), PostMode::AsyncPrompt)
            .await
            .expect("accept");

        let events = collect_turn(&mut stream).await;
        assert_eq!(
            methods(&events),
            vec![TURN_STARTED_METHOD, "<error>", TURN_ENDED_METHOD]
        );
        assert_sequences_are_consecutive(&events);
        assert_eq!(events[1].1["error"]["code"], -32603);
        assert_eq!(
            events[1].1["error"]["data"]["_meta"][META_KEY],
            json!({"sessionId": "s1", "sequence": events[2].0})
        );
        assert_eq!(events[2].1["params"]["outcome"], "timeout");

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn agent_exit_ends_turn_before_agent_exited_notification() {
        let runtime = Arc::new(
            AdapterRuntime::start(sh("IFS= read -r _line; exit 3"), Duration::from_secs(5))
                .await
                .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        let err = runtime
            .post(session_prompt(json!(6), "s1"))
            .await
            .expect_err("agent exits");
        assert!(matches!(err, AdapterError::Exited { .. }), "got {err:?}");

        let events = collect_turn(&mut stream).await;
        assert_eq!(
            events.last().expect("turn_ended").1["params"],
            json!({"sessionId": "s1", "requestId": 6, "outcome": "agent_exited"})
        );
        let (_, next) = next_event(&mut stream).await;
        assert_eq!(method_of(&next), "_adapter/agent_exited");
    }

    #[tokio::test]
    async fn shutdown_ends_pending_turns_as_cancelled() {
        let runtime = Arc::new(
            AdapterRuntime::start(
                sh("IFS= read -r _a; IFS= read -r _b; sleep 10"),
                Duration::from_secs(30),
            )
            .await
            .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        runtime
            .post_with_mode(session_prompt(json!(10), "s1"), PostMode::AsyncPrompt)
            .await
            .expect("accept");
        let poster = {
            let runtime = runtime.clone();
            tokio::spawn(async move { runtime.post(session_prompt(json!(11), "s2")).await })
        };
        // Both turns must be registered before shutting down.
        let mut started = 0;
        while started < 2 {
            if method_of(&next_event(&mut stream).await.1) == TURN_STARTED_METHOD {
                started += 1;
            }
        }

        runtime.shutdown().await;
        assert!(poster.await.expect("join").is_err());

        let mut ended = HashMap::new();
        while ended.len() < 2 {
            let (_, event) = next_event(&mut stream).await;
            if method_of(&event) == TURN_ENDED_METHOD {
                ended.insert(
                    event["params"]["requestId"].to_string(),
                    event["params"].clone(),
                );
            }
        }
        assert_eq!(
            ended["10"],
            json!({"sessionId": "s1", "requestId": 10, "outcome": "cancelled"})
        );
        assert_eq!(
            ended["11"],
            json!({"sessionId": "s2", "requestId": 11, "outcome": "cancelled"})
        );
    }

    #[tokio::test]
    async fn concurrent_turns_on_one_runtime_are_tracked_per_session() {
        let script = format!(
            "IFS= read -r a; IFS= read -r b; {}{}IFS= read -r _never",
            emit(r#"{"jsonrpc":"2.0","id":2,"result":{"stopReason":"end_turn"}}"#),
            emit(r#"{"jsonrpc":"2.0","id":1,"result":{"stopReason":"max_tokens"}}"#)
        );
        let runtime = Arc::new(
            AdapterRuntime::start(sh(&script), Duration::from_secs(2))
                .await
                .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        runtime
            .post_with_mode(session_prompt(json!(1), "s1"), PostMode::AsyncPrompt)
            .await
            .expect("accept s1");
        runtime
            .post_with_mode(session_prompt(json!(2), "s2"), PostMode::AsyncPrompt)
            .await
            .expect("accept s2");

        let first = collect_turn(&mut stream).await;
        let second = collect_turn(&mut stream).await;
        assert_eq!(
            first.last().expect("first").1["params"],
            json!({"sessionId": "s2", "requestId": 2, "outcome": "completed", "stopReason": "end_turn"})
        );
        assert_eq!(
            second.last().expect("second").1["params"],
            json!({"sessionId": "s1", "requestId": 1, "outcome": "completed", "stopReason": "max_tokens"})
        );

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn permission_request_emits_awaiting_input_and_client_answer_resolves_it() {
        let script = format!(
            "IFS= read -r line; {}IFS= read -r answer; {}IFS= read -r _never",
            emit(&permission_request_line("perm-1", "s1")),
            emit(r#"{"jsonrpc":"2.0","id":9,"result":{"stopReason":"end_turn"}}"#)
        );
        let runtime = Arc::new(
            AdapterRuntime::start(sh(&script), Duration::from_secs(2))
                .await
                .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        runtime
            .post_with_mode(session_prompt(json!(9), "s1"), PostMode::AsyncPrompt)
            .await
            .expect("accept");

        let (_, started) = next_event(&mut stream).await;
        assert_eq!(method_of(&started), TURN_STARTED_METHOD);
        let (request_sequence, request) = next_event(&mut stream).await;
        assert_eq!(method_of(&request), "session/request_permission");
        let (awaiting_sequence, awaiting) = next_event(&mut stream).await;
        assert_eq!(awaiting_sequence, request_sequence + 1);
        assert_eq!(method_of(&awaiting), AWAITING_INPUT_METHOD);
        assert_eq!(
            awaiting["params"],
            json!({"sessionId": "s1", "requestId": "perm-1", "kind": "permission"})
        );

        runtime
            .post(json!({
                "jsonrpc": "2.0",
                "id": "perm-1",
                "result": {"outcome": {"outcome": "selected", "optionId": "allow"}}
            }))
            .await
            .expect("client answer");

        let events = collect_turn(&mut stream).await;
        assert_eq!(
            methods(&events),
            vec![INPUT_RESOLVED_METHOD, "<result>", TURN_ENDED_METHOD]
        );
        assert_eq!(
            events[0].1["params"],
            json!({"sessionId": "s1", "requestId": "perm-1"})
        );

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn unanswered_permission_is_resolved_when_turn_ends() {
        let script = format!(
            "IFS= read -r line; {}{}IFS= read -r _late; IFS= read -r _never",
            emit(&permission_request_line("perm-2", "s1")),
            emit(r#"{"jsonrpc":"2.0","id":3,"result":{"stopReason":"end_turn"}}"#)
        );
        let runtime = Arc::new(
            AdapterRuntime::start(sh(&script), Duration::from_secs(2))
                .await
                .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        runtime
            .post_with_mode(session_prompt(json!(3), "s1"), PostMode::AsyncPrompt)
            .await
            .expect("accept");

        let events = collect_turn(&mut stream).await;
        assert_eq!(
            methods(&events),
            vec![
                TURN_STARTED_METHOD,
                "session/request_permission",
                AWAITING_INPUT_METHOD,
                INPUT_RESOLVED_METHOD,
                "<result>",
                TURN_ENDED_METHOD
            ]
        );
        assert_eq!(events[3].1["params"]["requestId"], "perm-2");

        // A late answer is forwarded but does not resolve the input twice.
        runtime
            .post(json!({"jsonrpc": "2.0", "id": "perm-2", "result": {"outcome": {"outcome": "cancelled"}}}))
            .await
            .expect("late answer");
        let quiet = tokio::time::timeout(Duration::from_millis(200), stream.next()).await;
        assert!(quiet.is_err(), "unexpected event after turn end: {quiet:?}");

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn agent_exit_resolves_pending_permission_before_ending_turn() {
        let script = format!(
            "IFS= read -r line; {}sleep 0.2; exit 3",
            emit(&permission_request_line("perm-3", "s1"))
        );
        let runtime = Arc::new(
            AdapterRuntime::start(sh(&script), Duration::from_secs(5))
                .await
                .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        runtime
            .post_with_mode(session_prompt(json!(12), "s1"), PostMode::AsyncPrompt)
            .await
            .expect("accept");

        let events = collect_turn(&mut stream).await;
        assert_eq!(
            methods(&events),
            vec![
                TURN_STARTED_METHOD,
                "session/request_permission",
                AWAITING_INPUT_METHOD,
                INPUT_RESOLVED_METHOD,
                "<error>",
                TURN_ENDED_METHOD
            ]
        );
        assert_eq!(events[5].1["params"]["outcome"], "agent_exited");
        let (_, next) = next_event(&mut stream).await;
        assert_eq!(method_of(&next), "_adapter/agent_exited");
    }

    #[tokio::test]
    async fn turn_events_can_be_disabled() {
        let script = format!(
            "IFS= read -r line; {}{}{}IFS= read -r _never",
            emit(UPDATE_S1),
            emit(&permission_request_line("perm-4", "s1")),
            emit(r#"{"jsonrpc":"2.0","id":5,"result":{"stopReason":"end_turn"}}"#)
        );
        let runtime = Arc::new(
            AdapterRuntime::start_with_options(
                sh(&script),
                RuntimeOptions {
                    request_timeout: Duration::from_secs(2),
                    turn_events: false,
                },
            )
            .await
            .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        let PostOutcome::Response(response) = runtime
            .post(session_prompt(json!(5), "s1"))
            .await
            .expect("response")
        else {
            panic!("expected inline response");
        };
        assert_eq!(response["result"], json!({"stopReason": "end_turn"}));

        let mut seen = Vec::new();
        for _ in 0..3 {
            seen.push(next_event(&mut stream).await);
        }
        assert_eq!(
            methods(&seen),
            vec!["session/update", "session/request_permission", "<result>"]
        );
        let quiet = tokio::time::timeout(Duration::from_millis(200), stream.next()).await;
        assert!(quiet.is_err(), "unexpected event: {quiet:?}");

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn non_prompt_requests_do_not_start_turns() {
        let script = format!(
            "IFS= read -r line; {}IFS= read -r _never",
            emit(r#"{"jsonrpc":"2.0","id":1,"result":{"sessionId":"s1"}}"#)
        );
        let runtime = Arc::new(
            AdapterRuntime::start(sh(&script), Duration::from_secs(2))
                .await
                .expect("start adapter"),
        );
        let mut stream = open_stream(&runtime).await;

        let PostOutcome::Response(response) = runtime
            .post(json!({"jsonrpc": "2.0", "id": 1, "method": "session/new", "params": {}}))
            .await
            .expect("response")
        else {
            panic!("expected inline response");
        };
        assert!(response["result"].get("_meta").is_none());
        let (_, event) = next_event(&mut stream).await;
        assert_eq!(event["id"], 1, "only the response is published: {event:?}");

        runtime.shutdown().await;
    }

    #[tokio::test]
    async fn shutdown_wakes_pending_synchronous_request() {
        let runtime = Arc::new(
            AdapterRuntime::start(sh("IFS= read -r line; sleep 10"), Duration::from_secs(30))
                .await
                .expect("start adapter"),
        );

        let poster = {
            let runtime = runtime.clone();
            tokio::spawn(async move { runtime.post(prompt(3)).await })
        };
        tokio::time::sleep(Duration::from_millis(100)).await;

        tokio::time::timeout(Duration::from_secs(2), runtime.shutdown())
            .await
            .expect("shutdown completes");
        let result = tokio::time::timeout(Duration::from_secs(2), poster)
            .await
            .expect("pending post wakes after shutdown")
            .expect("join");
        assert!(result.is_err(), "pending post should fail: {result:?}");
    }
}
