# ACP Migration Friction Log

Track every ACP migration issue that creates implementation friction, unclear behavior, or product risk.

Update this file continuously during the migration.

## Entry template

- Date:
- Area:
- Issue:
- Impact:
- Proposed direction:
- Decision:
- Owner:
- Status: `open` | `in_progress` | `resolved` | `deferred`
- Links:

## Entries

- Date: 2026-06-22
- Area: Agent process request timeout
- Issue: The process exit watcher held the child-process mutex across an unbounded asynchronous wait. Request timeout and shutdown paths blocked on that mutex after their own timeout fired.
- Impact: A timed-out prompt remained open until the agent process exited, potentially for hours, and runtime shutdown could also hang.
- Proposed direction: Poll process status with short, non-blocking `try_wait` calls so timeout and shutdown paths can acquire the child-process mutex.
- Decision: Accepted and implemented with a regression test covering a live agent that never responds.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/acp-http-adapter/src/process.rs`

- Date: 2026-10-01
- Area: Long-running ACP requests over streamable HTTP (async prompt, opt-in)
- Issue: `session/prompt` kept its POST open until the agent completed the turn, so long turns (over ~5 min) failed on client/proxy response-header timeouts (Node/Undici, reverse proxies) even though an SSE response channel already exists. A failed detached POST in `acp-http-client` also closed the shared SSE stream for every request.
- Impact: Long agent turns lost their result; one failed POST broke the whole client connection.
- Proposed direction: Upstream PR #308 made every `session/prompt` return `202` and deliver its result over SSE. That silently changes the `/v1/acp` contract for Gigacode, the `/opencode/*` adapter (`AcpDispatch`), and third-party clients that read the POST body.
- Decision: Accepted as opt-in. `POST /v1/acp/{server_id}` with header `x-sandboxagent-async-prompt: 1` (or `true`) returns `202` for `session/prompt` once it is written to the agent; the correlated result, the request timeout (`-32603 timed out waiting for agent response`), and process exit/`DELETE` (`-32603 agent process stopped before responding`) are delivered on SSE with the same `id`. Without the header the contract is unchanged (`200` + body); other methods always stay synchronous; `AcpDispatch` (`/opencode/*`) always uses the synchronous mode. Pending synchronous requests now wake on process exit/shutdown, which also fixes `DELETE` hanging behind an in-flight prompt (SBA-6). Late responses after timeout/shutdown are no longer re-broadcast. `acp-http-client` sends the header only while its SSE response is open, isolates detached POST failures to the matching request id (PR #306), and reconnects SSE with `Last-Event-ID` without waiting for another POST (PR #308). SSE errors carry the same agent diagnostics as POST errors (the SSE annotation holds only a weak reference to the runtime, so `DELETE` still closes open SSE streams). SSE reconnects use capped exponential backoff (150 ms doubling to 5 s, at most 8 consecutive failures) and stop on 401/403/410, or on 404 once the stream had connected (server deleted); when the client gives up, every prompt sent with the async header is rejected with an "ACP event stream unavailable" error instead of hanging. The next POST restarts the loop. No server flag was added; the header is the only switch.
- Known limits: (1) an async prompt is still bounded by the ACP request timeout; turns longer than that get `-32603 timed out waiting for agent response` (SBA-22 made it configurable via `--acp-request-timeout-ms` and raised the default to 2 h, see the entry below). (2) The replay ring keeps 1024 events per server; if more arrive while the client's SSE is disconnected, an async result can be evicted before the client reconnects with `Last-Event-ID` and is lost. (3) `agentStderr` on an SSE error is the stderr tail at the time the event is streamed (including replay), not at the time of the error.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/acp-http-adapter/src/process.rs`, `server/packages/sandbox-agent/src/acp_proxy_runtime.rs`, `server/packages/sandbox-agent/src/router.rs`, `sdks/acp-http-client/src/index.ts`, upstream PRs #306 and #308, upstream issue #305 (closed not planned)

- Date: 2026-02-10
- Area: Agent process availability
- Issue: Amp does not have a confirmed official ACP agent process in current ACP docs/research.
- Impact: Blocks full parity if Amp is required in v1 launch scope.
- Proposed direction: Treat Amp as conditional for v1.0 and support via pinned fallback only if agent process source is validated.
- Decision: Open.
- Owner: Unassigned.
- Status: open
- Links: `research/acp/acp-notes.md`

- Date: 2026-02-10
- Area: Transport
- Issue: ACP streamable HTTP is still draft upstream; v1 requires ACP over HTTP now.
- Impact: Potential divergence from upstream HTTP semantics.
- Proposed direction: Use strict JSON-RPC mapping and keep transport shim minimal/documented for later alignment.
- Decision: Open.
- Owner: Unassigned.
- Status: open
- Links: `research/acp/spec.md`

- Date: 2026-02-10
- Area: OpenCode compatibility sequencing
- Issue: OpenCode compatibility must be preserved but not block ACP core rewrite.
- Impact: Risk of core rewrites being constrained by legacy compat behavior.
- Proposed direction: Disable/comment out `/opencode/*` during ACP core bring-up, then re-enable via dedicated bridge step after core is stable.
- Decision: Accepted.
- Owner: Unassigned.
- Status: in_progress
- Links: `research/acp/migration-steps.md`

- Date: 2026-02-10
- Area: TypeScript SDK layering
- Issue: Risk of duplicating ACP protocol logic in our TS SDK instead of embedding upstream ACP SDK.
- Impact: Drift from ACP semantics and higher maintenance cost.
- Proposed direction: Embed `@agentclientprotocol/sdk` and keep our SDK as wrapper/convenience layer.
- Decision: Accepted.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/spec.md`

- Date: 2026-02-10
- Area: Installer behavior
- Issue: Lazy agent process install can race under concurrent first-use requests.
- Impact: Duplicate downloads, partial installs, or bootstrap failures.
- Proposed direction: Add per-agent install lock + idempotent install path used by both explicit install and lazy install.
- Decision: Accepted and implemented.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/spec.md`

- Date: 2026-02-10
- Area: ACP over HTTP standardization
- Issue: Community is actively piloting both Streamable HTTP and WebSocket; no final single transport profile has emerged yet.
- Impact: Risk of rework if we overfit to one draft behavior that later shifts.
- Proposed direction: Lock v1 public contract to Streamable HTTP with ACP JSON-RPC payloads, keep implementation modular so WebSocket can be added later without breaking v1 API.
- Decision: Accepted.
- Owner: Unassigned.
- Status: in_progress
- Links: `research/acp/acp-over-http-findings.md`, `research/acp/spec.md`

- Date: 2026-02-10
- Area: Session lifecycle surface
- Issue: ACP stable does not include v1-equivalent methods for session listing, explicit session termination/delete, or event-log polling.
- Impact: Direct lift-and-shift of the legacy session REST list, terminate, and event-polling behavior is not possible with ACP core only.
- Proposed direction: Define `_sandboxagent/session/*` extension methods for these control operations, while keeping core prompt flow on standard ACP methods.
- Decision: Open.
- Owner: Unassigned.
- Status: open
- Links: `research/acp/v1-schema-to-acp-mapping.md`, `research/acp/spec.md`

- Date: 2026-02-10
- Area: HITL question flow
- Issue: ACP stable defines `session/request_permission` but not a generic question request/response method matching v1 `question.*` and question reply endpoints.
- Impact: Existing question UX cannot be represented with standard ACP methods alone.
- Proposed direction: Introduce `_sandboxagent/session/request_question` extension request/response and carry legacy shape via `_meta`.
- Decision: Open.
- Owner: Unassigned.
- Status: open
- Links: `research/acp/v1-schema-to-acp-mapping.md`

- Date: 2026-02-10
- Area: Filesystem parity
- Issue: ACP stable filesystem methods are text-only (`fs/read_text_file`, `fs/write_text_file`), while v1 exposes raw bytes plus directory operations.
- Impact: Binary file reads/writes, archive upload, and directory management cannot map directly to ACP core.
- Proposed direction: Use ACP standard methods for UTF-8 text paths; add `_sandboxagent/fs/*` extensions for binary and directory operations.
- Decision: Open.
- Owner: Unassigned.
- Status: open
- Links: `research/acp/v1-schema-to-acp-mapping.md`

- Date: 2026-02-10
- Area: v1 decommissioning
- Issue: Ambiguity between "comment out v1" and "remove v1" causes rollout confusion.
- Impact: Risk of partial compatibility behavior and extra maintenance burden.
- Proposed direction: Hard-remove v1 behavior and return a stable HTTP 410 error for all `/v1/*` routes.
- Decision: Accepted.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/spec.md`, `research/acp/migration-steps.md`

- Date: 2026-02-10
- Area: TypeScript ACP-over-HTTP client support
- Issue: Official ACP client SDK does not currently provide the exact Streamable HTTP transport behavior required by this project.
- Impact: SDK cannot target `/v1/rpc` without additional transport implementation.
- Proposed direction: Embed upstream ACP SDK types/lifecycle and implement a project transport agent process for ACP-over-HTTP.
- Decision: Accepted.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/spec.md`, `research/acp/migration-steps.md`

- Date: 2026-02-10
- Area: Inspector migration
- Issue: Inspector currently depends on v1 session/event surfaces.
- Impact: Inspector breaks after v1 removal unless migrated to ACP transport.
- Proposed direction: Keep `/ui/` route and migrate inspector runtime calls to ACP-over-HTTP; add dedicated inspector ACP tests.
- Decision: Accepted.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/spec.md`, `research/acp/migration-steps.md`

- Date: 2026-02-10
- Area: Inspector asset embedding
- Issue: If `cargo build` runs before `frontend/packages/inspector/dist` exists, the build script can cache inspector-disabled embedding state.
- Impact: Local runs can serve `/ui/` as disabled even after inspector is built, unless Cargo reruns the build script.
- Proposed direction: Improve build-script invalidation to detect dist directory appearance/disappearance without manual rebuild nudges.
- Decision: Implemented by watching the inspector package directory in `build.rs` so Cargo reruns when dist appears/disappears.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/sandbox-agent/build.rs`, `research/acp/todo.md`

- Date: 2026-02-10
- Area: Deterministic ACP install tests
- Issue: Installer and lazy-install tests were coupled to the live ACP registry, causing non-deterministic test behavior.
- Impact: Flaky CI and inability to reliably validate install provenance and lazy install flows.
- Proposed direction: Add `SANDBOX_AGENT_ACP_REGISTRY_URL` override and drive tests with a local one-shot registry fixture.
- Decision: Accepted and implemented.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/agent-management/src/agents.rs`, `server/packages/sandbox-agent/tests/v1_api.rs`

- Date: 2026-02-10
- Area: Inspector E2E tooling
- Issue: `agent-browser` invocation under pnpm emits npm env warnings (`store-dir`, `recursive`) during scripted runs.
- Impact: No functional break, but noisy CI logs and possible future npm strictness risk.
- Proposed direction: Keep `npx -y agent-browser` script for now; revisit pinning/install strategy if warnings become hard failures.
- Decision: Accepted.
- Owner: Unassigned.
- Status: open
- Links: `frontend/packages/inspector/tests/agent-browser.e2e.sh`

- Date: 2026-02-10
- Area: Real agent process matrix rollout
- Issue: Full agent process smoke coverage requires provider credentials and installed real agent processes in CI/runtime environments.
- Impact: Phase-6 "full matrix green" and "install+prompt+stream per agent process" cannot be marked complete in local-only runs.
- Proposed direction: Keep deterministic agent process matrix in default CI (stub ACP agent processes for claude/codex/opencode) and run real credentialed agent processes in environment-specific jobs.
- Decision: Accepted.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/todo.md`

- Date: 2026-02-10
- Area: Inspector v1-to-v1 compatibility
- Issue: Restored inspector UI expects legacy `/v1` session/event contracts that no longer exist in ACP-native v1.
- Impact: Full parity would block migration; inspector would otherwise fail to run against v1.
- Proposed direction: Keep the restored UI and bridge to ACP with a thin compatibility client (`src/lib/legacyClient.ts`), stubbing non-parity features with explicit `TDOO` markers.
- Decision: Accepted.
- Owner: Unassigned.
- Status: open
- Links: `frontend/packages/inspector/src/lib/legacyClient.ts`, `research/acp/inspector-unimplemented.md`

- Date: 2026-02-10
- Area: Multi-client session visibility + process sharing
- Issue: Existing ACP runtime mapped one HTTP ACP connection to one dedicated agent process, which prevented global session visibility and increased process count.
- Impact: Clients could not discover sessions created by other clients; process utilization scaled with connection count instead of agent type.
- Proposed direction: Use one shared backend process per `AgentId`, maintain server-owned in-memory meta session registry across all connections, intercept `session/list` as a global aggregated view, and add an experimental detach extension (`_sandboxagent/session/detach`) for connection-level session detachment.
- Decision: Accepted and implemented.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/sandbox-agent/src/acp_runtime/mod.rs`, `server/packages/sandbox-agent/src/acp_runtime/mock.rs`, `server/packages/sandbox-agent/tests/v1_api.rs`, `server/packages/sandbox-agent/tests/v1_agent_process_matrix.rs`

- Date: 2026-02-10
- Area: TypeScript SDK package split and ACP lifecycle
- Issue: `sandbox-agent` SDK exposed ACP transport primitives directly (`createAcpClient`, raw envelope APIs, ACP type re-exports), making the public API ACP-heavy.
- Impact: Harder to keep a simple Sandbox-facing API while still supporting protocol-faithful ACP HTTP behavior and Sandbox metadata/extensions.
- Proposed direction: Split into `acp-http-client` (pure ACP HTTP transport/client) and `sandbox-agent` (`SandboxAgentClient`) as a thin wrapper with metadata/event conversion and extension helpers.
- Decision: Accepted and implemented.
- Owner: Unassigned.
- Status: resolved
- Links: `research/acp/ts-client.md`, `sdks/acp-http-client/src/index.ts`, `sdks/typescript/src/client.ts`

- Date: 2026-02-10
- Area: Streamable HTTP transport contract
- Issue: Ambiguity over whether `/v1/rpc` should track MCP transport negotiation (`POST` accepting SSE responses, multi-stream fanout) versus Sandbox Agent's simpler JSON-only POST contract.
- Impact: Without an explicit contract, clients can assume incompatible Accept/media semantics and open duplicate GET streams that receive duplicate events.
- Proposed direction: Define Sandbox Agent transport profile explicitly: `POST /v1/rpc` is JSON-only (`Content-Type` and `Accept` for `application/json`), `GET /v1/rpc` is SSE-only (`Accept: text/event-stream`), and allow only one active SSE stream per ACP connection id.
- Decision: Accepted and implemented.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/sandbox-agent/src/router.rs`, `server/packages/sandbox-agent/src/acp_runtime/mod.rs`, `server/packages/sandbox-agent/tests/v1_api/acp_transport.rs`, `docs/advanced/acp-http-client.mdx`

- Date: 2026-03-13
- Area: Actor runtime shutdown and draining
- Issue: Actors can continue receiving or finishing action work after shutdown has started, while actor cleanup clears runtime resources such as the database handle. In RivetKit this can surface as `Database not enabled` from `c.db` even when the actor definition correctly includes `db`.
- Impact: User requests can fail with misleading internal errors during runner eviction or shutdown, and long-lived request paths can bubble up as HTTP 502/timeout failures instead of a clear retryable stopping/draining signal.
- Proposed direction: Add a real runner draining state so actors stop receiving traffic before shutdown, and ensure actor cleanup does not clear `#db` until in-flight actions are fully quiesced or aborted. App-side request paths should also avoid waiting inline on long actor workflows when possible.
- Decision: Open.
- Owner: Unassigned.
- Status: open
- Links: `foundry/packages/backend/src/actors/workspace/app-shell.ts`, `/Users/nathan/rivet/rivetkit-typescript/packages/rivetkit/src/actor/instance/mod.ts`, `/Users/nathan/rivet/rivetkit-typescript/packages/rivetkit/src/drivers/engine/actor-driver.ts`

- Date: 2026-03-12
- Area: Foundry RivetKit serverless routing on Railway
- Issue: Moving Foundry from `/api/rivet` to `/v1/rivet` exposed three RivetKit deployment couplings: `serverless.basePath` had to be updated explicitly for metadata/start routes, `configureRunnerPool` could not be used in production because the current Rivet token lacked permission to list datacenters, and wrapping `registry.handler(c.req.raw)` inside Hono route handlers produced unstable serverless runner startup under Railway until `/v1/rivet` was dispatched directly from `Bun.serve`.
- Impact: `GET /v1/rivet/metadata` initially returned 404, app-shell actor creation failed during OAuth/session bootstrap, and Foundry sign-in blocked on `500` from `/v1/app/snapshot` and `/v1/auth/github/start`.
- Proposed direction: Treat RivetKit serverless base path as an explicit deployment config when versioning routes, avoid relying on runner-pool auto-configuration unless the production token has the required Rivet control-plane permissions, and prefer direct top-level dispatch for RivetKit serverless routes instead of routing them through higher-level Hono middleware.
- Decision: Accepted and implemented for Foundry. The backend now sets `serverless.basePath` to `/v1/rivet`, leaves runner-pool config to infrastructure, and serves RivetKit directly from the Bun server for `/v1/rivet`.
- Owner: Unassigned.
- Status: resolved
- Links: `foundry/packages/backend/src/actors/index.ts`, `foundry/packages/backend/src/index.ts`

- Date: 2026-02-10
- Area: Agent selection contract for ACP bootstrap/session creation
- Issue: `x-acp-agent` bound agent selection to transport bootstrap, which conflicted with Sandbox Agent meta-session goals where one client can manage sessions across multiple agents.
- Impact: Connections appeared agent-affine; agent selection was hidden in HTTP headers rather than explicit in ACP payload metadata.
- Proposed direction: Hard-remove `x-acp-agent`; require `params._meta["sandboxagent.dev"].agent` on `initialize` and `session/new`, and require `params.agent` for agent-routed calls that have no resolvable `sessionId`.
- Decision: Accepted and implemented.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/sandbox-agent/src/router.rs`, `server/packages/sandbox-agent/src/acp_runtime/helpers.rs`, `server/packages/sandbox-agent/src/acp_runtime/mod.rs`, `server/packages/sandbox-agent/src/acp_runtime/ext_meta.rs`, `server/packages/sandbox-agent/tests/v1_api/acp_transport.rs`

- Date: 2026-02-11
- Area: ACP server simplification
- Issue: Current `/v1/rpc` runtime includes server-managed metadata/session registry and `_sandboxagent/*` ACP extensions, while the new direction is a dumb stdio proxy keyed by client-provided ACP server id.
- Impact: Requires removing extension/metadata semantics and reshaping transport to `/v1/acp/{server_id}` with per-id subprocess lifecycle.
- Proposed direction: Replace `/v1/rpc` with `/v1/acp/{server_id}` (`POST`/`GET` SSE/`DELETE`), drop connection-id headers, keep replay by `server_id`, move non-ACP concerns to HTTP endpoints, and disable OpenCode routes.
- Decision: Accepted (spec drafted).
- Owner: Unassigned.
- Status: in_progress
- Links: `research/acp/simplify-server.md`

- Date: 2026-02-11
- Area: Directory-scoped config ownership
- Issue: MCP/skills config previously traveled with session initialization payloads; simplified server needs standalone HTTP config scoped by directory.
- Impact: Requires new HTTP APIs and clear naming for per-directory/per-entry operations without ACP extension transport.
- Proposed direction: Add directory-scoped query APIs: `/v1/config/mcp?directory=...&mcpName=...` and `/v1/config/skills?directory=...&skillName=...` (name required), using v1 payload shapes for MCP/skills config values.
- Decision: Accepted (spec updated).
- Owner: Unassigned.
- Status: in_progress
- Links: `research/acp/simplify-server.md`, `docs/mcp-config.mdx`, `docs/skills-config.mdx`

- Date: 2026-03-10
- Area: ACP HTTP client transport reentrancy for human-in-the-loop requests
- Issue: The TypeScript `acp-http-client` serialized the full lifetime of each POST on a single write queue. A long-running `session/prompt` request therefore blocked the client from POSTing a response to an agent-initiated `session/request_permission`, deadlocking permission approval flows.
- Impact: Permission requests arrived over SSE, but replying to them never resumed the original prompt turn. This blocked Claude and any other ACP agent using `session/request_permission`.
- Proposed direction: Make the HTTP transport fire POSTs asynchronously after preserving outbound ordering at enqueue time, rather than waiting for the entire HTTP response before the next write can begin. Keep response bodies routed back into the readable stream so request promises still resolve normally.
- Decision: Accepted and implemented in `acp-http-client`.
- Owner: Unassigned.
- Status: resolved
- Links: `sdks/acp-http-client/src/index.ts`, `sdks/acp-http-client/tests/smoke.test.ts`, `sdks/typescript/tests/integration.test.ts`

- Date: 2026-03-07
- Area: Desktop host/runtime API boundary
- Issue: Desktop automation needed screenshot/input/file-transfer-like host capabilities, but routing it through ACP would have mixed agent protocol semantics with host-owned runtime control and binary payloads.
- Impact: A desktop feature built as ACP methods would blur the division between agent/session behavior and Sandbox Agent host/runtime APIs, and would complicate binary screenshot transport.
- Proposed direction: Ship desktop as first-party HTTP endpoints under `/v1/desktop/*`, keep health/install/remediation in the server runtime, and expose the feature through the SDK and inspector without ACP extension methods.
- Decision: Accepted and implemented for phase one.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/sandbox-agent/src/router.rs`, `server/packages/sandbox-agent/src/desktop_runtime.rs`, `sdks/typescript/src/client.ts`, `frontend/packages/inspector/src/components/debug/DesktopTab.tsx`

- Date: 2026-10-01
- Area: TypeScript SDK agent authentication (`authMethods` / `authenticate`)
- Issue: `autoAuthenticate` only called `authenticate` for three hardcoded ids (`codex-api-key`, `openai-api-key`, `anthropic-api-key`), silently skipped every other advertised method, and swallowed `authenticate` errors. This broke the API-key flow of `codex-acp` 1.x and gateway-style custom auth (upstream issue #313).
- Impact: Clients could not pick an agent-advertised auth method, and a failed sign-in surfaced later as a confusing prompt failure instead of at session creation.
- Proposed direction: Let SDK callers choose the method from the agent's `initialize.authMethods`, keeping the legacy heuristic as the default.
- Decision: Accepted and implemented. New `auth` option on `SandboxAgent.connect/start`: `{ methodId }`, `{ selectMethod(methods, { agent }) }` (receives full `AuthMethod[]` including `_meta`; returns an id, `false` to skip, or `undefined` for the default), or `false` to disable. Order: `methodId`, then `selectMethod`, then the legacy heuristic. An explicitly chosen method must be advertised and its `authenticate` errors propagate from `createSession`; the legacy heuristic stays best-effort. No HTTP contract change. Still to verify live which ids `codex-acp` 1.x advertises for API keys and whether they belong in the default heuristic.
- Owner: Unassigned.
- Status: resolved
- Links: `sdks/typescript/src/client.ts`, `sdks/typescript/tests/integration.test.ts`, `sdks/typescript/tests/helpers/mock-agent.ts`, `docs/sdk-overview.mdx`

- Date: 2026-10-01
- Area: ACP request timeout (`/v1/acp`, sync and async prompt)
- Issue: Every ACP request was cut off after a hardcoded-default 120 s (`504 urn:sandbox-agent:error:timeout`, or `-32603 timed out waiting for agent response` on SSE for async prompts). Delegated agent turns routinely run longer. `SANDBOX_AGENT_ACP_REQUEST_TIMEOUT_MS` was already read but undocumented, untested, and had no CLI flag. Fork tiagoefreitas (`c686581`) hardcoded 7 200 000 ms instead.
- Impact: Long prompt turns failed even though the agent was still working.
- Proposed direction: Add `sandbox-agent server --acp-request-timeout-ms <MS>` with the same precedence as `--shutdown-timeout-ms` (flag, then env, then default), keep the default in one named constant.
- Decision: Implemented (SBA-22). Owner decision: default raised to 2 h (`DEFAULT_REQUEST_TIMEOUT` in `acp_proxy_runtime.rs`, one-line change). The flag rejects `0`; an invalid or zero env value logs a warning and uses the default. The same value bounds synchronous requests (POST returns `504`) and opt-in async prompts (POST returns `202`, then a JSON-RPC `-32603 timed out waiting for agent response` error with the same `id` on SSE); there is no separate async timeout. Clients that keep a synchronous POST open longer than their own HTTP timeout should use the async header. `/opencode/*` (`AcpDispatch`) uses the same runtime and timeout. The standalone `acp-http-adapter` binary keeps its own `--rpc-timeout-ms` (same unit, default still 120 s); not unified because it is a separate binary with its own CLI.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/sandbox-agent/src/acp_proxy_runtime.rs`, `server/packages/sandbox-agent/src/cli.rs`, `server/packages/sandbox-agent/src/router.rs`, `server/packages/sandbox-agent/tests/v1_api/acp_transport.rs`, `docs/cli.mdx`

- Date: 2026-10-01
- Area: Session resume and reattach in the TypeScript SDK (SBA-27)
- Issue: `resumeSession` always created a new agent session on a new server and overwrote persisted `modes`/`configOptions` with the new session's defaults, so the selected mode and model were lost. Reattaching a second client to a running `/v1/acp/{server_id}` was also unsafe: the server buffers and broadcasts every response to every SSE stream and replays the whole ring buffer to a new stream, so the new client received the old client's responses (same numeric JSON-RPC ids) and history.
- Impact: Restored sessions silently fell back to default permissions; a reattached client could resolve requests with another client's responses or drop its own as duplicates, and re-persisted old notifications.
- Proposed direction: Persist `serverId`, reattach to that server when it still runs and resume via `session/resume` when the agent advertises `sessionCapabilities.resume`, otherwise recreate with replay; re-apply previous mode/config in both cases.
- Decision: Accepted and implemented. `acp-http-client` prefixes outbound request ids per transport and only delivers responses to its own ids; `transport.skipBufferedEvents` starts SSE with `Last-Event-ID: u64::MAX` so only live events follow (no server change). Settings that cannot be re-applied throw `SessionConfigRestoreError` (carries the restored session). Requests the agent rejected because it does not know the session (error that names the session; bare -32002 "resource not found" is not enough) restore the session and retry once. Requests that fail because the server is gone (checked via `GET /v1/acp`) restore the session, but only `session/set_mode` and `session/set_config_option` are retried; prompts and other requests throw `SessionRequestInterruptedError` with the restored session, since the agent may already have run them. The fork's synthesized `session/prompt` response (tiagoefreitas `b4cc750`) was not ported: every response that resolves a request passes the envelope observer first; the SDK now awaits per-session event persistence before `prompt()` resolves. Known limitations (left as is): (1) an agent-initiated permission request pending when the old client crashed is not replayed to the reattached client; (2) `skipBufferedEvents` starts from `Last-Event-ID: u64::MAX`, so if the SSE stream reconnects before it has received any event, events published in between are skipped; (3) while two SDK clients are attached to the same server and share one persist store, both observe the session's notifications and write them twice; (4) if re-applying settings fails during a lazy restore inside `prompt()`, `SessionConfigRestoreError` is thrown and that prompt is not sent (the session is restored, so sending again works).
- Owner: Unassigned.
- Status: resolved
- Links: `sdks/typescript/src/client.ts`, `sdks/acp-http-client/src/index.ts`, `sdks/typescript/tests/integration.test.ts`, `docs/session-restoration.mdx`

- Date: 2026-10-01
- Area: `acp-http-client` prompt delivery vs. HTTP client timeouts (SBA-35)
- Issue: The client only sent `session/prompt` with `x-sandboxagent-async-prompt: 1` when SSE was already connected. A prompt issued while SSE was still connecting (first prompt right after `session/new`) or reconnecting went as a synchronous POST, and Node's `fetch` (undici `headersTimeout`, 300 s) cut the turn off long before the server's 2 h request timeout (SBA-22).
- Impact: Long turns failed client-side with `HeadersTimeoutError` while the agent was still working.
- Proposed direction: Either always wait for SSE and send async, or give the synchronous POST a dispatcher without `headersTimeout`.
- Decision: Implemented the first option. Before posting a prompt (and only after the first POST, so the bootstrap is never blocked), the transport starts the SSE loop if needed and waits up to `SSE_CONNECT_WAIT_MS` (10 s) for it to connect, then sends the prompt async. It stops waiting early when an SSE attempt fails with a network error (no HTTP response), the loop gives up (terminal status or too many failures), or the transport closes; HTTP errors such as the 404 before the bootstrap POST created the server keep it waiting. After that it falls back to the old synchronous POST, so an unreachable server still fails fast and the SBA-27 server-loss path (`SessionRequestInterruptedError`, no prompt retry) is unchanged. The wait happens inside the writable stream's `write`, which the ACP connection serializes, so a later `session/cancel` cannot overtake its prompt. A dispatcher without `headersTimeout` was rejected: it needs `undici` as a runtime dependency and only works in Node. Residual risk: if SSE stays down for the whole wait, the synchronous fallback is still subject to the HTTP client's timeouts.
- Owner: Unassigned.
- Status: resolved
- Links: `sdks/acp-http-client/src/index.ts`, `sdks/acp-http-client/tests/smoke.test.ts`, `sdks/typescript/tests/helpers/mock-agent.ts`, `docs/sdk-overview.mdx`

- Date: 2026-10-01
- Area: Batch download of files and directories (SBA-14)
- Issue: Only `POST /v1/fs/upload-batch` existed, so a client could not fetch a results directory in one request. The upstream draft (`e1a0956`, PR #190) built the whole tar in memory, had no limits, and had no CLI counterpart.
- Impact: Large result directories would have to be read file by file, or could exhaust server memory if archived in one go.
- Proposed direction: Add `GET /v1/fs/download-batch` as a plain HTTP endpoint (not an ACP extension), streamed, with limits.
- Decision: Implemented. The server pre-walks the tree with `symlink_metadata` (symlinks and special files rejected), enforces `maxBytes` (4 GiB), `maxEntries` (100000) and `maxDepth` (64) before sending the `200`, then streams the tar from a blocking thread through a bounded channel (64 KiB chunks, 8 in flight). Server limits come from `SANDBOX_AGENT_FS_DOWNLOAD_MAX_{BYTES,ENTRIES,DEPTH}`; query parameters can only lower them. Limit errors are problem+json `400` with type `urn:sandbox-agent:error:limit_exceeded` and `limit`/`max` extensions. If a file changes size or type after the pre-walk, the stream is aborted with a body error, so the client never gets a short archive that looks complete. The TS SDK `downloadFsBatch()` returns a `ReadableStream<Uint8Array>` and does not depend on `tar`. No CLI subcommand: the binary has no filesystem commands at all (not even for upload-batch), and callers use the SDK or HTTP (owner decision, 2026-10-01). The `transport.disableSse` change from the same upstream commit was not ported.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/sandbox-agent/src/router/download_batch.rs`, `server/packages/sandbox-agent/tests/v1_api/fs_download_batch.rs`, `sdks/typescript/src/client.ts`, `docs/file-system.mdx`

- Date: 2026-10-01
- Area: Turn completion signal for orchestrators (SBA-9)
- Issue: An observer could only infer the end of a turn from the `session/prompt` response broadcast on SSE (correlated by an id it did not send) or from `_adapter/agent_exited`; timeouts, `DELETE` and shutdown produced only a `-32603` for async prompts and nothing for sync ones, and there was no signal that the agent was waiting for a permission answer. A sync POST could also return before the turn's last events reached the ring.
- Impact: Brokers had to hold the long POST or guess, and could not tell "waiting for input" from "working".
- Proposed direction: Option B1 (owner decision): synthetic server notifications kept in `acp-http-adapter`, plus `_meta` on the prompt response. Agent hooks (option C), upstream #45 and #304 not taken; #304's fence is covered by `_meta.sequence`.
- Decision: Implemented. `_sandboxagent/session/turn_started|turn_ended|awaiting_input|input_resolved`, outcomes `completed|error|timeout|agent_exited|cancelled`; `DELETE`/shutdown report `cancelled` without `stopReason`, an agent-side cancel reports `cancelled` with `stopReason: "cancelled"`. Prompt responses carry `_meta["sandboxagent.dev"] = {sessionId, sequence}` (`result._meta`, or `error.data._meta` for errors) where `sequence` is the SSE id of `turn_ended`; the end-of-turn batch (`input_resolved`*, response, `turn_ended`) is published atomically before a sync caller is woken. Unanswered permission requests are resolved before `turn_ended` (and all of them on exit/shutdown), so `awaiting_input` and `input_resolved` always pair. Off for servers created by `/opencode/*`. SDK: `acp-http-client` exports the method constants, `parseSandboxAgentTurnNotification` and `sandboxAgentPromptMeta`; `sandbox-agent` adds `sdk.onTurnEvent(sessionId, listener)` / `session.onTurnEvent(listener)`, delivered after preceding session events and not persisted. Full contract in `server/ARCHITECTURE.md` ("Turn lifecycle events"). Known limitations: (1) `requestId` is the wire id, so for TS clients it is the transport-prefixed id; (2) a sync prompt that ends with an HTTP problem (`504`/`500`) has no `_meta`, only the SSE `turn_ended`; (3) the turn-events flag is fixed when the server is created, so a `/v1/acp` client posting to an OpenCode-created server id gets no events; (4) if the agent prints its response and exits immediately, the exit watcher can drain the turn first and report `agent_exited` (existing race).
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/acp-http-adapter/src/process.rs`, `server/packages/sandbox-agent/src/acp_proxy_runtime.rs`, `server/packages/sandbox-agent/src/cli.rs` (mock agent hooks), `server/packages/sandbox-agent/tests/v1_api/turn_events.rs`, `sdks/acp-http-client/src/index.ts`, `sdks/typescript/src/client.ts`, `docs/agent-sessions.mdx`, `docs/sdk-overview.mdx`

- Date: 2026-10-02
- Area: Session recovery after server loss or agent crash mid-turn (SBA-44)
- Issue: After SBA-35 prompts are almost always async, so a turn cut off by `DELETE /v1/acp/{id}` or an agent crash fails over SSE with `-32603` ("agent process stopped before responding"), not with the `-32003` HTTP error that `prepareSessionRecovery` required; the session was not restored and kept a stale `serverId`. Separately, an agent server whose child process exited stayed in the server map: it was still listed by `GET /v1/acp`, so the SDK thought it was alive, and the next POST failed with `502` "failed writing to agent stdin: Broken pipe".
- Impact: After a crash or a mid-turn delete every following prompt failed until the client was restarted.
- Proposed direction: Make the server stop exposing dead runtimes and let the SDK recognise server loss by asking the server instead of by error code.
- Decision: Implemented. Server: `AdapterRuntime` sets an exit flag (`has_exited()`, `exit_watch()`) as soon as the child exits, before it fails pending requests, so a client reacting to those errors already sees the server gone. `AcpProxyRuntime` spawns an exit reaper per instance (weak references only) that removes it from the map, and `list_instances`, SSE and POST lookups also skip and remove exited instances in the window before the reaper runs. Removal does not call `shutdown()` (that would end the pending turn as `cancelled` instead of `agent_exited`); open event streams still get the final events and then end. A POST for a removed id behaves like one for an unknown id (`400` without `?agent=`, a fresh agent with it); no HTTP contract change. SDK: on any failed session request (any code, network errors included) it checks `GET /v1/acp`; if the server is gone the connection is dropped and the session restored. A POST rejected with a `4xx` Sandbox Agent problem of type `invalid_request` or `session_not_found` counts as not delivered (the server returns these only before forwarding to the agent; a bare 4xx such as 408/429/499 from a proxy in front of the server does not count, since the proxy may already have forwarded the request), so the request is retried once on the restored session; anything else (SSE `-32603`, `5xx` such as agent exited or timeout) may have reached the agent, so prompts throw `SessionRequestInterruptedError` and are not replayed (SBA-27 rule kept). Test mock: prompt hooks (`crash:now`, `delay:`) now match only the last text block, because a recreated session prepends replayed history as the first block and the old hook text in it fired again. Known limitations: (1) a `502` write failure when the child dies between the liveness check and the stdin write is treated as possibly delivered (`SessionRequestInterruptedError`), although it was not; (2) the undelivered attempt and its error stay in the event log and so appear in replayed history after a recreate; (3) if the whole Sandbox Agent server is unreachable, nothing is restored and the original error is thrown; (4) the liveness check costs one `GET /v1/acp` per failed session request.
- Owner: Unassigned.
- Status: resolved
- Links: `server/packages/acp-http-adapter/src/process.rs`, `server/packages/sandbox-agent/src/acp_proxy_runtime.rs`, `server/packages/sandbox-agent/tests/v1_api/agent_exit.rs`, `sdks/typescript/src/client.ts`, `sdks/typescript/tests/integration.test.ts`, `sdks/typescript/tests/helpers/mock-agent.ts`, `docs/session-restoration.mdx`
