# Architecture

How the daemon, schemas, and agents fit together.

Sandbox Agent SDK is built around a single daemon that runs inside the sandbox and exposes a universal HTTP API. Clients use the API (or the TypeScript SDK / CLI) to create sessions, send messages, and stream events.

## Components

- **Daemon**: Rust HTTP server that manages agent processes and streaming.
- **Universal schema**: Shared input/output types for messages and events.
- **SDKs & CLI**: Convenience wrappers around the HTTP API.

## Agent Schema Pipeline

The schema pipeline extracts type definitions from AI coding agents and converts them to a universal format.

### Schema Extraction

TypeScript extractors in `resources/agent-schemas/src/` pull schemas from each agent:

| Agent | Source | Extractor |
|-------|--------|-----------|
| Claude | `claude --output-format json --json-schema` | `claude.ts` |
| Codex | `codex app-server generate-json-schema` | `codex.ts` |
| OpenCode | GitHub OpenAPI spec | `opencode.ts` |
| Amp | Scrapes ampcode.com docs | `amp.ts` |

All extractors include fallback schemas for when CLIs or URLs are unavailable.

**Output:** JSON schemas written to `resources/agent-schemas/artifacts/json-schema/`

### Rust Type Generation

The `server/packages/extracted-agent-schemas/` package generates Rust types at build time:

- `build.rs` reads JSON schemas and uses the `typify` crate to generate Rust structs
- Generated code is written to `$OUT_DIR/{agent}.rs`
- Types are exposed via `include!()` macros in `src/lib.rs`

```
resources/agent-schemas/artifacts/json-schema/*.json
        ↓ (build.rs + typify)
$OUT_DIR/{claude,codex,opencode,amp}.rs
        ↓ (include!)
extracted_agent_schemas::{claude,codex,opencode,amp}::*
```

### Universal Schema

The `server/packages/universal-agent-schema/` package defines agent-agnostic types:

**Core types** (`src/lib.rs`):
- `UniversalEvent` - Wrapper with id, timestamp, session_id, agent, data
- `UniversalEventData` - Enum: Message, Started, Error, QuestionAsked, PermissionAsked, Unknown
- `UniversalMessage` - Parsed (role, parts, metadata) or Unparsed (raw JSON)
- `UniversalMessagePart` - Text, ToolCall, ToolResult, FunctionCall, FunctionResult, File, Image, Error, Unknown

**Converters** (`src/agents/{claude,codex,opencode,amp}.rs`):
- Each agent has a converter module that transforms native events to universal format
- Conversions are best-effort; unparseable data preserved in `Unparsed` or `Unknown` variants

## Session Management

Sessions track agent conversations with in-memory state.

### Session Model

- **Session ID**: Client-provided primary session identifier.
- **Agent session ID**: Underlying ID from the agent (thread/session). This is surfaced in events but is not the primary key.

### Storage

Sessions are stored in an in-memory `HashMap<String, SessionState>` inside `SessionManager`:

```rust
struct SessionManager {
    sessions: Mutex<HashMap<String, SessionState>>,
    // ...
}
```

There is no disk persistence. Sessions are ephemeral and lost on server restart.

### SessionState

Each session tracks:

| Field | Purpose |
|-------|---------|
| `session_id` | Client-provided identifier |
| `agent` | Agent type (Claude, Codex, OpenCode, Amp) |
| `agent_mode` | Operating mode (build, plan, custom) |
| `permission_mode` | Permission handling (default, plan, bypass) |
| `model` | Optional model override |
| `events: Vec<UniversalEvent>` | Full event history |
| `pending_questions` | Question IDs awaiting reply |
| `pending_permissions` | Permission IDs awaiting reply |
| `broadcaster` | Tokio broadcast channel for SSE streaming |
| `ended` | Whether agent process has terminated |

### Lifecycle

```
POST /v1/acp/{serverId}?agent=... initialize ACP server, auto-install agent
        ↓
POST /v1/acp/{serverId}           session/new
POST /v1/acp/{serverId}           session/prompt
        ↓
GET /v1/acp/{serverId}            Subscribe to ACP SSE stream
        ↓
JSON-RPC response envelopes       Answer questions / reply to permissions
        ↓
DELETE /v1/acp/{serverId}         Close ACP server
```

### Event Streaming

- ACP envelopes are stored in memory per server and assigned a monotonically increasing SSE `id`.
- `GET /v1/acp/{serverId}` replays buffered envelopes and then streams live updates.
- Clients continue turns by POSTing ACP JSON-RPC requests to the same server id.
- Async prompt (opt-in): a `session/prompt` POST with header `x-sandboxagent-async-prompt: 1` returns `202 Accepted` once the request reaches the agent. Its JSON-RPC result, request-timeout error, or "agent process stopped" error (process exit or `DELETE`) arrives on the SSE stream with the same `id`. Without the header the POST returns `200` with the response body. Clients should only opt in while an SSE stream is open (or reconnect with `Last-Event-ID`). `/opencode/*` always uses the synchronous mode.
- Request timeout: each ACP request (sync or async prompt) is bounded by `--acp-request-timeout-ms` / `SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS` (flag wins; default 2 h, `DEFAULT_REQUEST_TIMEOUT` in `acp_proxy_runtime.rs`). Sync requests get `504`; async prompts get a JSON-RPC timeout error on SSE with the same `id`.

### Turn lifecycle events (SBA-9)

`AdapterRuntime` (`server/packages/acp-http-adapter/src/process.rs`) tracks turns per server and publishes synthetic JSON-RPC notifications on the same ring/broadcast, with ordinary SSE ids. Enabled for every `/v1/acp` server and for the standalone `acp-http-adapter` binary (`RuntimeOptions::turn_events`, default on). Servers created by the OpenCode-compat layer (`AcpDispatch::post`) start with it off; the flag is fixed when the server is created.

| Method | Params | Published |
|--------|--------|-----------|
| `_sandboxagent/session/turn_started` | `{sessionId, requestId}` | when a `session/prompt` request with an `id` is posted, before it is written to the agent's stdin |
| `_sandboxagent/session/turn_ended` | `{sessionId, requestId, outcome, stopReason?}` | exactly once per turn (see below) |
| `_sandboxagent/session/awaiting_input` | `{sessionId, requestId, kind: "permission"}` | right after the agent's `session/request_permission` request; `requestId` is that request's id |
| `_sandboxagent/session/input_resolved` | `{sessionId, requestId}` | when a client POSTs the answer (before it is written to the agent), or when the turn ends / the agent stops without an answer |

- `sessionId` is `params.sessionId` of the prompt or permission request (agent session id, `null` if missing); `requestId` is the JSON-RPC id as received on the wire (the TS client prefixes its ids per transport).
- Outcomes: `completed` (agent result; `stopReason` copied), `cancelled` (result with `stopReason: "cancelled"`, or `DELETE /v1/acp/{id}` / server shutdown drained the turn, no `stopReason`), `error` (agent JSON-RPC error, or the prompt could not be written to stdin), `timeout` (request timeout, sync or async), `agent_exited` (process exit, also a sync timeout that finds the process already gone).
- Ownership: the turn lives in the `PendingRequest` entry. Whoever removes the entry (stdout loop on the response, the sync or async timeout path, `fail_pending_requests` on exit or shutdown, a stdin write failure) publishes `turn_ended`, so it is never duplicated. Late agent responses after a timeout stay orphans and are dropped, as before.
- Ordering: `turn_started` precedes all agent output of the turn. The end of a turn is published as one uninterrupted batch under the ring lock: `input_resolved` for each still-awaited input of that session, then the response (agent result, or our `-32603` error for async timeout / stop), then `turn_ended`. Everything the agent wrote to stdout before its response has already been published by the stdout loop, so `turn_ended` is the last event of the turn. On process exit, the turn batches come before `_adapter/agent_exited`.
- Response metadata: the prompt response carries `_meta["sandboxagent.dev"] = {sessionId, sequence}` where `sequence` is the SSE id of the turn's `turn_ended`. For results it is `result._meta` (agent `_meta` keys are kept); for JSON-RPC errors it is `error.data._meta` (`data` is created when absent; a non-object `data` is left unchanged). The same annotated envelope goes to SSE and to the sync POST body. Sync errors that are HTTP problems (`504`, `500 agent_process_exited`) carry no metadata; their `turn_ended` is still on SSE.
- Sync POST vs SSE race: for tracked turns the stdout loop publishes the batch first and only then wakes the sync caller, so by the time the POST returns, every event up to `_meta.sequence` is in the ring. A client that also reads SSE has seen the whole turn once it has seen the event with that id. Untracked requests keep the old order (wake, then publish).
- Inputs: only `session/request_permission` is tracked (other agent-to-client requests are answered by the client automatically). The first client answer resolves it; a second answer or a late answer after the turn ended is forwarded to the agent without another event. Inputs are resolved at turn end per session (agents run one prompt per session at a time), and all remaining ones on process exit or shutdown.
- Not tracked: prompts sent as notifications (no `id`), and anything on servers with turn events off. Reconnecting with `Last-Event-ID` replays the events like any other envelope while they are in the ring buffer (1024 entries).
- Out of scope: a snapshot endpoint for current turn state (SBA-40), Claude background tasks that outlive the turn (SBA-25).

When a message is sent:

1. `send_message()` spawns the agent CLI as a subprocess
2. `consume_spawn()` reads stdout/stderr line by line
3. Each JSON line is parsed and converted via `parse_agent_line()`
4. Events are recorded via `record_event()` which:
   - Assigns incrementing event ID
   - Appends to `events` vector
   - Broadcasts to SSE subscribers

## Agent Execution

Each agent has a different execution model and communication pattern. There are two main architectural patterns:

### Architecture Patterns

**Subprocess Model (Claude, Amp):**
- New process spawned per message/turn
- Process terminates after turn completes
- Multi-turn via CLI resume flags (`--resume`, `--continue`)
- Simple but has process spawn overhead

**Client/Server Model (OpenCode, Codex):**
- Single long-running server process
- Multiple sessions/threads multiplexed via RPC
- Multi-turn via server-side thread persistence
- More efficient for repeated interactions

### Overview

| Agent | Architecture | Binary Source | Multi-Turn Method |
|-------|--------------|---------------|-------------------|
| Claude Code | Subprocess (per-turn) | GCS (Anthropic) | `--resume` flag |
| Codex | **Shared Server (JSON-RPC)** | GitHub releases | **Thread persistence** |
| OpenCode | HTTP Server (SSE) | GitHub releases | Server-side sessions |
| Amp | Subprocess (per-turn) | GCS (Amp) | `--continue` flag |

### Claude Code

Spawned as a subprocess with JSONL streaming:

```bash
claude --print --output-format stream-json --verbose \
  [--model MODEL] [--resume SESSION_ID] \
  [--permission-mode plan | --dangerously-skip-permissions] \
  PROMPT
```

- Streams JSON events to stdout, one per line
- Supports session resumption via `--resume`
- Permission modes: `--permission-mode plan` for approval workflow, `--dangerously-skip-permissions` for bypass

### Codex

Uses a **shared app-server process** that handles multiple sessions via JSON-RPC over stdio:

```bash
codex app-server
```

**Daemon flow:**
1. First Codex session triggers `codex app-server` spawn
2. Performs `initialize` / `initialized` handshake
3. Each session creation sends `thread/start` → receives `thread_id`
4. Messages sent via `turn/start` with `thread_id`
5. Notifications routed back to session by `thread_id`

**Key characteristics:**
- Single process handles all Codex sessions
- JSON-RPC over stdio (JSONL format)
- Thread IDs map to daemon session IDs
- Approval requests arrive as server-to-client JSON-RPC requests
- Process lifetime matches daemon lifetime (not per-turn)

### OpenCode

Unique architecture - runs as a **persistent HTTP server** rather than per-message subprocess:

```bash
opencode serve --port {4200-4300}
```

Then communicates via HTTP endpoints:

| Endpoint | Purpose |
|----------|---------|
| `POST /session` | Create new session |
| `POST /session/{id}/prompt` | Send message |
| `GET /event/subscribe` | SSE event stream |
| `POST /question/reply` | Answer HITL question |
| `POST /permission/reply` | Grant/deny permission |

The server is started once and reused across sessions. Events are received via Server-Sent Events (SSE) subscription.

### Amp

Spawned as a subprocess with dynamic flag detection:

```bash
amp [--execute|--print] [--output-format stream-json] \
  [--model MODEL] [--continue SESSION_ID] \
  [--dangerously-skip-permissions] PROMPT
```

- **Dynamic flag detection**: Probes `--help` output to determine which flags the installed version supports
- **Fallback strategy**: If execution fails, retries with progressively simpler flag combinations
- Streams JSON events to stdout
- Supports session continuation via `--continue`

### Communication Patterns

**Per-turn subprocess agents (Claude, Amp):**
1. Agent CLI spawned with appropriate flags
2. Stdout/stderr read line-by-line
3. Each line parsed as JSON
4. Events converted via `parse_agent_line()` → agent-specific converter
5. Universal events recorded and broadcast to SSE subscribers
6. Process terminated on turn completion

**Shared stdio server agent (Codex):**
1. Single `codex app-server` process started on first session
2. `initialize`/`initialized` handshake performed once
3. New sessions send `thread/start`, receive `thread_id`
4. Messages sent via `turn/start` with `thread_id`
5. Notifications read from stdout, routed by `thread_id`
6. Process persists across sessions and turns

**HTTP server agent (OpenCode):**
1. Server started on available port (if not running)
2. Session created via HTTP POST
3. Prompts sent via HTTP POST
4. Events received via SSE subscription
5. HITL responses forwarded via HTTP POST

### Credential Handling

All agents receive API keys via environment variables:

| Agent | Environment Variables |
|-------|----------------------|
| Claude | `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_AUTH_TOKEN` |
| Codex | `OPENAI_API_KEY`, `CODEX_API_KEY` |
| OpenCode | `OPENAI_API_KEY` |
| Amp | `ANTHROPIC_API_KEY` |

## Human-in-the-Loop

Questions and permission prompts are normalized into the universal schema:

- Question events surface as `questionAsked` with selectable options.
- Permission events surface as `permissionAsked` with `reply: once | always | reject`.
- Claude plan approval is normalized into a question event (approve/reject).

## SDK Modes

The TypeScript SDK supports two connection modes.

### Embedded Mode

Defined in `sdks/typescript/src/spawn.ts`:

1. **Binary resolution**: Checks `SANDBOX_AGENT_BIN` env, then platform-specific npm package, then `PATH`
2. **Port selection**: Uses provided port or finds a free one via `net.createServer()`
3. **Token generation**: Uses provided token or generates random 24-byte hex string
4. **Spawn**: Launches `sandbox-agent server --host <host> --port <port> --token <token>`
5. **Health wait**: Polls `GET /v1/health` until server is ready (up to 15s timeout)
6. **Cleanup**: On dispose, sends SIGTERM then SIGKILL if needed; also registers process exit handlers

```typescript
const handle = await spawnSandboxAgent({ log: "inherit" });
// handle.baseUrl = "http://127.0.0.1:<port>"
// handle.token = "<generated>"
// handle.dispose() to cleanup
```

### Server Mode

Defined in `sdks/typescript/src/client.ts`:

- Direct HTTP client to a remote `sandbox-agent` server
- Uses provided `baseUrl` and optional `token`
- No subprocess management

```typescript
const client = await SandboxAgent.connect({
  baseUrl: "http://remote-server:8080",
  token: "secret",
});
```

### Auto-Detection

Sandbox Agent provides two factory methods:

```typescript
// Connect to existing server
const client = await SandboxAgent.connect({
  baseUrl: "http://remote:8080",
});

// Start embedded subprocess
const client = await SandboxAgent.start();

// With options
const client = await SandboxAgent.start({
  spawn: { port: 9000 },
});
```

The `spawn` option can be:
- `true` / `false` - Enable/disable embedded mode
- `SandboxAgentSpawnOptions` - Fine-grained control over host, port, token, binary path, timeout, logging

## Authentication

The daemon uses a **global token** configured at startup. All HTTP and CLI operations reuse the same token and are validated against the `Authorization` header (`Bearer` or `Token`).

## Key Files

| Component | Path |
|-----------|------|
| Agent spawn/install | `server/packages/agent-management/src/agents.rs` |
| Session routing | `server/packages/sandbox-agent/src/router.rs` |
| Event converters | `server/packages/universal-agent-schema/src/agents/*.rs` |
| Schema extractors | `resources/agent-schemas/src/*.ts` |
| TypeScript SDK | `sdks/typescript/src/` |

---

# Agent Compatibility

Supported agents, install methods, and streaming formats.

## Compatibility Matrix

| Agent | Provider | Binary | Install method | Session ID | Streaming format |
|-------|----------|--------|----------------|------------|------------------|
| Claude Code | Anthropic | `claude` | curl raw binary from GCS | `session_id` | JSONL via stdout |
| Codex | OpenAI | `codex` | curl tarball from GitHub releases | `thread_id` | JSON-RPC over stdio |
| OpenCode | Multi-provider | `opencode` | curl tarball from GitHub releases | `session_id` | SSE or JSONL |
| Amp | Sourcegraph | `amp` | curl raw binary from GCS | `session_id` | JSONL via stdout |
| Mock | Built-in | — | bundled | `mock-*` | daemon-generated |

## Agent Modes

- **OpenCode**: discovered via the server API.
- **Claude Code / Codex / Amp**: hardcoded modes (typically `build`, `plan`, or `custom`).

## Capability Notes

- **Questions / permissions**: OpenCode natively supports these workflows. Claude plan approval is normalized into a question event (tests do not currently exercise Claude question/permission flows).
- **Streaming**: all agents stream events; OpenCode uses SSE, Codex uses JSON-RPC over stdio, others use JSONL. Codex is currently normalized to thread/turn starts plus user/assistant completed items (deltas and tool/reasoning items are not emitted yet).
- **User messages**: Claude CLI output does not include explicit user-message events in our snapshots, so only assistant messages are surfaced for Claude today.
- **Files and images**: normalized via `UniversalMessagePart` with `File` and `Image` parts.
