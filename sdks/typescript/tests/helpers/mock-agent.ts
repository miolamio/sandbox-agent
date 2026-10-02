import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function candidateInstallDirs(dataHome: string): string[] {
  const dirs = [join(dataHome, "sandbox-agent", "bin")];
  if (process.platform === "darwin") {
    dirs.push(join(dataHome, "Library", "Application Support", "sandbox-agent", "bin"));
  } else if (process.platform === "win32") {
    dirs.push(join(dataHome, "AppData", "Roaming", "sandbox-agent", "bin"));
  }
  return dirs;
}

export function prepareMockAgentDataHome(dataHome: string): Record<string, string> {
  const runtimeEnv: Record<string, string> = {};
  if (process.platform === "darwin") {
    runtimeEnv.HOME = dataHome;
    runtimeEnv.XDG_DATA_HOME = join(dataHome, ".local", "share");
  } else if (process.platform === "win32") {
    runtimeEnv.USERPROFILE = dataHome;
    runtimeEnv.APPDATA = join(dataHome, "AppData", "Roaming");
    runtimeEnv.LOCALAPPDATA = join(dataHome, "AppData", "Local");
  } else {
    runtimeEnv.HOME = dataHome;
    runtimeEnv.XDG_DATA_HOME = dataHome;
  }

  const nodeScript = String.raw`#!/usr/bin/env node
const { createInterface } = require("node:readline");

let nextSession = 0;
let nextPermission = 0;
const pendingPermissions = new Map();
// Prompts held open by the "delay:<ms>" hook, keyed by request id.
const delayedPrompts = new Map();
// Sessions this process created. Prompts and resume requests for any other
// session id fail like a real agent that lost its session state.
const knownSessions = new Set();

function sessionNotFound(id, sessionId) {
  emit({
    jsonrpc: "2.0",
    id,
    error: {
      code: -32002,
      message: "Session not found: " + String(sessionId),
    },
  });
}

function parseJsonEnv(name) {
  const raw = process.env[name];
  if (!raw) {
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Auth behavior is opt-in so tests that do not set MOCK_ACP_AUTH_METHODS see
// the original mock output.
const authMethods = parseJsonEnv("MOCK_ACP_AUTH_METHODS");
const rejectedAuthMethods = new Set(parseJsonEnv("MOCK_ACP_AUTH_REJECT") ?? []);
let authenticatedMethodId = null;

function emit(value) {
  process.stdout.write(JSON.stringify(value) + "\n");
}

// The text the user sent: the last text block, because a restored session
// prepends its replayed history as the first block. Test hooks match only this
// text, so a hook in replayed history does not fire again.
function userText(prompt) {
  if (!Array.isArray(prompt)) {
    return "";
  }

  for (let index = prompt.length - 1; index >= 0; index -= 1) {
    const block = prompt[index];
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }

  return "";
}

function firstText(prompt) {
  if (!Array.isArray(prompt)) {
    return "";
  }

  for (const block of prompt) {
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }

  return "";
}

const rl = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
});

rl.on("line", (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }

  const hasMethod = typeof msg?.method === "string";
  const hasId = Object.prototype.hasOwnProperty.call(msg, "id");
  const method = hasMethod ? msg.method : undefined;

  if (!hasMethod && hasId) {
    const pending = pendingPermissions.get(String(msg.id));
    if (pending) {
      pendingPermissions.delete(String(msg.id));
      const outcome = msg?.result?.outcome;
      const optionId = outcome?.outcome === "selected" ? outcome.optionId : "cancelled";
      const suffix = optionId === "reject-once" ? "rejected" : "approved";
      emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId: pending.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "mock permission " + suffix + ": " + optionId,
            },
          },
        },
      });
      emit({
        jsonrpc: "2.0",
        id: pending.promptId,
        result: {
          stopReason: "end_turn",
        },
      });
    }
    return;
  }

  // session/cancel ends the session's delayed prompts with stopReason "cancelled".
  if (method === "session/cancel" && !hasId) {
    const sessionId = msg?.params?.sessionId;
    for (const [promptId, held] of delayedPrompts) {
      if (held.sessionId !== sessionId) {
        continue;
      }
      clearTimeout(held.timer);
      delayedPrompts.delete(promptId);
      emit({ jsonrpc: "2.0", id: held.id, result: { stopReason: "cancelled" } });
    }
    return;
  }

  if (method === "session/prompt" && hasId && !knownSessions.has(msg?.params?.sessionId)) {
    sessionNotFound(msg.id, msg?.params?.sessionId);
    return;
  }

  if (method === "session/prompt") {
    const sessionId = typeof msg?.params?.sessionId === "string" ? msg.params.sessionId : "";
    const text = firstText(msg?.params?.prompt);
    emit({
      jsonrpc: "2.0",
      method: "session/update",
      params: {
        sessionId,
        update: {
          sessionUpdate: "agent_message_chunk",
          content: {
            type: "text",
            text: "mock: " + text,
          },
        },
      },
    });

    if (Array.isArray(authMethods)) {
      emit({
        jsonrpc: "2.0",
        method: "session/update",
        params: {
          sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: {
              type: "text",
              text: "auth:" + (authenticatedMethodId ?? "none"),
            },
          },
        },
      });
    }

    if (text.includes("permission")) {
      nextPermission += 1;
      const permissionId = "permission-" + nextPermission;
      pendingPermissions.set(permissionId, {
        promptId: msg.id,
        sessionId,
      });
      emit({
        jsonrpc: "2.0",
        id: permissionId,
        method: "session/request_permission",
        params: {
          sessionId,
          toolCall: {
            toolCallId: "tool-call-" + nextPermission,
            title: "Write mock.txt",
            kind: "edit",
            status: "pending",
            locations: [{ path: "/tmp/mock.txt" }],
            rawInput: {
              path: "/tmp/mock.txt",
              content: "hello",
            },
          },
          options: [
            {
              kind: "allow_once",
              name: "Allow once",
              optionId: "allow-once",
            },
            {
              kind: "allow_always",
              name: "Always allow",
              optionId: "allow-always",
            },
            {
              kind: "reject_once",
              name: "Reject",
              optionId: "reject-once",
            },
          ],
        },
      });
    }
  }

  if (!hasMethod || !hasId) {
    return;
  }

  if (method === "initialize") {
    emit({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: 1,
        capabilities: {},
        agentCapabilities: {
          sessionCapabilities: {
            resume: {},
          },
        },
        serverInfo: {
          name: "mock-acp-agent",
          version: "0.0.1",
        },
        ...(Array.isArray(authMethods) ? { authMethods } : {}),
      },
    });
    return;
  }

  if (method === "authenticate") {
    const methodId = msg?.params?.methodId;
    const known = Array.isArray(authMethods) && authMethods.some((entry) => entry && entry.id === methodId);
    if (!known || rejectedAuthMethods.has(methodId)) {
      emit({
        jsonrpc: "2.0",
        id: msg.id,
        error: {
          code: -32000,
          message: "mock authentication rejected for method " + String(methodId),
        },
      });
      return;
    }
    authenticatedMethodId = methodId;
    emit({
      jsonrpc: "2.0",
      id: msg.id,
      result: {},
    });
    return;
  }

  if (method === "session/new") {
    nextSession += 1;
    const sessionId = "mock-session-" + nextSession;
    knownSessions.add(sessionId);
    emit({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        sessionId,
      },
    });
    return;
  }

  if (method === "session/resume") {
    const sessionId = msg?.params?.sessionId;
    if (!knownSessions.has(sessionId)) {
      sessionNotFound(msg.id, sessionId);
      return;
    }
    emit({
      jsonrpc: "2.0",
      id: msg.id,
      result: {},
    });
    return;
  }

  // Test hook: a not-found error about something other than the session.
  if (method === "_mock/missing_resource") {
    emit({
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code: -32002,
        message: "Resource not found: /tmp/missing.txt",
        data: { uri: "/tmp/missing.txt" },
      },
    });
    return;
  }

  // Test hook: drop a session so the next request for it fails as unknown.
  if (method === "_mock/forget_session") {
    knownSessions.delete(msg?.params?.sessionId);
    emit({
      jsonrpc: "2.0",
      id: msg.id,
      result: {},
    });
    return;
  }

  if (method === "session/prompt") {
    const text = userText(msg?.params?.prompt);
    if (text.includes("permission")) {
      return;
    }
    const finish = () =>
      emit({
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          stopReason: "end_turn",
        },
      });
    // Test hook: "crash:now" in the prompt text makes the agent process exit mid-turn.
    if (text.includes("crash:now")) {
      process.exit(3);
    }
    // Test hook: "delay:<ms>" in the prompt text holds the turn open that long
    // (or until session/cancel for the session).
    const delayMatch = /delay:(\d+)/.exec(text);
    if (delayMatch) {
      const promptKey = String(msg.id);
      const timer = setTimeout(() => {
        delayedPrompts.delete(promptKey);
        finish();
      }, Number(delayMatch[1]));
      delayedPrompts.set(promptKey, { id: msg.id, sessionId: msg?.params?.sessionId, timer });
    } else {
      finish();
    }
    return;
  }

  emit({
    jsonrpc: "2.0",
    id: msg.id,
    result: {
      ok: true,
      echoedMethod: method,
    },
  });
});
`;

  for (const installDir of candidateInstallDirs(dataHome)) {
    const processDir = join(installDir, "agent_processes");
    mkdirSync(processDir, { recursive: true });

    const runner = process.platform === "win32" ? join(processDir, "mock-acp.cmd") : join(processDir, "mock-acp");

    const scriptFile = process.platform === "win32" ? join(processDir, "mock-acp.js") : runner;

    writeFileSync(scriptFile, nodeScript);

    if (process.platform === "win32") {
      writeFileSync(runner, `@echo off\r\nnode "${scriptFile}" %*\r\n`);
    }

    chmodSync(scriptFile, 0o755);
    if (process.platform === "win32") {
      chmodSync(runner, 0o755);
    }
  }

  return runtimeEnv;
}
