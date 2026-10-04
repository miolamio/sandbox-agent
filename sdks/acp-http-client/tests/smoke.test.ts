import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import {
  AcpHttpClient,
  SANDBOX_AGENT_TURN_ENDED,
  SANDBOX_AGENT_TURN_STARTED,
  parseSandboxAgentTurnNotification,
  sandboxAgentPromptMeta,
  type SandboxAgentTurnNotification,
  type SessionNotification,
} from "../src/index.ts";
import { spawnSandboxAgent, type SandboxAgentSpawnHandle } from "../../typescript/src/spawn.ts";
import { prepareMockAgentDataHome } from "../../typescript/tests/helpers/mock-agent.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

function findBinary(): string | null {
  if (process.env.SANDBOX_AGENT_BIN) {
    return process.env.SANDBOX_AGENT_BIN;
  }

  const cargoPaths = [resolve(__dirname, "../../../target/debug/sandbox-agent"), resolve(__dirname, "../../../target/release/sandbox-agent")];

  for (const p of cargoPaths) {
    if (existsSync(p)) {
      return p;
    }
  }

  return null;
}

const BINARY_PATH = findBinary();
if (!BINARY_PATH) {
  throw new Error("sandbox-agent binary not found. Build it (cargo build -p sandbox-agent) or set SANDBOX_AGENT_BIN.");
}
if (!process.env.SANDBOX_AGENT_BIN) {
  process.env.SANDBOX_AGENT_BIN = BINARY_PATH;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
  return await Promise.race([
    promise,
    sleep(timeoutMs).then(() => {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }),
  ]);
}

async function waitFor<T>(fn: () => T | undefined | null, timeoutMs = 5000, stepMs = 25): Promise<T> {
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

// A fetch that behaves like Node's default one but with a short undici
// headersTimeout, so a request whose response headers take longer fails like a
// real long turn does after 300 s. The SSE GET can be held back and its stream
// ended on demand, to model the moments when the event stream is not connected.
function shortHeadersTimeoutFetch(headersTimeoutMs: number) {
  const globalDispatcher = (globalThis as Record<symbol, unknown>)[Symbol.for("undici.globalDispatcher.1")];
  if (!globalDispatcher) {
    throw new Error("undici global dispatcher is not initialized");
  }
  const Agent = (globalDispatcher as { constructor: new (options: { headersTimeout: number }) => unknown }).constructor;
  const dispatcher = new Agent({ headersTimeout: headersTimeoutMs });

  const state = {
    // GETs wait until this returns true.
    sseAllowed: () => true,
    sseConnects: 0,
    endSse: null as (() => void) | null,
    promptPosts: [] as Array<{ asyncHeader: string | null; status: number | string }>,
  };

  const fetcher: typeof fetch = async (input, init) => {
    const withDispatcher = { ...init, dispatcher } as RequestInit;
    if (init?.method === "GET") {
      while (!state.sseAllowed()) {
        if (init.signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        await sleep(10);
      }
      const response = await globalThis.fetch(input, withDispatcher);
      if (!response.ok || !response.body) {
        return response;
      }
      state.sseConnects += 1;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          state.endSse = () => {
            try {
              controller.close();
            } catch {}
            reader.cancel().catch(() => {});
          };
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch {
            try {
              controller.close();
            } catch {}
          }
        },
        cancel() {
          reader.cancel().catch(() => {});
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    }

    const isPrompt = init?.method === "POST" && typeof init.body === "string" && (JSON.parse(init.body) as { method?: string }).method === "session/prompt";
    const asyncHeader = new Headers(init?.headers).get("x-sandboxagent-async-prompt");
    try {
      const response = await globalThis.fetch(input, withDispatcher);
      if (isPrompt) {
        state.promptPosts.push({ asyncHeader, status: response.status });
      }
      return response;
    } catch (error) {
      if (isPrompt) {
        state.promptPosts.push({ asyncHeader, status: String((error as { cause?: { code?: string } }).cause?.code ?? error) });
      }
      throw error;
    }
  };

  return { fetch: fetcher, state };
}

describe("AcpHttpClient integration", () => {
  let handle: SandboxAgentSpawnHandle;
  let baseUrl: string;
  let token: string;
  let dataHome: string;

  beforeAll(async () => {
    dataHome = mkdtempSync(join(tmpdir(), "acp-http-client-"));
    prepareMockAgentDataHome(dataHome);

    handle = await spawnSandboxAgent({
      enabled: true,
      log: "silent",
      timeoutMs: 30000,
      env: {
        XDG_DATA_HOME: dataHome,
        HOME: dataHome,
        USERPROFILE: dataHome,
        APPDATA: join(dataHome, "AppData", "Roaming"),
        LOCALAPPDATA: join(dataHome, "AppData", "Local"),
      },
    });
    baseUrl = handle.baseUrl;
    token = handle.token;
  });

  afterAll(async () => {
    await handle.dispose();
    rmSync(dataHome, { recursive: true, force: true });
  });

  it("runs initialize/newSession/prompt against real /v1/acp/{server_id}", async () => {
    const updates: SessionNotification[] = [];
    const serverId = `acp-http-client-${Date.now().toString(36)}`;

    const client = new AcpHttpClient({
      baseUrl,
      token,
      transport: {
        path: `/v1/acp/${encodeURIComponent(serverId)}`,
        bootstrapQuery: { agent: "mock" },
      },
      client: {
        sessionUpdate: async (notification) => {
          updates.push(notification);
        },
      },
    });

    const initialize = await client.initialize();
    expect(initialize.protocolVersion).toBeTruthy();

    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    expect(session.sessionId).toBeTruthy();

    const prompt = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "acp package integration" }],
    });
    expect(prompt.stopReason).toBe("end_turn");

    await waitFor(() => {
      const text = updates
        .flatMap((entry) => {
          if (entry.update.sessionUpdate !== "agent_message_chunk") {
            return [];
          }
          const content = entry.update.content;
          if (content.type !== "text") {
            return [];
          }
          return [content.text];
        })
        .join("");
      return text.includes("mock: acp package integration") ? text : undefined;
    });

    await client.disconnect();
  });

  it("answers session/request_permission while session/prompt is still in flight", async () => {
    const permissionRequests: Array<{ sessionId: string; title?: string | null }> = [];
    const serverId = `acp-http-client-permissions-${Date.now().toString(36)}`;

    const client = new AcpHttpClient({
      baseUrl,
      token,
      transport: {
        path: `/v1/acp/${encodeURIComponent(serverId)}`,
        bootstrapQuery: { agent: "mock" },
      },
      client: {
        requestPermission: async (request) => {
          permissionRequests.push({
            sessionId: request.sessionId,
            title: request.toolCall.title,
          });
          return {
            outcome: {
              outcome: "selected",
              optionId: "reject-once",
            },
          };
        },
      },
    });

    await client.initialize();

    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    const prompt = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "please trigger permission" }],
    });

    expect(prompt.stopReason).toBe("end_turn");
    expect(permissionRequests).toEqual([
      {
        sessionId: session.sessionId,
        title: "Write mock.txt",
      },
    ]);

    await client.disconnect();
  });

  it("keeps the SSE connection usable after a request POST fails", async () => {
    const serverId = `acp-http-client-post-failure-${Date.now().toString(36)}`;
    let failNextPrompt = true;
    const faultInjectingFetch: typeof fetch = async (input, init) => {
      if (failNextPrompt && init?.method === "POST" && typeof init.body === "string") {
        const envelope = JSON.parse(init.body) as { method?: string };
        if (envelope.method === "session/prompt") {
          failNextPrompt = false;
          throw new TypeError("simulated request POST failure");
        }
      }
      return globalThis.fetch(input, init);
    };

    const client = new AcpHttpClient({
      baseUrl,
      token,
      fetch: faultInjectingFetch,
      transport: {
        path: `/v1/acp/${encodeURIComponent(serverId)}`,
        bootstrapQuery: { agent: "mock" },
      },
    });

    await client.initialize();
    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    await expect(
      client.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "fail this request" }],
      }),
    ).rejects.toThrow("simulated request POST failure");

    const prompt = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "connection still works" }],
    });
    expect(prompt.stopReason).toBe("end_turn");

    await client.disconnect();
  });

  it("reconnects SSE without another POST while a prompt is in flight", async () => {
    const serverId = `acp-http-client-reconnect-${Date.now().toString(36)}`;
    let remainingSseFailures = 3;
    let sseConnected = false;
    let postCount = 0;
    const promptStatuses: number[] = [];
    const reconnectingFetch: typeof fetch = async (input, init) => {
      if (init?.method === "GET" && remainingSseFailures > 0) {
        remainingSseFailures -= 1;
        throw new TypeError("simulated SSE connection failure");
      }
      if (init?.method === "POST") {
        postCount += 1;
      }
      const response = await globalThis.fetch(input, init);
      if (init?.method === "GET" && response.ok) {
        sseConnected = true;
      }
      if (init?.method === "POST" && typeof init.body === "string" && (JSON.parse(init.body) as { method?: string }).method === "session/prompt") {
        promptStatuses.push(response.status);
      }
      return response;
    };

    const client = new AcpHttpClient({
      baseUrl,
      token,
      fetch: reconnectingFetch,
      transport: {
        path: `/v1/acp/${encodeURIComponent(serverId)}`,
        bootstrapQuery: { agent: "mock" },
      },
    });

    await client.initialize();
    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });

    // The SSE loop must recover from repeated failures on its own, without
    // waiting for another POST to restart it.
    const postsBeforeReconnect = postCount;
    await waitFor(() => (sseConnected ? true : undefined));
    expect(remainingSseFailures).toBe(0);
    expect(postCount).toBe(postsBeforeReconnect);
    await sleep(25);

    // With the stream restored, the prompt result is delivered over SSE.
    const prompt = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "reconnect the event stream" }],
    });

    expect(prompt.stopReason).toBe("end_turn");
    await waitFor(() => (promptStatuses.length > 0 ? true : undefined));
    expect(promptStatuses).toEqual([202]);

    await client.disconnect();
  });

  it("opts in to async prompt delivery over SSE when the event stream is connected", async () => {
    const serverId = `acp-http-client-async-prompt-${Date.now().toString(36)}`;
    const promptPosts: Array<{ asyncHeader: string | null; status: number }> = [];
    let sseConnected = false;
    const recordingFetch: typeof fetch = async (input, init) => {
      const response = await globalThis.fetch(input, init);
      if (init?.method === "GET" && response.ok) {
        sseConnected = true;
      }
      if (init?.method === "POST" && typeof init.body === "string") {
        const envelope = JSON.parse(init.body) as { method?: string };
        if (envelope.method === "session/prompt") {
          promptPosts.push({
            asyncHeader: new Headers(init.headers).get("x-sandboxagent-async-prompt"),
            status: response.status,
          });
        }
      }
      return response;
    };

    const client = new AcpHttpClient({
      baseUrl,
      token,
      fetch: recordingFetch,
      transport: {
        path: `/v1/acp/${encodeURIComponent(serverId)}`,
        bootstrapQuery: { agent: "mock" },
      },
    });

    await client.initialize();
    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    // Wait until the SSE stream is established before prompting.
    await waitFor(() => (sseConnected ? true : undefined));
    await sleep(25);

    const prompt = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "deliver over sse" }],
    });

    expect(prompt.stopReason).toBe("end_turn");
    // The response can arrive over SSE before the POST itself settles.
    await waitFor(() => (promptPosts.length > 0 ? true : undefined));
    expect(promptPosts).toEqual([{ asyncHeader: "1", status: 202 }]);

    await client.disconnect();
  });

  it("keeps synchronous prompt delivery when the event stream is unavailable", async () => {
    const serverId = `acp-http-client-sync-prompt-${Date.now().toString(36)}`;
    const promptPosts: Array<{ asyncHeader: string | null; status: number }> = [];
    const noSseFetch: typeof fetch = async (input, init) => {
      if (init?.method === "GET") {
        throw new TypeError("simulated SSE outage");
      }
      const response = await globalThis.fetch(input, init);
      if (init?.method === "POST" && typeof init.body === "string") {
        const envelope = JSON.parse(init.body) as { method?: string };
        if (envelope.method === "session/prompt") {
          promptPosts.push({
            asyncHeader: new Headers(init.headers).get("x-sandboxagent-async-prompt"),
            status: response.status,
          });
        }
      }
      return response;
    };

    const client = new AcpHttpClient({
      baseUrl,
      token,
      fetch: noSseFetch,
      transport: {
        path: `/v1/acp/${encodeURIComponent(serverId)}`,
        bootstrapQuery: { agent: "mock" },
      },
    });

    await client.initialize();
    const session = await client.newSession({
      cwd: process.cwd(),
      mcpServers: [],
    });
    const prompt = await client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "deliver inline" }],
    });

    expect(prompt.stopReason).toBe("end_turn");
    await waitFor(() => (promptPosts.length > 0 ? true : undefined));
    expect(promptPosts).toEqual([{ asyncHeader: null, status: 200 }]);

    await client.disconnect();
  });

  it("stops reconnecting SSE after the server is deleted", async () => {
    const serverId = `acp-http-client-deleted-${Date.now().toString(36)}`;
    const path = `/v1/acp/${encodeURIComponent(serverId)}`;
    let sseConnected = false;
    let getCount = 0;
    const countingFetch: typeof fetch = async (input, init) => {
      if (init?.method === "GET") {
        getCount += 1;
      }
      const response = await globalThis.fetch(input, init);
      if (init?.method === "GET" && response.ok) {
        sseConnected = true;
      }
      return response;
    };

    const client = new AcpHttpClient({
      baseUrl,
      token,
      fetch: countingFetch,
      transport: { path, bootstrapQuery: { agent: "mock" } },
    });

    await client.initialize();
    await waitFor(() => (sseConnected ? true : undefined));

    // Delete the server behind the client's back: the SSE stream ends and every
    // reconnect gets 404, which is terminal.
    const deleted = await globalThis.fetch(`${baseUrl}${path}`, {
      method: "DELETE",
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    expect(deleted.status).toBe(204);

    const getsAtDelete = getCount;
    await sleep(2_000);
    expect(getCount - getsAtDelete).toBeLessThanOrEqual(2);

    await client.disconnect();
  });

  it("resolves an async prompt whose result is replayed after lost events", async () => {
    const serverId = `acp-http-client-sse-gap-replay-${Date.now().toString(36)}`;
    let sseHeld = false;
    let sseConnects = 0;
    let promptPosted = false;
    const activeSse: { close: (() => void) | null } = { close: null };
    const fetcher: typeof fetch = async (input, init) => {
      if (init?.method !== "GET") {
        const isPrompt = typeof init?.body === "string" && (JSON.parse(init.body) as { method?: string }).method === "session/prompt";
        if (isPrompt) {
          // Take the event stream down before the server starts the turn, so
          // the turn's output overflows the replay buffer while it is down.
          promptPosted = new Headers(init?.headers).get("x-sandboxagent-async-prompt") !== null;
          sseHeld = true;
          activeSse.close?.();
        }
        return globalThis.fetch(input, init);
      }
      while (sseHeld) {
        if (init.signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        await sleep(10);
      }
      const response = await globalThis.fetch(input, init);
      if (!response.ok || !response.body) {
        return response;
      }
      sseConnects += 1;
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          activeSse.close = () => {
            try {
              controller.close();
            } catch {}
            reader.cancel().catch(() => {});
          };
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch {
            try {
              controller.close();
            } catch {}
          }
        },
        cancel() {
          reader.cancel().catch(() => {});
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    };

    let gapSeen = false;
    const client = new AcpHttpClient({
      baseUrl,
      token,
      fetch: fetcher,
      transport: { path: `/v1/acp/${encodeURIComponent(serverId)}`, bootstrapQuery: { agent: "mock" } },
      onEnvelope: (_envelope, _direction, meta) => {
        if (meta?.streamGap) {
          gapSeen = true;
        }
      },
    });

    try {
      await client.initialize();
      const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
      await waitFor(() => (sseConnects > 0 ? true : undefined));
      await sleep(25);

      const outcome = client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "__flood__" }] }).then(
        (response) => response,
        (error: unknown) => error,
      );
      await waitFor(() => (promptPosted ? true : undefined));
      // Let the turn finish while the event stream is down.
      await sleep(1_500);
      sseHeld = false;

      const result = await Promise.race([outcome, sleep(5_000).then(() => "timed out")]);
      expect(result).not.toBe("timed out");
      expect(result).not.toBeInstanceOf(Error);
      expect((result as { stopReason?: unknown }).stopReason).toBe("end_turn");
      expect(gapSeen).toBe(true);
    } finally {
      await client.disconnect();
    }
  });

  it("rejects an in-flight async prompt when events were lost while the event stream was down", async () => {
    const serverId = `acp-http-client-sse-gap-${Date.now().toString(36)}`;
    const path = `/v1/acp/${encodeURIComponent(serverId)}`;
    let sseHeld = false;
    let sseConnects = 0;
    const activeSse: { close: (() => void) | null } = { close: null };
    const holdingFetch: typeof fetch = async (input, init) => {
      if (init?.method !== "GET") {
        return globalThis.fetch(input, init);
      }
      while (sseHeld) {
        if (init.signal?.aborted) {
          throw new DOMException("aborted", "AbortError");
        }
        await sleep(10);
      }
      const response = await globalThis.fetch(input, init);
      if (!response.ok || !response.body) {
        return response;
      }
      sseConnects += 1;
      // Pass the real SSE body through a stream the test can end on demand.
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          activeSse.close = () => {
            try {
              controller.close();
            } catch {}
            reader.cancel().catch(() => {});
          };
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch {
            try {
              controller.close();
            } catch {}
          }
        },
        cancel() {
          reader.cancel().catch(() => {});
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    };

    let permissionSeen = false;
    const client = new AcpHttpClient({
      baseUrl,
      token,
      fetch: holdingFetch,
      transport: { path, bootstrapQuery: { agent: "mock" } },
      client: {
        // Never answer, so the prompt stays pending on the server.
        requestPermission: () => {
          permissionSeen = true;
          return new Promise(() => {});
        },
      },
    });
    const flooder = new AcpHttpClient({ baseUrl, token, transport: { path, bootstrapQuery: { agent: "mock" } } });

    try {
      await client.initialize();
      const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
      await waitFor(() => (sseConnects > 0 ? true : undefined));
      await sleep(25);

      const outcome = client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "please trigger permission" }] }).then(
        () => "resolved",
        (error: unknown) => error,
      );
      await waitFor(() => (permissionSeen ? true : undefined));

      // Take the event stream down, then publish more events than the server
      // buffers for replay.
      sseHeld = true;
      activeSse.close?.();
      await flooder.initialize();
      const floodSession = await flooder.newSession({ cwd: process.cwd(), mcpServers: [] });
      await withTimeout(flooder.prompt({ sessionId: floodSession.sessionId, prompt: [{ type: "text", text: "__flood__" }] }), "flood prompt", 15_000);

      // The reconnect replays from an event the server no longer has.
      sseHeld = false;
      const result = await Promise.race([outcome, sleep(5_000).then(() => "timed out")]);
      expect(result).not.toBe("timed out");
      expect(result).not.toBe("resolved");
      expect(String((result as { message?: unknown }).message)).toMatch(/lost/i);
    } finally {
      await flooder.disconnect({ deleteServer: false }).catch(() => {});
      await client.disconnect();
    }
  });

  it("rejects an in-flight async prompt when the event stream cannot be restored", async () => {
    const serverId = `acp-http-client-sse-lost-${Date.now().toString(36)}`;
    let sseConnected = false;
    let sseBroken = false;
    const activeSse: { close: (() => void) | null } = { close: null };
    const breakingFetch: typeof fetch = async (input, init) => {
      if (init?.method === "GET" && sseBroken) {
        return new Response(JSON.stringify({ status: 404, title: "Not Found" }), {
          status: 404,
          headers: { "content-type": "application/problem+json" },
        });
      }
      const response = await globalThis.fetch(input, init);
      if (init?.method !== "GET" || !response.ok || !response.body) {
        return response;
      }
      sseConnected = true;
      // Pass the real SSE body through a stream the test can end on demand.
      const reader = response.body.getReader();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          activeSse.close = () => {
            try {
              controller.close();
            } catch {}
            reader.cancel().catch(() => {});
          };
        },
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
            } else {
              controller.enqueue(value);
            }
          } catch {
            try {
              controller.close();
            } catch {}
          }
        },
        cancel() {
          reader.cancel().catch(() => {});
        },
      });
      return new Response(body, { status: response.status, headers: response.headers });
    };

    let permissionSeen = false;
    const client = new AcpHttpClient({
      baseUrl,
      token,
      fetch: breakingFetch,
      transport: {
        path: `/v1/acp/${encodeURIComponent(serverId)}`,
        bootstrapQuery: { agent: "mock" },
      },
      client: {
        // Never answer, so the prompt stays pending on the server.
        requestPermission: () => {
          permissionSeen = true;
          return new Promise(() => {});
        },
      },
    });

    await client.initialize();
    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    await waitFor(() => (sseConnected ? true : undefined));
    await sleep(25);

    const prompt = client.prompt({
      sessionId: session.sessionId,
      prompt: [{ type: "text", text: "please trigger permission" }],
    });
    const outcome = prompt.then(
      () => "resolved",
      (error: unknown) => error,
    );

    await waitFor(() => (permissionSeen ? true : undefined));
    sseBroken = true;
    activeSse.close?.();

    const result = await Promise.race([outcome, sleep(5_000).then(() => "timed out")]);
    expect(result).not.toBe("timed out");
    expect(result).not.toBe("resolved");
    expect(String((result as { message?: unknown }).message)).toMatch(/event stream/i);

    await client.disconnect();
  });
  it("delivers typed turn lifecycle notifications and prompt response metadata", async () => {
    const serverId = `acp-http-client-turns-${Date.now().toString(36)}`;
    const turnEvents: SandboxAgentTurnNotification[] = [];
    const client = new AcpHttpClient({
      baseUrl,
      token,
      transport: { path: `/v1/acp/${encodeURIComponent(serverId)}`, bootstrapQuery: { agent: "mock" } },
      client: {
        extNotification: async (method, params) => {
          const parsed = parseSandboxAgentTurnNotification(method, params);
          if (parsed) {
            turnEvents.push(parsed);
          }
        },
      },
    });
    try {
      await client.initialize();
      const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });

      const completed = await client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "turn events" }] });
      expect(completed.stopReason).toBe("end_turn");
      const meta = sandboxAgentPromptMeta(completed);
      expect(meta?.sessionId).toBe(session.sessionId);
      expect(typeof meta?.sequence).toBe("number");

      const ended = await waitFor(() => turnEvents.find((event) => event.method === SANDBOX_AGENT_TURN_ENDED));
      expect(turnEvents.map((event) => event.method)).toEqual([SANDBOX_AGENT_TURN_STARTED, SANDBOX_AGENT_TURN_ENDED]);
      expect(ended.params).toMatchObject({ sessionId: session.sessionId, outcome: "completed", stopReason: "end_turn" });
      expect(ended.params.requestId).toEqual(turnEvents[0]!.params.requestId);

      // Cancelling a running prompt ends its turn as cancelled.
      turnEvents.length = 0;
      const pending = client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "delay:10000" }] });
      await waitFor(() => turnEvents.find((event) => event.method === SANDBOX_AGENT_TURN_STARTED));
      await client.cancel({ sessionId: session.sessionId });
      await expect(withTimeout(pending, "cancelled prompt")).resolves.toMatchObject({ stopReason: "cancelled" });
      const cancelled = await waitFor(() => turnEvents.find((event) => event.method === SANDBOX_AGENT_TURN_ENDED));
      expect(cancelled.params).toMatchObject({ outcome: "cancelled", stopReason: "cancelled" });

      expect(parseSandboxAgentTurnNotification("_adapter/agent_exited", { success: false })).toBeNull();
      expect(parseSandboxAgentTurnNotification(SANDBOX_AGENT_TURN_ENDED, { sessionId: 1 })).toBeNull();
    } finally {
      await client.disconnect();
    }
  });

  it("ignores responses addressed to another client on the same server", async () => {
    const serverId = `acp-http-client-shared-${Date.now().toString(36)}`;
    const transport = { path: `/v1/acp/${encodeURIComponent(serverId)}`, bootstrapQuery: { agent: "mock" } };

    const first = new AcpHttpClient({ baseUrl, token, transport });
    await first.initialize();
    const firstSession = await first.newSession({ cwd: process.cwd(), mcpServers: [] });
    await first.prompt({ sessionId: firstSession.sessionId, prompt: [{ type: "text", text: "first client" }] });

    // A second client on the same server sends requests with the same JSON-RPC
    // ids the first client already used. The server buffers and broadcasts every
    // response, so each client must only accept responses to its own requests.
    const second = new AcpHttpClient({ baseUrl, token, transport });
    try {
      await second.initialize();
      const secondSession = await withTimeout(second.newSession({ cwd: process.cwd(), mcpServers: [] }), "second newSession");
      expect(secondSession.sessionId).not.toBe(firstSession.sessionId);

      const prompt = await withTimeout(
        second.prompt({ sessionId: secondSession.sessionId, prompt: [{ type: "text", text: "second client" }] }),
        "second prompt",
      );
      expect(prompt.stopReason).toBe("end_turn");
    } finally {
      await second.disconnect();
      await first.disconnect();
    }
  });

  it("skips events buffered before the client attached when asked to", async () => {
    const serverId = `acp-http-client-attach-${Date.now().toString(36)}`;
    const path = `/v1/acp/${encodeURIComponent(serverId)}`;

    const first = new AcpHttpClient({ baseUrl, token, transport: { path, bootstrapQuery: { agent: "mock" } } });
    await first.initialize();
    const session = await first.newSession({ cwd: process.cwd(), mcpServers: [] });
    await first.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "before attach" }] });

    const updates: SessionNotification[] = [];
    const attached = new AcpHttpClient({
      baseUrl,
      token,
      transport: { path, bootstrapQuery: { agent: "mock" }, skipBufferedEvents: true },
      client: {
        sessionUpdate: async (notification) => {
          updates.push(notification);
        },
      },
    });
    try {
      await attached.initialize();
      await attached.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "after attach" }] });

      const texts = () =>
        updates.flatMap((entry) =>
          entry.update.sessionUpdate === "agent_message_chunk" && entry.update.content.type === "text" ? [entry.update.content.text] : [],
        );
      await waitFor(() => (texts().includes("mock: after attach") ? true : undefined));
      expect(texts()).not.toContain("mock: before attach");
    } finally {
      await attached.disconnect();
      await first.disconnect();
    }
  });

  it("completes the first prompt of a new session that outlasts headersTimeout while the event stream is still connecting", async () => {
    const serverId = `acp-http-client-first-long-${Date.now().toString(36)}`;
    const { fetch: fetcher, state } = shortHeadersTimeoutFetch(500);
    // The event stream connects only 300 ms after the prompt is issued.
    let sseReleaseAt: number | null = null;
    state.sseAllowed = () => sseReleaseAt !== null && Date.now() >= sseReleaseAt;

    const client = new AcpHttpClient({
      baseUrl,
      token,
      fetch: fetcher,
      transport: { path: `/v1/acp/${encodeURIComponent(serverId)}`, bootstrapQuery: { agent: "mock" } },
    });
    try {
      await client.initialize();
      const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
      expect(state.sseConnects).toBe(0);

      sseReleaseAt = Date.now() + 300;
      const prompt = await withTimeout(
        client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "long turn delay:1500" }] }),
        "first long prompt",
        10_000,
      );
      expect(prompt.stopReason).toBe("end_turn");
      await waitFor(() => (state.promptPosts.length > 0 ? true : undefined));
      expect(state.promptPosts).toEqual([{ asyncHeader: "1", status: 202 }]);
    } finally {
      await client.disconnect();
    }
  });

  it("completes a prompt that outlasts headersTimeout when it is sent while the event stream reconnects", async () => {
    const serverId = `acp-http-client-reconnect-long-${Date.now().toString(36)}`;
    const { fetch: fetcher, state } = shortHeadersTimeoutFetch(500);

    const client = new AcpHttpClient({
      baseUrl,
      token,
      fetch: fetcher,
      transport: { path: `/v1/acp/${encodeURIComponent(serverId)}`, bootstrapQuery: { agent: "mock" } },
    });
    try {
      await client.initialize();
      const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
      await waitFor(() => (state.sseConnects > 0 ? true : undefined));

      // Drop the event stream and keep the reconnect pending until 300 ms
      // after the prompt is issued.
      let sseReleaseAt: number | null = null;
      state.sseAllowed = () => sseReleaseAt !== null && Date.now() >= sseReleaseAt;
      state.endSse?.();
      await sleep(250);
      expect(state.sseConnects).toBe(1);

      sseReleaseAt = Date.now() + 300;
      const prompt = await withTimeout(
        client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "long turn delay:1500" }] }),
        "long prompt during reconnect",
        10_000,
      );
      expect(prompt.stopReason).toBe("end_turn");
      expect(state.sseConnects).toBe(2);
      await waitFor(() => (state.promptPosts.length > 0 ? true : undefined));
      expect(state.promptPosts).toEqual([{ asyncHeader: "1", status: 202 }]);
    } finally {
      await client.disconnect();
    }
  });

  // Settles a promise to its outcome, so a test can wait for it with a deadline
  // without an unhandled rejection.
  function settle<T>(promise: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    return promise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
  }

  it("rejects an in-flight async prompt when the client disconnects", async () => {
    const serverId = `acp-http-client-close-async-${Date.now().toString(36)}`;
    let sseConnected = false;
    const recordingFetch: typeof fetch = async (input, init) => {
      const response = await globalThis.fetch(input, init);
      if (init?.method === "GET" && response.ok) {
        sseConnected = true;
      }
      return response;
    };
    const client = new AcpHttpClient({
      baseUrl,
      token,
      fetch: recordingFetch,
      transport: { path: `/v1/acp/${encodeURIComponent(serverId)}`, bootstrapQuery: { agent: "mock" } },
    });

    await client.initialize();
    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    await waitFor(() => (sseConnected ? true : undefined));

    const prompt = settle(client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "held delay:10000" }] }));
    await sleep(200);
    await client.disconnect();

    const outcome = await withTimeout(prompt, "prompt after disconnect", 3_000);
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: Error }).error.name).toBe("AcpClientClosedError");
  });

  it("rejects an in-flight synchronous prompt when the client disconnects", async () => {
    const serverId = `acp-http-client-close-sync-${Date.now().toString(36)}`;
    // No event stream: the prompt result can only arrive in the POST response.
    const noSseFetch: typeof fetch = async (input, init) => {
      if (init?.method === "GET") {
        return new Response(null, { status: 503 });
      }
      return globalThis.fetch(input, init);
    };
    const client = new AcpHttpClient({
      baseUrl,
      token,
      fetch: noSseFetch,
      transport: { path: `/v1/acp/${encodeURIComponent(serverId)}`, bootstrapQuery: { agent: "mock" } },
    });

    await client.initialize();
    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });

    const prompt = settle(client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "held delay:10000" }] }));
    await sleep(200);
    await client.disconnect();

    const outcome = await withTimeout(prompt, "prompt after disconnect", 3_000);
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: Error }).error.name).toBe("AcpClientClosedError");
  });

  it("rejects a request sent after the client disconnected", async () => {
    const serverId = `acp-http-client-after-close-${Date.now().toString(36)}`;
    const client = new AcpHttpClient({
      baseUrl,
      token,
      transport: { path: `/v1/acp/${encodeURIComponent(serverId)}`, bootstrapQuery: { agent: "mock" } },
    });

    await client.initialize();
    const session = await client.newSession({ cwd: process.cwd(), mcpServers: [] });
    await client.disconnect();

    const outcome = await withTimeout(
      settle(client.prompt({ sessionId: session.sessionId, prompt: [{ type: "text", text: "after close" }] })),
      "prompt sent after disconnect",
      3_000,
    );
    expect(outcome.ok).toBe(false);
    expect((outcome as { error: Error }).error.name).toBe("AcpClientClosedError");
  });
});
