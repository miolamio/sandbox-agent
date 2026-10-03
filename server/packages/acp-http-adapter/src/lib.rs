use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;

use app::build_router;
use process::AdapterRuntime;
use registry::LaunchSpec;

pub mod app;
pub mod process;
pub mod process_group;
pub mod registry;

/// Default total time from the first SIGTERM/SIGINT to exit.
pub const DEFAULT_SHUTDOWN_TIMEOUT: Duration = Duration::from_millis(5000);

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub registry_json: String,
    pub registry_agent_id: Option<String>,
    pub rpc_timeout: Duration,
    /// Total time from the first shutdown signal to exit, covering stopping
    /// the agent and draining connections (open SSE streams never end on
    /// their own).
    pub shutdown_timeout: Duration,
}

pub async fn run_server(
    config: ServerConfig,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let launch =
        LaunchSpec::from_registry_blob(&config.registry_json, config.registry_agent_id.as_deref())?;
    let runtime = Arc::new(AdapterRuntime::start(launch, config.rpc_timeout).await?);
    run_server_with_runtime(config.host, config.port, runtime, config.shutdown_timeout).await
}

/// Serves `runtime` until SIGTERM/SIGINT. Shutdown stops the agent, then
/// drains connections; when `shutdown_timeout` (counted from the first
/// signal) runs out, the process exits with code 0. A second signal exits
/// immediately with code 1.
pub async fn run_server_with_runtime(
    host: String,
    port: u16,
    runtime: Arc<AdapterRuntime>,
    shutdown_timeout: Duration,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let app = build_router(runtime.clone());
    let addr: SocketAddr = format!("{host}:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    let signals = TerminationSignals::new()?;
    tracing::info!(addr = %addr, "acp-http-adapter listening");

    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(runtime, signals, shutdown_timeout))
        .await?;
    Ok(())
}

async fn shutdown_signal(
    runtime: Arc<AdapterRuntime>,
    mut signals: TerminationSignals,
    budget: Duration,
) {
    signals.recv().await;
    let deadline = tokio::time::Instant::now() + budget;
    tracing::info!(
        budget_ms = budget.as_millis() as u64,
        "shutdown signal received; stopping agent process"
    );

    tokio::spawn(async move {
        signals.recv().await;
        tracing::warn!("second shutdown signal received; exiting immediately");
        std::process::exit(1);
    });

    let grace = process_group::DEFAULT_GRACE.min(budget / 2);
    if tokio::time::timeout_at(deadline, runtime.shutdown_with_grace(grace))
        .await
        .is_err()
    {
        tracing::warn!("stopping the agent used up the shutdown budget");
    }

    // Open SSE streams hold the event sender and never end on their own, so
    // the drain is bounded by the rest of the budget.
    tracing::info!("draining open connections");
    tokio::spawn(async move {
        tokio::time::sleep_until(deadline).await;
        tracing::warn!(
            budget_ms = budget.as_millis() as u64,
            "shutdown budget exhausted while draining connections; exiting"
        );
        std::process::exit(0);
    });
}

/// SIGINT and SIGTERM (`docker stop`, `kill`), registered once up front so a
/// signal is never lost between waits. Ctrl+C only on non-unix.
struct TerminationSignals {
    #[cfg(unix)]
    sigint: tokio::signal::unix::Signal,
    #[cfg(unix)]
    sigterm: tokio::signal::unix::Signal,
}

impl TerminationSignals {
    #[cfg(unix)]
    fn new() -> std::io::Result<Self> {
        use tokio::signal::unix::{signal, SignalKind};
        Ok(Self {
            sigint: signal(SignalKind::interrupt())?,
            sigterm: signal(SignalKind::terminate())?,
        })
    }

    #[cfg(not(unix))]
    fn new() -> std::io::Result<Self> {
        Ok(Self {})
    }

    #[cfg(unix)]
    async fn recv(&mut self) {
        tokio::select! {
            _ = self.sigint.recv() => {}
            _ = self.sigterm.recv() => {}
        }
    }

    #[cfg(not(unix))]
    async fn recv(&mut self) {
        let _ = tokio::signal::ctrl_c().await;
    }
}
