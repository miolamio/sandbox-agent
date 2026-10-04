import { createServer, request as httpRequest, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";

/**
 * What the proxy does with a request: forward it to the server, answer 503
 * without forwarding it, or close the client connection without an answer (a
 * network failure).
 */
export type FaultProxyAction = "forward" | "unavailable" | "drop";

export interface FaultProxyRequest {
  method: string;
  /** Path without the query string, e.g. `/v1/acp`. */
  path: string;
}

export interface FaultProxy {
  /** Base URL to give the SDK instead of the server's. */
  baseUrl: string;
  /** Decides what happens to each request; forwards everything by default. */
  rule: (request: FaultProxyRequest) => FaultProxyAction;
  /** Requests answered with 503 or dropped so far. */
  faults: FaultProxyRequest[];
  close(): Promise<void>;
}

/**
 * A real HTTP proxy in front of a Sandbox Agent server that can fail selected
 * requests. Forwarded requests and responses (event streams included) are
 * streamed through unchanged.
 */
export async function startFaultProxy(targetBaseUrl: string): Promise<FaultProxy> {
  const target = new URL(targetBaseUrl);
  const sockets = new Set<Socket>();

  const proxy: FaultProxy = {
    baseUrl: "",
    rule: () => "forward",
    faults: [],
    close: async () => {},
  };

  const server: Server = createServer((incoming: IncomingMessage, outgoing) => {
    const url = new URL(incoming.url ?? "/", "http://proxy.invalid");
    const described: FaultProxyRequest = { method: (incoming.method ?? "GET").toUpperCase(), path: url.pathname };
    const action = proxy.rule(described);

    if (action === "drop") {
      proxy.faults.push(described);
      incoming.socket.destroy();
      return;
    }
    if (action === "unavailable") {
      proxy.faults.push(described);
      incoming.resume();
      outgoing.writeHead(503, { "Content-Type": "application/problem+json" });
      outgoing.end(JSON.stringify({ type: "about:blank", title: "Service Unavailable", status: 503 }));
      return;
    }

    const upstream = httpRequest(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port,
        method: incoming.method,
        path: incoming.url,
        headers: { ...incoming.headers, host: target.host },
      },
      (response) => {
        outgoing.writeHead(response.statusCode ?? 502, response.headers);
        outgoing.flushHeaders();
        response.pipe(outgoing);
        response.on("error", () => outgoing.destroy());
      },
    );
    upstream.on("error", () => {
      if (!outgoing.headersSent) {
        outgoing.writeHead(502);
      }
      outgoing.destroy();
    });
    // A client that goes away (an event stream it closed) closes the upstream request too.
    outgoing.on("close", () => upstream.destroy());
    incoming.pipe(upstream);
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const { port } = server.address() as AddressInfo;
  proxy.baseUrl = `http://127.0.0.1:${port}`;
  proxy.close = async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return proxy;
}
