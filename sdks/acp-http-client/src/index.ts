import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  type AnyMessage,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type Client,
  type ForkSessionRequest,
  type ForkSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionOutcome,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type ResumeSessionRequest,
  type ResumeSessionResponse,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type SetSessionModelRequest,
  type SetSessionModelResponse,
  type SetSessionModeRequest,
  type SetSessionModeResponse,
  type Stream,
} from "@agentclientprotocol/sdk";

const DEFAULT_ACP_PATH = "/v1/rpc";

export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  [key: string]: unknown;
}

export type AcpEnvelopeDirection = "inbound" | "outbound";

export type AcpEnvelopeObserver = (envelope: AnyMessage, direction: AcpEnvelopeDirection) => void;

export type QueryValue = string | number | boolean | null | undefined;

export interface AcpHttpTransportOptions {
  path?: string;
  bootstrapQuery?: Record<string, QueryValue>;
  /**
   * Start the event stream after the events the server buffered before this
   * client connected. Use it when attaching to a server another client already
   * used, so that client's past notifications and requests are not replayed.
   */
  skipBufferedEvents?: boolean;
}

/**
 * Turn lifecycle notifications that a Sandbox Agent server publishes on the
 * event stream of `/v1/acp/{server_id}` (not for `/opencode/*`). They are
 * delivered to `client.extNotification`; use
 * {@link parseSandboxAgentTurnNotification} to narrow them.
 */
export const SANDBOX_AGENT_TURN_STARTED = "_sandboxagent/session/turn_started";
export const SANDBOX_AGENT_TURN_ENDED = "_sandboxagent/session/turn_ended";
export const SANDBOX_AGENT_AWAITING_INPUT = "_sandboxagent/session/awaiting_input";
export const SANDBOX_AGENT_INPUT_RESOLVED = "_sandboxagent/session/input_resolved";
/** `_meta` key of the metadata the server adds to `session/prompt` responses. */
export const SANDBOX_AGENT_META_KEY = "sandboxagent.dev";

export type SandboxAgentTurnOutcome = "completed" | "error" | "timeout" | "agent_exited" | "cancelled";

/** JSON-RPC id as sent on the wire (this client prefixes its own ids per transport). */
export type SandboxAgentRequestId = string | number;

export type SandboxAgentTurnNotification =
  | { method: typeof SANDBOX_AGENT_TURN_STARTED; params: { sessionId: string; requestId: SandboxAgentRequestId } }
  | {
      method: typeof SANDBOX_AGENT_TURN_ENDED;
      params: { sessionId: string; requestId: SandboxAgentRequestId; outcome: SandboxAgentTurnOutcome; stopReason?: string };
    }
  | { method: typeof SANDBOX_AGENT_AWAITING_INPUT; params: { sessionId: string; requestId: SandboxAgentRequestId; kind: "permission" } }
  | { method: typeof SANDBOX_AGENT_INPUT_RESOLVED; params: { sessionId: string; requestId: SandboxAgentRequestId } };

/** `_meta["sandboxagent.dev"]` of a `session/prompt` response. */
export interface SandboxAgentPromptMeta {
  sessionId: string;
  /** Event stream id of the turn's last event (`turn_ended`). */
  sequence: number;
}

const TURN_OUTCOMES: ReadonlySet<string> = new Set<SandboxAgentTurnOutcome>(["completed", "error", "timeout", "agent_exited", "cancelled"]);

function isRequestId(value: unknown): value is SandboxAgentRequestId {
  return typeof value === "string" || typeof value === "number";
}

/** Returns the typed turn notification, or `null` for any other or malformed notification. */
export function parseSandboxAgentTurnNotification(method: string, params: unknown): SandboxAgentTurnNotification | null {
  if (!params || typeof params !== "object") {
    return null;
  }
  const record = params as Record<string, unknown>;
  const { sessionId, requestId } = record;
  if (typeof sessionId !== "string" || !isRequestId(requestId)) {
    return null;
  }
  switch (method) {
    case SANDBOX_AGENT_TURN_STARTED:
    case SANDBOX_AGENT_INPUT_RESOLVED:
      return { method, params: { sessionId, requestId } };
    case SANDBOX_AGENT_AWAITING_INPUT:
      return record.kind === "permission" ? { method, params: { sessionId, requestId, kind: "permission" } } : null;
    case SANDBOX_AGENT_TURN_ENDED: {
      const { outcome, stopReason } = record;
      if (typeof outcome !== "string" || !TURN_OUTCOMES.has(outcome)) {
        return null;
      }
      return {
        method,
        params: {
          sessionId,
          requestId,
          outcome: outcome as SandboxAgentTurnOutcome,
          ...(typeof stopReason === "string" ? { stopReason } : {}),
        },
      };
    }
    default:
      return null;
  }
}

/**
 * Reads `_meta["sandboxagent.dev"]` from a `session/prompt` result (or from
 * `error.data` of a JSON-RPC error), if the server added it.
 */
export function sandboxAgentPromptMeta(value: { _meta?: Record<string, unknown> | null } | null | undefined): SandboxAgentPromptMeta | null {
  const meta = value?._meta?.[SANDBOX_AGENT_META_KEY];
  if (!meta || typeof meta !== "object") {
    return null;
  }
  const { sessionId, sequence } = meta as Record<string, unknown>;
  if (typeof sessionId !== "string" || typeof sequence !== "number") {
    return null;
  }
  return { sessionId, sequence };
}

export interface AcpHttpClientOptions {
  baseUrl: string;
  token?: string;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  client?: Partial<Client>;
  onEnvelope?: AcpEnvelopeObserver;
  transport?: AcpHttpTransportOptions;
}

export class AcpHttpError extends Error {
  readonly status: number;
  readonly problem?: ProblemDetails;
  readonly response: Response;

  constructor(status: number, problem: ProblemDetails | undefined, response: Response) {
    super(problem?.title ?? `Request failed with status ${status}`);
    this.name = "AcpHttpError";
    this.status = status;
    this.problem = problem;
    this.response = response;
  }
}

export interface RpcErrorResponse {
  code: number;
  message: string;
  data?: unknown;
}

const RPC_CODE_LABELS: Record<number, string> = {
  [-32700]: "Parse error",
  [-32600]: "Invalid request",
  [-32601]: "Method not supported by agent",
  [-32602]: "Invalid parameters",
  [-32603]: "Internal agent error",
  [-32000]: "Authentication required",
  [-32002]: "Resource not found",
};

export class AcpRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;

  constructor(code: number, message: string, data?: unknown) {
    const label = RPC_CODE_LABELS[code];
    const display = label ? `${label}: ${message}` : message;
    super(display);
    this.name = "AcpRpcError";
    this.code = code;
    this.data = data;
  }
}

function isRpcErrorResponse(value: unknown): value is RpcErrorResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    "code" in value &&
    typeof (value as RpcErrorResponse).code === "number" &&
    "message" in value &&
    typeof (value as RpcErrorResponse).message === "string"
  );
}

async function wrapRpc<T>(promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    if (isRpcErrorResponse(error)) {
      throw new AcpRpcError(error.code, error.message, error.data);
    }
    throw error;
  }
}

export class AcpHttpClient {
  private readonly transport: StreamableHttpAcpTransport;
  private readonly connection: ClientSideConnection;

  constructor(options: AcpHttpClientOptions) {
    const fetcher = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!fetcher) {
      throw new Error("Fetch API is not available; provide a fetch implementation.");
    }

    this.transport = new StreamableHttpAcpTransport({
      baseUrl: options.baseUrl,
      fetcher,
      token: options.token,
      defaultHeaders: options.headers,
      onEnvelope: options.onEnvelope,
      transport: options.transport,
    });

    const clientHandlers = buildClientHandlers(options.client);
    this.connection = new ClientSideConnection(() => clientHandlers, this.transport.stream);
  }

  async initialize(request: Partial<InitializeRequest> = {}): Promise<InitializeResponse> {
    const params: InitializeRequest = {
      protocolVersion: request.protocolVersion ?? PROTOCOL_VERSION,
      clientCapabilities: request.clientCapabilities,
      clientInfo: request.clientInfo ?? {
        name: "acp-http-client",
        version: "v1",
      },
    };

    if (request._meta !== undefined) {
      params._meta = request._meta;
    }

    return wrapRpc(this.connection.initialize(params));
  }

  async authenticate(request: AuthenticateRequest): Promise<AuthenticateResponse> {
    return wrapRpc(this.connection.authenticate(request));
  }

  async newSession(request: NewSessionRequest): Promise<NewSessionResponse> {
    return wrapRpc(this.connection.newSession(request));
  }

  async loadSession(request: LoadSessionRequest): Promise<LoadSessionResponse> {
    return wrapRpc(this.connection.loadSession(request));
  }

  async prompt(request: PromptRequest): Promise<PromptResponse> {
    return wrapRpc(this.connection.prompt(request));
  }

  async cancel(notification: CancelNotification): Promise<void> {
    return this.connection.cancel(notification);
  }

  async setSessionMode(request: SetSessionModeRequest): Promise<SetSessionModeResponse | void> {
    return wrapRpc(this.connection.setSessionMode(request));
  }

  async setSessionConfigOption(request: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    return wrapRpc(this.connection.setSessionConfigOption(request));
  }

  async listSessions(request: ListSessionsRequest): Promise<ListSessionsResponse> {
    return wrapRpc(this.connection.listSessions(request));
  }

  async unstableForkSession(request: ForkSessionRequest): Promise<ForkSessionResponse> {
    return wrapRpc(this.connection.unstable_forkSession(request));
  }

  async unstableResumeSession(request: ResumeSessionRequest): Promise<ResumeSessionResponse> {
    return wrapRpc(this.connection.unstable_resumeSession(request));
  }

  async unstableSetSessionModel(request: SetSessionModelRequest): Promise<SetSessionModelResponse | void> {
    return wrapRpc(this.connection.unstable_setSessionModel(request));
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return wrapRpc(this.connection.extMethod(method, params));
  }

  async extNotification(method: string, params: Record<string, unknown>): Promise<void> {
    return this.connection.extNotification(method, params);
  }

  async disconnect(): Promise<void> {
    await this.transport.close();
  }

  get closed(): Promise<void> {
    return this.connection.closed;
  }

  get signal(): AbortSignal {
    return this.connection.signal;
  }

  get clientSideConnection(): ClientSideConnection {
    return this.connection;
  }
}

type StreamableHttpAcpTransportOptions = {
  baseUrl: string;
  fetcher: typeof fetch;
  token?: string;
  defaultHeaders?: HeadersInit;
  onEnvelope?: AcpEnvelopeObserver;
  transport?: AcpHttpTransportOptions;
};

class StreamableHttpAcpTransport {
  readonly stream: Stream;

  private readonly baseUrl: string;
  private readonly path: string;
  private readonly fetcher: typeof fetch;
  private readonly token?: string;
  private readonly defaultHeaders?: HeadersInit;
  private readonly onEnvelope?: AcpEnvelopeObserver;
  private readonly bootstrapQuery: URLSearchParams | null;

  private readableController: ReadableStreamDefaultController<AnyMessage> | null = null;
  private sseAbortController: AbortController | null = null;
  private sseLoop: Promise<void> | null = null;
  private lastEventId: string | null = null;
  private closed = false;
  private closingPromise: Promise<void> | null = null;
  private postedOnce = false;
  // True while an SSE response is open. Only then is it safe to ask the server
  // to deliver prompt responses exclusively over SSE.
  private sseConnected = false;
  // Set after the first successful SSE connect. Before that, 404 can just mean
  // the bootstrap POST has not created the server yet, so it is retryable.
  private sseEverConnected = false;
  // Consecutive failed connect attempts of the current SSE loop.
  private sseFailures = 0;
  // True when the last SSE attempt failed without an HTTP response (network
  // error): the server is most likely unreachable.
  private sseUnreachable = false;
  // Woken whenever the SSE loop connects, fails an attempt, or stops.
  private readonly sseStateWaiters = new Set<() => void>();
  // Prompts sent with the async header: their result only arrives over SSE, so
  // they must be failed explicitly if SSE is given up.
  private readonly asyncPendingIds = new Map<string, string>();
  // Several clients can share one server, and the server broadcasts every
  // response to every event stream. Outbound request ids are therefore sent with
  // a per-transport prefix; only responses to ids in this map are delivered,
  // mapped back to the id the connection used. A response is delivered once:
  // its entry is removed on delivery, so a copy arriving over both the POST
  // body and the event stream is dropped.
  private readonly wireIdPrefix = `c${Math.random().toString(36).slice(2, 10)}-`;
  private readonly pendingRequestIds = new Map<string, number | string>();

  constructor(options: StreamableHttpAcpTransportOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.path = normalizePath(options.transport?.path ?? DEFAULT_ACP_PATH);
    this.fetcher = options.fetcher;
    this.token = options.token;
    this.defaultHeaders = options.defaultHeaders;
    this.onEnvelope = options.onEnvelope;
    this.bootstrapQuery = options.transport?.bootstrapQuery ? buildQueryParams(options.transport.bootstrapQuery) : null;
    if (options.transport?.skipBufferedEvents) {
      // Last-Event-ID asks for events after the given id. The largest id the
      // server accepts matches no buffered event, so only live events follow.
      this.lastEventId = MAX_SSE_EVENT_ID;
    }

    this.stream = {
      readable: new ReadableStream<AnyMessage>({
        start: (controller) => {
          this.readableController = controller;
        },
        cancel: async () => {
          await this.close();
        },
      }),
      writable: new WritableStream<AnyMessage>({
        write: async (message) => {
          await this.writeMessage(message);
        },
        close: async () => {
          await this.close();
        },
        abort: async () => {
          await this.close();
        },
      }),
    };
  }

  async close(): Promise<void> {
    if (this.closingPromise) {
      return this.closingPromise;
    }

    this.closingPromise = this.closeImpl();
    return this.closingPromise;
  }

  private async closeImpl(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.notifySseStateChange();

    if (this.sseAbortController) {
      this.sseAbortController.abort();
    }

    if (!this.postedOnce) {
      try {
        this.readableController?.close();
      } catch {
        // no-op
      }
      this.readableController = null;
      return;
    }

    const deleteHeaders = this.buildHeaders({
      Accept: "application/json",
    });

    try {
      const response = await this.fetcher(this.buildUrl(), {
        method: "DELETE",
        headers: deleteHeaders,
        signal: timeoutSignal(2_000),
      });

      if (!response.ok && response.status !== 404) {
        throw new AcpHttpError(response.status, await readProblem(response), response);
      }
    } catch {
      // Ignore close errors; close must be best effort.
    }

    try {
      this.readableController?.close();
    } catch {
      // no-op
    }

    this.readableController = null;
  }

  private async writeMessage(message: AnyMessage): Promise<void> {
    if (this.closed) {
      throw new Error("ACP client is closed");
    }

    this.observeEnvelope(message, "outbound");

    const headers = this.buildHeaders({
      "Content-Type": "application/json",
      Accept: "application/json",
    });

    const wireMessage = this.toWireMessage(message);

    if (isAsyncPromptRequest(wireMessage) && this.postedOnce && !this.sseConnected) {
      // A synchronous prompt POST would wait for the whole turn and be cut off
      // by HTTP response-header timeouts (undici: 300 s), so give a connecting
      // or reconnecting event stream a chance to come up first.
      this.ensureSseLoop();
      await this.waitForSseConnected(SSE_CONNECT_WAIT_MS);
      if (this.closed) {
        throw new Error("ACP client is closed");
      }
    }

    if (this.sseConnected && isAsyncPromptRequest(wireMessage)) {
      // The server acknowledges with 202 and delivers the result over SSE, so a
      // long-running prompt does not depend on HTTP response-header timeouts.
      headers.set(ASYNC_PROMPT_HEADER, "1");
      const id = requestIdFromMessage(wireMessage);
      if (typeof id === "string") {
        this.asyncPendingIds.set(id, id);
      }
    }

    const url = this.buildUrl(this.bootstrapQueryIfNeeded());
    this.postedOnce = true;
    this.ensureSseLoop();
    void this.postMessage(url, headers, wireMessage);
  }

  private toWireMessage(message: AnyMessage): AnyMessage {
    const record = message as Record<string, unknown>;
    const id = record.id;
    if (typeof record.method !== "string" || (typeof id !== "string" && typeof id !== "number")) {
      return message;
    }
    const wireId = `${this.wireIdPrefix}${String(id)}`;
    this.pendingRequestIds.set(wireId, id);
    return { ...record, id: wireId } as AnyMessage;
  }

  private async postMessage(url: string, headers: Headers, message: AnyMessage): Promise<void> {
    try {
      const response = await this.fetcher(url, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
      });

      if (!response.ok) {
        throw new AcpHttpError(response.status, await readProblem(response), response);
      }

      if (response.status === 200) {
        const text = await response.text();
        if (text.trim()) {
          const envelope = JSON.parse(text) as AnyMessage;
          this.pushInbound(envelope);
        }
        return;
      }

      // Drain response body so the underlying connection is released back to
      // the pool. Without this, Node.js undici keeps the socket occupied and
      // may stall subsequent requests to the same origin.
      await response.text().catch(() => {});
    } catch (error) {
      console.error("ACP write error:", error);
      this.handleDetachedRequestError(message, error);
    }
  }

  private handleDetachedRequestError(message: AnyMessage, error: unknown): void {
    const id = requestIdFromMessage(message);
    if (id === undefined) {
      this.failReadable(error);
      return;
    }

    this.pushInbound({
      jsonrpc: "2.0",
      id,
      error: toRpcError(error),
    } as AnyMessage);
  }

  private ensureSseLoop(): void {
    if (this.sseLoop || this.closed || !this.postedOnce) {
      return;
    }

    this.sseFailures = 0;
    this.sseUnreachable = false;
    this.sseLoop = this.runSseLoop().finally(() => {
      this.sseLoop = null;
      this.notifySseStateChange();
    });
  }

  /**
   * Waits until the event stream is connected, the loop reports a failed
   * attempt without an HTTP response or stops, the transport closes, or the
   * timeout passes. A network error means the server is most likely
   * unreachable, so the caller is not delayed then. HTTP errors (such as 404
   * before the bootstrap request created the server) keep the wait going.
   */
  private async waitForSseConnected(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!this.sseConnected && this.sseLoop && !this.sseUnreachable && !this.closed) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        break;
      }
      await new Promise<void>((resolve) => {
        const done = () => {
          clearTimeout(timer);
          this.sseStateWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        this.sseStateWaiters.add(done);
      });
    }
    return this.sseConnected;
  }

  private notifySseStateChange(): void {
    for (const waiter of [...this.sseStateWaiters]) {
      waiter();
    }
  }

  private async runSseLoop(): Promise<void> {
    while (!this.closed) {
      this.sseAbortController = new AbortController();

      const headers = this.buildHeaders({
        Accept: "text/event-stream",
      });

      if (this.lastEventId) {
        headers.set("Last-Event-ID", this.lastEventId);
      }

      try {
        const response = await this.fetcher(this.buildUrl(), {
          method: "GET",
          headers,
          signal: this.sseAbortController.signal,
        });
        if (!response.ok) {
          throw new AcpHttpError(response.status, await readProblem(response), response);
        }

        if (!response.body) {
          throw new Error("SSE stream is not readable in this environment.");
        }

        this.sseConnected = true;
        this.sseEverConnected = true;
        this.sseFailures = 0;
        this.sseUnreachable = false;
        this.notifySseStateChange();
        try {
          await this.consumeSse(response.body);
        } finally {
          this.sseConnected = false;
        }

        if (!this.closed) {
          await delay(150);
        }
      } catch (error) {
        if (this.closed || isAbortError(error)) {
          return;
        }

        // Prompt responses can be delivered exclusively over SSE after a 202.
        // Reconnect without waiting for another POST, replaying from
        // Last-Event-ID, with capped exponential backoff. Give up on terminal
        // statuses (server gone or unauthorized) or after repeated failures;
        // the next POST restarts the loop.
        this.sseFailures += 1;
        this.sseUnreachable = !(error instanceof AcpHttpError);
        this.notifySseStateChange();
        if (isTerminalSseError(error, this.sseEverConnected) || this.sseFailures >= SSE_MAX_CONSECUTIVE_FAILURES) {
          this.failAsyncPending(error);
          return;
        }
        await delay(Math.min(SSE_RECONNECT_BASE_MS * 2 ** (this.sseFailures - 1), SSE_RECONNECT_MAX_MS));
      }
    }
  }

  private failAsyncPending(cause: unknown): void {
    if (this.asyncPendingIds.size === 0) {
      return;
    }
    const reason = cause instanceof Error ? cause.message : String(cause);
    const ids = [...this.asyncPendingIds.values()];
    this.asyncPendingIds.clear();
    for (const id of ids) {
      this.pushInbound({
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: `ACP event stream unavailable; the prompt result could not be delivered (${reason})`,
        },
      } as AnyMessage);
    }
  }

  private async consumeSse(body: ReadableStream<Uint8Array>): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) {
          return;
        }

        buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

        let separatorIndex = buffer.indexOf("\n\n");
        while (separatorIndex !== -1) {
          const eventChunk = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          this.processSseEvent(eventChunk);
          separatorIndex = buffer.indexOf("\n\n");
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  private processSseEvent(chunk: string): void {
    if (!chunk.trim()) {
      return;
    }

    let eventName = "message";
    let eventId: string | null = null;
    const dataLines: string[] = [];

    for (const line of chunk.split("\n")) {
      if (!line || line.startsWith(":")) {
        continue;
      }

      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }

      if (line.startsWith("id:")) {
        eventId = line.slice(3).trim();
        continue;
      }

      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }

    if (eventId) {
      this.lastEventId = eventId;
    }

    if (eventName !== "message" || dataLines.length === 0) {
      return;
    }

    const payloadText = dataLines.join("\n");
    if (!payloadText.trim()) {
      return;
    }

    const envelope = JSON.parse(payloadText) as AnyMessage;
    this.pushInbound(envelope);
  }

  private pushInbound(envelope: AnyMessage): void {
    if (this.closed) {
      return;
    }

    const responseId = responseEnvelopeId(envelope);
    if (responseId) {
      const originalId = this.pendingRequestIds.get(responseId);
      if (originalId === undefined) {
        // Another client's response, or a duplicate of one already delivered.
        return;
      }
      this.pendingRequestIds.delete(responseId);
      this.asyncPendingIds.delete(responseId);
      envelope = { ...(envelope as Record<string, unknown>), id: originalId } as AnyMessage;
    }

    this.observeEnvelope(envelope, "inbound");

    try {
      this.readableController?.enqueue(envelope);
    } catch (error) {
      this.failReadable(error);
    }
  }

  private failReadable(error: unknown): void {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.notifySseStateChange();

    try {
      this.readableController?.error(error);
    } catch {
      // no-op
    }

    this.readableController = null;

    if (this.sseAbortController) {
      this.sseAbortController.abort();
    }
  }

  private observeEnvelope(message: AnyMessage, direction: AcpEnvelopeDirection): void {
    if (!this.onEnvelope) {
      return;
    }

    this.onEnvelope(message, direction);
  }

  private buildHeaders(extra?: HeadersInit): Headers {
    const headers = new Headers(this.defaultHeaders ?? undefined);

    if (this.token) {
      headers.set("Authorization", `Bearer ${this.token}`);
    }

    if (extra) {
      const merged = new Headers(extra);
      merged.forEach((value, key) => headers.set(key, value));
    }

    return headers;
  }

  private buildUrl(query?: URLSearchParams | null): string {
    const url = new URL(`${this.baseUrl}${this.path}`);
    if (query) {
      for (const [key, value] of query.entries()) {
        url.searchParams.set(key, value);
      }
    }
    return url.toString();
  }

  private bootstrapQueryIfNeeded(): URLSearchParams | null {
    if (this.postedOnce || !this.bootstrapQuery || this.bootstrapQuery.size === 0) {
      return null;
    }
    return this.bootstrapQuery;
  }
}

function buildClientHandlers(client?: Partial<Client>): Client {
  const fallbackPermission: RequestPermissionResponse = {
    outcome: {
      outcome: "cancelled",
    } as RequestPermissionOutcome,
  };

  return {
    requestPermission: async (request: RequestPermissionRequest) => {
      if (client?.requestPermission) {
        return client.requestPermission(request);
      }
      return fallbackPermission;
    },
    sessionUpdate: async (notification: SessionNotification) => {
      if (client?.sessionUpdate) {
        await client.sessionUpdate(notification);
      }
    },
    readTextFile: client?.readTextFile,
    writeTextFile: client?.writeTextFile,
    createTerminal: client?.createTerminal,
    terminalOutput: client?.terminalOutput,
    releaseTerminal: client?.releaseTerminal,
    waitForTerminalExit: client?.waitForTerminalExit,
    killTerminal: client?.killTerminal,
    extMethod: client?.extMethod,
    extNotification: async (method: string, params: Record<string, unknown>) => {
      if (client?.extNotification) {
        await client.extNotification(method, params);
      }
    },
  };
}

function responseEnvelopeId(message: AnyMessage): string | null {
  if (typeof message !== "object" || message === null) {
    return null;
  }
  const record = message as Record<string, unknown>;
  if ("method" in record) {
    return null;
  }
  if (!("result" in record) && !("error" in record)) {
    return null;
  }
  const id = record.id;
  if (id === null || id === undefined) {
    return null;
  }
  return String(id);
}

const ASYNC_PROMPT_HEADER = "x-sandboxagent-async-prompt";
const MAX_SSE_EVENT_ID = "18446744073709551615";
const SSE_RECONNECT_BASE_MS = 150;
const SSE_RECONNECT_MAX_MS = 5_000;
const SSE_MAX_CONSECUTIVE_FAILURES = 8;
// How long a prompt waits for a connecting event stream before it falls back
// to a synchronous POST.
const SSE_CONNECT_WAIT_MS = 10_000;
const TERMINAL_SSE_STATUSES = new Set([401, 403, 410]);

function isTerminalSseError(error: unknown, everConnected: boolean): boolean {
  if (!(error instanceof AcpHttpError)) {
    return false;
  }
  // 404 after a successful connect means the server was deleted.
  return TERMINAL_SSE_STATUSES.has(error.status) || (error.status === 404 && everConnected);
}

function isAsyncPromptRequest(message: AnyMessage): boolean {
  return (
    typeof message === "object" &&
    message !== null &&
    (message as Record<string, unknown>).method === "session/prompt" &&
    requestIdFromMessage(message) !== undefined
  );
}

function requestIdFromMessage(message: AnyMessage): number | string | null | undefined {
  if (typeof message !== "object" || message === null || !Object.hasOwn(message, "id")) {
    return undefined;
  }
  const id = (message as Record<string, unknown>).id;
  if (typeof id === "string" || typeof id === "number" || id === null) {
    return id;
  }
  return undefined;
}

function toRpcError(error: unknown): RpcErrorResponse {
  if (error instanceof AcpHttpError) {
    return {
      code: -32003,
      message: error.problem?.title ?? `HTTP ${error.status}`,
      data: error.problem ?? { status: error.status },
    };
  }
  if (error instanceof Error) {
    return {
      code: -32603,
      message: error.message,
    };
  }
  return {
    code: -32603,
    message: String(error),
  };
}

async function readProblem(response: Response): Promise<ProblemDetails | undefined> {
  try {
    const text = await response.clone().text();
    if (!text) {
      return undefined;
    }
    return JSON.parse(text) as ProblemDetails;
  } catch {
    return undefined;
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeoutSignal(timeoutMs: number): AbortSignal | undefined {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(timeoutMs);
  }
  return undefined;
}

function normalizePath(path: string): string {
  if (!path.startsWith("/")) {
    return `/${path}`;
  }
  return path;
}

function buildQueryParams(source: Record<string, QueryValue>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) {
      continue;
    }
    params.set(key, String(value));
  }
  return params;
}

export type * from "@agentclientprotocol/sdk";
export { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
