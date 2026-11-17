import { RateLimiter } from "../../lib/rate-limit.server";
import { logger } from "../../lib/logger.server";
import { kickWorker } from "../worker.server";
import { ingestPixelBatch } from "./ingest.server";
import { MAX_PIXEL_BODY_BYTES } from "./schema";

/**
 * Public collector for the Moosend web pixel extension (/api/pixel/events).
 *
 * The route is a resource route (no default export), so React Router's action
 * origin (CSRF) check does not apply - the pixel's sandboxed worker posts
 * cross-origin from the storefront/checkout. The pixel sends `text/plain`
 * bodies, which are CORS "simple requests" and need no preflight.
 *
 * No credentials are accepted or returned here. The Moosend API key is only
 * ever used server-side by the delivery worker.
 */

const ipLimiter = new RateLimiter(240, 60_000);
const keyLimiter = new RateLimiter(3_000, 60_000);

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function collectorResponse(status: number, body?: Record<string, unknown>) {
  return new Response(body ? JSON.stringify(body) : null, {
    status,
    headers: body ? { ...CORS_HEADERS, "Content-Type": "application/json" } : CORS_HEADERS,
  });
}

function clientIp(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || request.headers.get("x-real-ip") || "unknown";
}

export async function handleCollectorRequest(request: Request): Promise<Response> {
  if (request.method === "OPTIONS") return collectorResponse(204);
  if (request.method !== "POST") return collectorResponse(405, { error: "Method not allowed" });

  // The IP is used transiently for abuse protection only and is never stored.
  if (!ipLimiter.hit(clientIp(request))) {
    return collectorResponse(429, { error: "Too many requests" });
  }

  const declaredLength = Number(request.headers.get("content-length") || 0);
  if (declaredLength > MAX_PIXEL_BODY_BYTES) {
    return collectorResponse(413, { error: "Payload too large" });
  }

  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return collectorResponse(400, { error: "Unreadable body" });
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_PIXEL_BODY_BYTES) {
    return collectorResponse(413, { error: "Payload too large" });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return collectorResponse(400, { error: "Invalid JSON" });
  }

  const key =
    body && typeof (body as { key?: unknown }).key === "string"
      ? (body as { key: string }).key
      : "";
  if (key && !keyLimiter.hit(key)) {
    return collectorResponse(429, { error: "Too many requests" });
  }

  try {
    const result = await ingestPixelBatch(body);
    if (result.status === "invalid") return collectorResponse(400, { error: result.error });
    if (result.status === "accepted" && result.queued > 0) kickWorker();
    // Ignored batches (unknown key / tracking disabled) get the same response
    // so the endpoint does not reveal which keys exist.
    return collectorResponse(202, { ok: true });
  } catch (error) {
    logger.error("Pixel collector failed", { error });
    return collectorResponse(500, { error: "Internal error" });
  }
}

export function resetCollectorRateLimits() {
  ipLimiter.reset();
  keyLimiter.reset();
}
