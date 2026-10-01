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

#[derive(Debug)]
struct PendingRequest {
    sender: oneshot::Sender<Value>,
    /// The caller is not waiting on `sender`; terminal errors must be
    /// published on the stream instead.
    stream_response: bool,
}

type PendingMap = HashMap<String, PendingRequest>;
type ExitInfo = (Option<i32>, Option<String>);

#[derive(Debug, Clone)]
struct StreamMessage {
    sequence: u64,
    payload: Value,
}

#[derive(Debug)]
pub struct AdapterRuntime {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    pending: Arc<Mutex<PendingMap>>,
    sender: broadcast::Sender<StreamMessage>,
    ring: Arc<Mutex<VecDeque<StreamMessage>>>,
    sequence: Arc<AtomicU64>,
    request_timeout: Duration,
    shutting_down: AtomicBool,
    spawned_at: Instant,
    first_stdout: Arc<AtomicBool>,
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    exit_info: Arc<Mutex<Option<ExitInfo>>>,
}

impl AdapterRuntime {
    pub async fn start(
        launch: LaunchSpec,
        request_timeout: Duration,
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

        let (sender, _rx) = broadcast::channel(512);
        let runtime = Self {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            sender,
            ring: Arc::new(Mutex::new(VecDeque::with_capacity(RING_BUFFER_SIZE))),
            sequence: Arc::new(AtomicU64::new(0)),
            request_timeout,
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
                },
            );

            let write_start = Instant::now();
            if let Err(err) = self.send_to_subprocess(&payload).await {
                tracing::error!(
                    method = %method,
                    id = %key,
                    error = %err,
                    "post: failed to write to agent stdin"
                );
                self.pending.lock().await.remove(&key);
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

            let wait_start = Instant::now();
            match tokio::time::timeout(self.request_timeout, rx).await {
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
                    self.pending.lock().await.remove(&key);
                    if let Some((exit_code, stderr)) = self.try_process_exit_info().await {
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
        let sender = self.sender.clone();
        let ring = self.ring.clone();
        let sequence = self.sequence.clone();
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
                    let removed = pending.lock().await.remove(&key).is_some();
                    tracing::error!(
                        method = %method,
                        id = %key,
                        timeout_ms = request_timeout.as_millis() as u64,
                        "post: TIMEOUT waiting for asynchronous agent response"
                    );
                    if removed {
                        broadcast_payload(
                            &sender,
                            &ring,
                            &sequence,
                            json_rpc_error(id, AGENT_TIMEOUT_MESSAGE),
                        )
                        .await;
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
        let receiver = self.sender.subscribe();
        let ring = self.ring.lock().await;
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

        fail_pending_requests(&self.pending, &self.sender, &self.ring, &self.sequence).await;
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
        let sender = self.sender.clone();
        let ring = self.ring.clone();
        let sequence = self.sequence.clone();
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
                        let _ = request.sender.send(payload.clone());
                        // Also broadcast the response so SSE/notification subscribers
                        // see it in order after preceding notifications. This lets the
                        // SSE translation task detect turn completion after all
                        // session/update events have been processed.
                        broadcast_payload(&sender, &ring, &sequence, payload).await;
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

                broadcast_payload(&sender, &ring, &sequence, payload).await;
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
        let sender = self.sender.clone();
        let ring = self.ring.clone();
        let sequence = self.sequence.clone();
        let spawned_at = self.spawned_at;
        let pending = self.pending.clone();
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

            let pending_count = fail_pending_requests(&pending, &sender, &ring, &sequence).await;

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

                broadcast_payload(&sender, &ring, &sequence, payload).await;
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
/// on the stream. Returns the number of drained requests.
async fn fail_pending_requests(
    pending: &Mutex<PendingMap>,
    sender: &broadcast::Sender<StreamMessage>,
    ring: &Mutex<VecDeque<StreamMessage>>,
    sequence: &AtomicU64,
) -> usize {
    let drained = pending.lock().await.drain().collect::<Vec<_>>();
    let count = drained.len();
    for (key, request) in drained {
        if !request.stream_response {
            continue;
        }
        if let Ok(id) = serde_json::from_str::<Value>(&key) {
            broadcast_payload(
                sender,
                ring,
                sequence,
                json_rpc_error(id, AGENT_STOPPED_MESSAGE),
            )
            .await;
        }
    }
    count
}

async fn broadcast_payload(
    sender: &broadcast::Sender<StreamMessage>,
    ring: &Mutex<VecDeque<StreamMessage>>,
    sequence: &AtomicU64,
    payload: Value,
) {
    // Keep sequence allocation, replay insertion, and live publication ordered.
    // Otherwise concurrent timeout, exit, and stdout tasks can publish a newer
    // sequence before an older one and break Last-Event-ID replay.
    let mut guard = ring.lock().await;
    let sequence = sequence.fetch_add(1, Ordering::SeqCst) + 1;
    let message = StreamMessage { sequence, payload };
    guard.push_back(message.clone());
    while guard.len() > RING_BUFFER_SIZE {
        guard.pop_front();
    }
    let _ = sender.send(message);
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
        let mut stream = Box::pin(runtime.clone().payload_stream(Some(0)).await);

        let outcome = runtime
            .post_with_mode(prompt(7), PostMode::AsyncPrompt)
            .await
            .expect("accept request");
        assert!(matches!(outcome, PostOutcome::Accepted));

        let (_sequence, response) = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("stream response before timeout")
            .expect("response event");
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
        let mut stream = Box::pin(runtime.clone().value_stream(Some(0)).await);

        let outcome = runtime
            .post_with_mode(prompt(42), PostMode::AsyncPrompt)
            .await
            .expect("accept request");
        assert!(matches!(outcome, PostOutcome::Accepted));

        let response = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("stream response before timeout")
            .expect("response event");
        assert_eq!(response["id"], 42);
        assert_eq!(response["error"]["code"], -32603);
        assert_eq!(
            response["error"]["message"],
            "timed out waiting for agent response"
        );

        let mut saw_late_response = false;
        for _ in 0..2 {
            let Ok(Some(event)) =
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
        let mut stream = Box::pin(runtime.clone().value_stream(Some(0)).await);

        let outcome = runtime
            .post_with_mode(prompt(99), PostMode::AsyncPrompt)
            .await
            .expect("accept request");
        assert!(matches!(outcome, PostOutcome::Accepted));

        let response = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("stream response before timeout")
            .expect("response event");
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
        let mut stream = Box::pin(runtime.clone().value_stream(Some(0)).await);

        let outcome = runtime
            .post_with_mode(prompt(100), PostMode::AsyncPrompt)
            .await
            .expect("accept request");
        assert!(matches!(outcome, PostOutcome::Accepted));

        tokio::time::timeout(Duration::from_secs(1), runtime.shutdown())
            .await
            .expect("shutdown completes");
        let response = tokio::time::timeout(Duration::from_secs(1), stream.next())
            .await
            .expect("stream response before timeout")
            .expect("response event");
        assert_eq!(response["id"], 100);
        assert_eq!(
            response["error"]["message"],
            "agent process stopped before responding"
        );
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
