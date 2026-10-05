import {
  AcpHttpClient,
  AcpRpcError,
  PROTOCOL_VERSION,
  type AcpEnvelopeDirection,
  type AcpEnvelopeMeta,
  type AnyMessage,
  type AuthMethod,
  type CancelNotification,
  type NewSessionRequest,
  type NewSessionResponse,
  type PermissionOption,
  type PermissionOptionKind,
  type PromptRequest,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionNotification,
  type SessionModeState,
  type SetSessionConfigOptionResponse,
  type SetSessionConfigOptionRequest,
  type SetSessionModeResponse,
  type SetSessionModeRequest,
  parseSandboxAgentTurnNotification,
  SANDBOX_AGENT_INPUT_RESOLVED,
  SANDBOX_AGENT_TURN_ENDED,
  SANDBOX_AGENT_TURN_STARTED,
  type SandboxAgentRequestId,
  type SandboxAgentTurnNotification,
  type SandboxAgentTurnOutcome,
} from "acp-http-client";
import type { SandboxProvider } from "./providers/types.ts";
import { DesktopStreamSession, type DesktopStreamConnectOptions } from "./desktop-stream.ts";
import {
  type AcpServerListResponse,
  type AgentInfo,
  type AgentInstallRequest,
  type AgentInstallResponse,
  type AgentListResponse,
  type AgentProfile,
  type DesktopActionResponse,
  type DesktopClipboardQuery,
  type DesktopClipboardResponse,
  type DesktopClipboardWriteRequest,
  type DesktopDisplayInfoResponse,
  type DesktopKeyboardDownRequest,
  type DesktopKeyboardPressRequest,
  type DesktopKeyboardTypeRequest,
  type DesktopLaunchRequest,
  type DesktopLaunchResponse,
  type DesktopMouseClickRequest,
  type DesktopMouseDownRequest,
  type DesktopMouseDragRequest,
  type DesktopMouseMoveRequest,
  type DesktopMousePositionResponse,
  type DesktopMouseScrollRequest,
  type DesktopMouseUpRequest,
  type DesktopKeyboardUpRequest,
  type DesktopOpenRequest,
  type DesktopOpenResponse,
  type DesktopRecordingInfo,
  type DesktopRecordingListResponse,
  type DesktopRecordingStartRequest,
  type DesktopRegionScreenshotQuery,
  type DesktopScreenshotQuery,
  type DesktopStartRequest,
  type DesktopStatusResponse,
  type DesktopStreamStatusResponse,
  type DesktopWindowInfo,
  type DesktopWindowListResponse,
  type DesktopWindowMoveRequest,
  type DesktopWindowResizeRequest,
  type FsActionResponse,
  type FsDeleteQuery,
  type FsEntriesQuery,
  type FsEntry,
  type FsMoveRequest,
  type FsMoveResponse,
  type FsPathQuery,
  type FsStat,
  type FsDownloadBatchQuery,
  type FsUploadBatchQuery,
  type FsUploadBatchResponse,
  type FsWriteResponse,
  type HealthResponse,
  InMemorySessionPersistDriver,
  type ListEventsRequest,
  type ListPage,
  type ListPageRequest,
  type McpConfigQuery,
  type McpServerConfig,
  type ProblemDetails,
  type ProcessConfig,
  type ProcessCreateRequest,
  type ProcessInfo,
  type ProcessInputRequest,
  type ProcessInputResponse,
  type ProcessListQuery,
  type ProcessListResponse,
  type ProcessOwner,
  type ProcessLogEntry,
  type ProcessLogsQuery,
  type ProcessLogsResponse,
  type ProcessRunRequest,
  type ProcessRunResponse,
  type ProcessSignalQuery,
  type ProcessTerminalClientFrame,
  type ProcessTerminalServerFrame,
  type ProcessTerminalResizeRequest,
  type ProcessTerminalResizeResponse,
  type ProfileDetailResponse,
  type ProfileListResponse,
  type SessionEvent,
  type SessionPersistDriver,
  type SessionRecord,
  type SkillsConfig,
  type SkillsConfigQuery,
  type TerminalErrorStatus,
  type TerminalExitStatus,
  type TerminalReadyStatus,
  type TerminalResizePayload,
} from "./types.ts";

const API_PREFIX = "/v1";
const FS_PATH = `${API_PREFIX}/fs`;
const DEFAULT_BASE_URL = "http://sandbox-agent";

const DEFAULT_REPLAY_MAX_EVENTS = 50;
const DEFAULT_REPLAY_MAX_CHARS = 12_000;
const EVENT_INDEX_SCAN_EVENTS_LIMIT = 500;
const MAX_EVENT_INDEX_INSERT_RETRIES = 3;
const SESSION_CANCEL_METHOD = "session/cancel";
const PERMISSION_REQUEST_METHOD = "session/request_permission";
const MANUAL_CANCEL_ERROR = "Manual session/cancel calls are not allowed. Use destroySession(sessionId) instead.";
const HEALTH_WAIT_MIN_DELAY_MS = 500;
const HEALTH_WAIT_MAX_DELAY_MS = 15_000;
const HEALTH_WAIT_LOG_AFTER_MS = 5_000;
const HEALTH_WAIT_LOG_EVERY_MS = 10_000;
const HEALTH_WAIT_ENSURE_SERVER_AFTER_FAILURES = 3;

export interface SandboxAgentHealthWaitOptions {
  timeoutMs?: number;
}

/** Context passed to {@link SandboxAgentAuthOptions.selectMethod}. */
export interface AuthMethodSelectionContext {
  /** Agent the connection is being opened for (for example `"codex"`). */
  agent: string;
}

/**
 * Chooses which agent-advertised auth method to use.
 * Return a method id to use it, `false` to skip authentication for this agent,
 * or `null`/`undefined` to fall back to the default heuristic.
 */
export type AuthMethodSelector = (
  methods: AuthMethod[],
  context: AuthMethodSelectionContext,
) => string | false | null | undefined | Promise<string | false | null | undefined>;

/**
 * Controls how the SDK authenticates with an agent after connecting to it.
 * An explicitly chosen method must be advertised by the agent, and its errors are thrown.
 */
export interface SandboxAgentAuthOptions {
  /** Auth method id to use. Takes precedence over `selectMethod`. */
  methodId?: string;
  /** Picks a method from the full list the agent advertises (including `_meta`). */
  selectMethod?: AuthMethodSelector;
}

interface SandboxAgentConnectCommonOptions {
  /**
   * Agent auth method selection. Omit to keep the default heuristic
   * (env-var based API key methods only, errors ignored). `false` disables it.
   */
  auth?: SandboxAgentAuthOptions | false;
  headers?: HeadersInit;
  persist?: SessionPersistDriver;
  replayMaxEvents?: number;
  replayMaxChars?: number;
  /**
   * Off by default. When set, this client cancels a permission request of a
   * session it is attached to if the request is still unanswered after this
   * many milliseconds, it has no `onPermissionRequest` listener for the
   * session, and the request belongs to another client's prompt. Use it on a
   * supervising client so a turn does not wait for the server's request
   * timeout (2 hours by default) when the prompting client died.
   */
  cancelUnansweredPermissionsAfterMs?: number;
  signal?: AbortSignal;
  token?: string;
  skipHealthCheck?: boolean;
  /** @deprecated Use skipHealthCheck instead. */
  waitForHealth?: boolean | SandboxAgentHealthWaitOptions;
}

export type SandboxAgentConnectOptions =
  | (SandboxAgentConnectCommonOptions & {
      baseUrl: string;
      fetch?: typeof fetch;
    })
  | (SandboxAgentConnectCommonOptions & {
      fetch: typeof fetch;
      baseUrl?: string;
    });

export interface SandboxAgentStartOptions {
  sandbox: SandboxProvider;
  /** See {@link SandboxAgentConnectOptions} `auth`. */
  auth?: SandboxAgentAuthOptions | false;
  sandboxId?: string;
  skipHealthCheck?: boolean;
  fetch?: typeof fetch;
  headers?: HeadersInit;
  persist?: SessionPersistDriver;
  replayMaxEvents?: number;
  replayMaxChars?: number;
  /** See {@link SandboxAgentConnectOptions} `cancelUnansweredPermissionsAfterMs`. */
  cancelUnansweredPermissionsAfterMs?: number;
  signal?: AbortSignal;
  token?: string;
}

export interface SessionCreateRequest {
  id?: string;
  agent: string;
  /** Shorthand for `sessionInit.cwd`. Ignored when `sessionInit` is provided. */
  cwd?: string;
  /** Full session init. When omitted, built from `cwd` (or default) with empty `mcpServers`. */
  sessionInit?: Omit<NewSessionRequest, "_meta">;
  model?: string;
  mode?: string;
  thoughtLevel?: string;
}

export interface SessionResumeOrCreateRequest {
  id: string;
  agent: string;
  /** Shorthand for `sessionInit.cwd`. Ignored when `sessionInit` is provided. */
  cwd?: string;
  /** Full session init. When omitted, built from `cwd` (or default) with empty `mcpServers`. */
  sessionInit?: Omit<NewSessionRequest, "_meta">;
  model?: string;
  mode?: string;
  thoughtLevel?: string;
}

export interface SessionSendOptions {
  notification?: boolean;
}

export type SessionEventListener = (event: SessionEvent) => void;
export type PermissionReply = "once" | "always" | "reject";
export type PermissionRequestListener = (request: SessionPermissionRequest) => void;

/** How a turn ended. */
export type SessionTurnOutcome = SandboxAgentTurnOutcome;

interface SessionTurnEventBase {
  /** Local session id. */
  sessionId: string;
  agentSessionId: string;
  /**
   * Opaque id that correlates events: the prompt request for `turn_started`
   * and `turn_ended`, the agent's input request for `awaiting_input` and
   * `input_resolved`.
   */
  requestId: SandboxAgentRequestId;
}

/**
 * Turn lifecycle signal for a session, delivered to every client attached to
 * the session's server (not only the one that sent the prompt). Not persisted
 * as a session event.
 */
export type SessionTurnEvent =
  | (SessionTurnEventBase & { type: "turn_started" })
  | (SessionTurnEventBase & { type: "turn_ended"; outcome: SessionTurnOutcome; stopReason?: string })
  | (SessionTurnEventBase & { type: "awaiting_input"; kind: "permission" })
  | (SessionTurnEventBase & { type: "input_resolved" });

export type SessionTurnEventListener = (event: SessionTurnEvent) => void;
export type ProcessLogListener = (entry: ProcessLogEntry) => void;
export type ProcessLogFollowQuery = Omit<ProcessLogsQuery, "follow">;

export interface SessionPermissionRequestOption {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface SessionPermissionRequest {
  id: string;
  createdAt: number;
  sessionId: string;
  agentSessionId: string;
  availableReplies: PermissionReply[];
  options: SessionPermissionRequestOption[];
  toolCall: RequestPermissionRequest["toolCall"];
  rawRequest: RequestPermissionRequest;
}

export interface AgentQueryOptions {
  config?: boolean;
  noCache?: boolean;
}

export interface ProcessLogSubscription {
  close(): void;
  closed: Promise<void>;
}

export interface ProcessTerminalWebSocketUrlOptions {
  accessToken?: string;
}

export interface ProcessTerminalConnectOptions extends ProcessTerminalWebSocketUrlOptions {
  protocols?: string | string[];
  WebSocket?: typeof WebSocket;
}

export type ProcessTerminalSessionOptions = ProcessTerminalConnectOptions;
export type DesktopStreamSessionOptions = DesktopStreamConnectOptions;

export class SandboxAgentError extends Error {
  readonly status: number;
  readonly problem?: ProblemDetails;
  readonly response: Response;

  constructor(status: number, problem: ProblemDetails | undefined, response: Response) {
    super(problem?.title ?? `Request failed with status ${status}`);
    this.name = "SandboxAgentError";
    this.status = status;
    this.problem = problem;
    this.response = response;
  }
}

export class SandboxDestroyedError extends Error {
  readonly sandboxId: string;
  readonly provider: string;

  constructor(sandboxId: string, provider: string, options?: { cause?: unknown }) {
    super(`Sandbox '${provider}/${sandboxId}' no longer exists and cannot be reconnected.`, options);
    this.name = "SandboxDestroyedError";
    this.sandboxId = sandboxId;
    this.provider = provider;
  }
}

export class UnsupportedSessionCategoryError extends Error {
  readonly sessionId: string;
  readonly category: string;
  readonly availableCategories: string[];

  constructor(sessionId: string, category: string, availableCategories: string[]) {
    super(`Session '${sessionId}' does not support category '${category}'. Available categories: ${availableCategories.join(", ") || "(none)"}`);
    this.name = "UnsupportedSessionCategoryError";
    this.sessionId = sessionId;
    this.category = category;
    this.availableCategories = availableCategories;
  }
}

export class UnsupportedSessionValueError extends Error {
  readonly sessionId: string;
  readonly category: string;
  readonly configId: string;
  readonly requestedValue: string;
  readonly allowedValues: string[];

  constructor(sessionId: string, category: string, configId: string, requestedValue: string, allowedValues: string[]) {
    super(
      `Session '${sessionId}' does not support value '${requestedValue}' for category '${category}' (configId='${configId}'). Allowed values: ${allowedValues.join(", ") || "(none)"}`,
    );
    this.name = "UnsupportedSessionValueError";
    this.sessionId = sessionId;
    this.category = category;
    this.configId = configId;
    this.requestedValue = requestedValue;
    this.allowedValues = allowedValues;
  }
}

export class UnsupportedSessionConfigOptionError extends Error {
  readonly sessionId: string;
  readonly configId: string;
  readonly availableConfigIds: string[];

  constructor(sessionId: string, configId: string, availableConfigIds: string[]) {
    super(`Session '${sessionId}' does not expose config option '${configId}'. Available configIds: ${availableConfigIds.join(", ") || "(none)"}`);
    this.name = "UnsupportedSessionConfigOptionError";
    this.sessionId = sessionId;
    this.configId = configId;
    this.availableConfigIds = availableConfigIds;
  }
}

export class UnsupportedPermissionReplyError extends Error {
  readonly permissionId: string;
  readonly requestedReply: PermissionReply;
  readonly availableReplies: PermissionReply[];

  constructor(permissionId: string, requestedReply: PermissionReply, availableReplies: PermissionReply[]) {
    super(`Permission '${permissionId}' does not support reply '${requestedReply}'. Available replies: ${availableReplies.join(", ") || "(none)"}`);
    this.name = "UnsupportedPermissionReplyError";
    this.permissionId = permissionId;
    this.requestedReply = requestedReply;
    this.availableReplies = availableReplies;
  }
}

/**
 * Thrown by `resumeSession` (and by calls that restore a session on demand) when
 * the session was restored but some of its previous settings, such as the mode
 * or a config option, could not be applied again. `session` is restored and
 * usable; `failures` lists what was not applied.
 */
export class SessionConfigRestoreError extends Error {
  readonly session: Session;
  readonly failures: Array<{ category: string; configId: string; value: string; error: unknown }>;

  constructor(session: Session, failures: Array<{ category: string; configId: string; value: string; error: unknown }>) {
    const summary = failures
      .map((failure) => `${failure.configId}=${failure.value}: ${failure.error instanceof Error ? failure.error.message : String(failure.error)}`)
      .join("; ");
    super(`Session '${session.id}' was restored, but some previous settings could not be applied again: ${summary}`);
    this.name = "SessionConfigRestoreError";
    this.session = session;
    this.failures = failures;
  }
}

/**
 * Thrown when a request such as a prompt failed because the agent server went
 * away while it was being sent. The session has been restored (`session`), but
 * the request is not repeated automatically because the agent may already have
 * run it. Send it again if that is what you want.
 */
export class SessionRequestInterruptedError extends Error {
  readonly session: Session;
  readonly method: string;
  readonly cause: unknown;

  constructor(session: Session, method: string, cause: unknown) {
    super(
      `Session '${session.id}' lost its agent server during '${method}' and was restored; the request was not repeated because the agent may already have run it`,
    );
    this.name = "SessionRequestInterruptedError";
    this.session = session;
    this.method = method;
    this.cause = cause;
  }
}

/**
 * Thrown by session calls made after `dispose()` (they never start an agent
 * server or restore a session), and by a request that was still running when
 * `dispose()` was called. Such a request is not repeated, because the agent
 * may already have run it.
 */
export class SandboxAgentDisposedError extends Error {
  constructor(options?: { cause?: unknown }) {
    super("SandboxAgent was disposed", options);
    this.name = "SandboxAgentDisposedError";
  }
}

export class Session {
  private record: SessionRecord;
  private readonly sandbox: SandboxAgent;

  constructor(sandbox: SandboxAgent, record: SessionRecord) {
    this.sandbox = sandbox;
    this.record = { ...record };
  }

  get id(): string {
    return this.record.id;
  }

  get agent(): string {
    return this.record.agent;
  }

  get agentSessionId(): string {
    return this.record.agentSessionId;
  }

  get lastConnectionId(): string {
    return this.record.lastConnectionId;
  }

  /** Agent server the session was last attached to, if known. */
  get serverId(): string | undefined {
    return this.record.serverId;
  }

  get createdAt(): number {
    return this.record.createdAt;
  }

  get destroyedAt(): number | undefined {
    return this.record.destroyedAt;
  }

  async refresh(): Promise<Session> {
    const latest = await this.sandbox.getSession(this.id);
    if (!latest) {
      throw new Error(`session '${this.id}' no longer exists`);
    }
    this.apply(latest.toRecord());
    return this;
  }

  async rawSend(method: string, params: Record<string, unknown> = {}, options: SessionSendOptions = {}): Promise<unknown> {
    const updated = await this.sandbox.rawSendSessionMethod(this.id, method, params, options);
    this.apply(updated.session.toRecord());
    return updated.response;
  }

  async prompt(prompt: PromptRequest["prompt"]): Promise<PromptResponse> {
    const response = await this.rawSend("session/prompt", { prompt });
    return response as PromptResponse;
  }

  async setMode(modeId: string): Promise<SetSessionModeResponse | void> {
    const updated = await this.sandbox.setSessionMode(this.id, modeId);
    this.apply(updated.session.toRecord());
    return updated.response;
  }

  async setConfigOption(configId: string, value: string): Promise<SetSessionConfigOptionResponse> {
    const updated = await this.sandbox.setSessionConfigOption(this.id, configId, value);
    this.apply(updated.session.toRecord());
    return updated.response;
  }

  async setModel(model: string): Promise<SetSessionConfigOptionResponse> {
    const updated = await this.sandbox.setSessionModel(this.id, model);
    this.apply(updated.session.toRecord());
    return updated.response;
  }

  async setThoughtLevel(thoughtLevel: string): Promise<SetSessionConfigOptionResponse> {
    const updated = await this.sandbox.setSessionThoughtLevel(this.id, thoughtLevel);
    this.apply(updated.session.toRecord());
    return updated.response;
  }

  async getConfigOptions(): Promise<SessionConfigOption[]> {
    return this.sandbox.getSessionConfigOptions(this.id);
  }

  async getModes(): Promise<SessionModeState | null> {
    return this.sandbox.getSessionModes(this.id);
  }

  onEvent(listener: SessionEventListener): () => void {
    return this.sandbox.onSessionEvent(this.id, listener);
  }

  onPermissionRequest(listener: PermissionRequestListener): () => void {
    return this.sandbox.onPermissionRequest(this.id, listener);
  }

  onTurnEvent(listener: SessionTurnEventListener): () => void {
    return this.sandbox.onTurnEvent(this.id, listener);
  }

  async respondPermission(permissionId: string, reply: PermissionReply): Promise<void> {
    await this.sandbox.respondPermission(permissionId, reply);
  }

  async rawRespondPermission(permissionId: string, response: RequestPermissionResponse): Promise<void> {
    await this.sandbox.rawRespondPermission(permissionId, response);
  }

  toRecord(): SessionRecord {
    return { ...this.record };
  }

  apply(record: SessionRecord): void {
    this.record = { ...record };
  }
}

type TurnNotificationHandler = (connection: LiveAcpConnection, localSessionId: string, notification: SandboxAgentTurnNotification) => void;

type ObservedEnvelopeContext = {
  /** Event stream id, for envelopes that arrived over the event stream. */
  eventId?: string;
  /** Server instance generation from the event stream, see `AcpEnvelopeMeta`. */
  serverGeneration?: string;
  /**
   * Whether this client stores the envelope now. During another client's turn
   * that client stores the turn's events (in the order it saw them, after its
   * own prompt); this client delivers them to its listeners and keeps them in
   * a buffer for that turn (`foreignTurn`), which it stores after the turn
   * ended, so the turn is kept even if the prompting client died.
   */
  store: boolean;
  /** Buffer key of the foreign turn the envelope belongs to, when `store` is false. */
  foreignTurn?: number;
  /**
   * Whether the event index must be read from persistence again before
   * writing: at the start of this client's own prompt and for writes outside
   * its own turns, other clients may have written events since.
   */
  reseedIndex: boolean;
};

type ObservedEnvelopeHandler = (
  connection: LiveAcpConnection,
  envelope: AnyMessage,
  direction: AcpEnvelopeDirection,
  localSessionId: string | null,
  context: ObservedEnvelopeContext,
) => void;

type PermissionRequestContext = {
  /**
   * True when this client has a prompt of the session in flight, so the
   * permission request belongs to its own turn. Only a controlling client may
   * answer on its own (auto-cancel without a handler).
   */
  controlling: boolean;
  /** JSON-RPC id of the agent's request, matched against `input_resolved`. */
  rpcId?: string | number;
};

type PermissionRequestHandler = (
  connection: LiveAcpConnection,
  localSessionId: string,
  agentSessionId: string,
  request: RequestPermissionRequest,
  context: PermissionRequestContext,
) => Promise<RequestPermissionResponse>;

export class LiveAcpConnection {
  readonly connectionId: string;
  readonly agent: string;
  readonly serverId: string;
  /** Whether the agent advertised support for resuming an existing session. */
  readonly supportsResume: boolean;
  /**
   * True when this connection created its server. Only the creator deletes the
   * server when it closes; a connection that attached to an existing server
   * closes just its own event stream.
   */
  readonly ownsServer: boolean;
  /**
   * Creation time of the server instance (`createdAtMs` from the server list),
   * so event ids of a later server reusing the same id do not collide.
   */
  generation?: number;

  private readonly acp: AcpHttpClient;
  private readonly sessionByLocalId = new Map<string, string>();
  private readonly localByAgentSessionId = new Map<string, string>();
  private readonly pendingNewSessionLocals: string[] = [];
  private readonly pendingRequestSessionById = new Map<string, string>();
  private readonly pendingReplayByLocalSessionId = new Map<string, string>();
  // Prompts this connection sent that have not finished yet, per local session.
  private readonly activePromptsByLocalSessionId = new Map<string, number>();
  // Turns in progress per local session (turn request ids), split by whether
  // this client sent the prompt (its wire request id prefix) or another client.
  private readonly ownTurnsByLocalSessionId = new Map<string, Set<string>>();
  private readonly foreignTurnsByLocalSessionId = new Map<string, Set<string>>();
  // Buffer key of the current run of foreign turns, per local session.
  private readonly foreignTurnKeyByLocalSessionId = new Map<string, number>();
  private nextForeignTurnKey = 1;
  /**
   * Called when the foreign turns of a session are over (or can no longer be
   * followed: stream gap, stream stopped, connection closed). `responseEventId`
   * is the stored id the prompt response gets when the prompting client
   * received it over the event stream (the event just before `turn_ended`).
   */
  onForeignTurnFinished?: (connection: LiveAcpConnection, localSessionId: string, foreignTurn: number, responseEventId: string | undefined) => void;
  // JSON-RPC ids of permission requests seen on the event stream and not yet
  // handed to the handler, keyed by agent session id and tool call id.
  private readonly permissionRpcIds = new Map<string, string | number>();
  private lastAdapterExit: { success: boolean; code: number | null } | null = null;
  private lastAdapterExitAt = 0;

  private readonly onObservedEnvelope: ObservedEnvelopeHandler;
  private readonly onPermissionRequest: PermissionRequestHandler;
  private readonly onTurnEvent: TurnNotificationHandler;

  private constructor(
    agent: string,
    serverId: string,
    supportsResume: boolean,
    ownsServer: boolean,
    connectionId: string,
    acp: AcpHttpClient,
    onObservedEnvelope: ObservedEnvelopeHandler,
    onPermissionRequest: PermissionRequestHandler,
    onTurnEvent: TurnNotificationHandler,
  ) {
    this.agent = agent;
    this.serverId = serverId;
    this.supportsResume = supportsResume;
    this.ownsServer = ownsServer;
    this.connectionId = connectionId;
    this.acp = acp;
    this.onObservedEnvelope = onObservedEnvelope;
    this.onPermissionRequest = onPermissionRequest;
    this.onTurnEvent = onTurnEvent;
  }

  static async create(options: {
    baseUrl: string;
    token?: string;
    fetcher: typeof fetch;
    headers?: HeadersInit;
    auth?: SandboxAgentAuthOptions | false;
    agent: string;
    serverId: string;
    /**
     * Attach to a server that already exists: buffered events are not replayed,
     * the server is not created if it is gone (connecting fails instead), and
     * closing the connection leaves the server running.
     */
    attach?: boolean;
    onObservedEnvelope: ObservedEnvelopeHandler;
    onPermissionRequest: PermissionRequestHandler;
    /** Receives turn lifecycle notifications. Optional; they are dropped without it. */
    onTurnEvent?: TurnNotificationHandler;
  }): Promise<LiveAcpConnection> {
    const connectionId = randomId();
    const attach = options.attach === true;

    let live: LiveAcpConnection | null = null;
    const acp = new AcpHttpClient({
      baseUrl: options.baseUrl,
      token: options.token,
      fetch: options.fetcher,
      headers: options.headers,
      transport: {
        path: `${API_PREFIX}/acp/${encodeURIComponent(options.serverId)}`,
        // Without the agent the server rejects the first request instead of
        // creating the server, so attaching never starts a server of its own.
        bootstrapQuery: attach ? undefined : { agent: options.agent },
        skipBufferedEvents: attach,
      },
      client: {
        requestPermission: async (request: RequestPermissionRequest) => {
          if (!live) {
            return unansweredPermissionResponse();
          }
          return live.handlePermissionRequest(request);
        },
        sessionUpdate: async (_notification: SessionNotification) => {
          // Session updates are observed via envelope persistence.
        },
        extNotification: async (method: string, params: Record<string, unknown>) => {
          if (!live) return;
          live.handleAdapterNotification(method, params);
        },
      },
      onEnvelope: (envelope, direction, meta) => {
        if (!live) {
          return;
        }
        live.handleEnvelope(envelope, direction, meta);
      },
      onEventStreamStopped: () => {
        live?.finishAllTurns();
      },
    });

    let initResult: Awaited<ReturnType<AcpHttpClient["initialize"]>>;
    try {
      initResult = await acp.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: {
          name: "sandbox-agent-sdk",
          version: "v1",
        },
      });
    } catch (error) {
      await acp.disconnect({ deleteServer: !attach }).catch(() => {});
      throw error;
    }
    const supportsResume = initResult.agentCapabilities?.sessionCapabilities?.resume != null;
    live = new LiveAcpConnection(
      options.agent,
      options.serverId,
      supportsResume,
      !attach,
      connectionId,
      acp,
      options.onObservedEnvelope,
      options.onPermissionRequest,
      options.onTurnEvent ?? (() => {}),
    );

    if (initResult.authMethods && initResult.authMethods.length > 0) {
      try {
        await autoAuthenticate(acp, options.agent, initResult.authMethods, options.auth);
      } catch (error) {
        await acp.disconnect({ deleteServer: !attach }).catch(() => {});
        throw error;
      }
    }
    return live;
  }

  /**
   * Closes this connection. By default the server is deleted only when this
   * connection created it; `deleteServer` overrides that.
   */
  async close(options: { deleteServer?: boolean } = {}): Promise<void> {
    this.finishAllTurns();
    await this.acp.disconnect({ deleteServer: options.deleteServer ?? this.ownsServer });
  }

  hasBoundSession(localSessionId: string, agentSessionId?: string): boolean {
    const bound = this.sessionByLocalId.get(localSessionId);
    if (!bound) {
      return false;
    }
    if (agentSessionId && bound !== agentSessionId) {
      return false;
    }
    return true;
  }

  bindSession(localSessionId: string, agentSessionId: string): void {
    const previousAgentSessionId = this.sessionByLocalId.get(localSessionId);
    if (previousAgentSessionId && previousAgentSessionId !== agentSessionId) {
      this.localByAgentSessionId.delete(previousAgentSessionId);
    }
    this.sessionByLocalId.set(localSessionId, agentSessionId);
    this.localByAgentSessionId.set(agentSessionId, localSessionId);
  }

  /**
   * Forgets the agent session bound to a local session. With
   * `expectedAgentSessionId`, only when that is still the bound one, so a late
   * error about an older agent session does not drop a newer binding.
   */
  unbindSession(localSessionId: string, expectedAgentSessionId?: string): void {
    const agentSessionId = this.sessionByLocalId.get(localSessionId);
    if (expectedAgentSessionId !== undefined && agentSessionId !== expectedAgentSessionId) {
      return;
    }
    if (agentSessionId && this.localByAgentSessionId.get(agentSessionId) === localSessionId) {
      this.localByAgentSessionId.delete(agentSessionId);
    }
    this.sessionByLocalId.delete(localSessionId);
    this.pendingReplayByLocalSessionId.delete(localSessionId);
  }

  queueReplay(localSessionId: string, replayText: string | null): void {
    if (!replayText) {
      this.pendingReplayByLocalSessionId.delete(localSessionId);
      return;
    }
    this.pendingReplayByLocalSessionId.set(localSessionId, replayText);
  }

  async createRemoteSession(localSessionId: string, sessionInit: Omit<NewSessionRequest, "_meta">): Promise<NewSessionResponse> {
    const createStartedAt = Date.now();
    this.pendingNewSessionLocals.push(localSessionId);

    try {
      const response = await this.acp.newSession(sessionInit);
      this.bindSession(localSessionId, response.sessionId);
      return response;
    } catch (error) {
      const index = this.pendingNewSessionLocals.indexOf(localSessionId);
      if (index !== -1) {
        this.pendingNewSessionLocals.splice(index, 1);
      }
      const adapterExit = this.lastAdapterExit;
      if (adapterExit && this.lastAdapterExitAt >= createStartedAt) {
        const suffix = adapterExit.code == null ? "" : ` (code ${adapterExit.code})`;
        throw new Error(`Agent process exited while creating session${suffix}`);
      }
      throw error;
    }
  }

  /**
   * Reattach an agent session that already exists (in this server process or in
   * the agent's own storage). The session is bound first so notifications sent
   * while resuming are attributed to it; it is unbound again if resuming fails.
   */
  async resumeRemoteSession(
    localSessionId: string,
    agentSessionId: string,
    sessionInit: Omit<NewSessionRequest, "_meta">,
  ): Promise<{ configOptions?: SessionConfigOption[] | null; modes?: SessionModeState | null }> {
    this.bindSession(localSessionId, agentSessionId);
    try {
      return await this.acp.unstableResumeSession({
        sessionId: agentSessionId,
        cwd: sessionInit.cwd,
        mcpServers: sessionInit.mcpServers,
      });
    } catch (error) {
      this.unbindSession(localSessionId);
      throw error;
    }
  }

  async sendSessionMethod(localSessionId: string, method: string, params: Record<string, unknown>, options: SessionSendOptions): Promise<unknown> {
    const agentSessionId = this.sessionByLocalId.get(localSessionId);
    if (!agentSessionId) {
      throw new Error(`session '${localSessionId}' is not bound to live ACP connection '${this.connectionId}'`);
    }

    const mappedParams = mapSessionParams(params, agentSessionId);

    if (method === "session/prompt") {
      const replayText = this.pendingReplayByLocalSessionId.get(localSessionId);
      if (replayText) {
        // TODO: Replace this synthesized replay text with ACP-native restore once standardized.
        this.pendingReplayByLocalSessionId.delete(localSessionId);
        injectReplayPrompt(mappedParams, replayText);
      }

      if (options.notification) {
        await this.acp.extNotification(method, mappedParams);
        return undefined;
      }

      this.activePromptsByLocalSessionId.set(localSessionId, (this.activePromptsByLocalSessionId.get(localSessionId) ?? 0) + 1);
      try {
        return await this.acp.prompt(mappedParams as PromptRequest);
      } finally {
        const remaining = (this.activePromptsByLocalSessionId.get(localSessionId) ?? 1) - 1;
        if (remaining > 0) {
          this.activePromptsByLocalSessionId.set(localSessionId, remaining);
        } else {
          this.activePromptsByLocalSessionId.delete(localSessionId);
        }
      }
    }

    if (method === "session/cancel") {
      await this.acp.cancel(mappedParams as CancelNotification);
      return undefined;
    }

    if (method === "session/set_mode") {
      return this.acp.setSessionMode(mappedParams as SetSessionModeRequest);
    }

    if (method === "session/set_config_option") {
      return this.acp.setSessionConfigOption(mappedParams as SetSessionConfigOptionRequest);
    }

    if (options.notification) {
      await this.acp.extNotification(method, mappedParams);
      return undefined;
    }

    return this.acp.extMethod(method, mappedParams);
  }

  private handleEnvelope(envelope: AnyMessage, direction: AcpEnvelopeDirection, meta: AcpEnvelopeMeta | undefined): void {
    if (meta?.streamGap) {
      // Events were lost (the server's buffer moved past this client), so a
      // turn_ended may be missing: forget the turns in progress.
      this.resetTurns();
    }
    if (direction === "inbound") {
      const method = envelopeMethod(envelope);
      if (method === PERMISSION_REQUEST_METHOD) {
        this.rememberPermissionRpcId(envelope);
      }
      const turn = method ? parseSandboxAgentTurnNotification(method, (envelope as { params?: unknown }).params) : null;
      if (turn) {
        // Turn signals are not conversation history: deliver them to turn
        // listeners instead of persisting them as session events.
        const localSessionId = this.localByAgentSessionId.get(turn.params.sessionId);
        if (localSessionId) {
          this.trackTurn(localSessionId, turn, meta);
          this.onTurnEvent(this, localSessionId, turn);
        }
        return;
      }
    }
    const localSessionId = this.resolveSessionId(envelope, direction);
    const activePrompt = localSessionId !== null && (this.activePromptsByLocalSessionId.get(localSessionId) ?? 0) > 0;
    const ownTurn = activePrompt || (localSessionId !== null && (this.ownTurnsByLocalSessionId.get(localSessionId)?.size ?? 0) > 0);
    const foreignTurn = localSessionId !== null && (this.foreignTurnsByLocalSessionId.get(localSessionId)?.size ?? 0) > 0;
    const isOwnPrompt = direction === "outbound" && envelopeMethod(envelope) === "session/prompt";
    const store = direction === "outbound" || ownTurn || !foreignTurn;
    this.onObservedEnvelope(this, envelope, direction, localSessionId, {
      eventId: meta?.eventId,
      serverGeneration: meta?.serverGeneration,
      store,
      foreignTurn: store || localSessionId === null ? undefined : this.foreignTurnKeyByLocalSessionId.get(localSessionId),
      reseedIndex: !activePrompt || isOwnPrompt,
    });
  }

  /**
   * A turn is this client's own when its request id carries this client's
   * wire id prefix (also when the prompt's HTTP request failed after the
   * server accepted it), otherwise another client's.
   */
  private trackTurn(localSessionId: string, turn: SandboxAgentTurnNotification, meta: AcpEnvelopeMeta | undefined): void {
    const requestId = String(turn.params.requestId);
    if (turn.method === SANDBOX_AGENT_TURN_STARTED) {
      const own = this.acp.isOwnWireRequestId(turn.params.requestId);
      const byLocal = own ? this.ownTurnsByLocalSessionId : this.foreignTurnsByLocalSessionId;
      const turns = byLocal.get(localSessionId) ?? new Set<string>();
      if (!own && turns.size === 0) {
        this.foreignTurnKeyByLocalSessionId.set(localSessionId, this.nextForeignTurnKey++);
      }
      turns.add(requestId);
      byLocal.set(localSessionId, turns);
      return;
    }
    if (turn.method === SANDBOX_AGENT_TURN_ENDED) {
      const own = this.ownTurnsByLocalSessionId.get(localSessionId);
      own?.delete(requestId);
      if (own && own.size === 0) {
        this.ownTurnsByLocalSessionId.delete(localSessionId);
      }
      const foreign = this.foreignTurnsByLocalSessionId.get(localSessionId);
      if (foreign?.delete(requestId) && foreign.size === 0) {
        // The server publishes the prompt response right before turn_ended.
        const sequence = meta?.eventId !== undefined && /^\d+$/.test(meta.eventId) ? BigInt(meta.eventId) : undefined;
        const responseEventId =
          sequence !== undefined && sequence > 0n && meta?.serverGeneration !== undefined
            ? `${this.serverId}@${meta.serverGeneration}:${sequence - 1n}`
            : undefined;
        this.finishForeignTurns(localSessionId, responseEventId);
      }
    }
  }

  private finishForeignTurns(localSessionId: string, responseEventId?: string): void {
    this.foreignTurnsByLocalSessionId.delete(localSessionId);
    const key = this.foreignTurnKeyByLocalSessionId.get(localSessionId);
    this.foreignTurnKeyByLocalSessionId.delete(localSessionId);
    if (key !== undefined) {
      this.onForeignTurnFinished?.(this, localSessionId, key, responseEventId);
    }
  }

  /** Stops following the turns in progress (the connection closes or its stream stopped). */
  finishAllTurns(): void {
    this.resetTurns();
  }

  private resetTurns(): void {
    this.ownTurnsByLocalSessionId.clear();
    for (const localSessionId of [...this.foreignTurnsByLocalSessionId.keys()]) {
      this.finishForeignTurns(localSessionId);
    }
  }

  private rememberPermissionRpcId(envelope: AnyMessage): void {
    const id = (envelope as { id?: unknown }).id;
    const params = (envelope as { params?: { sessionId?: unknown; toolCall?: { toolCallId?: unknown } } }).params;
    if ((typeof id !== "string" && typeof id !== "number") || typeof params?.sessionId !== "string") {
      return;
    }
    this.permissionRpcIds.set(permissionKey(params.sessionId, params.toolCall?.toolCallId), id);
  }

  private handleAdapterNotification(method: string, params: Record<string, unknown>): void {
    if (method !== "_adapter/agent_exited") {
      return;
    }
    this.lastAdapterExit = {
      success: params.success === true,
      code: typeof params.code === "number" ? params.code : null,
    };
    this.lastAdapterExitAt = Date.now();
  }

  private async handlePermissionRequest(request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const agentSessionId = request.sessionId;
    const key = permissionKey(agentSessionId, request.toolCall?.toolCallId);
    const rpcId = this.permissionRpcIds.get(key);
    this.permissionRpcIds.delete(key);
    const localSessionId = this.localByAgentSessionId.get(agentSessionId);
    if (!localSessionId) {
      // Another client's session on the shared server: that client answers.
      return unansweredPermissionResponse();
    }

    return this.onPermissionRequest(this, localSessionId, agentSessionId, clonePermissionRequest(request), {
      controlling: (this.activePromptsByLocalSessionId.get(localSessionId) ?? 0) > 0,
      rpcId,
    });
  }

  private resolveSessionId(envelope: AnyMessage, direction: AcpEnvelopeDirection): string | null {
    const id = envelopeId(envelope);
    const method = envelopeMethod(envelope);

    if (direction === "outbound") {
      if (id && method === "session/new") {
        const localSessionId = this.pendingNewSessionLocals.shift() ?? null;
        if (localSessionId) {
          this.pendingRequestSessionById.set(id, localSessionId);
        }
        return localSessionId;
      }

      const localFromParams = this.localFromEnvelopeParams(envelope);
      if (id && localFromParams) {
        this.pendingRequestSessionById.set(id, localFromParams);
      }
      return localFromParams;
    }

    if (id) {
      const pending = this.pendingRequestSessionById.get(id) ?? null;
      if (pending) {
        this.pendingRequestSessionById.delete(id);
        const sessionIdFromResult = envelopeSessionIdFromResult(envelope);
        if (sessionIdFromResult) {
          this.bindSession(pending, sessionIdFromResult);
        }
        return pending;
      }
    }

    return this.localFromEnvelopeParams(envelope);
  }

  private localFromEnvelopeParams(envelope: AnyMessage): string | null {
    const agentSessionId = envelopeSessionIdFromParams(envelope);
    if (!agentSessionId) {
      return null;
    }
    return this.localByAgentSessionId.get(agentSessionId) ?? null;
  }
}

export class ProcessTerminalSession {
  readonly socket: WebSocket;
  readonly closed: Promise<void>;

  private readonly readyListeners = new Set<(status: TerminalReadyStatus) => void>();
  private readonly dataListeners = new Set<(data: Uint8Array) => void>();
  private readonly exitListeners = new Set<(status: TerminalExitStatus) => void>();
  private readonly errorListeners = new Set<(error: TerminalErrorStatus | Error) => void>();
  private readonly closeListeners = new Set<() => void>();

  private closeSignalSent = false;
  private closedResolve!: () => void;

  constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.binaryType = "arraybuffer";
    this.closed = new Promise<void>((resolve) => {
      this.closedResolve = resolve;
    });

    this.socket.addEventListener("message", (event) => {
      void this.handleMessage(event.data);
    });
    this.socket.addEventListener("error", () => {
      this.emitError(new Error("Terminal websocket connection failed."));
    });
    this.socket.addEventListener("close", () => {
      this.closedResolve();
      for (const listener of this.closeListeners) {
        listener();
      }
    });
  }

  onReady(listener: (status: TerminalReadyStatus) => void): () => void {
    this.readyListeners.add(listener);
    return () => {
      this.readyListeners.delete(listener);
    };
  }

  onData(listener: (data: Uint8Array) => void): () => void {
    this.dataListeners.add(listener);
    return () => {
      this.dataListeners.delete(listener);
    };
  }

  onExit(listener: (status: TerminalExitStatus) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  onError(listener: (error: TerminalErrorStatus | Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  onClose(listener: () => void): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  sendInput(data: string | ArrayBuffer | ArrayBufferView): void {
    const payload = encodeTerminalInput(data);
    this.sendFrame({
      type: "input",
      data: payload.data,
      encoding: payload.encoding,
    });
  }

  resize(payload: TerminalResizePayload): void {
    this.sendFrame({
      type: "resize",
      cols: payload.cols,
      rows: payload.rows,
    });
  }

  close(): void {
    if (this.socket.readyState === WS_READY_STATE_CONNECTING) {
      this.socket.addEventListener(
        "open",
        () => {
          this.close();
        },
        { once: true },
      );
      return;
    }

    if (this.socket.readyState === WS_READY_STATE_OPEN) {
      if (!this.closeSignalSent) {
        this.closeSignalSent = true;
        this.sendFrame({ type: "close" });
      }
      this.socket.close();
      return;
    }

    if (this.socket.readyState !== WS_READY_STATE_CLOSED) {
      this.socket.close();
    }
  }

  private async handleMessage(data: unknown): Promise<void> {
    try {
      if (typeof data === "string") {
        const frame = parseProcessTerminalServerFrame(data);
        if (!frame) {
          this.emitError(new Error("Received invalid terminal control frame."));
          return;
        }

        if (frame.type === "ready") {
          for (const listener of this.readyListeners) {
            listener(frame);
          }
          return;
        }

        if (frame.type === "exit") {
          for (const listener of this.exitListeners) {
            listener(frame);
          }
          return;
        }

        this.emitError(frame);
        return;
      }

      const bytes = await decodeTerminalBytes(data);
      for (const listener of this.dataListeners) {
        listener(bytes);
      }
    } catch (error) {
      this.emitError(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private sendFrame(frame: ProcessTerminalClientFrame): void {
    if (this.socket.readyState !== WS_READY_STATE_OPEN) {
      return;
    }

    this.socket.send(JSON.stringify(frame));
  }

  private emitError(error: TerminalErrorStatus | Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }
}

const WS_READY_STATE_CONNECTING = 0;
const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSED = 3;

export class SandboxAgent {
  private readonly baseUrl: string;
  private readonly token?: string;
  private readonly fetcher: typeof fetch;
  private readonly defaultHeaders?: HeadersInit;
  private readonly auth?: SandboxAgentAuthOptions | false;
  private readonly healthWait: NormalizedHealthWaitOptions;
  private readonly healthWaitAbortController = new AbortController();
  private sandboxProvider?: SandboxProvider;
  private sandboxProviderId?: string;
  private sandboxProviderRawId?: string;
  private sandboxInspectorUrl?: string;

  private readonly persist: SessionPersistDriver;
  private readonly replayMaxEvents: number;
  private readonly replayMaxChars: number;
  private readonly cancelUnansweredPermissionsAfterMs?: number;
  // Timers of the opt-in cancellation of other clients' unanswered requests.
  private readonly passivePermissionTimers = new Set<PassivePermissionTimer>();
  // Events of other clients' turns, stored after the turn ended (see
  // ObservedEnvelopeContext.store). Keyed by session, connection and turn key.
  private readonly foreignTurnBuffers = new Map<string, SessionEvent[]>();
  // Buffers that hit MAX_FOREIGN_TURN_BUFFER_EVENTS: the rest of that turn is not kept.
  private readonly overflowedForeignTurns = new Set<string>();
  // Pending checks of finished foreign turns, by buffer key.
  private readonly foreignTurnChecks = new Map<string, { sessionId: string; timer: ReturnType<typeof setTimeout> }>();

  private healthPromise?: Promise<void>;
  private healthError?: Error;
  private disposed = false;

  // Keyed by server id. One SDK instance can hold several connections for the
  // same agent when it reattaches sessions that ran on other servers.
  private readonly liveConnections = new Map<string, LiveAcpConnection>();
  private readonly pendingLiveConnections = new Map<string, Promise<LiveAcpConnection>>();
  private readonly pendingLiveConnectionsByAgent = new Map<string, Promise<LiveAcpConnection>>();
  private readonly pendingSessionRestores = new Map<string, Promise<Session>>();
  private readonly sessionHandles = new Map<string, Session>();
  private readonly eventListeners = new Map<string, Set<SessionEventListener>>();
  private readonly permissionListeners = new Map<string, Set<PermissionRequestListener>>();
  private readonly turnListeners = new Map<string, Set<SessionTurnEventListener>>();
  private readonly pendingPermissionRequests = new Map<string, PendingPermissionRequestState>();
  private readonly nextSessionEventIndexBySession = new Map<string, number>();
  private readonly seedSessionEventIndexBySession = new Map<string, Promise<void>>();
  private readonly pendingObservedEnvelopePersistenceBySession = new Map<string, Promise<void>>();

  constructor(options: SandboxAgentConnectOptions) {
    const baseUrl = options.baseUrl?.trim();
    if (!baseUrl && !options.fetch) {
      throw new Error("baseUrl is required unless fetch is provided.");
    }
    this.baseUrl = (baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.token = options.token;
    const resolvedFetch = options.fetch ?? globalThis.fetch?.bind(globalThis);
    if (!resolvedFetch) {
      throw new Error("Fetch API is not available; provide a fetch implementation.");
    }
    this.fetcher = resolvedFetch;
    this.defaultHeaders = options.headers;
    this.auth = options.auth;
    this.healthWait = normalizeHealthWaitOptions(options.skipHealthCheck, options.waitForHealth, options.signal);
    this.persist = options.persist ?? new InMemorySessionPersistDriver();

    this.replayMaxEvents = normalizePositiveInt(options.replayMaxEvents, DEFAULT_REPLAY_MAX_EVENTS);
    this.replayMaxChars = normalizePositiveInt(options.replayMaxChars, DEFAULT_REPLAY_MAX_CHARS);
    const cancelAfter = options.cancelUnansweredPermissionsAfterMs;
    this.cancelUnansweredPermissionsAfterMs = typeof cancelAfter === "number" && Number.isFinite(cancelAfter) && cancelAfter >= 0 ? cancelAfter : undefined;

    this.startHealthWait();
  }

  static async connect(options: SandboxAgentConnectOptions): Promise<SandboxAgent> {
    return new SandboxAgent(options);
  }

  static async start(options: SandboxAgentStartOptions): Promise<SandboxAgent> {
    const provider = options.sandbox;
    if (!provider.getUrl && !provider.getFetch) {
      throw new Error(`Sandbox provider '${provider.name}' must implement getUrl() or getFetch().`);
    }

    const existingSandbox = options.sandboxId ? parseSandboxProviderId(options.sandboxId) : null;

    if (existingSandbox && existingSandbox.provider !== provider.name) {
      throw new Error(
        `SandboxAgent.start received sandboxId '${options.sandboxId}' for provider '${existingSandbox.provider}', but the configured provider is '${provider.name}'.`,
      );
    }

    const rawSandboxId = existingSandbox?.rawId ?? (await provider.create());
    const prefixedSandboxId = `${provider.name}/${rawSandboxId}`;
    const createdSandbox = !existingSandbox;

    if (existingSandbox) {
      await provider.reconnect?.(rawSandboxId);
      await provider.ensureServer?.(rawSandboxId);
    }

    try {
      const fetcher = await resolveProviderFetch(provider, rawSandboxId);
      const baseUrl = provider.getUrl ? await provider.getUrl(rawSandboxId) : undefined;
      const inspectorUrl = provider.getInspectorUrl ? await provider.getInspectorUrl(rawSandboxId, baseUrl) : undefined;
      const providerFetch = options.fetch ?? fetcher;
      const commonConnectOptions = {
        auth: options.auth,
        headers: options.headers,
        persist: options.persist,
        replayMaxEvents: options.replayMaxEvents,
        replayMaxChars: options.replayMaxChars,
        cancelUnansweredPermissionsAfterMs: options.cancelUnansweredPermissionsAfterMs,
        signal: options.signal,
        skipHealthCheck: options.skipHealthCheck,
        token: options.token ?? (await resolveProviderToken(provider, rawSandboxId)),
      };

      const client = providerFetch
        ? new SandboxAgent({
            ...commonConnectOptions,
            baseUrl,
            fetch: providerFetch,
          })
        : new SandboxAgent({
            ...commonConnectOptions,
            baseUrl: requireSandboxBaseUrl(baseUrl, provider.name),
          });

      client.sandboxProvider = provider;
      client.sandboxProviderId = prefixedSandboxId;
      client.sandboxProviderRawId = rawSandboxId;
      client.sandboxInspectorUrl = inspectorUrl;
      return client;
    } catch (error) {
      if (createdSandbox) {
        try {
          await provider.destroy(rawSandboxId);
        } catch {
          // Best-effort cleanup if connect fails after provisioning.
        }
      }
      throw error;
    }
  }

  get sandboxId(): string | undefined {
    return this.sandboxProviderId;
  }

  get sandbox(): SandboxProvider | undefined {
    return this.sandboxProvider;
  }

  get inspectorUrl(): string {
    return this.sandboxInspectorUrl ?? `${this.baseUrl.replace(/\/+$/, "")}/ui/`;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.healthWaitAbortController.abort(createAbortError("SandboxAgent was disposed."));

    for (const [permissionId, pending] of this.pendingPermissionRequests) {
      this.pendingPermissionRequests.delete(permissionId);
      // A request of another client's turn is left for that client to answer.
      if (pending.controlling) {
        pending.resolve(cancelledPermissionResponse());
      }
    }
    for (const timer of this.passivePermissionTimers) {
      clearTimeout(timer.handle);
    }
    this.passivePermissionTimers.clear();
    for (const check of this.foreignTurnChecks.values()) {
      clearTimeout(check.timer);
    }
    this.foreignTurnChecks.clear();
    this.foreignTurnBuffers.clear();
    this.overflowedForeignTurns.clear();

    const connections = [...this.liveConnections.values()];
    this.liveConnections.clear();
    const pending = [...this.pendingLiveConnections.values()];
    this.pendingLiveConnections.clear();
    this.pendingLiveConnectionsByAgent.clear();
    this.pendingObservedEnvelopePersistenceBySession.clear();

    const pendingSettled = await Promise.allSettled(pending);
    for (const item of pendingSettled) {
      if (item.status === "fulfilled") {
        connections.push(item.value);
      }
    }

    await Promise.all(
      connections.map(async (connection) => {
        await connection.close();
      }),
    );
  }

  async destroySandbox(): Promise<void> {
    const provider = this.sandboxProvider;
    const rawSandboxId = this.sandboxProviderRawId;

    try {
      if (provider && rawSandboxId) {
        await provider.destroy(rawSandboxId);
      } else if (!provider || !rawSandboxId) {
        throw new Error("SandboxAgent is not attached to a provisioned sandbox.");
      }
    } finally {
      await this.dispose();
      this.sandboxProvider = undefined;
      this.sandboxProviderId = undefined;
      this.sandboxProviderRawId = undefined;
    }
  }

  async pauseSandbox(): Promise<void> {
    const provider = this.sandboxProvider;
    const rawSandboxId = this.sandboxProviderRawId;

    try {
      if (provider && rawSandboxId) {
        if (provider.pause) {
          await provider.pause(rawSandboxId);
        } else {
          await provider.destroy(rawSandboxId);
        }
      } else if (!provider || !rawSandboxId) {
        throw new Error("SandboxAgent is not attached to a provisioned sandbox.");
      }
    } finally {
      await this.dispose();
      this.sandboxProvider = undefined;
      this.sandboxProviderId = undefined;
      this.sandboxProviderRawId = undefined;
    }
  }

  async killSandbox(): Promise<void> {
    const provider = this.sandboxProvider;
    const rawSandboxId = this.sandboxProviderRawId;

    try {
      if (provider && rawSandboxId) {
        if (provider.kill) {
          await provider.kill(rawSandboxId);
        } else {
          await provider.destroy(rawSandboxId);
        }
      } else if (!provider || !rawSandboxId) {
        throw new Error("SandboxAgent is not attached to a provisioned sandbox.");
      }
    } finally {
      await this.dispose();
      this.sandboxProvider = undefined;
      this.sandboxProviderId = undefined;
      this.sandboxProviderRawId = undefined;
    }
  }

  async listSessions(request: ListPageRequest = {}): Promise<ListPage<Session>> {
    const page = await this.persist.listSessions(request);
    return {
      items: page.items.map((record) => this.upsertSessionHandle(record)),
      nextCursor: page.nextCursor,
    };
  }

  async getSession(id: string): Promise<Session | null> {
    const record = await this.persist.getSession(id);
    if (!record) {
      return null;
    }
    return this.upsertSessionHandle(record);
  }

  async getEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    return this.persist.listEvents(request);
  }

  async createSession(request: SessionCreateRequest): Promise<Session> {
    if (!request.agent.trim()) {
      throw new Error("createSession requires a non-empty agent");
    }
    this.assertNotDisposed();

    const localSessionId = request.id?.trim() || randomId();
    const sessionInit = normalizeSessionInit(request.sessionInit, request.cwd, this.sandboxProvider?.defaultCwd);
    let live: LiveAcpConnection;
    let response: NewSessionResponse;
    try {
      live = await this.getLiveConnection(request.agent.trim());
      response = await live.createRemoteSession(localSessionId, sessionInit);
    } catch (error) {
      throw this.disposedErrorOr(error);
    }

    const record: SessionRecord = {
      id: localSessionId,
      agent: request.agent.trim(),
      agentSessionId: response.sessionId,
      serverId: live.serverId,
      lastConnectionId: live.connectionId,
      createdAt: nowMs(),
      sandboxId: this.sandboxProviderId,
      sessionInit,
      configOptions: cloneConfigOptions(response.configOptions),
      modes: cloneModes(response.modes),
    };

    await this.persist.updateSession(record);
    live.bindSession(record.id, record.agentSessionId);
    let session = this.upsertSessionHandle(record);

    try {
      if (request.mode) {
        session = (await this.setSessionMode(session.id, request.mode)).session;
      }
      if (request.model) {
        session = (await this.setSessionModel(session.id, request.model)).session;
      }
      if (request.thoughtLevel) {
        session = (await this.setSessionThoughtLevel(session.id, request.thoughtLevel)).session;
      }
    } catch (err) {
      try {
        await this.destroySession(session.id);
      } catch {
        // Best-effort cleanup
      }
      throw err;
    }

    return session;
  }

  async resumeSession(id: string): Promise<Session> {
    this.assertNotDisposed();
    const existing = await this.persist.getSession(id);
    if (!existing) {
      throw new Error(`session '${id}' not found`);
    }

    const bound = this.findBoundLiveConnection(existing);
    if (bound && existing.lastConnectionId === bound.connectionId) {
      return this.upsertSessionHandle(existing);
    }

    return this.restoreSession(existing);
  }

  /**
   * Attach a persisted session to a live agent connection. Prefers the server
   * the session last ran on; when the agent supports resume, the existing agent
   * session is reattached without replaying history. Otherwise a new agent
   * session is created and history is replayed on the next prompt. Either way,
   * the previous mode and config options are applied again.
   */
  private restoreSession(existing: SessionRecord): Promise<Session> {
    if (this.disposed) {
      return Promise.reject(new SandboxAgentDisposedError());
    }
    const pending = this.pendingSessionRestores.get(existing.id);
    if (pending) {
      return pending;
    }

    const restoring = (async () => {
      // The caller's record can be stale: a restore that finished after it was
      // read already bound the session again here. Use that one instead of
      // starting a second restore (an orphaned agent session and a second replay).
      const latest = await this.persist.getSession(existing.id);
      if (latest && (latest.agentSessionId !== existing.agentSessionId || latest.lastConnectionId !== existing.lastConnectionId)) {
        const bound = this.findBoundLiveConnection(latest);
        if (bound && latest.lastConnectionId === bound.connectionId) {
          return this.upsertSessionHandle(latest);
        }
      }

      const live = await this.getLiveConnection(existing.agent, existing.serverId);
      const sessionInit = normalizeSessionInit(existing.sessionInit, undefined, this.sandboxProvider?.defaultCwd);

      const resumed = live.supportsResume ? await this.tryResumeRemoteSession(existing, live, sessionInit) : null;
      const restored = resumed ?? (await this.recreateRemoteSession(existing, live, sessionInit));

      return this.reapplySessionSettings(existing, restored);
    })().catch((error: unknown) => {
      throw this.disposedErrorOr(error);
    });

    this.pendingSessionRestores.set(existing.id, restoring);
    return restoring.finally(() => {
      if (this.pendingSessionRestores.get(existing.id) === restoring) {
        this.pendingSessionRestores.delete(existing.id);
      }
    });
  }

  private async tryResumeRemoteSession(
    existing: SessionRecord,
    live: LiveAcpConnection,
    sessionInit: Omit<NewSessionRequest, "_meta">,
  ): Promise<SessionRecord | null> {
    let response: { configOptions?: SessionConfigOption[] | null; modes?: SessionModeState | null };
    try {
      response = await live.resumeRemoteSession(existing.id, existing.agentSessionId, sessionInit);
    } catch (error) {
      if (error instanceof AcpRpcError && (RESUME_FALLBACK_ERROR_CODES.has(error.code) || isMissingRemoteSessionError(error, existing.agentSessionId))) {
        // The agent cannot resume this session (not supported, unknown or
        // expired, or rejected as invalid; some agents report an unknown
        // session only by message). Fall back to creating a new one.
        return null;
      }
      // Anything else (a transport failure, an internal agent error) may be
      // temporary: creating a new session would lose the agent's history.
      throw error;
    }

    const updated: SessionRecord = {
      ...existing,
      serverId: live.serverId,
      lastConnectionId: live.connectionId,
      destroyedAt: undefined,
      configOptions: cloneConfigOptions(response.configOptions) ?? existing.configOptions,
      modes: cloneModes(response.modes) ?? existing.modes,
    };
    await this.persist.updateSession(updated);
    return updated;
  }

  private async recreateRemoteSession(existing: SessionRecord, live: LiveAcpConnection, sessionInit: Omit<NewSessionRequest, "_meta">): Promise<SessionRecord> {
    const replaySource = await this.collectReplayEvents(existing.id, this.replayMaxEvents);
    const replayText = buildReplayText(replaySource, this.replayMaxChars);

    const recreated = await live.createRemoteSession(existing.id, sessionInit);

    const updated: SessionRecord = {
      ...existing,
      agentSessionId: recreated.sessionId,
      serverId: live.serverId,
      lastConnectionId: live.connectionId,
      destroyedAt: undefined,
      configOptions: cloneConfigOptions(recreated.configOptions),
      modes: cloneModes(recreated.modes),
    };

    await this.persist.updateSession(updated);
    live.bindSession(updated.id, updated.agentSessionId);
    live.queueReplay(updated.id, replayText);
    return updated;
  }

  /**
   * Apply the mode and config option values the session had before it was
   * restored, where the agent now reports something different. Every value is
   * attempted; failures are collected and thrown together as
   * SessionConfigRestoreError, which still carries the restored session.
   */
  private async reapplySessionSettings(previous: SessionRecord, current: SessionRecord): Promise<Session> {
    let session = this.upsertSessionHandle(current);

    const previousModeOption = findConfigOptionByCategory(previous.configOptions ?? [], "mode");
    const previousModeId = nonEmptyString(previous.modes?.currentModeId) ?? nonEmptyString(previousModeOption?.currentValue);
    const previousValues = (previous.configOptions ?? []).flatMap((option) => {
      const value = nonEmptyString(option.currentValue);
      return option.category !== "mode" && value ? [{ option, value }] : [];
    });
    if (!previousModeId && previousValues.length === 0) {
      return session;
    }

    const currentOptions = await this.getSessionConfigOptions(current.id);
    const currentModeId = (await this.getSessionModes(current.id))?.currentModeId;
    const failures: SessionConfigRestoreError["failures"] = [];

    if (previousModeId && previousModeId !== currentModeId) {
      const modeConfigId = findConfigOptionByCategory(currentOptions, "mode")?.id;
      try {
        session = await this.reapplySessionMode(current.id, previousModeId, modeConfigId);
      } catch (error) {
        failures.push({ category: "mode", configId: modeConfigId ?? "mode", value: previousModeId, error });
      }
    }

    for (const { option, value } of previousValues) {
      const now = currentOptions.find((candidate) => candidate.id === option.id);
      if (now?.currentValue === value) {
        continue;
      }
      try {
        session = (await this.sendSessionMethodInternal(current.id, "session/set_config_option", { configId: option.id, value }, {}, false, false)).session;
      } catch (error) {
        failures.push({ category: option.category ?? "uncategorized", configId: option.id, value, error });
      }
    }

    if (failures.length > 0) {
      const error = new SessionConfigRestoreError(session, failures);
      console.warn(error.message);
      throw error;
    }
    return session;
  }

  private async reapplySessionMode(sessionId: string, modeId: string, modeConfigId: string | undefined): Promise<Session> {
    try {
      return (await this.sendSessionMethodInternal(sessionId, "session/set_mode", { modeId }, {}, false, false)).session;
    } catch (error) {
      if (!(error instanceof AcpRpcError) || error.code !== -32601 || !modeConfigId) {
        throw error;
      }
      const fallback = await this.sendSessionMethodInternal(
        sessionId,
        "session/set_config_option",
        { configId: modeConfigId, value: modeId },
        {},
        false,
        false,
      );
      return fallback.session;
    }
  }

  async resumeOrCreateSession(request: SessionResumeOrCreateRequest): Promise<Session> {
    const existing = await this.persist.getSession(request.id);
    if (existing) {
      let session = await this.resumeSession(existing.id);
      if (request.mode) {
        session = (await this.setSessionMode(session.id, request.mode)).session;
      }
      if (request.model) {
        session = (await this.setSessionModel(session.id, request.model)).session;
      }
      if (request.thoughtLevel) {
        session = (await this.setSessionThoughtLevel(session.id, request.thoughtLevel)).session;
      }
      return session;
    }
    return this.createSession(request);
  }

  async destroySession(id: string): Promise<Session> {
    this.cancelPendingPermissionsForSession(id);
    this.clearPassivePermissionTimers((timer) => timer.sessionId === id);
    this.dropForeignTurnsOfSession(id);

    try {
      await this.sendSessionMethodInternal(id, SESSION_CANCEL_METHOD, {}, {}, true);
    } catch {
      // Best-effort: agent may already be gone
    }
    const existing = await this.requireSessionRecord(id);

    const updated: SessionRecord = {
      ...existing,
      destroyedAt: nowMs(),
    };

    await this.persist.updateSession(updated);
    return this.upsertSessionHandle(updated);
  }

  async setSessionMode(sessionId: string, modeId: string): Promise<{ session: Session; response: SetSessionModeResponse | void }> {
    const mode = modeId.trim();
    if (!mode) {
      throw new Error("setSessionMode requires a non-empty modeId");
    }

    const record = await this.requireSessionRecord(sessionId);
    const knownModeIds = extractKnownModeIds(record.modes);
    if (knownModeIds.length > 0 && !knownModeIds.includes(mode)) {
      throw new UnsupportedSessionValueError(sessionId, "mode", "mode", mode, knownModeIds);
    }

    try {
      return (await this.sendSessionMethodInternal(sessionId, "session/set_mode", { modeId: mode }, {}, false)) as {
        session: Session;
        response: SetSessionModeResponse | void;
      };
    } catch (error) {
      if (!(error instanceof AcpRpcError) || error.code !== -32601) {
        throw error;
      }
      return this.setSessionCategoryValue(sessionId, "mode", mode);
    }
  }

  async setSessionConfigOption(sessionId: string, configId: string, value: string): Promise<{ session: Session; response: SetSessionConfigOptionResponse }> {
    const resolvedConfigId = configId.trim();
    if (!resolvedConfigId) {
      throw new Error("setSessionConfigOption requires a non-empty configId");
    }
    const resolvedValue = value.trim();
    if (!resolvedValue) {
      throw new Error("setSessionConfigOption requires a non-empty value");
    }

    const options = await this.getSessionConfigOptions(sessionId);
    const option = findConfigOptionById(options, resolvedConfigId);
    if (!option) {
      throw new UnsupportedSessionConfigOptionError(
        sessionId,
        resolvedConfigId,
        options.map((item) => item.id),
      );
    }

    const allowedValues = extractConfigValues(option);
    if (allowedValues.length > 0 && !allowedValues.includes(resolvedValue)) {
      throw new UnsupportedSessionValueError(sessionId, option.category ?? "uncategorized", option.id, resolvedValue, allowedValues);
    }

    return (await this.sendSessionMethodInternal(
      sessionId,
      "session/set_config_option",
      {
        configId: resolvedConfigId,
        value: resolvedValue,
      },
      {},
      false,
    )) as { session: Session; response: SetSessionConfigOptionResponse };
  }

  async setSessionModel(sessionId: string, model: string): Promise<{ session: Session; response: SetSessionConfigOptionResponse }> {
    return this.setSessionCategoryValue(sessionId, "model", model);
  }

  async setSessionThoughtLevel(sessionId: string, thoughtLevel: string): Promise<{ session: Session; response: SetSessionConfigOptionResponse }> {
    return this.setSessionCategoryValue(sessionId, "thought_level", thoughtLevel);
  }

  async getSessionConfigOptions(sessionId: string): Promise<SessionConfigOption[]> {
    const record = await this.requireSessionRecord(sessionId);
    const hydrated = await this.hydrateSessionConfigOptions(record.id, record);
    return cloneConfigOptions(hydrated.configOptions) ?? [];
  }

  async getSessionModes(sessionId: string): Promise<SessionModeState | null> {
    const record = await this.requireSessionRecord(sessionId);
    if (record.modes && record.modes.availableModes.length > 0) {
      return cloneModes(record.modes);
    }

    const hydrated = await this.hydrateSessionConfigOptions(record.id, record);
    if (hydrated.modes && hydrated.modes.availableModes.length > 0) {
      return cloneModes(hydrated.modes);
    }

    const derived = deriveModesFromConfigOptions(hydrated.configOptions);
    if (!derived) {
      return cloneModes(hydrated.modes);
    }

    const updated: SessionRecord = {
      ...hydrated,
      modes: derived,
    };
    await this.persist.updateSession(updated);
    return cloneModes(derived);
  }

  private async setSessionCategoryValue(
    sessionId: string,
    category: string,
    value: string,
  ): Promise<{ session: Session; response: SetSessionConfigOptionResponse }> {
    const resolvedValue = value.trim();
    if (!resolvedValue) {
      throw new Error(`setSession${toTitleCase(category)} requires a non-empty value`);
    }

    const options = await this.getSessionConfigOptions(sessionId);
    const option = findConfigOptionByCategory(options, category);
    if (!option) {
      const categories = uniqueCategories(options);
      throw new UnsupportedSessionCategoryError(sessionId, category, categories);
    }

    const allowedValues = extractConfigValues(option);
    if (allowedValues.length > 0 && !allowedValues.includes(resolvedValue)) {
      throw new UnsupportedSessionValueError(sessionId, category, option.id, resolvedValue, allowedValues);
    }

    return this.setSessionConfigOption(sessionId, option.id, resolvedValue);
  }

  private async hydrateSessionConfigOptions(sessionId: string, snapshot: SessionRecord): Promise<SessionRecord> {
    if (snapshot.configOptions !== undefined) {
      return snapshot;
    }

    const info = await this.getAgent(snapshot.agent, { config: true });
    let configOptions = normalizeSessionConfigOptions(info.configOptions) ?? [];
    // Re-read the record from persistence so we merge against the latest
    // state, not a stale snapshot captured before the network await.
    const record = await this.persist.getSession(sessionId);
    if (!record) {
      return { ...snapshot, configOptions };
    }

    const currentModeId = record.modes?.currentModeId;
    if (currentModeId) {
      const modeOption = findConfigOptionByCategory(configOptions, "mode");
      if (modeOption) {
        configOptions = applyConfigOptionValue(configOptions, modeOption.id, currentModeId) ?? configOptions;
      }
    }

    const updated: SessionRecord = {
      ...record,
      configOptions,
      modes: deriveModesFromConfigOptions(configOptions) ?? record.modes,
    };
    await this.persist.updateSession(updated);
    return updated;
  }

  async rawSendSessionMethod(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
    options: SessionSendOptions = {},
  ): Promise<{ session: Session; response: unknown }> {
    return this.sendSessionMethodInternal(sessionId, method, params, options, false);
  }

  private async sendSessionMethodInternal(
    sessionId: string,
    method: string,
    params: Record<string, unknown>,
    options: SessionSendOptions,
    allowManagedCancel: boolean,
    recover = true,
  ): Promise<{ session: Session; response: unknown }> {
    if (method === SESSION_CANCEL_METHOD && !allowManagedCancel) {
      throw new Error(MANUAL_CANCEL_ERROR);
    }
    this.assertNotDisposed();

    const record = await this.persist.getSession(sessionId);
    if (!record) {
      throw new Error(`session '${sessionId}' not found`);
    }

    const live = this.findBoundLiveConnection(record);
    if (!live) {
      if (!recover) {
        // Called from a restore (or right after one): restoring again here
        // would wait for the restore in progress, that is for itself.
        throw new Error(`session '${record.id}' is no longer bound to an agent session`);
      }
      // The persisted session points at a stale connection; restore lazily.
      const restored = await this.restoreSession(record);
      return this.sendSessionMethodInternal(restored.id, method, params, options, allowManagedCancel, false);
    }

    let response: unknown;
    try {
      response = await live.sendSessionMethod(record.id, method, params, options);
    } catch (error) {
      if (this.disposed) {
        // Closed by dispose(): the request may have reached the agent, and the
        // session is not restored, so it is not repeated.
        throw this.disposedErrorOr(error);
      }
      const recovery = recover && method !== SESSION_CANCEL_METHOD ? await this.prepareSessionRecovery(live, record, error) : null;
      if (!recovery) {
        throw error;
      }
      // When the list just confirmed the server is gone, do not try to attach to it again.
      const restored = await this.restoreSession(recovery === "session_missing" ? record : { ...record, serverId: undefined });
      if (recovery === "server_gone" && !RETRY_SAFE_SESSION_METHODS.has(method)) {
        // The agent may have received and run the request before its server
        // went away, so repeating it could run it twice. Let the caller decide.
        throw new SessionRequestInterruptedError(restored, method, error);
      }
      return this.sendSessionMethodInternal(restored.id, method, params, options, allowManagedCancel, false);
    }

    if (method === "session/prompt") {
      // Make sure the prompt response event is persisted and delivered to
      // listeners before the prompt resolves.
      await this.flushObservedEnvelopePersistence(record.id);
    }
    await this.persistSessionStateFromMethod(record.id, method, params, response);
    const refreshed = await this.requireSessionRecord(record.id);
    return {
      session: this.upsertSessionHandle(refreshed),
      response,
    };
  }

  /**
   * Decide whether a failed session request calls for restoring the session.
   * - "session_missing": the agent rejected the request because it does not
   *   know the session, so it did not run it; the session is unbound and the
   *   request can be repeated after restoring.
   * - "not_delivered": the agent server no longer exists and the request was
   *   rejected over HTTP before reaching any agent, so it can be repeated after
   *   restoring; the connection is dropped.
   * - "server_gone": the agent server no longer exists (deleted, or its agent
   *   process exited) and the request may have reached the agent before that;
   *   the connection is dropped.
   *
   * Server loss is recognised by asking the server, not by the error code: a
   * turn cut off mid-way fails over the event stream (-32603), a rejected POST
   * with -32003, a lost connection as a network error. The server lists an
   * agent server only while its agent process is running.
   */
  private async prepareSessionRecovery(
    live: LiveAcpConnection,
    record: SessionRecord,
    error: unknown,
  ): Promise<"session_missing" | "not_delivered" | "server_gone" | null> {
    if (error instanceof AcpRpcError && isMissingRemoteSessionError(error, record.agentSessionId)) {
      live.unbindSession(record.id, record.agentSessionId);
      return "session_missing";
    }

    let servers: AcpServerListResponse;
    try {
      servers = await this.listAcpServers();
    } catch {
      // Whether the server is gone cannot be confirmed: keep the connection and
      // let the caller see the original error.
      return null;
    }
    if (servers.servers.some((server) => server.serverId === live.serverId)) {
      return null;
    }

    await this.discardLiveConnection(live);
    return isRejectedBeforeDelivery(error) ? "not_delivered" : "server_gone";
  }

  private async discardLiveConnection(live: LiveAcpConnection): Promise<void> {
    this.clearPassivePermissionTimers((timer) => timer.connection === live);
    live.finishAllTurns();
    if (this.liveConnections.get(live.serverId) === live) {
      this.liveConnections.delete(live.serverId);
    }
    await live.close({ deleteServer: false }).catch(() => {});
  }

  private async flushObservedEnvelopePersistence(sessionId: string): Promise<void> {
    // Persistence is chained per session, so waiting for the current tail also
    // covers every envelope observed before it.
    const pending = this.pendingObservedEnvelopePersistenceBySession.get(sessionId);
    if (pending) {
      await pending.catch(() => {});
    }
  }

  private findBoundLiveConnection(record: SessionRecord): LiveAcpConnection | undefined {
    const preferred = record.serverId ? this.liveConnections.get(record.serverId) : undefined;
    if (preferred?.hasBoundSession(record.id, record.agentSessionId)) {
      return preferred;
    }
    for (const connection of this.liveConnections.values()) {
      if (connection.hasBoundSession(record.id, record.agentSessionId)) {
        return connection;
      }
    }
    return undefined;
  }

  private async persistSessionStateFromMethod(sessionId: string, method: string, params: Record<string, unknown>, response: unknown): Promise<void> {
    // Re-read the record from persistence so we merge against the latest
    // state, not a stale snapshot captured before the RPC await.
    const record = await this.persist.getSession(sessionId);
    if (!record) {
      return;
    }

    if (method === "session/set_config_option") {
      const configId = typeof params.configId === "string" ? params.configId : null;
      const value = typeof params.value === "string" ? params.value : null;
      const updates: Partial<SessionRecord> = {};

      const serverConfigOptions = extractConfigOptionsFromSetResponse(response);
      if (serverConfigOptions) {
        updates.configOptions = cloneConfigOptions(serverConfigOptions);
      } else if (record.configOptions && configId && value) {
        // Server didn't return configOptions — optimistically update the
        // cached currentValue so subsequent getConfigOptions() reflects the
        // change without a round-trip.
        const updated = applyConfigOptionValue(record.configOptions, configId, value);
        if (updated) {
          updates.configOptions = updated;
        }
      }

      // When a mode-category config option is set via set_config_option
      // (fallback path from setSessionMode), keep modes.currentModeId in sync.
      if (configId && value) {
        const source = updates.configOptions ?? record.configOptions;
        const option = source ? findConfigOptionById(source, configId) : null;
        if (option?.category === "mode") {
          const nextModes = applyCurrentMode(record.modes, value);
          if (nextModes) {
            updates.modes = nextModes;
          }
        }
      }

      if (Object.keys(updates).length > 0) {
        await this.persist.updateSession({ ...record, ...updates });
      }
      return;
    }

    if (method === "session/set_mode") {
      const modeId = typeof params.modeId === "string" ? params.modeId : null;
      if (!modeId) {
        return;
      }
      const updates: Partial<SessionRecord> = {};
      const nextModes = applyCurrentMode(record.modes, modeId);
      if (nextModes) {
        updates.modes = nextModes;
      }
      // Keep configOptions mode-category currentValue in sync with the new
      // mode, mirroring the reverse sync in the set_config_option path above.
      if (record.configOptions) {
        const modeOption = findConfigOptionByCategory(record.configOptions, "mode");
        if (modeOption) {
          const updated = applyConfigOptionValue(record.configOptions, modeOption.id, modeId);
          if (updated) {
            updates.configOptions = updated;
          }
        }
      }
      if (Object.keys(updates).length > 0) {
        await this.persist.updateSession({ ...record, ...updates });
      }
    }
  }

  onSessionEvent(sessionId: string, listener: SessionEventListener): () => void {
    const listeners = this.eventListeners.get(sessionId) ?? new Set<SessionEventListener>();
    listeners.add(listener);
    this.eventListeners.set(sessionId, listeners);

    return () => {
      const set = this.eventListeners.get(sessionId);
      if (!set) {
        return;
      }
      set.delete(listener);
      if (set.size === 0) {
        this.eventListeners.delete(sessionId);
      }
    };
  }

  /**
   * Subscribes to turn lifecycle signals of a session: a turn started or ended
   * (with its outcome), and the agent is waiting for, or no longer waiting for,
   * a permission decision. Every client attached to the session receives them.
   */
  onTurnEvent(sessionId: string, listener: SessionTurnEventListener): () => void {
    const listeners = this.turnListeners.get(sessionId) ?? new Set<SessionTurnEventListener>();
    listeners.add(listener);
    this.turnListeners.set(sessionId, listeners);

    return () => {
      const set = this.turnListeners.get(sessionId);
      if (!set) {
        return;
      }
      set.delete(listener);
      if (set.size === 0) {
        this.turnListeners.delete(sessionId);
      }
    };
  }

  onPermissionRequest(sessionId: string, listener: PermissionRequestListener): () => void {
    const listeners = this.permissionListeners.get(sessionId) ?? new Set<PermissionRequestListener>();
    listeners.add(listener);
    this.permissionListeners.set(sessionId, listeners);

    return () => {
      const set = this.permissionListeners.get(sessionId);
      if (!set) {
        return;
      }
      set.delete(listener);
      if (set.size === 0) {
        this.permissionListeners.delete(sessionId);
      }
    };
  }

  async respondPermission(permissionId: string, reply: PermissionReply): Promise<void> {
    const pending = this.pendingPermissionRequests.get(permissionId);
    if (!pending) {
      throw new Error(`permission '${permissionId}' not found`);
    }

    let response: RequestPermissionResponse;
    try {
      response = permissionReplyToResponse(permissionId, pending.request, reply);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
      this.pendingPermissionRequests.delete(permissionId);
      throw error;
    }
    this.resolvePendingPermission(permissionId, response);
  }

  async rawRespondPermission(permissionId: string, response: RequestPermissionResponse): Promise<void> {
    if (!this.pendingPermissionRequests.has(permissionId)) {
      throw new Error(`permission '${permissionId}' not found`);
    }
    this.resolvePendingPermission(permissionId, clonePermissionResponse(response));
  }

  async getHealth(): Promise<HealthResponse> {
    return this.requestHealth();
  }

  async startDesktop(request: DesktopStartRequest = {}): Promise<DesktopStatusResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/start`, {
      body: request,
    });
  }

  async stopDesktop(): Promise<DesktopStatusResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/stop`);
  }

  async getDesktopStatus(): Promise<DesktopStatusResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/status`);
  }

  async getDesktopDisplayInfo(): Promise<DesktopDisplayInfoResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/display/info`);
  }

  async takeDesktopScreenshot(query: DesktopScreenshotQuery = {}): Promise<Uint8Array> {
    const response = await this.requestRaw("GET", `${API_PREFIX}/desktop/screenshot`, {
      query,
      accept: "image/*",
    });
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async takeDesktopRegionScreenshot(query: DesktopRegionScreenshotQuery): Promise<Uint8Array> {
    const response = await this.requestRaw("GET", `${API_PREFIX}/desktop/screenshot/region`, {
      query,
      accept: "image/*",
    });
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async getDesktopMousePosition(): Promise<DesktopMousePositionResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/mouse/position`);
  }

  async moveDesktopMouse(request: DesktopMouseMoveRequest): Promise<DesktopMousePositionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/mouse/move`, {
      body: request,
    });
  }

  async clickDesktop(request: DesktopMouseClickRequest): Promise<DesktopMousePositionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/mouse/click`, {
      body: request,
    });
  }

  async mouseDownDesktop(request: DesktopMouseDownRequest): Promise<DesktopMousePositionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/mouse/down`, {
      body: request,
    });
  }

  async mouseUpDesktop(request: DesktopMouseUpRequest): Promise<DesktopMousePositionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/mouse/up`, {
      body: request,
    });
  }

  async dragDesktopMouse(request: DesktopMouseDragRequest): Promise<DesktopMousePositionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/mouse/drag`, {
      body: request,
    });
  }

  async scrollDesktop(request: DesktopMouseScrollRequest): Promise<DesktopMousePositionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/mouse/scroll`, {
      body: request,
    });
  }

  async typeDesktopText(request: DesktopKeyboardTypeRequest): Promise<DesktopActionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/keyboard/type`, {
      body: request,
    });
  }

  async pressDesktopKey(request: DesktopKeyboardPressRequest): Promise<DesktopActionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/keyboard/press`, {
      body: request,
    });
  }

  async keyDownDesktop(request: DesktopKeyboardDownRequest): Promise<DesktopActionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/keyboard/down`, {
      body: request,
    });
  }

  async keyUpDesktop(request: DesktopKeyboardUpRequest): Promise<DesktopActionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/keyboard/up`, {
      body: request,
    });
  }

  async listDesktopWindows(): Promise<DesktopWindowListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/windows`);
  }

  async getDesktopFocusedWindow(): Promise<DesktopWindowInfo> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/windows/focused`);
  }

  async focusDesktopWindow(windowId: string): Promise<DesktopWindowInfo> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/windows/${encodeURIComponent(windowId)}/focus`);
  }

  async moveDesktopWindow(windowId: string, request: DesktopWindowMoveRequest): Promise<DesktopWindowInfo> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/windows/${encodeURIComponent(windowId)}/move`, {
      body: request,
    });
  }

  async resizeDesktopWindow(windowId: string, request: DesktopWindowResizeRequest): Promise<DesktopWindowInfo> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/windows/${encodeURIComponent(windowId)}/resize`, {
      body: request,
    });
  }

  async getDesktopClipboard(query: DesktopClipboardQuery = {}): Promise<DesktopClipboardResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/clipboard`, {
      query,
    });
  }

  async setDesktopClipboard(request: DesktopClipboardWriteRequest): Promise<DesktopActionResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/clipboard`, {
      body: request,
    });
  }

  async launchDesktopApp(request: DesktopLaunchRequest): Promise<DesktopLaunchResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/launch`, {
      body: request,
    });
  }

  async openDesktopTarget(request: DesktopOpenRequest): Promise<DesktopOpenResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/open`, {
      body: request,
    });
  }

  async getDesktopStreamStatus(): Promise<DesktopStreamStatusResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/stream/status`);
  }

  async startDesktopRecording(request: DesktopRecordingStartRequest = {}): Promise<DesktopRecordingInfo> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/recording/start`, {
      body: request,
    });
  }

  async stopDesktopRecording(): Promise<DesktopRecordingInfo> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/recording/stop`);
  }

  async listDesktopRecordings(): Promise<DesktopRecordingListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/recordings`);
  }

  async getDesktopRecording(id: string): Promise<DesktopRecordingInfo> {
    return this.requestJson("GET", `${API_PREFIX}/desktop/recordings/${encodeURIComponent(id)}`);
  }

  async downloadDesktopRecording(id: string): Promise<Uint8Array> {
    const response = await this.requestRaw("GET", `${API_PREFIX}/desktop/recordings/${encodeURIComponent(id)}/download`, {
      accept: "video/mp4",
    });
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async deleteDesktopRecording(id: string): Promise<void> {
    await this.requestRaw("DELETE", `${API_PREFIX}/desktop/recordings/${encodeURIComponent(id)}`);
  }

  async startDesktopStream(): Promise<DesktopStreamStatusResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/stream/start`);
  }

  async stopDesktopStream(): Promise<DesktopStreamStatusResponse> {
    return this.requestJson("POST", `${API_PREFIX}/desktop/stream/stop`);
  }

  async listAgents(options?: AgentQueryOptions): Promise<AgentListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/agents`, {
      query: toAgentQuery(options),
    });
  }

  async getAgent(agent: string, options?: AgentQueryOptions): Promise<AgentInfo> {
    try {
      return await this.requestJson("GET", `${API_PREFIX}/agents/${encodeURIComponent(agent)}`, {
        query: toAgentQuery(options),
      });
    } catch (error) {
      if (!(error instanceof SandboxAgentError) || error.status !== 404) {
        throw error;
      }

      const listed = await this.listAgents(options);
      const match = listed.agents.find((entry) => entry.id === agent);
      if (match) {
        return match;
      }
      throw error;
    }
  }

  async installAgent(agent: string, request: AgentInstallRequest = {}): Promise<AgentInstallResponse> {
    return this.requestJson("POST", `${API_PREFIX}/agents/${encodeURIComponent(agent)}/install`, {
      body: request,
    });
  }

  /**
   * Deletes an agent server and stops its agent process, including servers this
   * client only attached to. Sessions on it are restored on their next use.
   * `dispose()` deletes only the servers this client created.
   */
  async destroyAcpServer(serverId: string): Promise<void> {
    await this.requestRaw("DELETE", `${API_PREFIX}/acp/${encodeURIComponent(serverId)}`);
    const live = this.liveConnections.get(serverId);
    if (live) {
      this.liveConnections.delete(serverId);
      this.cancelPendingPermissionsForConnection(live);
      this.clearPassivePermissionTimers((timer) => timer.connection === live);
      live.finishAllTurns();
      await live.close({ deleteServer: false }).catch(() => {});
    }
  }

  async listAcpServers(): Promise<AcpServerListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/acp`);
  }

  async listFsEntries(query: FsEntriesQuery = {}): Promise<FsEntry[]> {
    return this.requestJson("GET", `${FS_PATH}/entries`, {
      query,
    });
  }

  async readFsFile(query: FsPathQuery): Promise<Uint8Array> {
    const response = await this.requestRaw("GET", `${FS_PATH}/file`, {
      query,
      accept: "application/octet-stream",
    });
    const buffer = await response.arrayBuffer();
    return new Uint8Array(buffer);
  }

  async writeFsFile(query: FsPathQuery, body: BodyInit): Promise<FsWriteResponse> {
    const response = await this.requestRaw("PUT", `${FS_PATH}/file`, {
      query,
      rawBody: body,
      contentType: "application/octet-stream",
      accept: "application/json",
    });
    return (await response.json()) as FsWriteResponse;
  }

  async deleteFsEntry(query: FsDeleteQuery): Promise<FsActionResponse> {
    return this.requestJson("DELETE", `${FS_PATH}/entry`, { query });
  }

  async mkdirFs(query: FsPathQuery): Promise<FsActionResponse> {
    return this.requestJson("POST", `${FS_PATH}/mkdir`, { query });
  }

  async moveFs(request: FsMoveRequest): Promise<FsMoveResponse> {
    return this.requestJson("POST", `${FS_PATH}/move`, { body: request });
  }

  async statFs(query: FsPathQuery): Promise<FsStat> {
    return this.requestJson("GET", `${FS_PATH}/stat`, { query });
  }

  async uploadFsBatch(body: BodyInit, query?: FsUploadBatchQuery): Promise<FsUploadBatchResponse> {
    const response = await this.requestRaw("POST", `${FS_PATH}/upload-batch`, {
      query,
      rawBody: body,
      contentType: "application/x-tar",
      accept: "application/json",
    });
    return (await response.json()) as FsUploadBatchResponse;
  }

  /**
   * Download a file or directory as a streamed tar archive.
   *
   * Directory archives contain the directory contents without a wrapper folder. Path,
   * symlink and limit errors are thrown as `SandboxAgentError` before any bytes arrive.
   * Use `new Response(stream).arrayBuffer()` to buffer it, or pipe it to disk.
   */
  async downloadFsBatch(query: FsDownloadBatchQuery = {}, options: { signal?: AbortSignal } = {}): Promise<ReadableStream<Uint8Array>> {
    const response = await this.requestRaw("GET", `${FS_PATH}/download-batch`, {
      query,
      accept: "application/x-tar",
      signal: options.signal,
    });
    return (
      response.body ??
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      })
    );
  }

  /**
   * @deprecated The server only stores this config; it is never passed to agents.
   * Pass MCP servers in `sessionInit.mcpServers` (or use agent profiles). Removed in the next minor release.
   */
  async getMcpConfig(query: McpConfigQuery): Promise<McpServerConfig> {
    return this.requestJson("GET", `${API_PREFIX}/config/mcp`, { query });
  }

  /**
   * @deprecated The server only stores this config; it is never passed to agents.
   * Pass MCP servers in `sessionInit.mcpServers` (or use agent profiles). Removed in the next minor release.
   */
  async setMcpConfig(query: McpConfigQuery, config: McpServerConfig): Promise<void> {
    await this.requestRaw("PUT", `${API_PREFIX}/config/mcp`, { query, body: config });
  }

  /**
   * @deprecated The server only stores this config; it is never passed to agents.
   * Pass MCP servers in `sessionInit.mcpServers` (or use agent profiles). Removed in the next minor release.
   */
  async deleteMcpConfig(query: McpConfigQuery): Promise<void> {
    await this.requestRaw("DELETE", `${API_PREFIX}/config/mcp`, { query });
  }

  /**
   * @deprecated The server only stores this config; it is never passed to agents.
   * Put skill files where the agent reads skills with the file system API (`writeFsFile`). Removed in the next minor release.
   */
  async getSkillsConfig(query: SkillsConfigQuery): Promise<SkillsConfig> {
    return this.requestJson("GET", `${API_PREFIX}/config/skills`, { query });
  }

  /**
   * @deprecated The server only stores this config; it is never passed to agents.
   * Put skill files where the agent reads skills with the file system API (`writeFsFile`). Removed in the next minor release.
   */
  async setSkillsConfig(query: SkillsConfigQuery, config: SkillsConfig): Promise<void> {
    await this.requestRaw("PUT", `${API_PREFIX}/config/skills`, { query, body: config });
  }

  /**
   * @deprecated The server only stores this config; it is never passed to agents.
   * Put skill files where the agent reads skills with the file system API (`writeFsFile`). Removed in the next minor release.
   */
  async deleteSkillsConfig(query: SkillsConfigQuery): Promise<void> {
    await this.requestRaw("DELETE", `${API_PREFIX}/config/skills`, { query });
  }

  /** Lists agent profiles stored on the server (from the API and from `--profiles`). */
  async listProfiles(): Promise<ProfileListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/config/profiles`);
  }

  /** Stored and resolved (`extends` applied) profile; env and plugin config values come back as `***`. */
  async getProfile(agent: string, name: string): Promise<ProfileDetailResponse> {
    return this.requestJson("GET", profilePath(agent, name));
  }

  /** Creates or replaces a profile. A `***` value keeps the value stored for that key. */
  async putProfile(agent: string, name: string, profile: AgentProfile): Promise<ProfileDetailResponse> {
    return this.requestJson("PUT", profilePath(agent, name), { body: profile });
  }

  async deleteProfile(agent: string, name: string): Promise<void> {
    await this.requestRaw("DELETE", profilePath(agent, name));
  }

  async getProcessConfig(): Promise<ProcessConfig> {
    return this.requestJson("GET", `${API_PREFIX}/processes/config`);
  }

  async setProcessConfig(config: ProcessConfig): Promise<ProcessConfig> {
    return this.requestJson("POST", `${API_PREFIX}/processes/config`, {
      body: config,
    });
  }

  async createProcess(request: ProcessCreateRequest): Promise<ProcessInfo> {
    return this.requestJson("POST", `${API_PREFIX}/processes`, {
      body: request,
    });
  }

  async runProcess(request: ProcessRunRequest): Promise<ProcessRunResponse> {
    return this.requestJson("POST", `${API_PREFIX}/processes/run`, {
      body: request,
    });
  }

  async listProcesses(query?: ProcessListQuery): Promise<ProcessListResponse> {
    return this.requestJson("GET", `${API_PREFIX}/processes`, {
      query,
    });
  }

  async getProcess(id: string): Promise<ProcessInfo> {
    return this.requestJson("GET", `${API_PREFIX}/processes/${encodeURIComponent(id)}`);
  }

  async stopProcess(id: string, query?: ProcessSignalQuery): Promise<ProcessInfo> {
    return this.requestJson("POST", `${API_PREFIX}/processes/${encodeURIComponent(id)}/stop`, {
      query,
    });
  }

  async killProcess(id: string, query?: ProcessSignalQuery): Promise<ProcessInfo> {
    return this.requestJson("POST", `${API_PREFIX}/processes/${encodeURIComponent(id)}/kill`, {
      query,
    });
  }

  async deleteProcess(id: string): Promise<void> {
    await this.requestRaw("DELETE", `${API_PREFIX}/processes/${encodeURIComponent(id)}`);
  }

  async getProcessLogs(id: string, query: ProcessLogFollowQuery = {}): Promise<ProcessLogsResponse> {
    return this.requestJson("GET", `${API_PREFIX}/processes/${encodeURIComponent(id)}/logs`, {
      query,
    });
  }

  async followProcessLogs(id: string, listener: ProcessLogListener, query: ProcessLogFollowQuery = {}): Promise<ProcessLogSubscription> {
    const abortController = new AbortController();
    const response = await this.requestRaw("GET", `${API_PREFIX}/processes/${encodeURIComponent(id)}/logs`, {
      query: { ...query, follow: true },
      accept: "text/event-stream",
      signal: abortController.signal,
    });

    if (!response.body) {
      abortController.abort();
      throw new Error("SSE stream is not readable in this environment.");
    }

    const closed = consumeProcessLogSse(response.body, listener, abortController.signal);

    return {
      close: () => abortController.abort(),
      closed,
    };
  }

  async sendProcessInput(id: string, request: ProcessInputRequest): Promise<ProcessInputResponse> {
    return this.requestJson("POST", `${API_PREFIX}/processes/${encodeURIComponent(id)}/input`, {
      body: request,
    });
  }

  async resizeProcessTerminal(id: string, request: ProcessTerminalResizeRequest): Promise<ProcessTerminalResizeResponse> {
    return this.requestJson("POST", `${API_PREFIX}/processes/${encodeURIComponent(id)}/terminal/resize`, {
      body: request,
    });
  }

  buildProcessTerminalWebSocketUrl(id: string, options: ProcessTerminalWebSocketUrlOptions = {}): string {
    return toWebSocketUrl(
      this.buildUrl(`${API_PREFIX}/processes/${encodeURIComponent(id)}/terminal/ws`, {
        access_token: options.accessToken ?? this.token,
      }),
    );
  }

  connectProcessTerminalWebSocket(id: string, options: ProcessTerminalConnectOptions = {}): WebSocket {
    const WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error("WebSocket API is not available; provide a WebSocket implementation.");
    }

    return new WebSocketCtor(
      this.buildProcessTerminalWebSocketUrl(id, {
        accessToken: options.accessToken,
      }),
      options.protocols,
    );
  }

  connectProcessTerminal(id: string, options: ProcessTerminalSessionOptions = {}): ProcessTerminalSession {
    return new ProcessTerminalSession(this.connectProcessTerminalWebSocket(id, options));
  }

  buildDesktopStreamWebSocketUrl(options: ProcessTerminalWebSocketUrlOptions = {}): string {
    return toWebSocketUrl(
      this.buildUrl(`${API_PREFIX}/desktop/stream/signaling`, {
        access_token: options.accessToken ?? this.token,
      }),
    );
  }

  connectDesktopStreamWebSocket(options: DesktopStreamConnectOptions = {}): WebSocket {
    const WebSocketCtor = options.WebSocket ?? globalThis.WebSocket;
    if (!WebSocketCtor) {
      throw new Error("WebSocket API is not available; provide a WebSocket implementation.");
    }

    return new WebSocketCtor(
      this.buildDesktopStreamWebSocketUrl({
        accessToken: options.accessToken,
      }),
      options.protocols,
    );
  }

  connectDesktopStream(options: DesktopStreamSessionOptions = {}): DesktopStreamSession {
    return new DesktopStreamSession(this.connectDesktopStreamWebSocket(options));
  }

  /**
   * Live connection for an agent. With `preferredServerId` (the server a
   * persisted session last ran on), attach to that server first so its agent
   * process and sessions are reused; attaching never creates a server. Only
   * when the server rejects the attach as unknown, and the server list confirms
   * it is gone, is any connection for the agent reused or a new server started.
   * If the list cannot be read then, the attach error is thrown instead.
   */
  private async getLiveConnection(agent: string, preferredServerId?: string): Promise<LiveAcpConnection> {
    this.assertNotDisposed();
    await this.awaitHealthy();

    const preferred = preferredServerId?.trim();
    if (preferred) {
      const existing = this.liveConnections.get(preferred) ?? (await this.pendingLiveConnections.get(preferred)?.catch(() => undefined));
      if (existing && existing.agent === agent) {
        return existing;
      }
      if (!existing) {
        let attached: LiveAcpConnection | undefined;
        try {
          attached = await this.openLiveConnection(agent, preferred, true);
        } catch (error) {
          // Only a server confirmed gone by the list is replaced by a new one
          // below. Any other failure (network, auth, server error, or a list
          // that cannot be read) is thrown, so the session is not forked onto a
          // second server.
          if (!isMissingServerRejection(error) || (await this.isAcpServerListedOrThrow(preferred, error))) {
            throw error;
          }
        }
        if (attached) {
          const otherAgent = await this.isAcpServerListedForOtherAgent(preferred, agent);
          // dispose() may have run during the list call and closed `attached`.
          this.assertNotDisposed();
          if (!otherAgent) {
            return attached;
          }
          // The id now belongs to a server of another agent: leave it running
          // and use a server for this agent instead.
          await this.discardLiveConnection(attached);
        }
      }
    }
    // The checks above await the server; nothing is reused or started after dispose().
    this.assertNotDisposed();

    for (const connection of this.liveConnections.values()) {
      if (connection.agent === agent) {
        return connection;
      }
    }
    const pendingForAgent = this.pendingLiveConnectionsByAgent.get(agent);
    if (pendingForAgent) {
      return pendingForAgent;
    }

    return this.openLiveConnection(agent, `sdk-${agent}-${randomId()}`, false);
  }

  /** Whether the server is listed; rethrows `cause` when the list cannot be read. */
  private async isAcpServerListedOrThrow(serverId: string, cause: unknown): Promise<boolean> {
    let servers: AcpServerListResponse;
    try {
      servers = await this.listAcpServers();
    } catch {
      throw cause;
    }
    return servers.servers.some((server) => server.serverId === serverId);
  }

  /**
   * Whether the server list shows the server running a different agent. A list
   * that cannot be read counts as no: the attached server stays in use, since a
   * session is never moved to a new server on a guess.
   */
  private async isAcpServerListedForOtherAgent(serverId: string, agent: string): Promise<boolean> {
    let servers: AcpServerListResponse;
    try {
      servers = await this.listAcpServers();
    } catch {
      return false;
    }
    return servers.servers.some((server) => server.serverId === serverId && server.agent !== agent);
  }

  private async openLiveConnection(agent: string, serverId: string, attach: boolean): Promise<LiveAcpConnection> {
    this.assertNotDisposed();
    const pending = this.pendingLiveConnections.get(serverId);
    if (pending) {
      return pending;
    }

    const creating = (async () => {
      const created = await LiveAcpConnection.create({
        baseUrl: this.baseUrl,
        token: this.token,
        fetcher: this.fetcher,
        headers: this.defaultHeaders,
        auth: this.auth,
        agent,
        serverId,
        attach,
        onObservedEnvelope: (connection, envelope, direction, localSessionId, context) => {
          void this.enqueueObservedEnvelopePersistence(connection, envelope, direction, localSessionId, context).catch((error) => {
            console.error("Failed to persist observed sandbox-agent envelope", error);
          });
        },
        onPermissionRequest: async (connection, localSessionId, agentSessionId, request, context) =>
          this.enqueuePermissionRequest(connection, localSessionId, agentSessionId, request, context),
        onTurnEvent: (connection, localSessionId, notification) => {
          if (notification.method === SANDBOX_AGENT_INPUT_RESOLVED) {
            this.dropResolvedPermissionRequests(connection, localSessionId, notification.params.requestId);
          }
          void this.enqueueTurnEvent(localSessionId, notification);
        },
      });

      if (this.disposed) {
        // dispose() ran while connecting: close it here (deleting the server
        // only if this connection created it) instead of leaving it running.
        await created.close();
        throw new SandboxAgentDisposedError();
      }

      created.onForeignTurnFinished = (connection, localSessionId, foreignTurn, responseEventId) =>
        this.scheduleForeignTurnCheck(foreignTurnBufferKey(localSessionId, connection, foreignTurn), localSessionId, responseEventId);

      const raced = this.liveConnections.get(serverId);
      if (raced) {
        // Never delete the server the winning connection uses.
        await created.close({ deleteServer: false });
        return raced;
      }

      this.liveConnections.set(serverId, created);
      return created;
    })();

    this.pendingLiveConnections.set(serverId, creating);
    if (!attach) {
      this.pendingLiveConnectionsByAgent.set(agent, creating);
    }
    try {
      return await creating;
    } finally {
      if (this.pendingLiveConnections.get(serverId) === creating) {
        this.pendingLiveConnections.delete(serverId);
      }
      if (this.pendingLiveConnectionsByAgent.get(agent) === creating) {
        this.pendingLiveConnectionsByAgent.delete(agent);
      }
    }
  }

  private async persistObservedEnvelope(
    connection: LiveAcpConnection,
    envelope: AnyMessage,
    direction: AcpEnvelopeDirection,
    localSessionId: string | null,
    context: ObservedEnvelopeContext,
  ): Promise<void> {
    if (!localSessionId) {
      return;
    }

    // Every client of a server receives its event stream, so an event from the
    // stream gets an id derived from the server instance and the stream's event
    // id. A driver keeps the first record per id, so a replay after
    // reconnecting, or an event two clients store, is kept once.
    let stableId: string | undefined;
    let sharedId = false;
    if (context.eventId !== undefined) {
      const generation = context.serverGeneration ?? (await this.lookupConnectionGeneration(connection));
      sharedId = generation !== undefined;
      stableId = generation === undefined ? `${connection.serverId}:${context.eventId}` : `${connection.serverId}@${generation}:${context.eventId}`;
    }
    const buildEvent = (eventIndex: number): SessionEvent => ({
      id: stableId ?? randomId(),
      eventIndex,
      sessionId: localSessionId,
      createdAt: nowMs(),
      connectionId: connection.connectionId,
      sender: direction === "outbound" ? "client" : "agent",
      payload: cloneEnvelope(envelope),
    });

    let event: SessionEvent;
    if (!context.store) {
      // Another client's turn: that client stores it. Deliver with a local index
      // and keep it to store after the turn, in case that client died. Only ids
      // every client derives the same way are kept, so no event is stored twice.
      event = buildEvent(await this.peekSessionEventIndex(localSessionId));
      if (sharedId && context.foreignTurn !== undefined) {
        const key = foreignTurnBufferKey(localSessionId, connection, context.foreignTurn);
        if (!this.overflowedForeignTurns.has(key)) {
          const buffered = this.foreignTurnBuffers.get(key) ?? [];
          if (buffered.length >= MAX_FOREIGN_TURN_BUFFER_EVENTS) {
            this.foreignTurnBuffers.delete(key);
            this.overflowedForeignTurns.add(key);
            console.warn(
              `sandbox-agent: another client's turn in session '${localSessionId}' exceeded ${MAX_FOREIGN_TURN_BUFFER_EVENTS} events; this client will not store it if that client dies`,
            );
          } else {
            buffered.push(event);
            this.foreignTurnBuffers.set(key, buffered);
          }
        }
      }
    } else {
      let stored: SessionEvent | null = null;
      for (let attempt = 0; attempt < MAX_EVENT_INDEX_INSERT_RETRIES; attempt += 1) {
        stored = buildEvent(await this.allocateSessionEventIndex(localSessionId, context.reseedIndex || attempt > 0));
        try {
          await this.persist.insertEvent(localSessionId, stored);
          break;
        } catch (error) {
          if (!isSessionEventIndexConflict(error) || attempt === MAX_EVENT_INDEX_INSERT_RETRIES - 1) {
            throw error;
          }
        }
      }
      if (!stored) {
        return;
      }
      event = stored;
      await this.persistSessionStateFromEvent(localSessionId, envelope, direction);
    }

    const listeners = this.eventListeners.get(localSessionId);
    if (!listeners || listeners.size === 0) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  /**
   * Generation of the connection's server for servers that do not send it on
   * the event stream: `createdAtMs` from the server list, looked up again on
   * every call until it is known.
   */
  private async lookupConnectionGeneration(connection: LiveAcpConnection): Promise<string | undefined> {
    if (connection.generation === undefined) {
      try {
        const listed = (await this.listAcpServers()).servers.find((server) => server.serverId === connection.serverId);
        connection.generation = listed?.createdAtMs;
      } catch {
        // Not known yet: such events are not shared with other clients.
      }
    }
    return connection.generation === undefined ? undefined : String(connection.generation);
  }

  /**
   * After another client's turn ended (or could no longer be followed), decide
   * whether the prompting client stored it. A live prompting client stores
   * every event of its turn, in order, ending with the prompt response, so this
   * client never writes while it sees that client make progress:
   * - done, nothing to write: the prompt response (`responseEventId`) or all
   *   buffered events of the turn are stored;
   * - keep waiting: the store changed since the last check (someone is
   *   writing);
   * - prompting client gone: nothing changed for FOREIGN_TURN_STALL_MS; then
   *   the missing events are stored after the highest stored index.
   */
  private scheduleForeignTurnCheck(key: string, sessionId: string, responseEventId: string | undefined): void {
    if (this.disposed || this.foreignTurnChecks.has(key)) {
      return;
    }
    let lastState: string | undefined;
    let unchangedSince = Date.now();
    const schedule = (delayMs: number) => {
      const timer = setTimeout(() => {
        void this.runInSessionQueue(sessionId, async () => {
          if (this.foreignTurnChecks.get(key)?.timer !== timer) {
            return;
          }
          this.foreignTurnChecks.delete(key);
          const events = this.foreignTurnBuffers.get(key);
          if (!events) {
            this.overflowedForeignTurns.delete(key);
            return;
          }
          const scan = await this.scanPersistedSessionEvents(sessionId);
          // dispose() or destroySession() may have dropped the turn during the scan.
          if (this.disposed || this.foreignTurnBuffers.get(key) !== events) {
            return;
          }
          if ((responseEventId !== undefined && scan.ids.has(responseEventId)) || events.every((event) => scan.ids.has(event.id))) {
            this.foreignTurnBuffers.delete(key);
            return;
          }
          const state = `${scan.ids.size}:${scan.maxIndex}`;
          if (state !== lastState) {
            lastState = state;
            unchangedSince = Date.now();
          } else if (Date.now() - unchangedSince >= FOREIGN_TURN_STALL_MS) {
            this.foreignTurnBuffers.delete(key);
            await this.storeMissingEvents(sessionId, events, scan);
            return;
          }
          schedule(FOREIGN_TURN_CHECK_INTERVAL_MS);
        }).catch((error) => {
          console.error("Failed to persist observed sandbox-agent turn", error);
        });
      }, delayMs);
      this.foreignTurnChecks.set(key, { sessionId, timer });
    };
    schedule(FOREIGN_TURN_CHECK_INTERVAL_MS);
  }

  private dropForeignTurnsOfSession(sessionId: string): void {
    for (const [key, check] of this.foreignTurnChecks) {
      if (check.sessionId === sessionId) {
        clearTimeout(check.timer);
        this.foreignTurnChecks.delete(key);
      }
    }
    const prefix = `${sessionId}\u0000`;
    for (const key of [...this.foreignTurnBuffers.keys(), ...this.overflowedForeignTurns]) {
      if (key.startsWith(prefix)) {
        this.foreignTurnBuffers.delete(key);
        this.overflowedForeignTurns.delete(key);
      }
    }
  }

  /** Runs `task` after the session's queued persistence work, keeping later work behind it. */
  private runInSessionQueue(sessionId: string, task: () => Promise<void>): Promise<void> {
    const previous = this.pendingObservedEnvelopePersistenceBySession.get(sessionId) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    this.pendingObservedEnvelopePersistenceBySession.set(sessionId, current);
    return current.finally(() => {
      if (this.pendingObservedEnvelopePersistenceBySession.get(sessionId) === current) {
        this.pendingObservedEnvelopePersistenceBySession.delete(sessionId);
      }
    });
  }

  /** Stores, in order and after the highest stored index, the events not stored yet. */
  private async storeMissingEvents(sessionId: string, events: SessionEvent[], scan: { maxIndex: number; ids: Set<string> }): Promise<void> {
    let next = scan.maxIndex + 1;
    for (const event of events) {
      if (scan.ids.has(event.id)) {
        continue;
      }
      for (let attempt = 0; attempt < MAX_EVENT_INDEX_INSERT_RETRIES; attempt += 1) {
        const eventIndex = attempt === 0 ? next : await this.allocateSessionEventIndex(sessionId, true);
        try {
          await this.persist.insertEvent(sessionId, { ...event, eventIndex });
          next = eventIndex + 1;
          break;
        } catch (error) {
          if (!isSessionEventIndexConflict(error) || attempt === MAX_EVENT_INDEX_INSERT_RETRIES - 1) {
            throw error;
          }
        }
      }
      await this.persistSessionStateFromEvent(sessionId, event.payload, event.sender === "client" ? "outbound" : "inbound");
    }
    this.nextSessionEventIndexBySession.set(sessionId, Math.max(this.nextSessionEventIndexBySession.get(sessionId) ?? 1, next));
  }

  private async enqueueObservedEnvelopePersistence(
    connection: LiveAcpConnection,
    envelope: AnyMessage,
    direction: AcpEnvelopeDirection,
    localSessionId: string | null,
    context: ObservedEnvelopeContext,
  ): Promise<void> {
    if (!localSessionId) {
      return;
    }

    const previous = this.pendingObservedEnvelopePersistenceBySession.get(localSessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // Keep later envelope persistence moving even if an earlier write failed.
      })
      .then(() => this.persistObservedEnvelope(connection, envelope, direction, localSessionId, context));

    this.pendingObservedEnvelopePersistenceBySession.set(localSessionId, current);

    try {
      await current;
    } finally {
      if (this.pendingObservedEnvelopePersistenceBySession.get(localSessionId) === current) {
        this.pendingObservedEnvelopePersistenceBySession.delete(localSessionId);
      }
    }
  }

  /**
   * Delivers a turn signal after every envelope observed before it has been
   * persisted and delivered to session event listeners, so a `turn_ended`
   * listener sees the whole turn.
   */
  private async enqueueTurnEvent(localSessionId: string, notification: SandboxAgentTurnNotification): Promise<void> {
    const previous = this.pendingObservedEnvelopePersistenceBySession.get(localSessionId) ?? Promise.resolve();
    const current = previous
      .catch(() => {
        // An earlier persistence failure must not drop the signal.
      })
      .then(() => this.emitTurnEvent(localSessionId, notification));

    this.pendingObservedEnvelopePersistenceBySession.set(localSessionId, current);
    try {
      await current;
    } catch (error) {
      console.error("Failed to deliver sandbox-agent turn event", error);
    } finally {
      if (this.pendingObservedEnvelopePersistenceBySession.get(localSessionId) === current) {
        this.pendingObservedEnvelopePersistenceBySession.delete(localSessionId);
      }
    }
  }

  private async emitTurnEvent(localSessionId: string, notification: SandboxAgentTurnNotification): Promise<void> {
    const listeners = this.turnListeners.get(localSessionId);
    if (!listeners || listeners.size === 0) {
      return;
    }
    const event = toSessionTurnEvent(localSessionId, notification);
    for (const listener of listeners) {
      try {
        listener(event);
      } catch (error) {
        // One failing listener must not keep the event from the others.
        console.error("Session turn event listener failed", error);
      }
    }
  }

  private async persistSessionStateFromEvent(sessionId: string, envelope: AnyMessage, direction: AcpEnvelopeDirection): Promise<void> {
    if (direction !== "inbound") {
      return;
    }

    if (envelopeMethod(envelope) !== "session/update") {
      return;
    }

    const update = envelopeSessionUpdate(envelope);
    if (!update || typeof update.sessionUpdate !== "string") {
      return;
    }

    const record = await this.persist.getSession(sessionId);
    if (!record) {
      return;
    }

    if (update.sessionUpdate === "config_option_update") {
      const configOptions = normalizeSessionConfigOptions(update.configOptions);
      if (configOptions) {
        await this.persist.updateSession({
          ...record,
          configOptions,
        });
      }
      return;
    }

    if (update.sessionUpdate === "current_mode_update") {
      const modeId = typeof update.currentModeId === "string" ? update.currentModeId : null;
      if (!modeId) {
        return;
      }
      const nextModes = applyCurrentMode(record.modes, modeId);
      if (!nextModes) {
        return;
      }
      await this.persist.updateSession({
        ...record,
        modes: nextModes,
      });
    }
  }

  /**
   * `reseed` reads the highest stored index again and continues after it (or
   * after the local counter, whichever is higher), so writes that other
   * clients sharing the driver made in the meantime are not overtaken.
   */
  /**
   * Index for an event this client delivers but does not store: the next
   * index it would use, without taking it, so delivering other clients'
   * events does not push this client's own writes further out.
   */
  private async peekSessionEventIndex(sessionId: string): Promise<number> {
    await this.ensureSessionEventIndexSeeded(sessionId);
    return this.nextSessionEventIndexBySession.get(sessionId) ?? 1;
  }

  private async allocateSessionEventIndex(sessionId: string, reseed: boolean): Promise<number> {
    if (reseed) {
      const maxPersistedIndex = await this.findMaxPersistedSessionEventIndex(sessionId);
      const next = Math.max(this.nextSessionEventIndexBySession.get(sessionId) ?? 1, maxPersistedIndex + 1);
      this.nextSessionEventIndexBySession.set(sessionId, next + 1);
      return next;
    }
    await this.ensureSessionEventIndexSeeded(sessionId);
    const nextIndex = this.nextSessionEventIndexBySession.get(sessionId) ?? 1;
    this.nextSessionEventIndexBySession.set(sessionId, nextIndex + 1);
    return nextIndex;
  }

  private async ensureSessionEventIndexSeeded(sessionId: string): Promise<void> {
    if (this.nextSessionEventIndexBySession.has(sessionId)) {
      return;
    }

    if (!this.seedSessionEventIndexBySession.has(sessionId)) {
      const pending = (async () => {
        const maxPersistedIndex = await this.findMaxPersistedSessionEventIndex(sessionId);
        this.nextSessionEventIndexBySession.set(sessionId, Math.max(1, maxPersistedIndex + 1));
      })().finally(() => {
        this.seedSessionEventIndexBySession.delete(sessionId);
      });
      this.seedSessionEventIndexBySession.set(sessionId, pending);
    }

    const pending = this.seedSessionEventIndexBySession.get(sessionId);
    if (pending) {
      await pending;
    }
  }

  private async findMaxPersistedSessionEventIndex(sessionId: string): Promise<number> {
    return (await this.scanPersistedSessionEvents(sessionId)).maxIndex;
  }

  private async scanPersistedSessionEvents(sessionId: string): Promise<{ maxIndex: number; ids: Set<string> }> {
    let maxIndex = 0;
    const ids = new Set<string>();
    let eventCursor: string | undefined;

    while (true) {
      const eventsPage = await this.persist.listEvents({
        sessionId,
        cursor: eventCursor,
        limit: EVENT_INDEX_SCAN_EVENTS_LIMIT,
      });

      for (const event of eventsPage.items) {
        ids.add(event.id);
        if (Number.isFinite(event.eventIndex) && event.eventIndex > maxIndex) {
          maxIndex = Math.floor(event.eventIndex);
        }
      }

      if (!eventsPage.nextCursor) {
        break;
      }
      eventCursor = eventsPage.nextCursor;
    }

    return { maxIndex, ids };
  }

  private async collectReplayEvents(sessionId: string, maxEvents: number): Promise<SessionEvent[]> {
    const all: SessionEvent[] = [];
    let cursor: string | undefined;

    while (true) {
      const page = await this.persist.listEvents({
        sessionId,
        cursor,
        limit: Math.max(100, maxEvents),
      });

      all.push(...page.items);

      if (!page.nextCursor) {
        break;
      }

      cursor = page.nextCursor;
    }

    return all.slice(-maxEvents);
  }

  private upsertSessionHandle(record: SessionRecord): Session {
    const existing = this.sessionHandles.get(record.id);
    if (existing) {
      existing.apply(record);
      return existing;
    }

    const created = new Session(this, record);
    this.sessionHandles.set(record.id, created);
    return created;
  }

  private async requireSessionRecord(id: string): Promise<SessionRecord> {
    const record = await this.persist.getSession(id);
    if (!record) {
      throw new Error(`session '${id}' not found`);
    }
    return record;
  }

  private async enqueuePermissionRequest(
    connection: LiveAcpConnection,
    localSessionId: string,
    agentSessionId: string,
    request: RequestPermissionRequest,
    context: PermissionRequestContext,
  ): Promise<RequestPermissionResponse> {
    const listeners = this.permissionListeners.get(localSessionId);
    if (!listeners || listeners.size === 0) {
      // Only the client whose prompt the request belongs to cancels it when
      // nobody handles it. Other clients attached to the session never reply.
      if (context.controlling) {
        return cancelledPermissionResponse();
      }
      if (this.cancelUnansweredPermissionsAfterMs !== undefined) {
        return this.cancelPermissionLater(connection, localSessionId, context.rpcId, this.cancelUnansweredPermissionsAfterMs);
      }
      return unansweredPermissionResponse();
    }

    const pendingId = randomId();
    const permissionRequest: SessionPermissionRequest = {
      id: pendingId,
      createdAt: nowMs(),
      sessionId: localSessionId,
      agentSessionId,
      availableReplies: availablePermissionReplies(request.options),
      options: request.options.map(clonePermissionOption),
      toolCall: clonePermissionToolCall(request.toolCall),
      rawRequest: clonePermissionRequest(request),
    };

    return await new Promise<RequestPermissionResponse>((resolve, reject) => {
      this.pendingPermissionRequests.set(pendingId, {
        id: pendingId,
        sessionId: localSessionId,
        connection,
        rpcId: context.rpcId,
        controlling: context.controlling,
        request: clonePermissionRequest(request),
        resolve,
        reject,
      });

      try {
        for (const listener of listeners) {
          listener(permissionRequest);
        }
      } catch (error) {
        this.pendingPermissionRequests.delete(pendingId);
        reject(error);
      }
    });
  }

  private resolvePendingPermission(permissionId: string, response: RequestPermissionResponse): void {
    const pending = this.pendingPermissionRequests.get(permissionId);
    if (!pending) {
      throw new Error(`permission '${permissionId}' not found`);
    }

    this.pendingPermissionRequests.delete(permissionId);
    pending.resolve(response);
  }

  /** Opt-in: cancel another client's request unless it is answered in time. */
  private cancelPermissionLater(
    connection: LiveAcpConnection,
    sessionId: string,
    rpcId: string | number | undefined,
    delayMs: number,
  ): Promise<RequestPermissionResponse> {
    return new Promise<RequestPermissionResponse>((resolve) => {
      const timer: PassivePermissionTimer = {
        connection,
        sessionId,
        rpcId,
        handle: setTimeout(() => {
          this.passivePermissionTimers.delete(timer);
          resolve(cancelledPermissionResponse());
        }, delayMs),
      };
      this.passivePermissionTimers.add(timer);
    });
  }

  private clearPassivePermissionTimers(matches: (timer: PassivePermissionTimer) => boolean): void {
    for (const timer of this.passivePermissionTimers) {
      if (matches(timer)) {
        // The promise is left unsettled: no reply is sent.
        clearTimeout(timer.handle);
        this.passivePermissionTimers.delete(timer);
      }
    }
  }

  /**
   * The request was answered (by any client) or the turn ended: forget it
   * without replying, so a late local reply is not sent as a second answer.
   */
  private dropResolvedPermissionRequests(connection: LiveAcpConnection, sessionId: string, rpcId: string | number): void {
    for (const timer of this.passivePermissionTimers) {
      if (timer.connection === connection && timer.sessionId === sessionId && timer.rpcId !== undefined && String(timer.rpcId) === String(rpcId)) {
        // Answered elsewhere: never reply (the promise is left unsettled).
        clearTimeout(timer.handle);
        this.passivePermissionTimers.delete(timer);
      }
    }
    for (const [permissionId, pending] of this.pendingPermissionRequests) {
      if (pending.connection === connection && pending.sessionId === sessionId && pending.rpcId !== undefined && String(pending.rpcId) === String(rpcId)) {
        this.pendingPermissionRequests.delete(permissionId);
      }
    }
  }

  private cancelPendingPermissionsForConnection(connection: LiveAcpConnection): void {
    for (const [permissionId, pending] of this.pendingPermissionRequests) {
      if (pending.connection === connection) {
        this.pendingPermissionRequests.delete(permissionId);
        pending.resolve(cancelledPermissionResponse());
      }
    }
  }

  private cancelPendingPermissionsForSession(sessionId: string): void {
    for (const [permissionId, pending] of this.pendingPermissionRequests) {
      if (pending.sessionId !== sessionId) {
        continue;
      }
      this.pendingPermissionRequests.delete(permissionId);
      pending.resolve(cancelledPermissionResponse());
    }
  }

  private async requestJson<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const response = await this.requestRaw(method, path, {
      query: options.query,
      body: options.body,
      headers: options.headers,
      accept: options.accept ?? "application/json",
      signal: options.signal,
      skipReadyWait: options.skipReadyWait,
    });

    if (response.status === 204) {
      return undefined as T;
    }

    return (await response.json()) as T;
  }

  private async requestRaw(method: string, path: string, options: RequestOptions = {}): Promise<Response> {
    if (!options.skipReadyWait) {
      await this.awaitHealthy(options.signal);
    }

    const url = this.buildUrl(path, options.query);
    const headers = this.buildHeaders(options.headers);

    if (options.accept) {
      headers.set("Accept", options.accept);
    }

    const init: RequestInit = {
      method,
      headers,
      signal: options.signal,
    };

    if (options.rawBody !== undefined && options.body !== undefined) {
      throw new Error("requestRaw received both rawBody and body");
    }

    if (options.rawBody !== undefined) {
      if (options.contentType) {
        headers.set("Content-Type", options.contentType);
      }
      init.body = options.rawBody;
    } else if (options.body !== undefined) {
      headers.set("Content-Type", "application/json");
      init.body = JSON.stringify(options.body);
    }

    const response = await this.fetcher(url, init);
    if (!response.ok) {
      const problem = await readProblem(response);
      throw new SandboxAgentError(response.status, problem, response);
    }

    return response;
  }

  private startHealthWait(): void {
    if (!this.healthWait.enabled || this.healthPromise) {
      return;
    }

    this.healthPromise = this.runHealthWait().catch((error) => {
      this.healthError = error instanceof Error ? error : new Error(String(error));
    });
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new SandboxAgentDisposedError();
    }
  }

  /** After dispose(), a failure of an ACP call becomes SandboxAgentDisposedError. */
  private disposedErrorOr(error: unknown): unknown {
    if (!this.disposed || error instanceof SandboxAgentDisposedError) {
      return error;
    }
    return new SandboxAgentDisposedError({ cause: error });
  }

  private async awaitHealthy(signal?: AbortSignal): Promise<void> {
    if (!this.healthPromise) {
      throwIfAborted(signal);
      return;
    }

    await waitForAbortable(this.healthPromise, signal);
    throwIfAborted(signal);
    if (this.healthError) {
      throw this.healthError;
    }
  }

  private async runHealthWait(): Promise<void> {
    const signal = this.healthWait.enabled ? anyAbortSignal([this.healthWait.signal, this.healthWaitAbortController.signal]) : undefined;
    const startedAt = Date.now();
    const deadline = typeof this.healthWait.timeoutMs === "number" ? startedAt + this.healthWait.timeoutMs : undefined;

    let delayMs = HEALTH_WAIT_MIN_DELAY_MS;
    let nextLogAt = startedAt + HEALTH_WAIT_LOG_AFTER_MS;
    let lastError: unknown;
    let consecutiveFailures = 0;

    while (!this.disposed && (deadline === undefined || Date.now() < deadline)) {
      throwIfAborted(signal);

      try {
        const health = await this.requestHealth({ signal });
        if (health.status === "ok") {
          return;
        }
        lastError = new Error(`Unexpected health response: ${JSON.stringify(health)}`);
        consecutiveFailures++;
      } catch (error) {
        if (isAbortError(error)) {
          throw error;
        }
        lastError = error;
        consecutiveFailures++;
      }

      if (consecutiveFailures >= HEALTH_WAIT_ENSURE_SERVER_AFTER_FAILURES && this.sandboxProvider?.ensureServer && this.sandboxProviderRawId) {
        try {
          await this.sandboxProvider.ensureServer(this.sandboxProviderRawId);
        } catch {
          // Best-effort; the next health check will determine if it worked.
        }
        consecutiveFailures = 0;
      }

      const now = Date.now();
      if (now >= nextLogAt) {
        const details = formatHealthWaitError(lastError);
        console.warn(`sandbox-agent at ${this.baseUrl} is not healthy after ${now - startedAt}ms; still waiting (${details})`);
        nextLogAt = now + HEALTH_WAIT_LOG_EVERY_MS;
      }

      await sleep(delayMs, signal);
      delayMs = Math.min(HEALTH_WAIT_MAX_DELAY_MS, delayMs * 2);
    }

    if (this.disposed) {
      return;
    }

    throw new Error(`Timed out waiting for sandbox-agent health after ${this.healthWait.timeoutMs}ms (${formatHealthWaitError(lastError)})`);
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

  private buildUrl(path: string, query?: Record<string, QueryValue>): string {
    const url = new URL(`${this.baseUrl}${path}`);

    if (query) {
      Object.entries(query).forEach(([key, value]) => {
        if (value === undefined || value === null) {
          return;
        }
        url.searchParams.set(key, String(value));
      });
    }

    return url.toString();
  }

  private async requestHealth(options: { signal?: AbortSignal } = {}): Promise<HealthResponse> {
    return this.requestJson("GET", `${API_PREFIX}/health`, {
      signal: options.signal,
      skipReadyWait: true,
    });
  }
}

function isSessionEventIndexConflict(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /UNIQUE constraint failed: .*session_id, .*event_index/.test(error.message);
}

type PassivePermissionTimer = {
  connection: LiveAcpConnection;
  sessionId: string;
  rpcId?: string | number;
  handle: ReturnType<typeof setTimeout>;
};

type PendingPermissionRequestState = {
  id: string;
  sessionId: string;
  connection: LiveAcpConnection;
  rpcId?: string | number;
  /** The request belongs to a prompt this client sent. */
  controlling: boolean;
  request: RequestPermissionRequest;
  resolve: (response: RequestPermissionResponse) => void;
  reject: (reason?: unknown) => void;
};

type QueryValue = string | number | boolean | null | undefined;

type RequestOptions = {
  query?: Record<string, QueryValue>;
  body?: unknown;
  rawBody?: BodyInit;
  contentType?: string;
  headers?: HeadersInit;
  accept?: string;
  signal?: AbortSignal;
  skipReadyWait?: boolean;
};

type NormalizedHealthWaitOptions = { enabled: false; timeoutMs?: undefined; signal?: undefined } | { enabled: true; timeoutMs?: number; signal?: AbortSignal };

function parseProcessTerminalServerFrame(payload: string): ProcessTerminalServerFrame | null {
  try {
    const parsed = JSON.parse(payload) as unknown;
    if (!isRecord(parsed) || typeof parsed.type !== "string") {
      return null;
    }

    if (parsed.type === "ready" && typeof parsed.processId === "string") {
      return parsed as ProcessTerminalServerFrame;
    }

    if (parsed.type === "exit" && (parsed.exitCode === undefined || parsed.exitCode === null || typeof parsed.exitCode === "number")) {
      return parsed as ProcessTerminalServerFrame;
    }

    if (parsed.type === "error" && typeof parsed.message === "string") {
      return parsed as ProcessTerminalServerFrame;
    }
  } catch {
    return null;
  }

  return null;
}

function encodeTerminalInput(data: string | ArrayBuffer | ArrayBufferView): { data: string; encoding?: "base64" } {
  if (typeof data === "string") {
    return { data };
  }

  const bytes = encodeTerminalBytes(data);
  return {
    data: bytesToBase64(bytes),
    encoding: "base64",
  };
}

function encodeTerminalBytes(data: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
}

async function decodeTerminalBytes(data: unknown): Promise<Uint8Array> {
  if (data instanceof ArrayBuffer) {
    return new Uint8Array(data);
  }

  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }

  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }

  throw new Error(`Unsupported terminal frame payload: ${String(data)}`);
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== "undefined") {
    return Buffer.from(bytes).toString("base64");
  }

  if (typeof btoa === "function") {
    let binary = "";
    const chunkSize = 0x8000;
    for (let index = 0; index < bytes.length; index += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
    }
    return btoa(binary);
  }

  throw new Error("Base64 encoding is not available in this environment.");
}

// Env-var based methods that the server process can satisfy automatically.
// Interactive methods (e.g. "claude-login") cannot be fulfilled programmatically.
const DEFAULT_AUTH_METHOD_IDS = new Set(["codex-api-key", "openai-api-key", "anthropic-api-key"]);

/**
 * Select and call `authenticate` based on the agent's advertised auth methods.
 *
 * Order: explicit `methodId`, then `selectMethod`, then the default heuristic.
 * An explicitly chosen method must be advertised and its errors propagate.
 * The default heuristic stays best-effort: its errors are ignored because the
 * agent may already have credentials from env vars or credential files.
 */
async function autoAuthenticate(acp: AcpHttpClient, agent: string, methods: AuthMethod[], auth: SandboxAgentAuthOptions | false | undefined): Promise<void> {
  if (auth === false) {
    return;
  }

  let explicit: string | false | null | undefined = auth?.methodId;
  if (explicit === undefined && auth?.selectMethod) {
    explicit = await auth.selectMethod(methods, { agent });
  }

  if (explicit === false) {
    return;
  }

  if (typeof explicit === "string") {
    if (!methods.some((method) => method.id === explicit)) {
      const advertised = methods.map((method) => method.id).join(", ");
      throw new Error(`Agent '${agent}' does not advertise auth method '${explicit}' (advertised: ${advertised}).`);
    }
    try {
      await acp.authenticate({ methodId: explicit });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Failed to authenticate agent '${agent}' with auth method '${explicit}': ${message}`, { cause: error });
    }
    return;
  }

  const envBased = methods.find((method) => DEFAULT_AUTH_METHOD_IDS.has(method.id));
  if (!envBased) {
    return;
  }

  try {
    await acp.authenticate({ methodId: envBased.id });
  } catch {
    // Best-effort; see function docs.
  }
}

function toAgentQuery(options: AgentQueryOptions | undefined): Record<string, QueryValue> | undefined {
  if (!options) {
    return undefined;
  }

  return {
    config: options.config,
    no_cache: options.noCache,
  };
}

function profilePath(agent: string, name: string): string {
  return `${API_PREFIX}/config/profiles/${encodeURIComponent(agent)}/${encodeURIComponent(name)}`;
}

function normalizeSessionInit(
  value: Omit<NewSessionRequest, "_meta"> | undefined,
  cwdShorthand?: string,
  providerDefaultCwd?: string,
): Omit<NewSessionRequest, "_meta"> {
  if (!value) {
    return {
      cwd: cwdShorthand ?? providerDefaultCwd ?? defaultCwd(),
      mcpServers: [],
    };
  }

  return {
    ...value,
    cwd: value.cwd ?? cwdShorthand ?? providerDefaultCwd ?? defaultCwd(),
    mcpServers: value.mcpServers ?? [],
  };
}

// acp-http-client reports HTTP-level request failures with this JSON-RPC code.
const ACP_HTTP_TRANSPORT_ERROR_CODE = -32003;

// Problem types Sandbox Agent returns for POST /v1/acp/{server_id} before it
// forwards anything to the agent process: an unknown (deleted or exited) server
// without `?agent=`, or an invalid request.
const UNDELIVERED_POST_PROBLEM_TYPES = new Set(["urn:sandbox-agent:error:invalid_request", "urn:sandbox-agent:error:session_not_found"]);

/**
 * The POST carrying the request was rejected by Sandbox Agent itself with a 4xx
 * problem it only returns before forwarding anything to the agent process, so
 * the agent never saw the request. Any other failure may come after the agent
 * received it: 5xx (agent exited, timeout, write failure), and 4xx without a
 * Sandbox Agent problem body, which a proxy in front of the server (408, 429,
 * 499) can return after it already forwarded the request.
 */
function isRejectedBeforeDelivery(error: unknown): boolean {
  if (!(error instanceof AcpRpcError) || error.code !== ACP_HTTP_TRANSPORT_ERROR_CODE) {
    return false;
  }
  const problem = error.data as { status?: unknown; type?: unknown } | null | undefined;
  const status = problem?.status;
  return typeof status === "number" && status >= 400 && status < 500 && typeof problem?.type === "string" && UNDELIVERED_POST_PROBLEM_TYPES.has(problem.type);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

// Errors with which an agent says it cannot resume a session: method not
// supported, session not found, invalid params. Only these lead to a new
// agent session (and a replay of history) instead of the resumed one.
const RESUME_FALLBACK_ERROR_CODES = new Set([-32601, -32002, -32602]);

// Requests that only set state, so repeating one after the session was
// restored has the same effect as sending it once.
const RETRY_SAFE_SESSION_METHODS = new Set(["session/set_mode", "session/set_config_option"]);

/**
 * The agent reports that it does not know this session (for example after it
 * restarted). -32002 alone only means "resource not found", so the error must
 * also point at the session: by session id in its data or message, or by a
 * session-specific message.
 */
function isMissingRemoteSessionError(error: AcpRpcError, agentSessionId: string): boolean {
  if (error.code === ACP_HTTP_TRANSPORT_ERROR_CODE) {
    // An HTTP rejection by Sandbox Agent (for example 404 "Session Not Found"
    // for a server that is gone), not the agent: server loss is checked
    // separately, against the server list.
    return false;
  }
  const message = error.message.toLowerCase();
  if (message.includes("session not found") || message.includes("unknown session") || message.includes("session does not exist")) {
    return true;
  }
  if (error.code !== -32002) {
    return false;
  }
  const data = error.data as { sessionId?: unknown; uri?: unknown } | null | undefined;
  if (data && typeof data === "object" && (data.sessionId === agentSessionId || data.uri === agentSessionId)) {
    return true;
  }
  return error.message.includes(agentSessionId);
}

function toSessionTurnEvent(localSessionId: string, notification: SandboxAgentTurnNotification): SessionTurnEvent {
  const base = {
    sessionId: localSessionId,
    agentSessionId: notification.params.sessionId,
    requestId: notification.params.requestId,
  };
  switch (notification.method) {
    case "_sandboxagent/session/turn_started":
      return { ...base, type: "turn_started" };
    case "_sandboxagent/session/turn_ended":
      return {
        ...base,
        type: "turn_ended",
        outcome: notification.params.outcome,
        ...(notification.params.stopReason !== undefined ? { stopReason: notification.params.stopReason } : {}),
      };
    case "_sandboxagent/session/awaiting_input":
      return { ...base, type: "awaiting_input", kind: notification.params.kind };
    case "_sandboxagent/session/input_resolved":
      return { ...base, type: "input_resolved" };
  }
}

function mapSessionParams(params: Record<string, unknown>, agentSessionId: string): Record<string, unknown> {
  return {
    ...params,
    sessionId: agentSessionId,
  };
}

function injectReplayPrompt(params: Record<string, unknown>, replayText: string): void {
  const prompt = Array.isArray(params.prompt) ? [...params.prompt] : [];
  prompt.unshift({
    type: "text",
    text: replayText,
  });
  params.prompt = prompt;
}

function buildReplayText(events: SessionEvent[], maxChars: number): string | null {
  if (events.length === 0) {
    return null;
  }

  const prefix = "Previous session history is replayed below as JSON-RPC envelopes. Use it as context before responding to the latest user prompt.\n";
  let text = prefix;

  for (const event of events) {
    const line = JSON.stringify({
      createdAt: event.createdAt,
      sender: event.sender,
      payload: event.payload,
    });

    if (text.length + line.length + 1 > maxChars) {
      text += "\n[history truncated]";
      break;
    }

    text += `${line}\n`;
  }

  return text;
}

function envelopeMethod(message: AnyMessage): string | null {
  if (!isRecord(message) || !("method" in message) || typeof message["method"] !== "string") {
    return null;
  }
  return message["method"];
}

function envelopeId(message: AnyMessage): string | null {
  if (!isRecord(message) || !("id" in message) || message["id"] === undefined || message["id"] === null) {
    return null;
  }
  return String(message["id"]);
}

function envelopeSessionIdFromParams(message: AnyMessage): string | null {
  if (!isRecord(message) || !("params" in message) || !isRecord(message["params"])) {
    return null;
  }

  const params = message["params"];
  if (typeof params.sessionId === "string" && params.sessionId.length > 0) {
    return params.sessionId;
  }

  return null;
}

function envelopeSessionIdFromResult(message: AnyMessage): string | null {
  if (!isRecord(message) || !("result" in message) || !isRecord(message["result"])) {
    return null;
  }

  const result = message["result"];
  if (typeof result.sessionId === "string" && result.sessionId.length > 0) {
    return result.sessionId;
  }

  return null;
}

function cloneEnvelope(envelope: AnyMessage): AnyMessage {
  return JSON.parse(JSON.stringify(envelope)) as AnyMessage;
}

function clonePermissionRequest(request: RequestPermissionRequest): RequestPermissionRequest {
  return JSON.parse(JSON.stringify(request)) as RequestPermissionRequest;
}

function clonePermissionResponse(response: RequestPermissionResponse): RequestPermissionResponse {
  return JSON.parse(JSON.stringify(response)) as RequestPermissionResponse;
}

function clonePermissionOption(option: PermissionOption): SessionPermissionRequestOption {
  return {
    optionId: option.optionId,
    name: option.name,
    kind: option.kind,
  };
}

function clonePermissionToolCall(toolCall: RequestPermissionRequest["toolCall"]): RequestPermissionRequest["toolCall"] {
  return JSON.parse(JSON.stringify(toolCall)) as RequestPermissionRequest["toolCall"];
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null;
}

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === "function") {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nowMs(): number {
  return Date.now();
}

function defaultCwd(): string {
  if (typeof process !== "undefined" && typeof process.cwd === "function") {
    return process.cwd();
  }
  return "/";
}

function normalizePositiveInt(value: number | undefined, fallback: number): number {
  if (!Number.isFinite(value) || (value ?? 0) < 1) {
    return fallback;
  }
  return Math.floor(value as number);
}

function normalizeHealthWaitOptions(
  skipHealthCheck: boolean | undefined,
  waitForHealth: boolean | SandboxAgentHealthWaitOptions | undefined,
  signal: AbortSignal | undefined,
): NormalizedHealthWaitOptions {
  if (skipHealthCheck === true || waitForHealth === false) {
    return { enabled: false };
  }

  if (waitForHealth === true || waitForHealth === undefined) {
    return { enabled: true, signal };
  }

  const timeoutMs =
    typeof waitForHealth.timeoutMs === "number" && Number.isFinite(waitForHealth.timeoutMs) && waitForHealth.timeoutMs > 0
      ? Math.floor(waitForHealth.timeoutMs)
      : undefined;

  return {
    enabled: true,
    signal,
    timeoutMs,
  };
}

function parseSandboxProviderId(sandboxId: string): { provider: string; rawId: string } {
  const slashIndex = sandboxId.indexOf("/");
  if (slashIndex < 1 || slashIndex === sandboxId.length - 1) {
    throw new Error(`Sandbox IDs must be prefixed as "{provider}/{id}". Received '${sandboxId}'.`);
  }

  return {
    provider: sandboxId.slice(0, slashIndex),
    rawId: sandboxId.slice(slashIndex + 1),
  };
}

function requireSandboxBaseUrl(baseUrl: string | undefined, providerName: string): string {
  if (!baseUrl) {
    throw new Error(`Sandbox provider '${providerName}' did not return a base URL.`);
  }
  return baseUrl;
}

async function resolveProviderFetch(provider: SandboxProvider, rawSandboxId: string): Promise<typeof globalThis.fetch | undefined> {
  if (provider.getFetch) {
    return await provider.getFetch(rawSandboxId);
  }

  return undefined;
}

async function resolveProviderToken(provider: SandboxProvider, rawSandboxId: string): Promise<string | undefined> {
  const maybeGetToken = (
    provider as SandboxProvider & {
      getToken?: (sandboxId: string) => string | undefined | Promise<string | undefined>;
    }
  ).getToken;
  if (typeof maybeGetToken !== "function") {
    return undefined;
  }

  const token = await maybeGetToken.call(provider, rawSandboxId);
  return typeof token === "string" && token ? token : undefined;
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

function normalizeSessionConfigOptions(value: unknown): SessionConfigOption[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const normalized = value.filter(isSessionConfigOption) as SessionConfigOption[];
  return cloneConfigOptions(normalized) ?? [];
}

function extractConfigOptionsFromSetResponse(response: unknown): SessionConfigOption[] | undefined {
  if (!isRecord(response)) {
    return undefined;
  }
  return normalizeSessionConfigOptions(response.configOptions);
}

function findConfigOptionByCategory(options: SessionConfigOption[], category: string): SessionConfigOption | undefined {
  return options.find((option) => option.category === category);
}

function findConfigOptionById(options: SessionConfigOption[], configId: string): SessionConfigOption | undefined {
  return options.find((option) => option.id === configId);
}

function uniqueCategories(options: SessionConfigOption[]): string[] {
  return [...new Set(options.map((option) => option.category).filter((value): value is string => !!value))].sort();
}

function extractConfigValues(option: SessionConfigOption): string[] {
  if (!isRecord(option) || option.type !== "select" || !Array.isArray(option.options)) {
    return [];
  }

  const values: string[] = [];
  for (const entry of option.options as unknown[]) {
    if (isRecord(entry) && typeof entry.value === "string") {
      values.push(entry.value);
      continue;
    }
    if (isRecord(entry) && Array.isArray(entry.options)) {
      for (const nested of entry.options) {
        if (isRecord(nested) && typeof nested.value === "string") {
          values.push(nested.value);
        }
      }
    }
  }

  return [...new Set(values)];
}

function extractKnownModeIds(modes: SessionModeState | null | undefined): string[] {
  if (!modes || !Array.isArray(modes.availableModes)) {
    return [];
  }
  return modes.availableModes.map((mode) => (typeof mode.id === "string" ? mode.id : null)).filter((value): value is string => !!value);
}

function deriveModesFromConfigOptions(configOptions: SessionConfigOption[] | undefined): SessionModeState | null {
  if (!configOptions || configOptions.length === 0) {
    return null;
  }

  const modeOption = findConfigOptionByCategory(configOptions, "mode");
  if (!modeOption || modeOption.type !== "select" || !Array.isArray(modeOption.options)) {
    return null;
  }

  const availableModes = modeOption.options
    .flatMap((entry: unknown) => flattenConfigOptions(entry))
    .map((entry: { value: string; name: string; description?: string }) => ({
      id: entry.value,
      name: entry.name,
      description: entry.description ?? null,
    }));

  return {
    currentModeId: typeof modeOption.currentValue === "string" && modeOption.currentValue.length > 0 ? modeOption.currentValue : (availableModes[0]?.id ?? ""),
    availableModes,
  };
}

function applyCurrentMode(modes: SessionModeState | null | undefined, currentModeId: string): SessionModeState | null {
  if (modes && Array.isArray(modes.availableModes)) {
    return {
      ...modes,
      currentModeId,
    };
  }
  return {
    currentModeId,
    availableModes: [],
  };
}

function applyConfigOptionValue(configOptions: SessionConfigOption[], configId: string, value: string): SessionConfigOption[] | null {
  const idx = configOptions.findIndex((o) => o.id === configId);
  if (idx === -1) {
    return null;
  }
  const updated = cloneConfigOptions(configOptions) ?? [];
  updated[idx] = { ...updated[idx]!, currentValue: value } as SessionConfigOption;
  return updated;
}

function flattenConfigOptions(entry: unknown): Array<{ value: string; name: string; description?: string }> {
  if (!isRecord(entry)) {
    return [];
  }
  if (typeof entry.value === "string" && typeof entry.name === "string") {
    return [
      {
        value: entry.value,
        name: entry.name,
        description: typeof entry.description === "string" ? entry.description : undefined,
      },
    ];
  }
  if (!Array.isArray(entry.options)) {
    return [];
  }
  return entry.options.flatMap((nested) => flattenConfigOptions(nested));
}

function envelopeSessionUpdate(message: AnyMessage): Record<string, unknown> | null {
  if (!isRecord(message) || !("params" in message) || !isRecord(message.params)) {
    return null;
  }
  if (!("update" in message.params) || !isRecord(message.params.update)) {
    return null;
  }
  return message.params.update;
}

function cloneConfigOptions(value: SessionConfigOption[] | null | undefined): SessionConfigOption[] | undefined {
  if (!value) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(value)) as SessionConfigOption[];
}

function cloneModes(value: SessionModeState | null | undefined): SessionModeState | null {
  if (!value) {
    return null;
  }
  return JSON.parse(JSON.stringify(value)) as SessionModeState;
}

function availablePermissionReplies(options: PermissionOption[]): PermissionReply[] {
  const replies = new Set<PermissionReply>();
  for (const option of options) {
    if (option.kind === "allow_once") {
      replies.add("once");
    } else if (option.kind === "allow_always") {
      replies.add("always");
    } else if (option.kind === "reject_once" || option.kind === "reject_always") {
      replies.add("reject");
    }
  }
  return [...replies];
}

function permissionReplyToResponse(permissionId: string, request: RequestPermissionRequest, reply: PermissionReply): RequestPermissionResponse {
  const preferredKinds: PermissionOptionKind[] =
    reply === "once" ? ["allow_once"] : reply === "always" ? ["allow_always", "allow_once"] : ["reject_once", "reject_always"];

  const selected = preferredKinds
    .map((kind) => request.options.find((option) => option.kind === kind))
    .find((option): option is PermissionOption => Boolean(option));

  if (!selected) {
    throw new UnsupportedPermissionReplyError(permissionId, reply, availablePermissionReplies(request.options));
  }

  return {
    outcome: {
      outcome: "selected",
      optionId: selected.optionId,
    },
  };
}

/**
 * Never settles, so no reply is sent: the request belongs to another client.
 * Nothing keeps a reference to it, so it is garbage collected.
 */
function unansweredPermissionResponse(): Promise<RequestPermissionResponse> {
  return new Promise<RequestPermissionResponse>(() => {});
}

// Checks of another client's finished turn (see scheduleForeignTurnCheck): how
// often the store is checked, and how long it must stay unchanged, with the
// turn still incomplete, before the prompting client is taken to be gone.
const FOREIGN_TURN_CHECK_INTERVAL_MS = 250;
const FOREIGN_TURN_STALL_MS = 2_000;
// Events of another client's turn kept for that check, per turn.
const MAX_FOREIGN_TURN_BUFFER_EVENTS = 1_000;

function foreignTurnBufferKey(localSessionId: string, connection: LiveAcpConnection, foreignTurn: number): string {
  return `${localSessionId}\u0000${connection.connectionId}\u0000${foreignTurn}`;
}

/** The server rejected a request because the server does not exist (any more). */
function isMissingServerRejection(error: unknown): boolean {
  if (!(error instanceof AcpRpcError) || error.code !== ACP_HTTP_TRANSPORT_ERROR_CODE) {
    return false;
  }
  const status = (error.data as { status?: unknown } | undefined)?.status;
  return status === 400 || status === 404;
}

function permissionKey(agentSessionId: string, toolCallId: unknown): string {
  return `${agentSessionId}\u0000${typeof toolCallId === "string" ? toolCallId : ""}`;
}

function cancelledPermissionResponse(): RequestPermissionResponse {
  return {
    outcome: {
      outcome: "cancelled",
    },
  };
}

function isSessionConfigOption(value: unknown): value is SessionConfigOption {
  return isRecord(value) && typeof value.id === "string" && typeof value.name === "string" && typeof value.type === "string";
}

function toTitleCase(input: string): string {
  if (!input) {
    return "";
  }
  return input
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join("");
}

function formatHealthWaitError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (error === undefined || error === null) {
    return "unknown error";
  }

  return String(error);
}

function anyAbortSignal(signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const active = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (active.length === 0) {
    return undefined;
  }

  if (active.length === 1) {
    return active[0];
  }

  const controller = new AbortController();
  const onAbort = (event: Event) => {
    cleanup();
    const signal = event.target as AbortSignal;
    controller.abort(signal.reason ?? createAbortError());
  };
  const cleanup = () => {
    for (const signal of active) {
      signal.removeEventListener("abort", onAbort);
    }
  };

  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason ?? createAbortError());
      return controller.signal;
    }
  }

  for (const signal of active) {
    signal.addEventListener("abort", onAbort, { once: true });
  }

  return controller.signal;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) {
    return;
  }

  throw signal.reason instanceof Error ? signal.reason : createAbortError(signal.reason);
}

async function waitForAbortable<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) {
    return promise;
  }

  throwIfAborted(signal);

  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : createAbortError(signal.reason));
    };
    const cleanup = () => {
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}

async function consumeProcessLogSse(body: ReadableStream<Uint8Array>, listener: ProcessLogListener, signal: AbortSignal): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }

      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");

      let separatorIndex = buffer.indexOf("\n\n");
      while (separatorIndex !== -1) {
        const chunk = buffer.slice(0, separatorIndex);
        buffer = buffer.slice(separatorIndex + 2);

        const entry = parseProcessLogSseChunk(chunk);
        if (entry) {
          listener(entry);
        }

        separatorIndex = buffer.indexOf("\n\n");
      }
    }
  } catch (error) {
    if (signal.aborted || isAbortError(error)) {
      return;
    }
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function parseProcessLogSseChunk(chunk: string): ProcessLogEntry | null {
  if (!chunk.trim()) {
    return null;
  }

  let eventName = "message";
  const dataLines: string[] = [];

  for (const line of chunk.split("\n")) {
    if (!line || line.startsWith(":")) {
      continue;
    }

    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
      continue;
    }

    if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }

  if (eventName !== "log") {
    return null;
  }

  const data = dataLines.join("\n");
  if (!data.trim()) {
    return null;
  }

  return JSON.parse(data) as ProcessLogEntry;
}

function toWebSocketUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") {
    parsed.protocol = "ws:";
  } else if (parsed.protocol === "https:") {
    parsed.protocol = "wss:";
  }
  return parsed.toString();
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function createAbortError(reason?: unknown): Error {
  if (reason instanceof Error) {
    return reason;
  }

  const message = typeof reason === "string" ? reason : "This operation was aborted.";
  if (typeof DOMException !== "undefined") {
    return new DOMException(message, "AbortError");
  }

  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (!signal) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  throwIfAborted(signal);

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(signal.reason instanceof Error ? signal.reason : createAbortError(signal.reason));
    };
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}
