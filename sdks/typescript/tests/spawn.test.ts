import { describe, expect, it } from "vitest";
import { shutdownWaitMs } from "../src/spawn.ts";

describe("shutdownWaitMs", () => {
  it("waits for the server's default 5 s shutdown budget plus a 2 s margin", () => {
    expect(shutdownWaitMs(undefined)).toBe(7_000);
  });

  it("follows SANDBOX_AGENT_SHUTDOWN_TIMEOUT_MS", () => {
    expect(shutdownWaitMs(" 8000 ")).toBe(10_000);
  });

  it("falls back to the default budget for values the server rejects", () => {
    for (const raw of ["", "abc", "0", "-5", "1.5"]) {
      expect(shutdownWaitMs(raw), raw).toBe(7_000);
    }
  });
});
