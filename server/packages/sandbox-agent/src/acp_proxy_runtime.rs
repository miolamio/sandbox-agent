use std::collections::HashMap;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use acp_http_adapter::process::{
    AdapterError, AdapterRuntime, PostMode, PostOutcome, RuntimeOptions,
};
use acp_http_adapter::registry::LaunchSpec;
use axum::response::sse::Event;
use futures::{Stream, StreamExt};
use sandbox_agent_agent_management::agents::{AgentId, AgentManager, InstallOptions};
use sandbox_agent_error::SandboxError;
use sandbox_agent_opencode_adapter::{AcpDispatch, AcpDispatchResult, AcpPayloadStream};
use serde_json::{Number, Value};
use tokio::sync::{Mutex, RwLock};

/// Env var for the ACP request timeout. `--acp-request-timeout-ms` overrides it.
pub const REQUEST_TIMEOUT_ENV: &str = "SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS";

/// How long one ACP request (including a whole `session/prompt` turn, sync or
/// async) may wait for the agent's response. 2 hours (raised from 120 s, SBA-22)
/// so long delegated turns are not cut off. Single source of truth for the
/// default: change it here only.
pub const DEFAULT_REQUEST_TIMEOUT: Duration = Duration::from_millis(7_200_000);

/// Resolves the ACP request timeout: the `--acp-request-timeout-ms` flag wins,
/// then `SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS`, then [`DEFAULT_REQUEST_TIMEOUT`].
/// An unparsable or zero env value falls back to the default.
pub fn resolve_request_timeout(flag_ms: Option<u64>, env: Option<&str>) -> Duration {
    if let Some(ms) = flag_ms.filter(|ms| *ms > 0) {
        return Duration::from_millis(ms);
    }
    match env {
        Some(raw) => match raw.trim().parse::<u64>() {
            Ok(ms) if ms > 0 => Duration::from_millis(ms),
            _ => {
                tracing::warn!(
                    env = REQUEST_TIMEOUT_ENV,
                    value = raw,
                    "invalid ACP request timeout; using default"
                );
                DEFAULT_REQUEST_TIMEOUT
            }
        },
        None => DEFAULT_REQUEST_TIMEOUT,
    }
}

#[derive(Debug, Clone)]
pub struct AcpProxyRuntime {
    inner: Arc<AcpProxyRuntimeInner>,
}

#[derive(Debug)]
struct AcpProxyRuntimeInner {
    agent_manager: Arc<AgentManager>,
    require_preinstall: bool,
    request_timeout: Duration,
    instances: RwLock<HashMap<String, Arc<ProxyInstance>>>,
    instance_locks: Mutex<HashMap<String, Arc<Mutex<()>>>>,
    install_locks: Mutex<HashMap<AgentId, Arc<Mutex<()>>>>,
}

#[derive(Debug)]
struct ProxyInstance {
    server_id: String,
    agent: AgentId,
    runtime: Arc<AdapterRuntime>,
    created_at_ms: i64,
}

#[derive(Debug)]
pub enum ProxyPostOutcome {
    Response(Value),
    Accepted,
}

#[derive(Debug, Clone)]
pub struct AcpServerInstanceInfo {
    pub server_id: String,
    pub agent: AgentId,
    pub created_at_ms: i64,
}

pub type PinBoxSseStream =
    std::pin::Pin<Box<dyn Stream<Item = Result<Event, std::convert::Infallible>> + Send>>;
type PinBoxPayloadStream = std::pin::Pin<Box<dyn Stream<Item = (u64, Value)> + Send>>;

impl ProxyInstance {
    /// Stream payloads with the same error diagnostics that POST responses get,
    /// so errors delivered only over SSE (async prompts) keep their context.
    async fn annotated_payload_stream(&self, last_event_id: Option<u64>) -> PinBoxPayloadStream {
        let stream = self.runtime.clone().payload_stream(last_event_id).await;
        let agent = self.agent;
        // Hold only a weak reference: a strong one would keep the runtime (and
        // its broadcast sender) alive, so the stream would never close after
        // DELETE/shutdown and the runtime would leak.
        let runtime = Arc::downgrade(&self.runtime);
        Box::pin(stream.then(move |(sequence, value)| {
            let runtime = runtime.upgrade();
            async move {
                let value = annotate_agent_error(agent, value);
                let value = match runtime {
                    Some(runtime) => annotate_agent_stderr(value, &runtime).await,
                    None => value,
                };
                (sequence, value)
            }
        }))
    }
}

impl AcpProxyRuntime {
    /// `request_timeout` bounds each ACP request; see [`resolve_request_timeout`].
    pub fn new(agent_manager: Arc<AgentManager>, request_timeout: Duration) -> Self {
        let require_preinstall = std::env::var("SANDBOX_AGENT_REQUIRE_PREINSTALL")
            .ok()
            .is_some_and(|value| {
                let trimmed = value.trim();
                trimmed == "1"
                    || trimmed.eq_ignore_ascii_case("true")
                    || trimmed.eq_ignore_ascii_case("yes")
            });

        Self {
            inner: Arc::new(AcpProxyRuntimeInner {
                agent_manager,
                require_preinstall,
                request_timeout,
                instances: RwLock::new(HashMap::new()),
                instance_locks: Mutex::new(HashMap::new()),
                install_locks: Mutex::new(HashMap::new()),
            }),
        }
    }

    pub async fn list_instances(&self) -> Vec<AcpServerInstanceInfo> {
        let mut infos = self
            .inner
            .instances
            .read()
            .await
            .values()
            // An agent server whose agent process exited is gone even if its
            // exit reaper has not removed it yet.
            .filter(|instance| !instance.runtime.has_exited())
            .map(|instance| AcpServerInstanceInfo {
                server_id: instance.server_id.clone(),
                agent: instance.agent,
                created_at_ms: instance.created_at_ms,
            })
            .collect::<Vec<_>>();
        infos.sort_by(|left, right| left.server_id.cmp(&right.server_id));
        infos
    }

    /// Forwards a `/v1/acp` request. A server created by this call publishes
    /// turn lifecycle events (`_sandboxagent/session/*`).
    pub async fn post(
        &self,
        server_id: &str,
        bootstrap_agent: Option<AgentId>,
        payload: Value,
        mode: PostMode,
    ) -> Result<ProxyPostOutcome, SandboxError> {
        self.post_with_origin(server_id, bootstrap_agent, payload, mode, true)
            .await
    }

    /// `turn_events` only applies when this call creates the server: the
    /// OpenCode-compat layer (`/opencode/*`) creates its servers without turn
    /// events, `/v1/acp` with them.
    async fn post_with_origin(
        &self,
        server_id: &str,
        bootstrap_agent: Option<AgentId>,
        payload: Value,
        mode: PostMode,
        turn_events: bool,
    ) -> Result<ProxyPostOutcome, SandboxError> {
        let method: String = payload
            .get("method")
            .and_then(|v| v.as_str())
            .unwrap_or("<none>")
            .to_string();
        let id: String = payload.get("id").map(|v| v.to_string()).unwrap_or_default();

        tracing::info!(
            server_id = server_id,
            method = method,
            id = %id,
            bootstrap_agent = ?bootstrap_agent,
            "acp_proxy: POST received"
        );

        let start = std::time::Instant::now();
        let instance = self
            .get_or_create_instance(server_id, bootstrap_agent, turn_events)
            .await?;
        let instance_elapsed = start.elapsed();

        tracing::debug!(
            server_id = server_id,
            agent = instance.agent.as_str(),
            instance_ms = instance_elapsed.as_millis() as u64,
            "acp_proxy: instance resolved"
        );

        let payload = normalize_payload_for_agent(instance.agent, payload);

        match instance.runtime.post_with_mode(payload, mode).await {
            Ok(PostOutcome::Response(value)) => {
                let total_ms = start.elapsed().as_millis() as u64;
                tracing::info!(
                    server_id = server_id,
                    method = method,
                    id = %id,
                    total_ms = total_ms,
                    "acp_proxy: POST → response"
                );
                let value = annotate_agent_error(instance.agent, value);
                let value = annotate_agent_stderr(value, &instance.runtime).await;
                Ok(ProxyPostOutcome::Response(value))
            }
            Ok(PostOutcome::Accepted) => {
                tracing::info!(
                    server_id = server_id,
                    method = method,
                    "acp_proxy: POST → accepted"
                );
                Ok(ProxyPostOutcome::Accepted)
            }
            Err(err) => {
                let total_ms = start.elapsed().as_millis() as u64;
                tracing::error!(
                    server_id = server_id,
                    method = method,
                    id = %id,
                    total_ms = total_ms,
                    error = %err,
                    "acp_proxy: POST → error"
                );
                Err(map_adapter_error(err, Some(instance.agent)))
            }
        }
    }

    pub async fn sse(
        &self,
        server_id: &str,
        last_event_id: Option<u64>,
    ) -> Result<PinBoxSseStream, SandboxError> {
        let instance = self.get_instance(server_id).await?;
        let stream =
            instance
                .annotated_payload_stream(last_event_id)
                .await
                .map(|(sequence, payload)| {
                    Ok(Event::default()
                        .event("message")
                        .id(sequence.to_string())
                        .data(payload.to_string()))
                });
        Ok(Box::pin(stream))
    }

    pub async fn delete(&self, server_id: &str) -> Result<(), SandboxError> {
        let removed = self.inner.instances.write().await.remove(server_id);
        if let Some(instance) = removed {
            instance.runtime.shutdown().await;
        }
        Ok(())
    }

    pub async fn shutdown_all(&self) {
        let instances = {
            let mut guard = self.inner.instances.write().await;
            guard
                .drain()
                .map(|(_, instance)| instance)
                .collect::<Vec<_>>()
        };

        for instance in instances {
            instance.runtime.shutdown().await;
        }
    }

    async fn get_instance(&self, server_id: &str) -> Result<Arc<ProxyInstance>, SandboxError> {
        self.live_instance(server_id)
            .await
            .ok_or_else(|| SandboxError::SessionNotFound {
                session_id: server_id.to_string(),
            })
    }

    /// The instance for `server_id` if its agent process is still running. An
    /// instance whose agent process exited is removed and reported as missing,
    /// so it is never reused: requests for it are rejected before reaching any
    /// agent, and the id can be bootstrapped again.
    async fn live_instance(&self, server_id: &str) -> Option<Arc<ProxyInstance>> {
        let existing = self.inner.instances.read().await.get(server_id).cloned()?;
        if !existing.runtime.has_exited() {
            return Some(existing);
        }
        remove_exited_instance(&self.inner, &existing).await;
        None
    }

    /// Removes `instance` as soon as its agent process exits, so a crashed agent
    /// server does not stay listed until someone touches it.
    fn spawn_exit_reaper(&self, instance: &Arc<ProxyInstance>) {
        // Weak references only: the reaper must not keep the proxy runtime or
        // the instance alive.
        let inner = Arc::downgrade(&self.inner);
        let weak_instance = Arc::downgrade(instance);
        let mut exit_watch = instance.runtime.exit_watch();
        tokio::spawn(async move {
            if exit_watch.wait_for(|exited| *exited).await.is_err() {
                return;
            }
            let (Some(inner), Some(instance)) = (inner.upgrade(), weak_instance.upgrade()) else {
                return;
            };
            remove_exited_instance(&inner, &instance).await;
        });
    }

    async fn get_or_create_instance(
        &self,
        server_id: &str,
        bootstrap_agent: Option<AgentId>,
        turn_events: bool,
    ) -> Result<Arc<ProxyInstance>, SandboxError> {
        if let Some(existing) = self.live_instance(server_id).await {
            if let Some(agent) = bootstrap_agent {
                if agent != existing.agent {
                    return Err(SandboxError::Conflict {
                        message: format!(
                            "server '{server_id}' already exists for agent '{}'; requested '{agent}'",
                            existing.agent.as_str()
                        ),
                    });
                }
            }
            return Ok(existing);
        }

        let lock = {
            let mut locks = self.inner.instance_locks.lock().await;
            locks
                .entry(server_id.to_string())
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;

        if let Some(existing) = self.live_instance(server_id).await {
            if let Some(agent) = bootstrap_agent {
                if agent != existing.agent {
                    return Err(SandboxError::Conflict {
                        message: format!(
                            "server '{server_id}' already exists for agent '{}'; requested '{agent}'",
                            existing.agent.as_str()
                        ),
                    });
                }
            }
            return Ok(existing);
        }

        let agent = bootstrap_agent.ok_or_else(|| SandboxError::InvalidRequest {
            message: format!(
                "missing required 'agent' query parameter for first POST to /v1/acp/{server_id}"
            ),
        })?;

        let created = self.create_instance(server_id, agent, turn_events).await?;
        self.inner
            .instances
            .write()
            .await
            .insert(server_id.to_string(), created.clone());
        self.spawn_exit_reaper(&created);

        Ok(created)
    }

    async fn create_instance(
        &self,
        server_id: &str,
        agent: AgentId,
        turn_events: bool,
    ) -> Result<Arc<ProxyInstance>, SandboxError> {
        let total_started = std::time::Instant::now();
        tracing::info!(
            server_id = server_id,
            agent = agent.as_str(),
            "create_instance: starting"
        );

        let install_started = std::time::Instant::now();
        self.ensure_installed(agent).await?;
        tracing::info!(
            server_id = server_id,
            agent = agent.as_str(),
            install_ms = install_started.elapsed().as_millis() as u64,
            "create_instance: agent installed/verified"
        );

        let resolve_started = std::time::Instant::now();
        let manager = self.inner.agent_manager.clone();
        let mut launch = tokio::task::spawn_blocking(move || manager.resolve_agent_process(agent))
            .await
            .map_err(|err| SandboxError::StreamError {
                message: format!("failed to resolve agent process launch spec: {err}"),
            })?
            .map_err(|err| SandboxError::StreamError {
                message: err.to_string(),
            })?;

        if agent == AgentId::Mock {
            if let Ok(exe) = std::env::current_exe() {
                let path = exe.to_string_lossy().to_string();
                launch
                    .env
                    .entry("SANDBOX_AGENT_BIN".to_string())
                    .or_insert(path);
            }
        }

        tracing::info!(
            server_id = server_id,
            agent = agent.as_str(),
            program = ?launch.program,
            args = ?launch.args,
            resolve_ms = resolve_started.elapsed().as_millis() as u64,
            "create_instance: launch spec resolved, spawning"
        );

        let spawn_started = std::time::Instant::now();
        let runtime = AdapterRuntime::start_with_options(
            LaunchSpec {
                program: launch.program,
                args: launch.args,
                env: launch.env,
            },
            RuntimeOptions {
                request_timeout: self.inner.request_timeout,
                turn_events,
            },
        )
        .await
        .map_err(|err| map_adapter_error(err, Some(agent)))?;

        let total_ms = total_started.elapsed().as_millis() as u64;
        tracing::info!(
            server_id = server_id,
            agent = agent.as_str(),
            spawn_ms = spawn_started.elapsed().as_millis() as u64,
            total_ms = total_ms,
            "create_instance: ready"
        );

        Ok(Arc::new(ProxyInstance {
            server_id: server_id.to_string(),
            agent,
            runtime: Arc::new(runtime),
            created_at_ms: now_ms(),
        }))
    }

    async fn ensure_installed(&self, agent: AgentId) -> Result<(), SandboxError> {
        let started = std::time::Instant::now();
        if self.inner.require_preinstall {
            if !self.is_ready(agent).await {
                return Err(SandboxError::AgentNotInstalled {
                    agent: agent.as_str().to_string(),
                });
            }
            tracing::info!(
                agent = agent.as_str(),
                total_ms = started.elapsed().as_millis() as u64,
                "ensure_installed: preinstall requirement satisfied"
            );
            return Ok(());
        }

        if self.is_ready(agent).await {
            tracing::info!(
                agent = agent.as_str(),
                total_ms = started.elapsed().as_millis() as u64,
                "ensure_installed: already ready"
            );
            return Ok(());
        }

        let lock = {
            let mut locks = self.inner.install_locks.lock().await;
            locks
                .entry(agent)
                .or_insert_with(|| Arc::new(Mutex::new(())))
                .clone()
        };
        let _guard = lock.lock().await;

        if self.is_ready(agent).await {
            tracing::info!(
                agent = agent.as_str(),
                total_ms = started.elapsed().as_millis() as u64,
                "ensure_installed: became ready while waiting for lock"
            );
            return Ok(());
        }

        tracing::info!(
            agent = agent.as_str(),
            "ensure_installed: installing missing artifacts"
        );
        let install_started = std::time::Instant::now();
        let manager = self.inner.agent_manager.clone();
        tokio::task::spawn_blocking(move || manager.install(agent, InstallOptions::default()))
            .await
            .map_err(|err| SandboxError::InstallFailed {
                agent: agent.as_str().to_string(),
                stderr: Some(format!("installer task failed: {err}")),
            })?
            .map_err(|err| SandboxError::InstallFailed {
                agent: agent.as_str().to_string(),
                stderr: Some(err.to_string()),
            })?;

        tracing::info!(
            agent = agent.as_str(),
            install_ms = install_started.elapsed().as_millis() as u64,
            total_ms = started.elapsed().as_millis() as u64,
            "ensure_installed: install complete"
        );
        Ok(())
    }

    async fn is_ready(&self, agent: AgentId) -> bool {
        if agent == AgentId::Mock {
            return true;
        }
        self.inner.agent_manager.is_installed(agent)
    }
}

impl AcpDispatch for AcpProxyRuntime {
    fn post(
        &self,
        server_id: &str,
        bootstrap_agent: Option<&str>,
        payload: Value,
    ) -> Pin<Box<dyn Future<Output = Result<AcpDispatchResult, String>> + Send + '_>> {
        let server_id = server_id.to_string();
        let agent = bootstrap_agent.and_then(AgentId::parse);
        Box::pin(async move {
            // The OpenCode-compat layer waits on the dispatch result, so it always
            // uses the synchronous request/response contract.
            // It also tracks turns itself, so its servers do not publish turn
            // lifecycle events.
            match self
                .post_with_origin(&server_id, agent, payload, PostMode::Sync, false)
                .await
            {
                Ok(ProxyPostOutcome::Response(value)) => Ok(AcpDispatchResult::Response(value)),
                Ok(ProxyPostOutcome::Accepted) => Ok(AcpDispatchResult::Accepted),
                Err(err) => Err(err.to_string()),
            }
        })
    }

    fn notification_stream(
        &self,
        server_id: &str,
        last_event_id: Option<u64>,
    ) -> Pin<Box<dyn Future<Output = Result<AcpPayloadStream, String>> + Send + '_>> {
        let server_id = server_id.to_string();
        Box::pin(async move {
            let instance = self
                .get_instance(&server_id)
                .await
                .map_err(|e| e.to_string())?;
            let stream = instance
                .annotated_payload_stream(last_event_id)
                .await
                .map(|(_sequence, payload)| payload);
            Ok(Box::pin(stream) as AcpPayloadStream)
        })
    }

    fn delete(
        &self,
        server_id: &str,
    ) -> Pin<Box<dyn Future<Output = Result<(), String>> + Send + '_>> {
        let server_id = server_id.to_string();
        Box::pin(async move { self.delete(&server_id).await.map_err(|err| err.to_string()) })
    }
}

/// Removes `instance` from the server map if it is still the entry for its id
/// (a newer instance under the same id is left alone). The runtime is not shut
/// down: its process already exited, and the exit watcher still publishes the
/// final events to open event streams, which end once it is done.
async fn remove_exited_instance(inner: &AcpProxyRuntimeInner, instance: &Arc<ProxyInstance>) {
    let removed = {
        let mut instances = inner.instances.write().await;
        let is_current = instances
            .get(&instance.server_id)
            .is_some_and(|current| Arc::ptr_eq(current, instance));
        if is_current {
            instances.remove(&instance.server_id)
        } else {
            None
        }
    };
    if removed.is_some() {
        tracing::warn!(
            server_id = instance.server_id.as_str(),
            agent = instance.agent.as_str(),
            "acp_proxy: agent process exited; server removed"
        );
    }
}

fn map_adapter_error(err: AdapterError, agent: Option<AgentId>) -> SandboxError {
    match err {
        AdapterError::InvalidEnvelope => SandboxError::InvalidRequest {
            message: "request body must be a JSON-RPC object".to_string(),
        },
        AdapterError::Timeout => SandboxError::Timeout {
            message: Some("timed out waiting for agent response".to_string()),
        },
        AdapterError::Serialize(error) => SandboxError::InvalidRequest {
            message: format!("failed to serialize JSON payload: {error}"),
        },
        AdapterError::Write(error) => SandboxError::StreamError {
            message: format!("failed writing to agent stdin: {error}"),
        },
        AdapterError::Exited { exit_code, stderr } => {
            if let Some(agent) = agent {
                SandboxError::AgentProcessExited {
                    agent: agent.as_str().to_string(),
                    exit_code,
                    stderr,
                }
            } else {
                SandboxError::StreamError {
                    message: if let Some(stderr) = stderr {
                        format!(
                            "agent process exited before responding (exit_code: {:?}, stderr: {})",
                            exit_code, stderr
                        )
                    } else {
                        format!(
                            "agent process exited before responding (exit_code: {:?})",
                            exit_code
                        )
                    },
                }
            }
        }
        AdapterError::Spawn(error) => SandboxError::StreamError {
            message: format!("failed to start agent process: {error}"),
        },
        AdapterError::MissingStdin | AdapterError::MissingStdout | AdapterError::MissingStderr => {
            SandboxError::StreamError {
                message: "agent subprocess pipes were not available".to_string(),
            }
        }
    }
}

fn normalize_payload_for_agent(agent: AgentId, payload: Value) -> Value {
    if agent != AgentId::Pi {
        return payload;
    }

    // Pi's ACP adapter is stricter than other adapters for a couple of bootstrap
    // fields. Normalize here so older/raw ACP clients still work against Pi.
    normalize_pi_payload(payload)
}

fn normalize_pi_payload(mut payload: Value) -> Value {
    let method = payload
        .get("method")
        .and_then(Value::as_str)
        .unwrap_or_default();

    match method {
        "initialize" => {
            // Some clients send ACP protocolVersion as a string ("1.0"), but
            // pi-acp expects a numeric JSON value and rejects strings.
            if let Some(protocol) = payload.pointer_mut("/params/protocolVersion") {
                if let Some(raw) = protocol.as_str() {
                    if let Some(number) = parse_json_number(raw) {
                        *protocol = Value::Number(number);
                    }
                }
            }
        }
        "session/new" => {
            // The TypeScript SDK and opencode adapter already send mcpServers: [],
            // but raw /v1/acp callers may omit it. pi-acp currently validates
            // mcpServers as required, so default it here for compatibility.
            if let Some(params) = payload.get_mut("params").and_then(Value::as_object_mut) {
                params
                    .entry("mcpServers".to_string())
                    .or_insert_with(|| Value::Array(Vec::new()));
            }
        }
        _ => {}
    }

    payload
}

fn parse_json_number(raw: &str) -> Option<Number> {
    let trimmed = raw.trim();

    if let Ok(unsigned) = trimmed.parse::<u64>() {
        return Some(Number::from(unsigned));
    }

    if let Ok(signed) = trimmed.parse::<i64>() {
        return Some(Number::from(signed));
    }

    trimmed.parse::<f64>().ok().and_then(Number::from_f64)
}

/// Inspect JSON-RPC error responses from agent processes and add helpful hints
/// when we can infer the root cause from a known error pattern.
async fn annotate_agent_stderr(mut value: Value, runtime: &AdapterRuntime) -> Value {
    if value.get("error").is_none() {
        return value;
    }
    if let Some(stderr) = runtime.stderr_tail_summary().await {
        if let Some(error) = value.get_mut("error") {
            if let Some(error_obj) = error.as_object_mut() {
                let data = error_obj
                    .entry("data")
                    .or_insert_with(|| Value::Object(Default::default()));
                if let Some(obj) = data.as_object_mut() {
                    obj.insert("agentStderr".to_string(), Value::String(stderr));
                }
            }
        }
    }
    value
}

fn annotate_agent_error(agent: AgentId, mut value: Value) -> Value {
    if agent != AgentId::Pi {
        return value;
    }

    let matches = value
        .pointer("/error/data/details")
        .and_then(|v| v.as_str())
        .is_some_and(|s| s.contains("Cannot call write after a stream was destroyed"));

    if matches {
        if let Some(data) = value.pointer_mut("/error/data") {
            if let Some(obj) = data.as_object_mut() {
                obj.insert(
                    "hint".to_string(),
                    Value::String(
                        "The pi CLI exited immediately — this usually means no API key is \
                         configured. Set ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY, \
                         or another supported provider key."
                            .to_string(),
                    ),
                );
            }
        }
    }

    value
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_timeout_defaults_without_flag_or_env() {
        assert_eq!(resolve_request_timeout(None, None), DEFAULT_REQUEST_TIMEOUT);
        assert_eq!(DEFAULT_REQUEST_TIMEOUT, Duration::from_secs(2 * 60 * 60));
    }

    #[test]
    fn request_timeout_reads_env() {
        assert_eq!(
            resolve_request_timeout(None, Some(" 7500 ")),
            Duration::from_millis(7500)
        );
    }

    #[test]
    fn request_timeout_invalid_or_zero_env_falls_back_to_default() {
        for raw in ["", "0", "abc", "-5", "1.5"] {
            assert_eq!(
                resolve_request_timeout(None, Some(raw)),
                DEFAULT_REQUEST_TIMEOUT,
                "env {raw:?}"
            );
        }
    }

    #[test]
    fn request_timeout_resolution_prefers_flag_over_env() {
        assert_eq!(
            resolve_request_timeout(Some(1500), Some("60000")),
            Duration::from_millis(1500)
        );
        assert_eq!(
            resolve_request_timeout(Some(1500), Some("garbage")),
            Duration::from_millis(1500)
        );
        assert_eq!(
            resolve_request_timeout(Some(1500), None),
            Duration::from_millis(1500)
        );
    }
}
