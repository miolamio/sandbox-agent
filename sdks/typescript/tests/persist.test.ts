import { describe, expect, it } from "vitest";
import { InMemorySessionPersistDriver, type SessionEvent } from "../src/index.ts";

function event(id: string, eventIndex: number, connectionId: string): SessionEvent {
  return {
    id,
    eventIndex,
    sessionId: "s1",
    createdAt: eventIndex,
    connectionId,
    sender: "agent",
    payload: { jsonrpc: "2.0", method: "session/update", params: { sessionId: "agent-s1" } },
  };
}

describe("InMemorySessionPersistDriver", () => {
  it("keeps the first record when an event id is inserted again", async () => {
    const persist = new InMemorySessionPersistDriver();
    await persist.insertEvent("s1", event("server-1:7", 1, "author"));
    await persist.insertEvent("s1", event("server-1:7", 2, "observer"));
    await persist.insertEvent("s1", event("server-1:8", 3, "observer"));

    const { items } = await persist.listEvents({ sessionId: "s1" });
    expect(items.map((item) => [item.id, item.eventIndex, item.connectionId])).toEqual([
      ["server-1:7", 1, "author"],
      ["server-1:8", 3, "observer"],
    ]);
  });
});
