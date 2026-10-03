# acp-http-adapter

Minimal ACP HTTP to stdio proxy.

## Endpoints

- `GET /v1/health`
- `POST /v1/rpc`
- `GET /v1/rpc` (SSE)
- `DELETE /v1/rpc`

## Stdio framing

Uses ACP stdio framing from ACP docs:
- UTF-8 JSON-RPC messages
- one message per line
- newline-delimited (`\n`)
- no embedded newlines in messages

## Run

```bash
cargo run -p acp-http-adapter -- \
  --host 127.0.0.1 \
  --port 7591 \
  --registry-json '{"distribution":{"npx":{"package":"@zed-industries/codex-acp"}}}'
```

`--registry-json` accepts:
- full registry document (`{"agents":[...]}`) with `--registry-agent-id`
- single registry entry (`{"id":"...","distribution":...}`)
- direct distribution object (`{"npx":...}` or `{"binary":...}`)

## Shutdown

The agent runs in its own process group. On `SIGTERM` or `SIGINT` the adapter
sends `SIGTERM` to that group (the agent and everything it started), then
`SIGKILL` to whatever is left after up to 1 second, and drains open
connections. Open SSE streams never end on their own, so the whole shutdown is
bounded by `--shutdown-timeout-ms` (default 5000, counted from the first
signal); when it runs out the adapter exits with code 0. A second signal exits
immediately with code 1.

## Library

```rust
use std::time::Duration;
use acp_http_adapter::{run_server, ServerConfig, DEFAULT_SHUTDOWN_TIMEOUT};

run_server(ServerConfig {
    host: "127.0.0.1".to_string(),
    port: 7591,
    registry_json: r#"{"distribution":{"npx":{"package":"@zed-industries/codex-acp"}}}"#.to_string(),
    registry_agent_id: None,
    rpc_timeout: Duration::from_secs(120),
    shutdown_timeout: DEFAULT_SHUTDOWN_TIMEOUT,
}).await?;
```
