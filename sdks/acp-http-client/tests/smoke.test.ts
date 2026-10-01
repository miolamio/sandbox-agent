import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { AcpHttpClient, type SessionNotification } from "../src/index.ts";
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
});
