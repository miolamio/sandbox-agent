import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
  type SessionTurnEvent,
} from "../src/index.ts";
import { isNodeRuntime } from "../src/spawn.ts";
import { createDockerTestLayout, disposeDockerTestLayout, startDockerSandboxAgent, type DockerSandboxAgentHandle } from "./helpers/docker.ts";
import { prepareMockAgentDataHome } from "./helpers/mock-agent.ts";
import WebSocket from "ws";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

  it("restores a session whose agent server was deleted without sending the prompt twice", async () => {
    const sdk = await SandboxAgent.connect({ baseUrl, token });
    try {
      const session = await sdk.createSession({ agent: "mock" });
      await session.prompt([{ type: "text", text: "before delete" }]);

      const serverId = (await sdk.getSession(session.id))?.serverId;
      expect(serverId).toBeTruthy();

      const response = await fetch(`${baseUrl}/v1/acp/${encodeURIComponent(serverId!)}`, {
        method: "DELETE",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      });
      expect(response.ok).toBe(true);

      // The agent may have run a prompt before its server went away, so the SDK
      // restores the session but does not send the prompt again by itself.
      const interrupted = await withTimeout(
        session.prompt([{ type: "text", text: "after delete" }]).then(
          () => null,
          (error: unknown) => error,
        ),
        "prompt after server delete",
      );
      expect(interrupted).toBeInstanceOf(SessionRequestInterruptedError);
      expect((interrupted as SessionRequestInterruptedError).session.id).toBe(session.id);

      const promptsWithText = async (text: string) => {
        const events = await sdk.getEvents({ sessionId: session.id, limit: 500 });
        return events.items.filter((event) => {
          const payload = event.payload as { method?: string; params?: { prompt?: Array<{ text?: unknown }> } };
          return (
            event.sender === "client" &&
            payload.method === "session/prompt" &&
            (payload.params?.prompt ?? []).some((block) => typeof block.text === "string" && block.text.includes(text))
          );
        });
      };
      expect(await promptsWithText("after delete")).toHaveLength(1);

      const servers = await sdk.listAcpServers();
      expect(servers.servers.some((server) => server.agent === "mock")).toBe(true);

      const prompt = await withTimeout(session.prompt([{ type: "text", text: "resent by caller" }]), "prompt on restored session");
      expect(prompt.stopReason).toBe("end_turn");
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
