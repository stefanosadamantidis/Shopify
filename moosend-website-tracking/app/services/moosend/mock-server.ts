/**
 * Mock Moosend tracking receiver for local development and automated tests.
 * Self-contained (node:http only) so it can run directly with Node's
 * TypeScript type stripping: `npm run mock:moosend`.
 *
 * Endpoints:
 *   POST /track   -> accepts one event (any POST path is accepted)
 *   GET  /events  -> lists received events
 *   DELETE /events -> clears received events
 *
 * Failure simulation (env MOCK_MOOSEND_FAIL_MODE or header x-mock-fail):
 *   none | always500 | always429 | unauthorized | random
 */
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

export type MockFailMode =
  | "none"
  | "always500"
  | "always429"
  | "unauthorized"
  | "random";

export interface MockMoosendOptions {
  port?: number;
  host?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  failMode?: MockFailMode;
  log?: boolean;
}

export interface ReceivedEvent {
  receivedAt: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

export interface MockMoosendServer {
  url: string;
  server: Server;
  events: ReceivedEvent[];
  setFailMode(mode: MockFailMode): void;
  /** Clears received events and the idempotency memory. */
  reset(): void;
  close(): Promise<void>;
}

const REQUIRED_FIELDS = ["eventId", "websiteId", "event", "occurredAt", "visitor", "data"];

function readBody(req: IncomingMessage, limit = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

export function startMockMoosendServer(
  options: MockMoosendOptions = {},
): Promise<MockMoosendServer> {
  const events: ReceivedEvent[] = [];
  let failMode: MockFailMode = options.failMode ?? "none";
  const apiKeyHeader = (options.apiKeyHeader ?? "X-Api-Key").toLowerCase();
  const seenIds = new Set<string>();

  const send = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  };

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url?.startsWith("/events")) {
        return send(res, 200, { count: events.length, events });
      }
      if (req.method === "DELETE" && req.url?.startsWith("/events")) {
        events.length = 0;
        seenIds.clear();
        return send(res, 200, { cleared: true });
      }
      if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });

      const mode = (req.headers["x-mock-fail"] as MockFailMode | undefined) ?? failMode;
      if (mode === "always500") return send(res, 500, { error: "Simulated server error" });
      if (mode === "always429") return send(res, 429, { error: "Simulated rate limit" });
      if (mode === "random" && Math.random() < 0.5) {
        return send(res, 503, { error: "Simulated intermittent failure" });
      }

      const providedKey = req.headers[apiKeyHeader];
      if (mode === "unauthorized" || (options.apiKey && providedKey !== options.apiKey)) {
        return send(res, 401, { error: "Invalid API key" });
      }

      const raw = await readBody(req);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(raw);
      } catch {
        return send(res, 400, { error: "Invalid JSON" });
      }
      const missing = REQUIRED_FIELDS.filter((field) => !(field in body));
      if (missing.length) {
        return send(res, 422, { error: `Missing fields: ${missing.join(", ")}` });
      }

      const eventId = String(body.eventId);
      if (seenIds.has(eventId)) {
        return send(res, 200, { accepted: true, duplicate: true });
      }
      seenIds.add(eventId);

      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") {
          headers[key] = key === apiKeyHeader ? "[redacted]" : value;
        }
      }
      events.push({ receivedAt: new Date().toISOString(), headers, body });
      if (options.log) {
        console.log(
          `[mock-moosend] ${String(body.event)} ${eventId} visitor=${JSON.stringify(
            (body.visitor as Record<string, unknown>)?.anonymousId,
          )}`,
        );
      }
      return send(res, 202, { accepted: true });
    } catch (error) {
      return send(res, 500, { error: error instanceof Error ? error.message : "error" });
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, options.host ?? "127.0.0.1", () => {
      const address = server.address() as AddressInfo;
      resolve({
        url: `http://${options.host ?? "127.0.0.1"}:${address.port}`,
        server,
        events,
        setFailMode(mode) {
          failMode = mode;
        },
        reset() {
          events.length = 0;
          seenIds.clear();
          failMode = options.failMode ?? "none";
        },
        close: () =>
          new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}
