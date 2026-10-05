import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  InMemorySessionPersistDriver,
  SandboxAgent,
  SandboxAgentError,
  SessionRequestInterruptedError,
  type ListEventsRequest,
  type ListPage,
  type SessionEvent,
  type SessionPersistDriver,
  type SessionRecord,
  type Session,
  type SessionTurnEvent,
} from "../src/index.ts";
import { isNodeRuntime } from "../src/spawn.ts";
import { createDockerTestLayout, disposeDockerTestLayout, startDockerSandboxAgent, type DockerSandboxAgentHandle } from "./helpers/docker.ts";
import { prepareMockAgentDataHome } from "./helpers/mock-agent.ts";
import { startFaultProxy } from "./helpers/fault-proxy.ts";
import WebSocket from "ws";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Delegates to a shared driver, with a delay before each event write (a slow client). */
class DelayedWritePersistDriver implements SessionPersistDriver {
  constructor(
    private readonly inner: SessionPersistDriver,
    private readonly delayMs: number,
  ) {}

  getSession(id: string) {
    return this.inner.getSession(id);
  }

  listSessions(request?: { cursor?: string; limit?: number }) {
    return this.inner.listSessions(request);
  }

  updateSession(session: SessionRecord) {
    return this.inner.updateSession(session);
  }

  listEvents(request: ListEventsRequest) {
    return this.inner.listEvents(request);
  }

  async insertEvent(sessionId: string, event: SessionEvent): Promise<void> {
    await sleep(this.delayMs);
    await this.inner.insertEvent(sessionId, event);
  }
}

/** Delegates to a shared driver until `dead` is set; then writes nothing (a client that died). */
class KillablePersistDriver implements SessionPersistDriver {
  dead = false;

  constructor(private readonly inner: SessionPersistDriver) {}

  getSession(id: string) {
    return this.inner.getSession(id);
  }

  listSessions(request?: { cursor?: string; limit?: number }) {
    return this.inner.listSessions(request);
  }

  async updateSession(session: SessionRecord): Promise<void> {
    if (!this.dead) {
      await this.inner.updateSession(session);
    }
  }

  listEvents(request: ListEventsRequest) {
    return this.inner.listEvents(request);
  }

  async insertEvent(sessionId: string, event: SessionEvent): Promise<void> {
    if (!this.dead) {
      await this.inner.insertEvent(sessionId, event);
    }
  }
}

class StrictUniqueSessionPersistDriver implements SessionPersistDriver {
  private readonly events = new InMemorySessionPersistDriver({
    maxEventsPerSession: 500,
  });
  private readonly eventIndexesBySession = new Map<string, Set<number>>();

  async getSession(id: string): Promise<SessionRecord | null> {
    return this.events.getSession(id);
  }

  async listSessions(request?: { cursor?: string; limit?: number }): Promise<ListPage<SessionRecord>> {
    return this.events.listSessions(request);
  }

  async updateSession(session: SessionRecord): Promise<void> {
    await this.events.updateSession(session);
  }

  async listEvents(request: ListEventsRequest): Promise<ListPage<SessionEvent>> {
    return this.events.listEvents(request);
  }

  async insertEvent(sessionId: string, event: SessionEvent): Promise<void> {
    await sleep(5);

    const indexes = this.eventIndexesBySession.get(sessionId) ?? new Set<number>();
    if (indexes.has(event.eventIndex)) {
      throw new Error("UNIQUE constraint failed: sandbox_agent_events.session_id, sandbox_agent_events.event_index");
    }

    indexes.add(event.eventIndex);
    this.eventIndexesBySession.set(sessionId, indexes);

    await sleep(5);
    await this.events.insertEvent(sessionId, event);
  }
}

async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 6000, stepMs = 30): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = fn();
    if (value !== undefined && value !== null) {
      return value;
    }
    await sleep(stepMs);
  }
  throw new Error("timed out waiting for condition");
}

async function waitForAsync<T>(fn: () => Promise<T | undefined | null>, timeoutMs = 6000, stepMs = 30): Promise<T> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await fn();
    if (value !== undefined && value !== null) {
      return value;
    }
    await sleep(stepMs);
  }
  throw new Error("timed out waiting for condition");
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 15_000): Promise<T> {
  return await Promise.race([
    promise,
    sleep(timeoutMs).then(() => {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }),
  ]);
}

/** Settles a promise to its outcome, so it can be awaited with a deadline without an unhandled rejection. */
function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: Error }> {
  return promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: error instanceof Error ? error : new Error(String(error)) }),
  );
}

/** Ids of the agent servers the server lists right now. */
async function listServerIds(baseUrl: string, token: string | undefined): Promise<string[]> {
  const response = await fetch(`${baseUrl}/v1/acp`, { headers: token ? { Authorization: `Bearer ${token}` } : undefined });
  expect(response.ok).toBe(true);
  const body = (await response.json()) as { servers: Array<{ serverId: string }> };
  return body.servers.map((server) => server.serverId);
}

/**
 * A fetch that passes every request to the server unchanged and calls `onRequest`
 * first, so a test can act (for example dispose a client) at a precise moment.
 */
function createObservingFetch(onRequest: (method: string, url: URL) => void | Promise<void>): typeof fetch {
  return async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    await onRequest(method, url);
    return fetch(input, init);
  };
}

async function deleteAcpServer(baseUrl: string, token: string | undefined, serverId: string): Promise<void> {
  const response = await fetch(`${baseUrl}/v1/acp/${encodeURIComponent(serverId)}`, {
    method: "DELETE",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
  expect(response.ok).toBe(true);
}

/**
 * Client `session/prompt` events of a session whose user text (the last text
 * block; replayed history is prepended as the first one) contains `text`.
 */
async function clientPromptsWithText(sdk: SandboxAgent, sessionId: string, text: string): Promise<SessionEvent[]> {
  const events = await sdk.getEvents({ sessionId, limit: 500 });
  return events.items.filter((event) => {
    const payload = event.payload as { method?: string; params?: { prompt?: Array<{ text?: unknown }> } };
    const userText = (payload.params?.prompt ?? []).filter((block) => typeof block.text === "string").at(-1)?.text as string | undefined;
    return event.sender === "client" && payload.method === "session/prompt" && userText?.includes(text) === true;
  });
}

function buildTarArchive(entries: Array<{ name: string; content: string }>): Uint8Array {
  const blocks: Buffer[] = [];

  for (const entry of entries) {
    const content = Buffer.from(entry.content, "utf8");
    const header = Buffer.alloc(512, 0);

    writeTarString(header, 0, 100, entry.name);
    writeTarOctal(header, 100, 8, 0o644);
    writeTarOctal(header, 108, 8, 0);
    writeTarOctal(header, 116, 8, 0);
    writeTarOctal(header, 124, 12, content.length);
    writeTarOctal(header, 136, 12, Math.floor(Date.now() / 1000));
    header.fill(0x20, 148, 156);
    header[156] = "0".charCodeAt(0);
    writeTarString(header, 257, 6, "ustar");
    writeTarString(header, 263, 2, "00");

    let checksum = 0;
    for (const byte of header) {
      checksum += byte;
    }
    writeTarChecksum(header, checksum);

    blocks.push(header);
    blocks.push(content);

    const remainder = content.length % 512;
    if (remainder !== 0) {
      blocks.push(Buffer.alloc(512 - remainder, 0));
    }
  }

  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

/** Minimal tar reader for tests: returns file contents by path and `dir/` keys for directories. */
function parseTarArchive(bytes: Uint8Array): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const decoder = new TextDecoder();
  const readString = (offset: number, length: number) => {
    const slice = bytes.subarray(offset, offset + length);
    const end = slice.indexOf(0);
    return decoder.decode(end === -1 ? slice : slice.subarray(0, end));
  };
  let offset = 0;
  let longName: string | null = null;
  while (offset + 512 <= bytes.length) {
    if (bytes.subarray(offset, offset + 512).every((byte) => byte === 0)) {
      break;
    }
    const size = Number.parseInt(readString(offset + 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(bytes[offset + 156] || 0x30);
    const prefix = readString(offset + 345, 155);
    let name = longName ?? (prefix && readString(offset + 257, 6) === "ustar" ? `${prefix}/` : "") + readString(offset, 100);
    longName = null;
    const dataStart = offset + 512;
    const data = bytes.subarray(dataStart, dataStart + size);
    offset = dataStart + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = decoder.decode(data).replace(/\0+$/, "");
      continue;
    }
    name = name.replace(/^\.\//, "");
    if (type === "5") {
      out.set(name.endsWith("/") ? name : `${name}/`, null);
    } else if (type === "0" || type === "\0") {
      out.set(name, decoder.decode(data));
    }
  }
  return out;
}

function writeTarString(buffer: Buffer, offset: number, length: number, value: string): void {
  const bytes = Buffer.from(value, "utf8");
  bytes.copy(buffer, offset, 0, Math.min(bytes.length, length));
}

function writeTarOctal(buffer: Buffer, offset: number, length: number, value: number): void {
  const rendered = value.toString(8).padStart(length - 1, "0");
  writeTarString(buffer, offset, length, rendered);
  buffer[offset + length - 1] = 0;
}

function writeTarChecksum(buffer: Buffer, checksum: number): void {
  const rendered = checksum.toString(8).padStart(6, "0");
  writeTarString(buffer, 148, 6, rendered);
  buffer[154] = 0;
  buffer[155] = 0x20;
}

function decodeProcessLogData(data: string, encoding: string): string {
  if (encoding === "base64") {
    return Buffer.from(data, "base64").toString("utf8");
  }
  return data;
}

function nodeCommand(source: string): { command: string; args: string[] } {
  return {
    command: "node",
    args: ["-e", source],
  };
}

function forwardRequest(defaultFetch: typeof fetch, baseUrl: string, outgoing: Request, parsed: URL): Promise<Response> {
  const forwardedInit: RequestInit & { duplex?: "half" } = {
    method: outgoing.method,
    headers: new Headers(outgoing.headers),
    signal: outgoing.signal,
  };

  if (outgoing.method !== "GET" && outgoing.method !== "HEAD") {
    forwardedInit.body = outgoing.body;
    forwardedInit.duplex = "half";
  }

  const forwardedUrl = new URL(`${parsed.pathname}${parsed.search}`, baseUrl);
  return defaultFetch(forwardedUrl, forwardedInit);
}

async function launchDesktopFocusWindow(sdk: SandboxAgent, display: string): Promise<string> {
  const windowProcess = await sdk.createProcess({
    command: "xterm",
    args: ["-geometry", "80x24+40+40", "-title", "Sandbox Desktop Test", "-e", "sh", "-lc", "sleep 60"],
    env: { DISPLAY: display },
  });

  await waitForAsync(
    async () => {
      const result = await sdk.runProcess({
        command: "sh",
        args: [
          "-lc",
          'wid="$(xdotool search --onlyvisible --name \'Sandbox Desktop Test\' 2>/dev/null | head -n 1 || true)"; if [ -z "$wid" ]; then exit 3; fi; xdotool windowactivate "$wid"',
        ],
        env: { DISPLAY: display },
        timeoutMs: 5_000,
      });

      return result.exitCode === 0 ? true : undefined;
    },
    10_000,
    200,
  );

  return windowProcess.id;
}

describe("Integration: TypeScript SDK flat session API", () => {
  let handle: DockerSandboxAgentHandle;
  let baseUrl: string;
  let token: string;
  let layout: ReturnType<typeof createDockerTestLayout>;

  beforeEach(async () => {
    layout = createDockerTestLayout();
    prepareMockAgentDataHome(layout.xdgDataHome);

    handle = await startDockerSandboxAgent(layout, {
      timeoutMs: 30000,
    });
    baseUrl = handle.baseUrl;
    token = handle.token;
  });

  afterEach(async () => {
    await handle?.dispose?.();
    if (layout) {
      disposeDockerTestLayout(layout);
    }
  });

  it("detects Node.js runtime", () => {
    expect(isNodeRuntime()).toBe(true);
  });

  it("creates a session, sends prompt, and persists events", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const session = await sdk.createSession({ agent: "mock" });

    const observed: SessionEvent[] = [];
    const off = session.onEvent((event) => {
      observed.push(event);
    });

    const prompt = await session.prompt([{ type: "text", text: "hello flat sdk" }]);
    expect(prompt.stopReason).toBe("end_turn");

    await waitFor(() => {
      const inbound = observed.find((event) => event.sender === "agent");
      return inbound;
    });

    const listed = await sdk.listSessions({ limit: 20 });
    expect(listed.items.some((entry) => entry.id === session.id)).toBe(true);

    const fetched = await sdk.getSession(session.id);
    expect(fetched?.agent).toBe("mock");

    const acpServers = await sdk.listAcpServers();
    expect(acpServers.servers.some((server) => server.agent === "mock")).toBe(true);

    const events = await sdk.getEvents({ sessionId: session.id, limit: 100 });
    expect(events.items.length).toBeGreaterThan(0);
    expect(events.items.some((event) => event.sender === "client")).toBe(true);
    expect(events.items.some((event) => event.sender === "agent")).toBe(true);
    expect(events.items.every((event) => typeof event.id === "string")).toBe(true);
    expect(events.items.every((event) => Number.isInteger(event.eventIndex))).toBe(true);

    for (let i = 1; i < events.items.length; i += 1) {
      expect(events.items[i]!.eventIndex).toBeGreaterThanOrEqual(events.items[i - 1]!.eventIndex);
    }

    off();
    await sdk.dispose();
  });

  it("preserves observed event indexes across session creation follow-up calls", async () => {
    const persist = new StrictUniqueSessionPersistDriver();
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
      persist,
    });

    const session = await sdk.createSession({ agent: "mock" });
    const prompt = await session.prompt([{ type: "text", text: "preserve event indexes" }]);
    expect(prompt.stopReason).toBe("end_turn");

    const events = await waitForAsync(async () => {
      const page = await sdk.getEvents({ sessionId: session.id, limit: 200 });
      return page.items.length >= 4 ? page : null;
    });
    expect(new Set(events.items.map((event) => event.eventIndex)).size).toBe(events.items.length);

    await sdk.dispose();
  });

  it("covers agent query flags and filesystem HTTP helpers", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const directory = join(layout.rootDir, "fs-test");
    const nestedDir = join(directory, "nested");
    const filePath = join(directory, "notes.txt");
    const movedPath = join(directory, "notes-moved.txt");
    const uploadDir = join(directory, "uploaded");
    mkdirSync(directory, { recursive: true });

    try {
      const listedAgents = await sdk.listAgents({ config: true, noCache: true });
      expect(listedAgents.agents.some((agent) => agent.id === "mock")).toBe(true);

      const mockAgent = await sdk.getAgent("mock", { config: true, noCache: true });
      expect(mockAgent.id).toBe("mock");
      expect(Array.isArray(mockAgent.configOptions)).toBe(true);

      await sdk.mkdirFs({ path: nestedDir });
      await sdk.writeFsFile({ path: filePath }, "hello from sdk");

      const bytes = await sdk.readFsFile({ path: filePath });
      expect(new TextDecoder().decode(bytes)).toBe("hello from sdk");

      const stat = await sdk.statFs({ path: filePath });
      expect(stat.path).toBe(filePath);
      expect(stat.size).toBe(bytes.byteLength);

      const entries = await sdk.listFsEntries({ path: directory });
      expect(entries.some((entry) => entry.path === nestedDir)).toBe(true);
      expect(entries.some((entry) => entry.path === filePath)).toBe(true);

      const moved = await sdk.moveFs({
        from: filePath,
        to: movedPath,
        overwrite: true,
      });
      expect(moved.to).toBe(movedPath);

      const uploadResult = await sdk.uploadFsBatch(buildTarArchive([{ name: "batch.txt", content: "batch upload works" }]), { path: uploadDir });
      expect(uploadResult.paths.some((path) => path.endsWith("batch.txt"))).toBe(true);

      const uploaded = await sdk.readFsFile({ path: join(uploadDir, "batch.txt") });
      expect(new TextDecoder().decode(uploaded)).toBe("batch upload works");

      const deleted = await sdk.deleteFsEntry({ path: movedPath });
      expect(deleted.path).toBe(movedPath);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await sdk.dispose();
    }
  });

  it("downloads a directory as tar via downloadFsBatch", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const directory = join(layout.rootDir, "fs-download-batch");
    mkdirSync(directory, { recursive: true });

    try {
      await sdk.uploadFsBatch(
        buildTarArchive([
          { name: "a.txt", content: "alpha" },
          { name: "nested/b.txt", content: "bravo" },
        ]),
        { path: directory },
      );

      const stream = await sdk.downloadFsBatch({ path: directory });
      expect(stream).toBeInstanceOf(ReadableStream);
      const archive = new Uint8Array(await new Response(stream).arrayBuffer());
      const files = parseTarArchive(archive);
      expect(files.get("a.txt")).toBe("alpha");
      expect(files.get("nested/b.txt")).toBe("bravo");
      expect(files.has("nested/")).toBe(true);

      // Server-side checks fail before streaming starts and surface as SandboxAgentError.
      const limited = await sdk.downloadFsBatch({ path: directory, maxEntries: 1 }).catch((error: unknown) => error);
      expect(limited).toBeInstanceOf(SandboxAgentError);
      expect((limited as SandboxAgentError).status).toBe(400);
      expect((limited as SandboxAgentError).problem?.type).toBe("urn:sandbox-agent:error:limit_exceeded");

      const missing = await sdk.downloadFsBatch({ path: join(directory, "missing") }).catch((error: unknown) => error);
      expect(missing).toBeInstanceOf(SandboxAgentError);
      expect((missing as SandboxAgentError).status).toBe(400);
    } finally {
      rmSync(directory, { recursive: true, force: true });
      await sdk.dispose();
    }
  });

  it("uses custom fetch for both HTTP helpers and ACP session traffic", async () => {
    const defaultFetch = globalThis.fetch;
    if (!defaultFetch) {
      throw new Error("Global fetch is not available in this runtime.");
    }

    const seenPaths: string[] = [];
    const customFetch: typeof fetch = async (input, init) => {
      const outgoing = new Request(input, init);
      const parsed = new URL(outgoing.url);
      seenPaths.push(parsed.pathname);

      return forwardRequest(defaultFetch, baseUrl, outgoing, parsed);
    };

    const sdk = await SandboxAgent.connect({
      token,
      fetch: customFetch,
    });
    let sessionId: string | undefined;

    try {
      await withTimeout(sdk.getHealth(), "custom fetch getHealth");
      const session = await withTimeout(sdk.createSession({ agent: "mock" }), "custom fetch createSession");
      sessionId = session.id;
      expect(session.agent).toBe("mock");
      await withTimeout(sdk.destroySession(session.id), "custom fetch destroySession");

      expect(seenPaths).toContain("/v1/health");
      expect(seenPaths.some((path) => path.startsWith("/v1/acp/"))).toBe(true);
    } finally {
      if (sessionId) {
        await sdk.destroySession(sessionId).catch(() => {});
      }
      await withTimeout(sdk.dispose(), "custom fetch dispose");
    }
  }, 60_000);

  it("requires baseUrl when fetch is not provided", async () => {
    await expect(SandboxAgent.connect({ token } as any)).rejects.toThrow("baseUrl is required unless fetch is provided.");
  });

  it("waits for health before non-ACP HTTP helpers", async () => {
    const defaultFetch = globalThis.fetch;
    if (!defaultFetch) {
      throw new Error("Global fetch is not available in this runtime.");
    }

    let healthAttempts = 0;
    const seenPaths: string[] = [];
    const customFetch: typeof fetch = async (input, init) => {
      const outgoing = new Request(input, init);
      const parsed = new URL(outgoing.url);
      seenPaths.push(parsed.pathname);

      if (parsed.pathname === "/v1/health") {
        healthAttempts += 1;
        if (healthAttempts < 3) {
          return new Response("warming up", { status: 503 });
        }
      }

      return forwardRequest(defaultFetch, baseUrl, outgoing, parsed);
    };

    const sdk = await SandboxAgent.connect({
      token,
      fetch: customFetch,
    });

    const agents = await sdk.listAgents();
    expect(Array.isArray(agents.agents)).toBe(true);
    expect(healthAttempts).toBe(3);

    const firstAgentsRequest = seenPaths.indexOf("/v1/agents");
    expect(firstAgentsRequest).toBeGreaterThanOrEqual(0);
    expect(seenPaths.slice(0, firstAgentsRequest)).toEqual(["/v1/health", "/v1/health", "/v1/health"]);

    await sdk.dispose();
  });

  it("surfaces health timeout when a request awaits readiness", async () => {
    const customFetch: typeof fetch = async (input, init) => {
      const outgoing = new Request(input, init);
      const parsed = new URL(outgoing.url);

      if (parsed.pathname === "/v1/health") {
        return new Response("warming up", { status: 503 });
      }

      throw new Error(`Unexpected request path during timeout test: ${parsed.pathname}`);
    };

    const sdk = await SandboxAgent.connect({
      token,
      fetch: customFetch,
      waitForHealth: { timeoutMs: 100 },
    });

    await expect(sdk.listAgents()).rejects.toThrow("Timed out waiting for sandbox-agent health");
    await sdk.dispose();
  });

  it("aborts the shared health wait when connect signal is aborted", async () => {
    const controller = new AbortController();
    const customFetch: typeof fetch = async (input, init) => {
      const outgoing = new Request(input, init);
      const parsed = new URL(outgoing.url);

      if (parsed.pathname !== "/v1/health") {
        throw new Error(`Unexpected request path during abort test: ${parsed.pathname}`);
      }

      return new Promise<Response>((_resolve, reject) => {
        const onAbort = () => {
          outgoing.signal.removeEventListener("abort", onAbort);
          reject(outgoing.signal.reason ?? new DOMException("Connect aborted", "AbortError"));
        };

        if (outgoing.signal.aborted) {
          onAbort();
          return;
        }

        outgoing.signal.addEventListener("abort", onAbort, { once: true });
      });
    };

    const sdk = await SandboxAgent.connect({
      token,
      fetch: customFetch,
      signal: controller.signal,
    });

    const pending = sdk.listAgents();
    controller.abort(new DOMException("Connect aborted", "AbortError"));

    await expect(pending).rejects.toThrow("Connect aborted");
    await sdk.dispose();
  });

  it("restores a session on stale connection by recreating and replaying history on first prompt", async () => {
    const persist = new InMemorySessionPersistDriver({
      maxEventsPerSession: 200,
    });

    const first = await SandboxAgent.connect({
      baseUrl,
      token,
      persist,
      replayMaxEvents: 50,
      replayMaxChars: 20_000,
    });

    const created = await first.createSession({ agent: "mock" });
    await created.prompt([{ type: "text", text: "first run" }]);
    const oldConnectionId = created.lastConnectionId;

    await first.dispose();

    const second = await SandboxAgent.connect({
      baseUrl,
      token,
      persist,
      replayMaxEvents: 50,
      replayMaxChars: 20_000,
    });

    const restored = await second.resumeSession(created.id);
    expect(restored.lastConnectionId).not.toBe(oldConnectionId);

    await restored.prompt([{ type: "text", text: "second run" }]);

    const events = await second.getEvents({ sessionId: restored.id, limit: 500 });

    const replayInjected = events.items.find((event) => {
      if (event.sender !== "client") {
        return false;
      }
      const payload = event.payload as Record<string, unknown>;
      const method = payload.method;
      const params = payload.params as Record<string, unknown> | undefined;
      const prompt = Array.isArray(params?.prompt) ? params?.prompt : [];
      const firstBlock = prompt[0] as Record<string, unknown> | undefined;
      return method === "session/prompt" && typeof firstBlock?.text === "string" && firstBlock.text.includes("Previous session history is replayed below");
    });

    expect(replayInjected).toBeTruthy();

    await second.dispose();
  });

  it("resumeSession restores previously selected mode and model after recreation", async () => {
    const persist = new InMemorySessionPersistDriver({
      maxEventsPerSession: 500,
    });

    const first = await SandboxAgent.connect({ baseUrl, token, persist });
    const created = await first.createSession({ agent: "mock" });
    await created.setMode("plan");
    await created.setModel("mock-fast");

    // dispose() deletes the agent server, so resume has to recreate the session.
    await first.dispose();

    const second = await SandboxAgent.connect({ baseUrl, token, persist });
    try {
      const restored = await second.resumeSession(created.id);
      expect(restored.lastConnectionId).not.toBe(created.lastConnectionId);

      expect((await restored.getModes())?.currentModeId).toBe("plan");
      const modelOption = (await restored.getConfigOptions()).find((option) => option.category === "model");
      expect(modelOption?.currentValue).toBe("mock-fast");

      const events = await second.getEvents({ sessionId: restored.id, limit: 500 });
      const reapplied = events.items.filter((event) => event.sender === "client" && event.connectionId === restored.lastConnectionId);
      const methodParams = (method: string) =>
        reapplied
          .map((event) => event.payload as { method?: string; params?: Record<string, unknown> })
          .filter((payload) => payload.method === method && payload.params?.sessionId === restored.agentSessionId)
          .map((payload) => payload.params);

      expect(methodParams("session/set_mode")).toContainEqual(expect.objectContaining({ modeId: "plan" }));
      expect(methodParams("session/set_config_option")).toContainEqual(expect.objectContaining({ value: "mock-fast" }));
    } finally {
      await second.dispose();
    }
  });

  it("resumeSession reattaches to a live server without replaying history", async () => {
    const persist = new InMemorySessionPersistDriver({
      maxEventsPerSession: 500,
    });

    // The first client never disposes, which is what a crashed client looks like:
    // its agent server keeps running.
    const first = await SandboxAgent.connect({ baseUrl, token, persist });
    const second = await SandboxAgent.connect({ baseUrl, token, persist });
    try {
      const created = await first.createSession({ agent: "mock" });
      await created.prompt([{ type: "text", text: "first run" }]);

      const before = await persist.getSession(created.id);
      expect(before?.serverId).toBeTruthy();

      const restored = await second.resumeSession(created.id);
      expect(restored.agentSessionId).toBe(created.agentSessionId);
      expect(restored.lastConnectionId).not.toBe(created.lastConnectionId);
      expect(restored.serverId).toBe(before?.serverId);

      const after = await persist.getSession(created.id);
      expect(after?.serverId).toBe(before?.serverId);
      expect(after?.agentSessionId).toBe(created.agentSessionId);

      const prompt = await withTimeout(restored.prompt([{ type: "text", text: "second run" }]), "reattached prompt");
      expect(prompt.stopReason).toBe("end_turn");

      const events = await second.getEvents({ sessionId: restored.id, limit: 500 });
      const replayed = events.items.some((event) => {
        const payload = event.payload as { method?: string; params?: { prompt?: Array<{ text?: unknown }> } };
        const text = payload.params?.prompt?.[0]?.text;
        return payload.method === "session/prompt" && typeof text === "string" && text.includes("Previous session history is replayed below");
      });
      expect(replayed).toBe(false);
    } finally {
      await second.dispose();
      await first.dispose();
    }
  });

  it("delivers a prompt once after its agent server was deleted between turns", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      await session.prompt([{ type: "text", text: "before delete" }]);

      const serverId = (await sdk.getSession(session.id))?.serverId;
      expect(serverId).toBeTruthy();
      await deleteAcpServer(baseUrl, token, serverId!);

      // The server was already gone when the prompt was posted, so the agent
      // never saw it: the SDK restores the session and sends it once.
      const turnEvents: SessionTurnEvent[] = [];
      session.onTurnEvent((event) => turnEvents.push(event));
      const prompt = await withTimeout(session.prompt([{ type: "text", text: "after delete" }]), "prompt after server delete");
      expect(prompt.stopReason).toBe("end_turn");

      await waitFor(() => turnEvents.find((event) => event.type === "turn_ended"));
      expect(turnEvents.filter((event) => event.type === "turn_started")).toHaveLength(1);

      const restored = await sdk.getSession(session.id);
      expect(restored?.serverId).toBeTruthy();
      expect(restored?.serverId).not.toBe(serverId);
      const servers = await sdk.listAcpServers();
      expect(servers.servers.map((server) => server.serverId)).toContain(restored!.serverId);
      expect(servers.servers.map((server) => server.serverId)).not.toContain(serverId);
    } finally {
      await sdk.dispose();
    }
  });

  it("treats a 4xx without a sandbox-agent problem body as possibly delivered", async () => {
    // A proxy in front of the server can answer 408/429/499 after it already
    // forwarded the request, so such a 4xx must not lead to a silent resend.
    const defaultFetch = globalThis.fetch;
    // Set to the deleted server's id: the proxy rejects POSTs to it.
    let proxyRejectsServer: string | null = null;
    const proxyFetch: typeof fetch = async (input, init) => {
      const outgoing = new Request(input, init);
      const parsed = new URL(outgoing.url);
      const forwarded = await forwardRequest(defaultFetch, baseUrl, outgoing, parsed);
      if (proxyRejectsServer && outgoing.method === "POST" && parsed.pathname === `/v1/acp/${encodeURIComponent(proxyRejectsServer)}`) {
        await forwarded.text().catch(() => {});
        // A generic problem body, as many gateways send: a status, but not a
        // Sandbox Agent problem type.
        return new Response(JSON.stringify({ type: "about:blank", title: "Too Many Requests", status: 429 }), {
          status: 429,
          headers: { "Content-Type": "application/problem+json" },
        });
      }
      return forwarded;
    };

    const sdk = await SandboxAgent.connect({ token, fetch: proxyFetch });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      await session.prompt([{ type: "text", text: "before delete" }]);
      const serverId = (await sdk.getSession(session.id))?.serverId;
      await deleteAcpServer(baseUrl, token, serverId!);

      proxyRejectsServer = serverId ?? null;
      const failed = await withTimeout(
        session.prompt([{ type: "text", text: "rejected by proxy" }]).then(
          () => null,
          (error: unknown) => error,
        ),
        "prompt rejected by proxy",
      );
      proxyRejectsServer = null;

      expect(failed).toBeInstanceOf(SessionRequestInterruptedError);
      expect(await clientPromptsWithText(sdk, session.id, "rejected by proxy")).toHaveLength(1);
      const next = await withTimeout(session.prompt([{ type: "text", text: "resent by caller" }]), "prompt after proxy rejection");
      expect(next.stopReason).toBe("end_turn");
    } finally {
      await sdk.dispose();
    }
  });

  it("reports an interrupted prompt and restores the session when its agent server is deleted mid-turn", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    // Another client with its own agent server must not be affected.
    const bystander = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      const other = await bystander.createSession({ agent: "mock" });
      await session.prompt([{ type: "text", text: "before delete" }]);
      const serverId = (await sdk.getSession(session.id))?.serverId;
      const otherServerId = (await bystander.getSession(other.id))?.serverId;
      expect(serverId).toBeTruthy();
      expect(otherServerId).toBeTruthy();
      expect(otherServerId).not.toBe(serverId);

      const turnEvents: SessionTurnEvent[] = [];
      session.onTurnEvent((event) => turnEvents.push(event));
      const pending = session.prompt([{ type: "text", text: "delay:20000 mid-turn" }]).then(
        () => null,
        (error: unknown) => error,
      );
      await waitFor(() => turnEvents.find((event) => event.type === "turn_started"));
      await deleteAcpServer(baseUrl, token, serverId!);

      const interrupted = await withTimeout(pending, "prompt interrupted by server delete");
      expect(interrupted).toBeInstanceOf(SessionRequestInterruptedError);
      expect((interrupted as SessionRequestInterruptedError).session.id).toBe(session.id);
      expect((interrupted as SessionRequestInterruptedError).method).toBe("session/prompt");

      // Restored before the error was thrown, and the interrupted prompt was
      // not sent again.
      const restored = await sdk.getSession(session.id);
      expect(restored?.serverId).toBeTruthy();
      expect(restored?.serverId).not.toBe(serverId);
      expect(await clientPromptsWithText(sdk, session.id, "mid-turn")).toHaveLength(1);

      const next = await withTimeout(session.prompt([{ type: "text", text: "resent by caller" }]), "prompt on restored session");
      expect(next.stopReason).toBe("end_turn");
      expect(await clientPromptsWithText(sdk, session.id, "mid-turn")).toHaveLength(1);

      const servers = (await sdk.listAcpServers()).servers.map((server) => server.serverId);
      expect(servers).toContain(otherServerId);
      expect(servers).not.toContain(serverId);
      const otherPrompt = await withTimeout(other.prompt([{ type: "text", text: "bystander keeps working" }]), "bystander prompt");
      expect(otherPrompt.stopReason).toBe("end_turn");
      expect((await bystander.getSession(other.id))?.serverId).toBe(otherServerId);
    } finally {
      await bystander.dispose();
      await sdk.dispose();
    }
  });

  it("restores a session after its agent process crashes while the server stays up", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      const serverId = (await sdk.getSession(session.id))?.serverId;
      expect(serverId).toBeTruthy();

      const crashed = await withTimeout(
        session.prompt([{ type: "text", text: "crash:now" }]).then(
          () => null,
          (error: unknown) => error,
        ),
        "crashing prompt",
      );
      expect(crashed).toBeInstanceOf(SessionRequestInterruptedError);
      expect(await clientPromptsWithText(sdk, session.id, "crash:now")).toHaveLength(1);

      // The dead agent server is no longer listed, so it cannot be reused.
      const servers = (await sdk.listAcpServers()).servers.map((server) => server.serverId);
      expect(servers).not.toContain(serverId);

      const next = await withTimeout(session.prompt([{ type: "text", text: "continue after agent exit" }]), "prompt after agent crash");
      expect(next.stopReason).toBe("end_turn");
      const restored = await sdk.getSession(session.id);
      expect(restored?.serverId).toBeTruthy();
      expect(restored?.serverId).not.toBe(serverId);
      expect(await clientPromptsWithText(sdk, session.id, "crash:now")).toHaveLength(1);
    } finally {
      await sdk.dispose();
    }
  });

  it("delivers a prompt once when the agent process crashed while the session was idle", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      const record = await sdk.getSession(session.id);
      const serverId = record!.serverId!;
      const turnEvents: SessionTurnEvent[] = [];
      session.onTurnEvent((event) => turnEvents.push(event));
      // A finished turn makes sure the event stream is connected.
      await session.prompt([{ type: "text", text: "warm up" }]);

      // Crash the agent process directly, without this client sending anything.
      const crash = await fetch(`${baseUrl}/v1/acp/${encodeURIComponent(serverId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: "raw-crash",
          method: "session/prompt",
          params: { sessionId: record!.agentSessionId, prompt: [{ type: "text", text: "crash:now" }] },
        }),
      });
      expect(crash.status).toBe(500);
      await waitFor(() => turnEvents.find((event) => event.type === "turn_ended" && event.outcome === "agent_exited"));

      const next = await withTimeout(session.prompt([{ type: "text", text: "after idle crash" }]), "prompt after idle crash");
      expect(next.stopReason).toBe("end_turn");
      await waitFor(() => turnEvents.find((event) => event.type === "turn_ended" && event.outcome === "completed"));
      // Warm-up, crash, and the delivered prompt: one turn each.
      expect(turnEvents.filter((event) => event.type === "turn_started")).toHaveLength(3);
      expect((await sdk.getSession(session.id))?.serverId).not.toBe(serverId);
    } finally {
      await sdk.dispose();
    }
  });

  it("does not restore a session for unrelated not-found errors", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      const agentSessionId = session.agentSessionId;

      await expect(session.rawSend("_mock/missing_resource", {})).rejects.toThrow("Resource not found");

      const record = await sdk.getSession(session.id);
      expect(record?.agentSessionId).toBe(agentSessionId);
      const events = await sdk.getEvents({ sessionId: session.id, limit: 500 });
      const sessionCreates = events.items.filter((event) => (event.payload as { method?: string }).method === "session/new");
      expect(sessionCreates).toHaveLength(1);
      const missingResourceCalls = events.items.filter((event) => (event.payload as { method?: string }).method === "_mock/missing_resource");
      expect(missingResourceCalls).toHaveLength(1);
    } finally {
      await sdk.dispose();
    }
  });

  it("recovers a session the agent no longer knows", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      await session.setMode("plan");
      const forgottenAgentSessionId = session.agentSessionId;
      await session.rawSend("_mock/forget_session", {});

      const prompt = await withTimeout(session.prompt([{ type: "text", text: "after forget" }]), "prompt after forgotten session");
      expect(prompt.stopReason).toBe("end_turn");

      const refreshed = await sdk.getSession(session.id);
      expect(refreshed?.agentSessionId).not.toBe(forgottenAgentSessionId);
      expect((await refreshed!.getModes())?.currentModeId).toBe("plan");
    } finally {
      await sdk.dispose();
    }
  });

  it("persists the prompt response event before prompt resolves", async () => {
    const persist = new StrictUniqueSessionPersistDriver();
    const sdk = await SandboxAgent.connect({ baseUrl, token, persist });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      const observed: SessionEvent[] = [];
      session.onEvent((event) => observed.push(event));

      await session.prompt([{ type: "text", text: "persist response" }]);

      const isPromptResult = (event: SessionEvent) => {
        const payload = event.payload as { result?: { stopReason?: unknown } };
        return event.sender === "agent" && payload.result?.stopReason === "end_turn";
      };
      const events = await sdk.getEvents({ sessionId: session.id, limit: 200 });
      expect(events.items.filter(isPromptResult)).toHaveLength(1);
      expect(observed.filter(isPromptResult)).toHaveLength(1);
    } finally {
      await sdk.dispose();
    }
  });

  it("broker observer receives turn-ended signal", async () => {
    const persist = new InMemorySessionPersistDriver({ maxEventsPerSession: 500 });
    // The author sends prompts; the observer only attaches to the same server
    // and watches, like an orchestrator would.
    const author = await SandboxAgent.connect({ baseUrl, token, persist });
    const observer = await SandboxAgent.connect({ baseUrl, token, persist });
    try {
      const created = await author.createSession({ agent: "mock" });
      const watched = await observer.resumeSession(created.id);

      const turnEvents: SessionTurnEvent[] = [];
      const off = watched.onTurnEvent((event) => turnEvents.push(event));

      const prompt = await created.prompt([{ type: "text", text: "observed turn" }]);
      expect(prompt.stopReason).toBe("end_turn");

      const ended = await waitFor(() => turnEvents.find((event) => event.type === "turn_ended"));
      expect(turnEvents.map((event) => event.type)).toEqual(["turn_started", "turn_ended"]);
      expect(ended).toMatchObject({
        type: "turn_ended",
        sessionId: created.id,
        agentSessionId: created.agentSessionId,
        outcome: "completed",
        stopReason: "end_turn",
      });
      expect(ended.requestId).toEqual(turnEvents[0]!.requestId);

      // Turn events are signals, not conversation history.
      const events = await author.getEvents({ sessionId: created.id, limit: 500 });
      const synthetic = events.items.filter((event) => String((event.payload as { method?: unknown }).method ?? "").startsWith("_sandboxagent/session/"));
      expect(synthetic).toEqual([]);
      off();
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  // Author + observer: two clients share one persistence driver, and the
  // observer attaches to the author's agent server with resumeSession().
  async function connectAuthorAndObserver() {
    const persist = new InMemorySessionPersistDriver({ maxEventsPerSession: 1000 });
    const author = await SandboxAgent.connect({ baseUrl, token, persist });
    const observer = await SandboxAgent.connect({ baseUrl, token, persist });
    const session = await author.createSession({ agent: "mock" });
    const watched = await observer.resumeSession(session.id);
    expect(watched.serverId).toBe(session.serverId);
    // Make sure the observer's event stream is live before a scenario starts.
    await promptAndWaitForObserver(session, watched, "connect observer");
    return { persist, author, observer, session, watched };
  }

  async function promptAndWaitForObserver(author: Session, watched: Session, text: string): Promise<void> {
    let ended = false;
    const off = watched.onTurnEvent((event) => {
      if (event.type === "turn_ended") {
        ended = true;
      }
    });
    try {
      await withTimeout(author.prompt([{ type: "text", text }]), `prompt '${text}'`);
      await waitFor(() => (ended ? true : undefined));
    } finally {
      off();
    }
  }

  function collectPermissionTexts(session: Session): string[] {
    const texts: string[] = [];
    session.onEvent((event) => {
      const text = (event.payload as any)?.params?.update?.content?.text;
      if (typeof text === "string" && text.startsWith("mock permission ")) {
        texts.push(text);
      }
    });
    return texts;
  }

  it("a passive observer does not answer the author's permission request", async () => {
    const { author, observer, session } = await connectAuthorAndObserver();
    try {
      const texts = collectPermissionTexts(session);
      let permissionId: string | undefined;
      session.onPermissionRequest((request) => {
        permissionId = request.id;
      });

      let finished = false;
      const pending = session.prompt([{ type: "text", text: "trigger permission" }]);
      void pending.then(
        () => (finished = true),
        () => (finished = true),
      );
      await waitFor(() => permissionId);
      await sleep(300);
      // Without an answer from the author the turn is still waiting.
      expect(finished).toBe(false);

      await session.respondPermission(permissionId!, "once");
      await expect(withTimeout(pending, "prompt after the author's reply")).resolves.toMatchObject({ stopReason: "end_turn" });
      await waitFor(() => (texts.length > 0 ? texts : undefined));
      await sleep(100);
      expect(texts).toEqual(["mock permission approved: allow-once"]);
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("an observer's pending permission request is dropped once the author answered it", async () => {
    const { author, observer, session, watched } = await connectAuthorAndObserver();
    try {
      const texts = collectPermissionTexts(session);
      let authorPermissionId: string | undefined;
      let observerPermissionId: string | undefined;
      session.onPermissionRequest((request) => {
        authorPermissionId = request.id;
      });
      watched.onPermissionRequest((request) => {
        observerPermissionId = request.id;
      });
      const resolved: SessionTurnEvent[] = [];
      watched.onTurnEvent((event) => {
        if (event.type === "input_resolved") {
          resolved.push(event);
        }
      });

      const pending = session.prompt([{ type: "text", text: "trigger permission" }]);
      await waitFor(() => authorPermissionId);
      await waitFor(() => observerPermissionId);
      await session.respondPermission(authorPermissionId!, "once");
      await expect(withTimeout(pending, "prompt after the author's reply")).resolves.toMatchObject({ stopReason: "end_turn" });
      await waitFor(() => resolved[0]);

      // A late reply from the observer is not sent as a second answer.
      await expect(watched.respondPermission(observerPermissionId!, "reject")).rejects.toThrow(/not found/);
      await sleep(100);
      expect(texts).toEqual(["mock permission approved: allow-once"]);
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("a client attached to another session on the same server does not answer its permission requests", async () => {
    const persist = new InMemorySessionPersistDriver({ maxEventsPerSession: 1000 });
    const author = await SandboxAgent.connect({ baseUrl, token, persist });
    const observer = await SandboxAgent.connect({ baseUrl, token, persist });
    try {
      const target = await author.createSession({ agent: "mock" });
      const neighbour = await author.createSession({ agent: "mock" });
      expect(neighbour.serverId).toBe(target.serverId);
      const watched = await observer.resumeSession(neighbour.id);
      await promptAndWaitForObserver(neighbour, watched, "connect observer");

      let permissionId: string | undefined;
      target.onPermissionRequest((request) => {
        permissionId = request.id;
      });
      let finished = false;
      const pending = target.prompt([{ type: "text", text: "trigger permission" }]);
      void pending.then(
        () => (finished = true),
        () => (finished = true),
      );
      await waitFor(() => permissionId);
      await sleep(300);
      expect(finished).toBe(false);

      await target.respondPermission(permissionId!, "once");
      await expect(withTimeout(pending, "prompt after the author's reply")).resolves.toMatchObject({ stopReason: "end_turn" });
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("a sole client without a permission handler still cancels permission requests", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      const texts = collectPermissionTexts(session);
      await expect(withTimeout(session.prompt([{ type: "text", text: "trigger permission" }]), "prompt")).resolves.toMatchObject({
        stopReason: "end_turn",
      });
      await waitFor(() => (texts.length > 0 ? texts : undefined));
      expect(texts).toEqual(["mock permission approved: cancelled"]);
    } finally {
      await sdk.dispose();
    }
  });

  it("disposing an attached observer leaves the author's server and other observers running", async () => {
    const { persist, author, observer, session } = await connectAuthorAndObserver();
    const second = await SandboxAgent.connect({ baseUrl, token, persist });
    try {
      const secondWatched = await second.resumeSession(session.id);
      const serverId = session.serverId;
      const agentSessionId = session.agentSessionId;
      expect(serverId).toBeTruthy();

      await observer.dispose();

      const servers = await author.listAcpServers();
      expect(servers.servers.map((server) => server.serverId)).toContain(serverId);

      await promptAndWaitForObserver(session, secondWatched, "author continues");
      const record = await persist.getSession(session.id);
      expect(record?.serverId).toBe(serverId);
      expect(record?.agentSessionId).toBe(agentSessionId);

      const events = await author.getEvents({ sessionId: session.id, limit: 1000 });
      const replayed = events.items.some((event) => {
        const payload = event.payload as { method?: string; params?: { prompt?: Array<{ text?: unknown }> } };
        const text = payload.params?.prompt?.[0]?.text;
        return payload.method === "session/prompt" && typeof text === "string" && text.includes("Previous session history is replayed below");
      });
      expect(replayed).toBe(false);
    } finally {
      await second.dispose();
      await observer.dispose();
      await author.dispose();
    }
  });

  it("disposing an observer mid-turn does not interrupt the author's turn", async () => {
    const { author, observer, session } = await connectAuthorAndObserver();
    try {
      const turnEvents: SessionTurnEvent[] = [];
      session.onTurnEvent((event) => turnEvents.push(event));
      const prompt = session.prompt([{ type: "text", text: "delay:1500" }]);
      await waitFor(() => turnEvents.find((event) => event.type === "turn_started"));

      await observer.dispose();

      await expect(withTimeout(prompt, "author prompt")).resolves.toMatchObject({ stopReason: "end_turn" });
      const ended = await waitFor(() => turnEvents.find((event) => event.type === "turn_ended"));
      expect(ended).toMatchObject({ outcome: "completed" });
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("the client that created a server deletes it on dispose", async () => {
    const { author, observer, session } = await connectAuthorAndObserver();
    try {
      await author.dispose();
      const servers = await observer.listAcpServers();
      expect(servers.servers.map((server) => server.serverId)).not.toContain(session.serverId);
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("destroyAcpServer deletes a server the client only attached to", async () => {
    const { author, observer, session } = await connectAuthorAndObserver();
    try {
      await observer.destroyAcpServer(session.serverId!);
      const servers = await author.listAcpServers();
      expect(servers.servers.map((server) => server.serverId)).not.toContain(session.serverId);
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  async function expectLiveSlowAuthorOrder(writeDelayMs: number): Promise<void> {
    const shared = new InMemorySessionPersistDriver({ maxEventsPerSession: 1000 });
    // Both clients stay alive; only the author's writes are slow.
    const author = await SandboxAgent.connect({ baseUrl, token, persist: new DelayedWritePersistDriver(shared, writeDelayMs) });
    const observer = await SandboxAgent.connect({ baseUrl, token, persist: shared });
    try {
      const session = await author.createSession({ agent: "mock" });
      const watched = await observer.resumeSession(session.id);
      const words = ["warm", "one", "two", "three", "four"];
      for (const word of words) {
        await promptAndWaitForObserver(session, watched, `PROMPT:${word}`);
      }
      // Longer than the observer's stall detection (2 s), so a late write by it would show.
      await sleep(3_000);

      const stored = (await shared.listEvents({ sessionId: session.id, limit: 1000 })).items;
      const marked = stored.flatMap((event) => {
        const payload = event.payload as any;
        const promptText = payload?.method === "session/prompt" ? payload.params?.prompt?.[0]?.text : undefined;
        const chunkText = payload?.params?.update?.content?.text;
        const prompt = event.sender === "client" && typeof promptText === "string" ? /^PROMPT:(\w+)$/.exec(promptText) : null;
        const chunk = event.sender === "agent" && typeof chunkText === "string" ? /^mock: PROMPT:(\w+)$/.exec(chunkText) : null;
        return prompt ? [{ token: `P:${prompt[1]}`, event }] : chunk ? [{ token: `C:${chunk[1]}`, event }] : [];
      });
      expect(marked.map((entry) => entry.token)).toEqual(words.flatMap((word) => [`P:${word}`, `C:${word}`]));
      // Strictly increasing indexes: the order does not depend on how ties are broken.
      for (let index = 1; index < marked.length; index += 1) {
        expect(marked[index]!.event.eventIndex).toBeGreaterThan(marked[index - 1]!.event.eventIndex);
      }
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  }

  it("keeps shared history in order with a live observer and a live author whose writes take 150 ms", async () => {
    await expectLiveSlowAuthorOrder(150);
  }, 60_000);

  it("keeps shared history in order with a live observer and a live author whose writes take 60 ms", async () => {
    await expectLiveSlowAuthorOrder(60);
  }, 60_000);

  it("keeps shared history and replay in true order with an attached observer and a slow author", async () => {
    const shared = new InMemorySessionPersistDriver({ maxEventsPerSession: 1000 });
    // The author's writes land late, so the observer sees each event first.
    const author = await SandboxAgent.connect({ baseUrl, token, persist: new DelayedWritePersistDriver(shared, 40) });
    const observer = await SandboxAgent.connect({ baseUrl, token, persist: shared });
    let third: SandboxAgent | undefined;
    try {
      const session = await author.createSession({ agent: "mock" });
      const watched = await observer.resumeSession(session.id);
      const words = ["one", "two", "three", "four"];
      for (const word of words) {
        await promptAndWaitForObserver(session, watched, `PROMPT:${word}`);
      }
      await sleep(300);

      const expected = words.flatMap((word) => [`P:${word}`, `C:${word}`]);
      const stored = (await shared.listEvents({ sessionId: session.id, limit: 1000 })).items;
      const tokens = stored.flatMap((event) => {
        const payload = event.payload as any;
        const promptText = payload?.method === "session/prompt" ? payload.params?.prompt?.[0]?.text : undefined;
        const chunkText = payload?.params?.update?.content?.text;
        const prompt = event.sender === "client" && typeof promptText === "string" ? /^PROMPT:(\w+)$/.exec(promptText) : null;
        const chunk = event.sender === "agent" && typeof chunkText === "string" ? /^mock: PROMPT:(\w+)$/.exec(chunkText) : null;
        return prompt ? [`P:${prompt[1]}`] : chunk ? [`C:${chunk[1]}`] : [];
      });
      expect(tokens).toEqual(expected);

      // A client that has to recreate the session replays the history in the same order.
      await author.destroyAcpServer(session.serverId!);
      third = await SandboxAgent.connect({ baseUrl, token, persist: shared });
      const restored = await third.resumeSession(session.id);
      await withTimeout(restored.prompt([{ type: "text", text: "after replay" }]), "replayed prompt");
      const after = (await shared.listEvents({ sessionId: session.id, limit: 1000 })).items;
      const replayPrompt = after.find(
        (event) => event.sender === "client" && JSON.stringify(event.payload).includes("Previous session history is replayed below"),
      );
      expect(replayPrompt).toBeTruthy();
      const replayTokens = [...JSON.stringify(replayPrompt!.payload).matchAll(/(mock: )?PROMPT:(\w+)/g)].map((match) => `${match[1] ? "C" : "P"}:${match[2]}`);
      expect(replayTokens).toEqual(expected);
    } finally {
      await third?.dispose();
      await observer.dispose();
      await author.dispose();
    }
  });

  it("an observer stores the rest of a turn whose prompting client died mid-turn", async () => {
    const shared = new InMemorySessionPersistDriver({ maxEventsPerSession: 1000 });
    const authorPersist = new KillablePersistDriver(shared);
    const author = await SandboxAgent.connect({ baseUrl, token, persist: authorPersist });
    const observer = await SandboxAgent.connect({ baseUrl, token, persist: shared });
    try {
      const session = await author.createSession({ agent: "mock" });
      const watched = await observer.resumeSession(session.id);
      await promptAndWaitForObserver(session, watched, "connect observer");

      // The author shows the request to a user and then dies: it never answers
      // and stores nothing more.
      session.onPermissionRequest(() => {});
      let permissionId: string | undefined;
      watched.onPermissionRequest((request) => {
        permissionId = request.id;
      });
      let ended = false;
      watched.onTurnEvent((event) => {
        if (event.type === "turn_ended") {
          ended = true;
        }
      });
      const pending = session.prompt([{ type: "text", text: "trigger permission" }]).catch(() => undefined);
      await waitFor(() => permissionId);
      authorPersist.dead = true;

      await watched.respondPermission(permissionId!, "once");
      await waitFor(() => (ended ? true : undefined));
      await pending;
      // Longer than the observer's stall detection (2 s), so a late write by it would show.
      await sleep(3_000);

      const events = (await shared.listEvents({ sessionId: session.id, limit: 1000 })).items;
      expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
      const textOf = (event: SessionEvent) => (event.payload as any)?.params?.update?.content?.text;
      const promptIndex = events.findIndex((event) => event.sender === "client" && (event.payload as any)?.params?.prompt?.[0]?.text === "trigger permission");
      const chunkIndex = events.findIndex((event) => textOf(event) === "mock: trigger permission");
      const requestIndex = events.findIndex((event) => (event.payload as any)?.method === "session/request_permission");
      const approved = events.filter((event) => textOf(event) === "mock permission approved: allow-once");
      expect(approved).toHaveLength(1);
      const approvedIndex = events.indexOf(approved[0]!);
      expect(promptIndex).toBeGreaterThanOrEqual(0);
      expect(promptIndex).toBeLessThan(chunkIndex);
      expect(chunkIndex).toBeLessThan(requestIndex);
      expect(requestIndex).toBeLessThan(approvedIndex);
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("an observer stores the turn of an owner that disposed mid-turn without storing it", async () => {
    const shared = new InMemorySessionPersistDriver({ maxEventsPerSession: 1000 });
    const authorPersist = new KillablePersistDriver(shared);
    const author = await SandboxAgent.connect({ baseUrl, token, persist: authorPersist });
    const observer = await SandboxAgent.connect({ baseUrl, token, persist: shared });
    try {
      const session = await author.createSession({ agent: "mock" });
      const watched = await observer.resumeSession(session.id);
      await promptAndWaitForObserver(session, watched, "connect observer");

      let seen = false;
      watched.onEvent((event) => {
        if ((event.payload as any)?.params?.update?.content?.text === "mock: delay:5000") {
          seen = true;
        }
      });
      // The author stores nothing of this turn and then disposes, which deletes its server.
      authorPersist.dead = true;
      void session.prompt([{ type: "text", text: "delay:5000" }]).catch(() => undefined);
      await waitFor(() => (seen ? true : undefined));
      await withTimeout(author.dispose(), "author dispose");
      await sleep(3_000);

      const events = (await shared.listEvents({ sessionId: session.id, limit: 1000 })).items;
      const chunks = events.filter((event) => (event.payload as any)?.params?.update?.content?.text === "mock: delay:5000");
      expect(chunks).toHaveLength(1);
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("an observer attaching mid-turn while the server list fails does not duplicate events", async () => {
    const shared = new InMemorySessionPersistDriver({ maxEventsPerSession: 1000 });
    const author = await SandboxAgent.connect({ baseUrl, token, persist: shared });
    const observer = await SandboxAgent.connect({ baseUrl, token, persist: shared });
    try {
      const session = await author.createSession({ agent: "mock" });
      let permissionId: string | undefined;
      session.onPermissionRequest((request) => {
        permissionId = request.id;
      });
      const pending = session.prompt([{ type: "text", text: "trigger permission" }]);
      await waitFor(() => permissionId);

      // Every server list call after the first one (which finds the server to attach to) fails.
      const listAcpServers = observer.listAcpServers.bind(observer);
      let calls = 0;
      (observer as unknown as { listAcpServers: () => ReturnType<typeof listAcpServers> }).listAcpServers = async () => {
        calls += 1;
        if (calls > 1) {
          throw new Error("simulated server list failure");
        }
        return listAcpServers();
      };
      await observer.resumeSession(session.id);
      await sleep(100);
      await session.respondPermission(permissionId!, "once");
      await withTimeout(pending, "prompt");
      // Longer than the observer's stall detection (2 s), so a late write by it would show.
      await sleep(3_000);

      const events = (await shared.listEvents({ sessionId: session.id, limit: 1000 })).items;
      expect(new Set(events.map((event) => event.id)).size).toBe(events.length);
      const approved = events.filter((event) => (event.payload as any)?.params?.update?.content?.text === "mock permission approved: allow-once");
      expect(approved).toHaveLength(1);
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("does not fork a session when attaching to its server fails for another reason", async () => {
    const persist = new InMemorySessionPersistDriver({ maxEventsPerSession: 1000 });
    const author = await SandboxAgent.connect({ baseUrl, token, persist });
    const proxy = await startFaultProxy(baseUrl);
    const observer = await SandboxAgent.connect({ baseUrl: proxy.baseUrl, token, persist });
    try {
      const session = await author.createSession({ agent: "mock" });
      const serverId = session.serverId!;
      // A network failure on the first request to the existing server.
      proxy.rule = ({ method, path }) =>
        proxy.faults.length === 0 && method === "POST" && path === `/v1/acp/${encodeURIComponent(serverId)}` ? "drop" : "forward";

      await expect(observer.resumeSession(session.id)).rejects.toBeTruthy();
      expect(proxy.faults).toHaveLength(1);

      const record = await persist.getSession(session.id);
      expect(record?.serverId).toBe(serverId);
      expect(record?.agentSessionId).toBe(session.agentSessionId);
      const servers = await author.listAcpServers();
      expect(servers.servers.map((server) => server.serverId)).toEqual([serverId]);

      const watched = await observer.resumeSession(session.id);
      expect(watched.serverId).toBe(serverId);
      expect(watched.agentSessionId).toBe(session.agentSessionId);
    } finally {
      await observer.dispose();
      await author.dispose();
      await proxy.close();
    }
  });

  it("resumes a session on its server while listing servers fails", async () => {
    const persist = new InMemorySessionPersistDriver({ maxEventsPerSession: 1000 });
    const author = await SandboxAgent.connect({ baseUrl, token, persist });
    const proxy = await startFaultProxy(baseUrl);
    let failList = true;
    proxy.rule = ({ method, path }) => (failList && method === "GET" && path === "/v1/acp" ? "unavailable" : "forward");
    const observer = await SandboxAgent.connect({ baseUrl: proxy.baseUrl, token, persist });
    const sender = await SandboxAgent.connect({ baseUrl: proxy.baseUrl, token, persist });
    const late = await SandboxAgent.connect({ baseUrl: proxy.baseUrl, token, persist });
    try {
      const session = await author.createSession({ agent: "mock" });
      await session.prompt([{ type: "text", text: "before list failure" }]);
      const serverId = session.serverId!;

      // The server is alive: resuming attaches to it without needing the list.
      const watched = await withTimeout(observer.resumeSession(session.id), "resume while list fails");
      expect(watched.serverId).toBe(serverId);
      expect(watched.agentSessionId).toBe(session.agentSessionId);
      expect((await persist.getSession(session.id))?.serverId).toBe(serverId);

      // A request that restores the session on its own (no resumeSession first) is delivered there too.
      const prompted = await withTimeout(
        sender.rawSendSessionMethod(session.id, "session/prompt", { prompt: [{ type: "text", text: "while list fails" }] }),
        "prompt while list fails",
      );
      expect((prompted.response as { stopReason?: string }).stopReason).toBe("end_turn");
      expect(await clientPromptsWithText(author, session.id, "while list fails")).toHaveLength(1);
      expect((await persist.getSession(session.id))?.serverId).toBe(serverId);
      expect((await author.listAcpServers()).servers.map((server) => server.serverId)).toEqual([serverId]);

      // The server is gone, but while the list fails that cannot be confirmed:
      // resuming fails and no new server is started.
      await deleteAcpServer(baseUrl, token, serverId);
      const before = await persist.getSession(session.id);
      const failedLists = proxy.faults.length;
      await expect(late.resumeSession(session.id)).rejects.toBeTruthy();
      expect(proxy.faults.length).toBeGreaterThan(failedLists);
      expect(await persist.getSession(session.id)).toEqual(before);
      expect((await author.listAcpServers()).servers).toEqual([]);

      // Once the list confirms the server is gone, the session moves to a new one.
      failList = false;
      const moved = await withTimeout(late.resumeSession(session.id), "resume after list recovers");
      expect(moved.serverId).not.toBe(serverId);
      expect((await author.listAcpServers()).servers.map((server) => server.serverId)).toEqual([moved.serverId]);
    } finally {
      await late.dispose();
      await sender.dispose();
      await observer.dispose();
      await author.dispose();
      await proxy.close();
    }
  });

  it("does not recover a failed prompt while listing servers fails", async () => {
    const persist = new InMemorySessionPersistDriver({ maxEventsPerSession: 1000 });
    const proxy = await startFaultProxy(baseUrl);
    let failList = false;
    let failPostTo: string | undefined;
    proxy.rule = ({ method, path }) => {
      if (failList && method === "GET" && path === "/v1/acp") {
        return "unavailable";
      }
      if (failPostTo && method === "POST" && path === `/v1/acp/${encodeURIComponent(failPostTo)}`) {
        return "unavailable";
      }
      return "forward";
    };
    const sdk = await SandboxAgent.connect({ baseUrl: proxy.baseUrl, token, persist });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      await session.prompt([{ type: "text", text: "before failures" }]);
      const serverId = session.serverId!;
      const before = await persist.getSession(session.id);

      // The server is alive but the prompt and the list both fail: the prompt
      // fails, and the session stays on its server.
      failList = true;
      failPostTo = serverId;
      await expect(session.prompt([{ type: "text", text: "rejected prompt" }])).rejects.not.toBeInstanceOf(SessionRequestInterruptedError);
      expect(proxy.faults.some((fault) => fault.method === "GET" && fault.path === "/v1/acp")).toBe(true);
      expect(await persist.getSession(session.id)).toEqual(before);
      failPostTo = undefined;
      expect(await sdk.listAcpServers().catch(() => null)).toBeNull();
      failList = false;
      expect((await sdk.listAcpServers()).servers.map((server) => server.serverId)).toEqual([serverId]);

      const retried = await withTimeout(session.prompt([{ type: "text", text: "after failures" }]), "prompt after failures");
      expect(retried.stopReason).toBe("end_turn");
      expect((await persist.getSession(session.id))?.serverId).toBe(serverId);

      // The server is gone, but while the list fails that cannot be confirmed:
      // the prompt fails and no new server is started.
      await deleteAcpServer(baseUrl, token, serverId);
      failList = true;
      const lostBefore = await persist.getSession(session.id);
      await expect(session.prompt([{ type: "text", text: "server unconfirmed" }])).rejects.not.toBeInstanceOf(SessionRequestInterruptedError);
      expect(await persist.getSession(session.id)).toEqual(lostBefore);
      failList = false;
      expect((await sdk.listAcpServers()).servers).toEqual([]);

      // Once the list confirms the server is gone, the session is restored and
      // the prompt is delivered once.
      const turnEvents: SessionTurnEvent[] = [];
      session.onTurnEvent((event) => turnEvents.push(event));
      const recovered = await withTimeout(session.prompt([{ type: "text", text: "after list recovers" }]), "prompt after list recovers");
      expect(recovered.stopReason).toBe("end_turn");
      await waitFor(() => turnEvents.find((event) => event.type === "turn_ended"));
      expect(turnEvents.filter((event) => event.type === "turn_started")).toHaveLength(1);
      const restored = await persist.getSession(session.id);
      expect(restored?.serverId).not.toBe(serverId);
      expect((await sdk.listAcpServers()).servers.map((server) => server.serverId)).toEqual([restored!.serverId]);
    } finally {
      await sdk.dispose();
      await proxy.close();
    }
  });

  it("a passive client opted in to cancelUnansweredPermissionsAfterMs cancels a request nobody answers", async () => {
    const persist = new InMemorySessionPersistDriver({ maxEventsPerSession: 1000 });
    const author = await SandboxAgent.connect({ baseUrl, token, persist });
    const observer = await SandboxAgent.connect({ baseUrl, token, persist, cancelUnansweredPermissionsAfterMs: 500 });
    try {
      const session = await author.createSession({ agent: "mock" });
      const watched = await observer.resumeSession(session.id);
      await promptAndWaitForObserver(session, watched, "connect observer");
      const texts = collectPermissionTexts(session);
      // The author's listener never answers, like a client that hung or died.
      let permissionId: string | undefined;
      session.onPermissionRequest((request) => {
        permissionId = request.id;
      });

      const started = Date.now();
      const prompt = await withTimeout(session.prompt([{ type: "text", text: "trigger permission" }]), "prompt");
      expect(prompt.stopReason).toBe("end_turn");
      expect(permissionId).toBeTruthy();
      expect(Date.now() - started).toBeGreaterThanOrEqual(400);
      await waitFor(() => (texts.length > 0 ? texts : undefined));
      expect(texts).toEqual(["mock permission approved: cancelled"]);
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("restores an observer's session on a new server after the owner disposed", async () => {
    const { persist, author, observer, session, watched } = await connectAuthorAndObserver();
    try {
      const oldServerId = session.serverId;
      await author.dispose();
      expect((await observer.listAcpServers()).servers.map((server) => server.serverId)).not.toContain(oldServerId);

      // The observer attached without the agent bootstrap query, so its POST to
      // the deleted server is rejected with a 400 before any agent sees it. The
      // SDK confirms the server is gone, restores the session on a new server
      // it owns, and sends the prompt once more, so the call resolves.
      await expect(withTimeout(watched.prompt([{ type: "text", text: "after the owner left" }]), "first prompt after owner dispose")).resolves.toMatchObject({
        stopReason: "end_turn",
      });

      const record = await persist.getSession(session.id);
      const newServerId = record?.serverId;
      expect(newServerId).toBeTruthy();
      expect(newServerId).not.toBe(oldServerId);
      expect(record?.agentSessionId).toBeTruthy();
      expect((await observer.listAcpServers()).servers.map((server) => server.serverId)).toContain(newServerId);

      await expect(withTimeout(watched.prompt([{ type: "text", text: "on the new server" }]), "prompt on new server")).resolves.toMatchObject({
        stopReason: "end_turn",
      });
      expect((await persist.getSession(session.id))?.serverId).toBe(newServerId);

      // The observer owns the new server now, so its dispose deletes it.
      await observer.dispose();
      const checker = await SandboxAgent.connect({ baseUrl, token });
      try {
        expect((await checker.listAcpServers()).servers.map((server) => server.serverId)).not.toContain(newServerId);
      } finally {
        await checker.dispose();
      }
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("rejects a prompt in flight when its client is disposed", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      const turnEvents: SessionTurnEvent[] = [];
      session.onTurnEvent((event) => turnEvents.push(event));
      const prompt = settle(session.prompt([{ type: "text", text: "held delay:10000" }]));
      await waitFor(() => turnEvents.find((event) => event.type === "turn_started"));

      await sdk.dispose();

      const outcome = await withTimeout(prompt, "prompt after dispose", 3_000);
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: Error }).error.name).toBe("SandboxAgentDisposedError");
    } finally {
      await sdk.dispose();
    }
  });

  it("rejects a prompt in flight when an attached client is disposed, and the owner's turn goes on", async () => {
    const { author, observer, session, watched } = await connectAuthorAndObserver();
    try {
      const turnEvents: SessionTurnEvent[] = [];
      watched.onTurnEvent((event) => turnEvents.push(event));
      const prompt = settle(watched.prompt([{ type: "text", text: "held delay:10000" }]));
      await waitFor(() => turnEvents.find((event) => event.type === "turn_started"));

      await observer.dispose();

      const outcome = await withTimeout(prompt, "observer prompt after dispose", 3_000);
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: Error }).error.name).toBe("SandboxAgentDisposedError");
      expect(await listServerIds(baseUrl, token)).toContain(session.serverId);
      await expect(withTimeout(session.prompt([{ type: "text", text: "author goes on" }]), "author prompt")).resolves.toMatchObject({
        stopReason: "end_turn",
      });
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("does not start an agent server for session calls after dispose", async () => {
    const persist = new InMemorySessionPersistDriver();
    const sdk = await SandboxAgent.connect({ baseUrl, token, persist });
    const session = await sdk.createSession({ agent: "mock" });
    await sdk.dispose();
    expect(await listServerIds(baseUrl, token)).toEqual([]);

    const calls = {
      prompt: settle(session.prompt([{ type: "text", text: "after dispose" }])),
      setMode: settle(session.setMode("plan")),
      resumeSession: settle(sdk.resumeSession(session.id)),
      createSession: settle(sdk.createSession({ agent: "mock" })),
    };
    for (const [name, call] of Object.entries(calls)) {
      const outcome = await withTimeout(call, `${name} after dispose`, 5_000);
      expect(outcome.ok, name).toBe(false);
      expect((outcome as { error: Error }).error.name, name).toBe("SandboxAgentDisposedError");
    }
    expect(await listServerIds(baseUrl, token)).toEqual([]);
    expect((await persist.getSession(session.id))?.serverId).toBe(session.serverId);
  });

  it("disposing while a session restore checks the server list leaves no server behind", async () => {
    const persist = new InMemorySessionPersistDriver();
    const author = await SandboxAgent.connect({ baseUrl, token, persist });
    const session = await author.createSession({ agent: "mock" });
    await author.dispose();

    let disposeOnList = true;
    let client: SandboxAgent | undefined;
    const fetcher = createObservingFetch(async (method, url) => {
      if (disposeOnList && method === "GET" && url.pathname === "/v1/acp") {
        disposeOnList = false;
        await client!.dispose();
      }
    });
    client = await SandboxAgent.connect({ baseUrl, token, persist, fetch: fetcher });
    try {
      const outcome = await withTimeout(settle(client.resumeSession(session.id)), "resume during dispose", 5_000);
      expect(disposeOnList).toBe(false);
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: Error }).error.name).toBe("SandboxAgentDisposedError");
      await sleep(200);
      expect(await listServerIds(baseUrl, token)).toEqual([]);
    } finally {
      await client.dispose();
    }
  });

  it("disposing while a session restore starts its agent server leaves no server behind", async () => {
    const persist = new InMemorySessionPersistDriver();
    const author = await SandboxAgent.connect({ baseUrl, token, persist });
    const session = await author.createSession({ agent: "mock" });
    await author.dispose();

    let disposing: Promise<void> | undefined;
    let client: SandboxAgent | undefined;
    const fetcher = createObservingFetch((method, url) => {
      // The first POST to a new server carries the agent so the server creates it.
      if (!disposing && method === "POST" && url.searchParams.get("agent") === "mock") {
        disposing = client!.dispose();
      }
    });
    client = await SandboxAgent.connect({ baseUrl, token, persist, fetch: fetcher });
    try {
      const outcome = await withTimeout(settle(client.resumeSession(session.id)), "resume during dispose", 5_000);
      expect(disposing).toBeDefined();
      await withTimeout(disposing!, "dispose");
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: Error }).error.name).toBe("SandboxAgentDisposedError");
      await sleep(200);
      expect(await listServerIds(baseUrl, token)).toEqual([]);
    } finally {
      await client.dispose();
    }
  });

  it("restores a session once when two prompts need the restore at the same time", async () => {
    const persist = new InMemorySessionPersistDriver();
    const author = await SandboxAgent.connect({ baseUrl, token, persist });
    const session = await author.createSession({ agent: "mock" });
    await author.dispose();

    const client = await SandboxAgent.connect({ baseUrl, token, persist });
    try {
      const handle = (await client.getSession(session.id))!;
      const results = await withTimeout(
        Promise.all([handle.prompt([{ type: "text", text: "parallel one" }]), handle.prompt([{ type: "text", text: "parallel two" }])]),
        "parallel prompts",
      );
      expect(results.map((result) => result.stopReason)).toEqual(["end_turn", "end_turn"]);

      const record = await persist.getSession(session.id);
      expect(await listServerIds(baseUrl, token)).toEqual([record?.serverId]);
      const handleAfter = await client.getSession(session.id);
      expect(handleAfter?.agentSessionId).toBe(record?.agentSessionId);
    } finally {
      await client.dispose();
    }
  });

  it("a late session-not-found for an older agent session does not undo a newer restore", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      const firstAgentSessionId = session.agentSessionId;
      // Fails with "session not found" for the first agent session 1.5 s later.
      const late = settle(session.prompt([{ type: "text", text: "late notfound-after:1500" }]));
      await sleep(200);

      // The agent forgets the session: the next prompt restores it on a new agent session.
      await session.rawSend("_mock/forget_session", {});
      await expect(withTimeout(session.prompt([{ type: "text", text: "after forget" }]), "prompt after forget")).resolves.toMatchObject({
        stopReason: "end_turn",
      });
      const restoredAgentSessionId = (await sdk.getSession(session.id))?.agentSessionId;
      expect(restoredAgentSessionId).toBeTruthy();
      expect(restoredAgentSessionId).not.toBe(firstAgentSessionId);

      // The late error is about the old agent session: the restored session is kept
      // and the prompt, which the agent did not run, is sent on it. Its recovery
      // starts a restore with the record read before the first restore finished;
      // that restore must reuse the finished one instead of creating a third
      // agent session (with only the unbind check it would).
      const outcome = await withTimeout(late, "late prompt", 10_000);
      expect(outcome.ok).toBe(true);
      expect((await sdk.getSession(session.id))?.agentSessionId).toBe(restoredAgentSessionId);
      await expect(withTimeout(session.prompt([{ type: "text", text: "still restored" }]), "prompt after late error")).resolves.toMatchObject({
        stopReason: "end_turn",
      });
      expect((await sdk.getSession(session.id))?.agentSessionId).toBe(restoredAgentSessionId);
    } finally {
      await sdk.dispose();
    }
  });

  it("does not replace a session with a new one when resuming it fails for a transient reason", async () => {
    const persist = new InMemorySessionPersistDriver();
    const author = await SandboxAgent.connect({ baseUrl, token, persist });
    const observer = await SandboxAgent.connect({ baseUrl, token, persist });
    try {
      const session = await author.createSession({ agent: "mock" });
      await session.prompt([{ type: "text", text: "history" }]);
      await session.rawSend("_mock/fail_next_resume", { code: -32603, message: "temporary failure" });

      const outcome = await withTimeout(settle(observer.resumeSession(session.id)), "resume with transient failure");
      expect(outcome.ok).toBe(false);
      expect((outcome as { error: Error }).error.message).toContain("temporary failure");
      expect((await persist.getSession(session.id))?.agentSessionId).toBe(session.agentSessionId);

      // Trying again resumes the same agent session.
      const watched = await withTimeout(observer.resumeSession(session.id), "second resume");
      expect(watched.agentSessionId).toBe(session.agentSessionId);
      expect(watched.serverId).toBe(session.serverId);
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("replaces a session when resuming it fails with a plain session-not-found error", async () => {
    const persist = new InMemorySessionPersistDriver();
    const author = await SandboxAgent.connect({ baseUrl, token, persist });
    const observer = await SandboxAgent.connect({ baseUrl, token, persist });
    try {
      const session = await author.createSession({ agent: "mock" });
      // Some agents report an unknown session as an internal error with that text.
      await session.rawSend("_mock/fail_next_resume", { code: -32603, message: "Session not found" });

      const watched = await withTimeout(observer.resumeSession(session.id), "resume of an unknown session");
      expect(watched.agentSessionId).not.toBe(session.agentSessionId);
      expect((await persist.getSession(session.id))?.agentSessionId).toBe(watched.agentSessionId);
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("delivers turn events to every listener when one listener throws", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const session = await sdk.createSession({ agent: "mock" });
      session.onTurnEvent(() => {
        throw new Error("listener failure");
      });
      const received: SessionTurnEvent[] = [];
      session.onTurnEvent((event) => received.push(event));

      await withTimeout(session.prompt([{ type: "text", text: "listeners" }]), "prompt");
      await waitFor(() => received.find((event) => event.type === "turn_ended"));
      expect(received.map((event) => event.type)).toEqual(["turn_started", "turn_ended"]);
    } finally {
      errors.mockRestore();
      await sdk.dispose();
    }
  });

  it("derives stream event ids from the server id and its generation", async () => {
    const { author, observer, session } = await connectAuthorAndObserver();
    try {
      const server = (await author.listAcpServers()).servers.find((entry) => entry.serverId === session.serverId);
      expect(server).toBeTruthy();
      const events = (await author.getEvents({ sessionId: session.id, limit: 1000 })).items;
      const chunk = events.find((event) => (event.payload as any)?.params?.update?.content?.text === "mock: connect observer");
      expect(chunk?.id).toMatch(new RegExp(`^${session.serverId}@${server!.createdAtMs}:\\d+$`));
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("an attached observer does not duplicate events in shared persistence", async () => {
    const { author, observer, session, watched } = await connectAuthorAndObserver();
    try {
      const chunkText = "mock: same payload";
      const delivered: SessionEvent[] = [];
      watched.onEvent((event) => {
        if ((event.payload as any)?.params?.update?.content?.text === chunkText) {
          delivered.push(event);
        }
      });

      // Two distinct events with an identical payload must both be kept.
      await promptAndWaitForObserver(session, watched, "same payload");
      await promptAndWaitForObserver(session, watched, "same payload");

      const events = (await author.getEvents({ sessionId: session.id, limit: 1000 })).items;
      const textOf = (event: SessionEvent) => (event.payload as any)?.params?.update?.content?.text;
      expect(events.filter((event) => event.sender === "agent" && textOf(event) === "mock: connect observer")).toHaveLength(1);
      const chunks = events.filter((event) => event.sender === "agent" && textOf(event) === chunkText);
      expect(chunks).toHaveLength(2);
      expect(new Set(events.map((event) => event.id)).size).toBe(events.length);

      // The observer still receives every event.
      expect(delivered).toHaveLength(2);
      expect(delivered.map((event) => event.id).sort()).toEqual(chunks.map((event) => event.id).sort());
    } finally {
      await observer.dispose();
      await author.dispose();
    }
  });

  it("reports awaiting input while a permission request is open", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      const turnEvents: SessionTurnEvent[] = [];
      session.onTurnEvent((event) => turnEvents.push(event));
      session.onPermissionRequest((request) => {
        // Reply only after awaiting_input has been delivered.
        void waitFor(() => turnEvents.find((event) => event.type === "awaiting_input")).then(() => session.respondPermission(request.id, "once"));
      });

      await session.prompt([{ type: "text", text: "trigger permission for turn events" }]);
      await waitFor(() => turnEvents.find((event) => event.type === "turn_ended"));

      expect(turnEvents.map((event) => event.type)).toEqual(["turn_started", "awaiting_input", "input_resolved", "turn_ended"]);
      const awaiting = turnEvents[1]!;
      expect(awaiting).toMatchObject({ type: "awaiting_input", kind: "permission", sessionId: session.id });
      expect(turnEvents[2]!.requestId).toEqual(awaiting.requestId);
      expect(turnEvents[3]).toMatchObject({ outcome: "completed", stopReason: "end_turn" });
    } finally {
      await sdk.dispose();
    }
  });

  it("reports a cancelled turn when the session is destroyed mid-turn", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      const turnEvents: SessionTurnEvent[] = [];
      sdk.onTurnEvent(session.id, (event) => turnEvents.push(event));

      const prompt = session.prompt([{ type: "text", text: "delay:10000" }]);
      await waitFor(() => turnEvents.find((event) => event.type === "turn_started"));
      await sdk.destroySession(session.id);

      await expect(prompt).resolves.toMatchObject({ stopReason: "cancelled" });
      const ended = await waitFor(() => turnEvents.find((event) => event.type === "turn_ended"));
      expect(ended).toMatchObject({ outcome: "cancelled", stopReason: "cancelled" });
    } finally {
      await sdk.dispose();
    }
  });

  it("reports agent_exited when the agent crashes mid-turn", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      const turnEvents: SessionTurnEvent[] = [];
      session.onTurnEvent((event) => turnEvents.push(event));

      await expect(session.prompt([{ type: "text", text: "crash:now" }])).rejects.toBeTruthy();
      const ended = await waitFor(() => turnEvents.find((event) => event.type === "turn_ended"));
      expect(ended).toMatchObject({ type: "turn_ended", sessionId: session.id, outcome: "agent_exited" });
      expect(ended.stopReason).toBeUndefined();
    } finally {
      await sdk.dispose();
    }
  });

  it("enforces in-memory event cap to avoid leaks", async () => {
    const persist = new InMemorySessionPersistDriver({
      maxEventsPerSession: 8,
    });

    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
      persist,
    });

    const session = await sdk.createSession({ agent: "mock" });

    for (let i = 0; i < 20; i += 1) {
      await session.prompt([{ type: "text", text: `event-cap-${i}` }]);
    }

    const events = await sdk.getEvents({ sessionId: session.id, limit: 200 });
    expect(events.items.length).toBeLessThanOrEqual(8);

    await sdk.dispose();
  });

  it("blocks manual session/cancel and requires destroySession", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const session = await sdk.createSession({ agent: "mock" });

    await expect(session.rawSend("session/cancel")).rejects.toThrow("Use destroySession(sessionId) instead.");
    await expect(sdk.rawSendSessionMethod(session.id, "session/cancel", {})).rejects.toThrow("Use destroySession(sessionId) instead.");

    const destroyed = await sdk.destroySession(session.id);
    expect(destroyed.destroyedAt).toBeDefined();

    const reloaded = await sdk.getSession(session.id);
    expect(reloaded?.destroyedAt).toBeDefined();

    await sdk.dispose();
  });

  it("supports typed config helpers and createSession preconfiguration", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const session = await sdk.createSession({
      agent: "mock",
      model: "mock",
    });

    const options = await session.getConfigOptions();
    expect(options.some((option) => option.category === "model")).toBe(true);

    await expect(session.setModel("unknown-model")).rejects.toThrow("does not support value");

    await sdk.dispose();
  });

  it("setModel happy path switches to a valid model", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const session = await sdk.createSession({ agent: "mock" });
    await session.setModel("mock-fast");

    const options = await session.getConfigOptions();
    const modelOption = options.find((o) => o.category === "model");
    expect(modelOption?.currentValue).toBe("mock-fast");

    await sdk.dispose();
  });

  it("setMode happy path switches to a valid mode", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const session = await sdk.createSession({ agent: "mock" });
    await session.setMode("plan");

    const modes = await waitForAsync(async () => {
      const current = await session.getModes();
      return current?.currentModeId === "plan" ? current : null;
    });
    expect(modes.currentModeId).toBe("plan");

    const modeOption = await waitForAsync(async () => {
      const option = (await session.getConfigOptions()).find((o) => o.category === "mode");
      return option?.currentValue === "plan" ? option : null;
    });
    expect(modeOption.currentValue).toBe("plan");

    await sdk.dispose();
  });

  it("setThoughtLevel happy path switches to a valid thought level", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const session = await sdk.createSession({ agent: "mock" });
    await session.setThoughtLevel("high");

    const options = await session.getConfigOptions();
    const thoughtOption = options.find((o) => o.category === "thought_level");
    expect(thoughtOption?.currentValue).toBe("high");

    await sdk.dispose();
  });

  it("setModel/setMode/setThoughtLevel can be changed multiple times", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const session = await sdk.createSession({ agent: "mock" });

    // Model: mock → mock-fast → mock
    await session.setModel("mock-fast");
    expect((await session.getConfigOptions()).find((o) => o.category === "model")?.currentValue).toBe("mock-fast");
    await session.setModel("mock");
    expect((await session.getConfigOptions()).find((o) => o.category === "model")?.currentValue).toBe("mock");

    // Mode: normal → plan → normal
    await session.setMode("plan");
    expect((await session.getModes())?.currentModeId).toBe("plan");
    await session.setMode("normal");
    expect((await session.getModes())?.currentModeId).toBe("normal");

    // Thought level: low → high → medium → low
    await session.setThoughtLevel("high");
    expect((await session.getConfigOptions()).find((o) => o.category === "thought_level")?.currentValue).toBe("high");
    await session.setThoughtLevel("medium");
    expect((await session.getConfigOptions()).find((o) => o.category === "thought_level")?.currentValue).toBe("medium");
    await session.setThoughtLevel("low");
    expect((await session.getConfigOptions()).find((o) => o.category === "thought_level")?.currentValue).toBe("low");

    await sdk.dispose();
  });

  it("surfaces ACP permission requests and maps approve/reject replies", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const session = await sdk.createSession({ agent: "mock" });
    const permissionIds: string[] = [];
    const permissionTexts: string[] = [];

    const offPermissions = session.onPermissionRequest((request) => {
      permissionIds.push(request.id);
      const reply = permissionIds.length === 1 ? "reject" : "always";
      void session.respondPermission(request.id, reply);
    });

    const offEvents = session.onEvent((event) => {
      const text = (event.payload as any)?.params?.update?.content?.text;
      if (typeof text === "string" && text.startsWith("mock permission ")) {
        permissionTexts.push(text);
      }
    });

    await session.prompt([{ type: "text", text: "trigger permission request one" }]);
    await session.prompt([{ type: "text", text: "trigger permission request two" }]);

    await waitFor(() => (permissionIds.length === 2 ? permissionIds : undefined));
    await waitFor(() => (permissionTexts.length === 2 ? permissionTexts : undefined));

    expect(permissionTexts[0]).toContain("rejected");
    expect(permissionTexts[1]).toContain("approved");

    offEvents();
    offPermissions();
    await sdk.dispose();
  });

  it("supports MCP and skills config HTTP helpers", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const directory = join(layout.rootDir, "config-test");

    mkdirSync(directory, { recursive: true });

    const mcpConfig = {
      type: "local" as const,
      command: "node",
      args: ["server.js"],
      env: { LOG_LEVEL: "debug" },
    };

    await sdk.setMcpConfig(
      {
        directory,
        mcpName: "local-test",
      },
      mcpConfig,
    );

    const loadedMcp = await sdk.getMcpConfig({
      directory,
      mcpName: "local-test",
    });
    expect(loadedMcp.type).toBe("local");

    await sdk.deleteMcpConfig({
      directory,
      mcpName: "local-test",
    });

    const skillsConfig = {
      sources: [
        {
          type: "github",
          source: "rivet-dev/skills",
          skills: ["sandbox-agent"],
        },
      ],
    };

    await sdk.setSkillsConfig(
      {
        directory,
        skillName: "default",
      },
      skillsConfig,
    );

    const loadedSkills = await sdk.getSkillsConfig({
      directory,
      skillName: "default",
    });
    expect(Array.isArray(loadedSkills.sources)).toBe(true);

    await sdk.deleteSkillsConfig({
      directory,
      skillName: "default",
    });

    await sdk.dispose();
    rmSync(directory, { recursive: true, force: true });
  });

  it("covers process runtime HTTP helpers, log streaming, and terminal websocket access", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });

    const originalConfig = await sdk.getProcessConfig();
    const updatedConfig = await sdk.setProcessConfig({
      ...originalConfig,
      maxOutputBytes: originalConfig.maxOutputBytes + 1,
    });
    expect(updatedConfig.maxOutputBytes).toBe(originalConfig.maxOutputBytes + 1);

    const runResult = await sdk.runProcess({
      ...nodeCommand("process.stdout.write('run-stdout'); process.stderr.write('run-stderr');"),
      timeoutMs: 5_000,
    });
    expect(runResult.stdout).toContain("run-stdout");
    expect(runResult.stderr).toContain("run-stderr");

    let interactiveProcessId: string | undefined;
    let ttyProcessId: string | undefined;
    let killProcessId: string | undefined;

    try {
      const interactiveProcess = await sdk.createProcess({
        ...nodeCommand(`
          process.stdin.setEncoding("utf8");
          process.stdout.write("ready\\n");
          process.stdin.on("data", (chunk) => {
            process.stdout.write("echo:" + chunk);
          });
          setInterval(() => {}, 1_000);
        `),
        interactive: true,
      });
      interactiveProcessId = interactiveProcess.id;

      const listed = await sdk.listProcesses();
      expect(listed.processes.some((process) => process.id === interactiveProcess.id)).toBe(true);

      const fetched = await sdk.getProcess(interactiveProcess.id);
      expect(fetched.status).toBe("running");

      const initialLogs = await waitForAsync(async () => {
        const logs = await sdk.getProcessLogs(interactiveProcess.id, { tail: 10 });
        return logs.entries.some((entry) => decodeProcessLogData(entry.data, entry.encoding).includes("ready")) ? logs : undefined;
      });
      expect(initialLogs.entries.some((entry) => decodeProcessLogData(entry.data, entry.encoding).includes("ready"))).toBe(true);

      const followedLogs: string[] = [];
      const subscription = await sdk.followProcessLogs(
        interactiveProcess.id,
        (entry) => {
          followedLogs.push(decodeProcessLogData(entry.data, entry.encoding));
        },
        { tail: 1 },
      );

      try {
        const inputResult = await sdk.sendProcessInput(interactiveProcess.id, {
          data: Buffer.from("hello over stdin\n", "utf8").toString("base64"),
          encoding: "base64",
        });
        expect(inputResult.bytesWritten).toBeGreaterThan(0);

        await waitFor(() => {
          const joined = followedLogs.join("");
          return joined.includes("echo:hello over stdin") ? joined : undefined;
        });
      } finally {
        subscription.close();
        await subscription.closed;
      }

      const stopped = await sdk.stopProcess(interactiveProcess.id, { waitMs: 5_000 });
      expect(stopped.status).toBe("exited");

      await sdk.deleteProcess(interactiveProcess.id);
      interactiveProcessId = undefined;

      const ttyProcess = await sdk.createProcess({
        ...nodeCommand(`
          process.stdin.setEncoding("utf8");
          process.stdin.on("data", (chunk) => {
            process.stdout.write(chunk);
          });
          setInterval(() => {}, 1_000);
        `),
        interactive: true,
        tty: true,
      });
      ttyProcessId = ttyProcess.id;

      const resized = await sdk.resizeProcessTerminal(ttyProcess.id, {
        cols: 120,
        rows: 40,
      });
      expect(resized.cols).toBe(120);
      expect(resized.rows).toBe(40);

      const wsUrl = sdk.buildProcessTerminalWebSocketUrl(ttyProcess.id);
      expect(wsUrl.startsWith("ws://") || wsUrl.startsWith("wss://")).toBe(true);

      const session = sdk.connectProcessTerminal(ttyProcess.id, {
        WebSocket: WebSocket as unknown as typeof globalThis.WebSocket,
      });
      const readyFrames: string[] = [];
      const ttyOutput: string[] = [];
      const exitFrames: Array<number | null | undefined> = [];
      const terminalErrors: string[] = [];
      let closeCount = 0;

      session.onReady((frame) => {
        readyFrames.push(frame.processId);
      });
      session.onData((bytes) => {
        ttyOutput.push(Buffer.from(bytes).toString("utf8"));
      });
      session.onExit((frame) => {
        exitFrames.push(frame.exitCode);
      });
      session.onError((error) => {
        terminalErrors.push(error instanceof Error ? error.message : error.message);
      });
      session.onClose(() => {
        closeCount += 1;
      });

      await waitFor(() => readyFrames[0]);

      session.sendInput("hello tty\n");

      await waitFor(() => {
        const joined = ttyOutput.join("");
        return joined.includes("hello tty") ? joined : undefined;
      });

      session.close();
      await session.closed;
      expect(closeCount).toBeGreaterThan(0);
      expect(exitFrames).toHaveLength(0);
      expect(terminalErrors).toEqual([]);

      await waitForAsync(async () => {
        const processInfo = await sdk.getProcess(ttyProcess.id);
        return processInfo.status === "running" ? processInfo : undefined;
      });

      const killedTty = await sdk.killProcess(ttyProcess.id, { waitMs: 5_000 });
      expect(killedTty.status).toBe("exited");

      await sdk.deleteProcess(ttyProcess.id);
      ttyProcessId = undefined;

      const killProcess = await sdk.createProcess({
        ...nodeCommand("setInterval(() => {}, 1_000);"),
      });
      killProcessId = killProcess.id;

      const killed = await sdk.killProcess(killProcess.id, { waitMs: 5_000 });
      expect(killed.status).toBe("exited");

      await sdk.deleteProcess(killProcess.id);
      killProcessId = undefined;
    } finally {
      await sdk.setProcessConfig(originalConfig);

      if (interactiveProcessId) {
        await sdk.killProcess(interactiveProcessId, { waitMs: 5_000 }).catch(() => {});
        await sdk.deleteProcess(interactiveProcessId).catch(() => {});
      }

      if (ttyProcessId) {
        await sdk.killProcess(ttyProcessId, { waitMs: 5_000 }).catch(() => {});
        await sdk.deleteProcess(ttyProcessId).catch(() => {});
      }

      if (killProcessId) {
        await sdk.killProcess(killProcessId, { waitMs: 5_000 }).catch(() => {});
        await sdk.deleteProcess(killProcessId).catch(() => {});
      }

      await sdk.dispose();
    }
  });

  it("covers desktop status, screenshot, display, mouse, and keyboard helpers", async () => {
    const sdk = await SandboxAgent.connect({
      baseUrl,
      token,
    });
    let focusWindowProcessId: string | undefined;

    try {
      const initialStatus = await sdk.getDesktopStatus();
      expect(initialStatus.state).toBe("inactive");

      const started = await sdk.startDesktop({
        width: 1440,
        height: 900,
        dpi: 96,
      });
      expect(started.state).toBe("active");
      expect(started.display?.startsWith(":")).toBe(true);
      expect(started.missingDependencies).toEqual([]);

      const displayInfo = await sdk.getDesktopDisplayInfo();
      expect(displayInfo.display).toBe(started.display);
      expect(displayInfo.resolution.width).toBe(1440);
      expect(displayInfo.resolution.height).toBe(900);

      const screenshot = await sdk.takeDesktopScreenshot();
      expect(Buffer.from(screenshot.subarray(0, 8)).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))).toBe(true);

      const region = await sdk.takeDesktopRegionScreenshot({
        x: 10,
        y: 20,
        width: 40,
        height: 50,
      });
      expect(Buffer.from(region.subarray(0, 8)).equals(Buffer.from("\x89PNG\r\n\x1a\n", "binary"))).toBe(true);

      const moved = await sdk.moveDesktopMouse({ x: 40, y: 50 });
      expect(moved.x).toBe(40);
      expect(moved.y).toBe(50);

      const dragged = await sdk.dragDesktopMouse({
        startX: 40,
        startY: 50,
        endX: 80,
        endY: 90,
        button: "left",
      });
      expect(dragged.x).toBe(80);
      expect(dragged.y).toBe(90);

      const clicked = await sdk.clickDesktop({
        x: 80,
        y: 90,
        button: "left",
        clickCount: 1,
      });
      expect(clicked.x).toBe(80);
      expect(clicked.y).toBe(90);

      const scrolled = await sdk.scrollDesktop({
        x: 80,
        y: 90,
        deltaY: -2,
      });
      expect(scrolled.x).toBe(80);
      expect(scrolled.y).toBe(90);

      const position = await sdk.getDesktopMousePosition();
      expect(position.x).toBe(80);
      expect(position.y).toBe(90);

      focusWindowProcessId = await launchDesktopFocusWindow(sdk, started.display!);

      const typed = await sdk.typeDesktopText({
        text: "hello desktop",
        delayMs: 5,
      });
      expect(typed.ok).toBe(true);

      const pressed = await sdk.pressDesktopKey({ key: "ctrl+l" });
      expect(pressed.ok).toBe(true);

      const stopped = await sdk.stopDesktop();
      expect(stopped.state).toBe("inactive");
    } finally {
      if (focusWindowProcessId) {
        await sdk.killProcess(focusWindowProcessId, { waitMs: 5_000 }).catch(() => {});
        await sdk.deleteProcess(focusWindowProcessId).catch(() => {});
      }
      await sdk.stopDesktop().catch(() => {});
      await sdk.dispose();
    }
  });
});

describe("Integration: agent auth method selection", { timeout: 120_000 }, () => {
  let handle: DockerSandboxAgentHandle | undefined;
  let layout: ReturnType<typeof createDockerTestLayout> | undefined;

  async function startWithAuthMethods(methods: Array<Record<string, unknown>>, rejected: string[] = []): Promise<string> {
    layout = createDockerTestLayout();
    prepareMockAgentDataHome(layout.xdgDataHome);
    handle = await startDockerSandboxAgent(layout, {
      timeoutMs: 30000,
      env: {
        MOCK_ACP_AUTH_METHODS: JSON.stringify(methods),
        MOCK_ACP_AUTH_REJECT: JSON.stringify(rejected),
      },
    });
    return handle.baseUrl;
  }

  async function promptAuthMarker(sdk: SandboxAgent): Promise<string> {
    const session = await sdk.createSession({ agent: "mock" });
    const texts: string[] = [];
    const off = session.onEvent((event) => {
      const text = (event.payload as any)?.params?.update?.content?.text;
      if (typeof text === "string") {
        texts.push(text);
      }
    });
    const prompt = await session.prompt([{ type: "text", text: "which auth" }]);
    expect(prompt.stopReason).toBe("end_turn");
    const marker = await waitFor(() => texts.find((text) => text.startsWith("auth:")));
    off();
    return marker;
  }

  afterEach(async () => {
    await handle?.dispose?.();
    handle = undefined;
    if (layout) {
      disposeDockerTestLayout(layout);
      layout = undefined;
    }
  });

  it("authenticates with an explicitly selected agent-advertised auth method", async () => {
    const baseUrl = await startWithAuthMethods([{ id: "gateway-token", name: "Gateway token" }]);
    const sdk = await SandboxAgent.connect({ baseUrl, auth: { methodId: "gateway-token" } });
    try {
      expect(await promptAuthMarker(sdk)).toBe("auth:gateway-token");
    } finally {
      await sdk.dispose();
    }
  });

  it("passes full advertised auth methods to a selectMethod callback", async () => {
    const baseUrl = await startWithAuthMethods([
      { id: "claude-login", name: "Log in" },
      { id: "gateway-token", name: "Gateway", _meta: { "sandboxagent.dev": { kind: "gateway" } } },
    ]);
    const seen: Array<{ agent: string; ids: string[] }> = [];
    const sdk = await SandboxAgent.connect({
      baseUrl,
      auth: {
        selectMethod: (methods, context) => {
          seen.push({ agent: context.agent, ids: methods.map((method) => method.id) });
          return methods.find((method) => (method._meta as any)?.["sandboxagent.dev"]?.kind === "gateway")?.id;
        },
      },
    });
    try {
      expect(await promptAuthMarker(sdk)).toBe("auth:gateway-token");
      expect(seen).toEqual([{ agent: "mock", ids: ["claude-login", "gateway-token"] }]);
    } finally {
      await sdk.dispose();
    }
  });

  it("surfaces authenticate errors for an explicitly selected method", async () => {
    const baseUrl = await startWithAuthMethods([{ id: "gateway-token", name: "Gateway token" }], ["gateway-token"]);
    const sdk = await SandboxAgent.connect({ baseUrl, auth: { methodId: "gateway-token" } });
    try {
      await expect(sdk.createSession({ agent: "mock" })).rejects.toThrow(
        /Failed to authenticate agent 'mock' with auth method 'gateway-token'.*mock authentication rejected/,
      );
    } finally {
      await sdk.dispose();
    }
  });

  it("rejects an explicitly selected auth method the agent does not advertise", async () => {
    const baseUrl = await startWithAuthMethods([{ id: "claude-login", name: "Log in" }]);
    const sdk = await SandboxAgent.connect({ baseUrl, auth: { methodId: "gateway-token" } });
    try {
      await expect(sdk.createSession({ agent: "mock" })).rejects.toThrow(/does not advertise auth method 'gateway-token'/);
    } finally {
      await sdk.dispose();
    }
  });

  it("keeps legacy env-based auth method selection by default", async () => {
    const baseUrl = await startWithAuthMethods([
      { id: "claude-login", name: "Log in" },
      { id: "openai-api-key", name: "OpenAI API key" },
    ]);
    const sdk = await SandboxAgent.connect({ baseUrl });
    try {
      expect(await promptAuthMarker(sdk)).toBe("auth:openai-api-key");
    } finally {
      await sdk.dispose();
    }
  });

  it("does not authenticate with unknown methods by default and keeps an already-authenticated agent working", async () => {
    const baseUrl = await startWithAuthMethods([{ id: "claude-login", name: "Log in" }]);
    const sdk = await SandboxAgent.connect({ baseUrl });
    try {
      expect(await promptAuthMarker(sdk)).toBe("auth:none");
    } finally {
      await sdk.dispose();
    }
  });

  it("skips authentication entirely when auth is false", async () => {
    const baseUrl = await startWithAuthMethods([{ id: "openai-api-key", name: "OpenAI API key" }]);
    const sdk = await SandboxAgent.connect({ baseUrl, auth: false });
    try {
      expect(await promptAuthMarker(sdk)).toBe("auth:none");
    } finally {
      await sdk.dispose();
    }
  });
});

describe("Integration: agent profiles", () => {
  let handle: DockerSandboxAgentHandle;
  let baseUrl: string;
  let token: string;
  let layout: ReturnType<typeof createDockerTestLayout>;

  beforeEach(async () => {
    layout = createDockerTestLayout();
    prepareMockAgentDataHome(layout.xdgDataHome);
    handle = await startDockerSandboxAgent(layout, { timeoutMs: 30000 });
    baseUrl = handle.baseUrl;
    token = handle.token;
  });

  afterEach(async () => {
    await handle?.dispose?.();
    if (layout) {
      disposeDockerTestLayout(layout);
    }
  });

  it("manages agent profiles with masked secrets", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });

    const saved = await sdk.putProfile("mock", "base", {
      process: { env: { API_TOKEN: "s3cr3t" } },
      session: { systemPrompt: { mode: "append", text: "Be brief." } },
    });
    expect(saved.stored.process?.env?.API_TOKEN).toBe("***");
    expect(saved.hasValue["process.env.API_TOKEN"]).toBe(true);

    await sdk.putProfile("mock", "review", { extends: "base", session: { systemPrompt: { mode: "replace", text: "Review only." } } });
    const review = await sdk.getProfile("mock", "review");
    expect(review.source).toBe("api");
    expect(review.resolved.process?.env?.API_TOKEN).toBe("***");
    expect(review.resolved.session?.systemPrompt).toEqual({ mode: "replace", text: "Review only." });

    const listed = await sdk.listProfiles();
    expect(listed.profiles).toEqual([
      { agent: "mock", name: "base", source: "api" },
      { agent: "mock", name: "review", source: "api", extends: "base" },
    ]);

    const conflict = await sdk.deleteProfile("mock", "base").catch((error: unknown) => error);
    expect(conflict).toBeInstanceOf(SandboxAgentError);
    expect((conflict as SandboxAgentError).status).toBe(409);

    const invalid = await sdk.putProfile("codex", "x", { session: { plugins: [{ path: "/p" }] } }).catch((error: unknown) => error);
    expect((invalid as SandboxAgentError).status).toBe(400);
    expect((invalid as SandboxAgentError).problem?.type).toBe("urn:sandbox-agent:error:profile_invalid");

    await sdk.deleteProfile("mock", "review");
    await sdk.deleteProfile("mock", "base");
    expect((await sdk.listProfiles()).profiles).toEqual([]);

    const agents = await sdk.listAgents();
    expect(agents.agents.find((agent) => agent.id === "claude")?.customization.session.plugins).toBe(true);

    await sdk.dispose();
  });
});
