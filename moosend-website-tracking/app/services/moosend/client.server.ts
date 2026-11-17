import type { MoosendEventPayload, OutboundEvent } from "./types";

/**
 * HTTP delivery to the configured Moosend destination.
 *
 * IMPORTANT: The production endpoint URL, authentication header and wire
 * format have not been supplied by Moosend. The endpoint and header name are
 * configuration placeholders (MOOSEND_TRACKING_ENDPOINT,
 * MOOSEND_API_KEY_HEADER). Adapt `serializePayload` here once the real
 * contract is validated - no other module needs to change.
 */

export interface DeliveryRequest {
  endpoint: string;
  apiKey: string;
  apiKeyHeader: string;
  payload: MoosendEventPayload;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export interface DeliveryResult {
  ok: boolean;
  status: number | null;
  retryable: boolean;
  error?: string;
}

export const USER_AGENT = "MoosendShopifyApp/1.0";

export function buildPayload(params: {
  event: OutboundEvent;
  websiteId: string;
  shopDomain: string;
  anonymousId: string;
  email: string | null;
  name: string | null;
}): MoosendEventPayload {
  const { event } = params;
  return {
    schemaVersion: 1,
    eventId: event.eventId,
    websiteId: params.websiteId,
    event: event.name,
    trackerMethod: event.trackerMethod,
    occurredAt: event.occurredAt,
    visitor: {
      anonymousId: params.anonymousId,
      email: params.email,
      name: params.name,
    },
    context: {
      source: event.source,
      shopDomain: params.shopDomain,
      url: event.page?.url ?? null,
      referrer: event.page?.referrer ?? null,
      pageTitle: event.page?.title ?? null,
    },
    data: event.data,
  };
}

export function serializePayload(payload: MoosendEventPayload): string {
  return JSON.stringify(payload);
}

export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

export async function deliverToMoosend(
  request: DeliveryRequest,
): Promise<DeliveryResult> {
  const fetchImpl = request.fetchImpl ?? fetch;
  try {
    const response = await fetchImpl(request.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": USER_AGENT,
        "Idempotency-Key": request.payload.eventId,
        [request.apiKeyHeader]: request.apiKey,
      },
      body: serializePayload(request.payload),
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    // Drain the body so the connection can be reused.
    await response.text().catch(() => "");
    if (response.ok) {
      return { ok: true, status: response.status, retryable: false };
    }
    return {
      ok: false,
      status: response.status,
      retryable: isRetryableStatus(response.status),
      error: `Destination responded with HTTP ${response.status}`,
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.name === "TimeoutError"
          ? `Timed out after ${request.timeoutMs}ms`
          : error.message
        : String(error);
    return { ok: false, status: null, retryable: true, error: message };
  }
}
