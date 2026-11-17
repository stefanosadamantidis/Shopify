/**
 * Centralised, validated access to environment configuration.
 * Values are read lazily so tests can adjust process.env between cases.
 */

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

export const config = {
  get appUrl(): string {
    return (process.env.SHOPIFY_APP_URL || "").replace(/\/+$/, "");
  },
  /** Moosend destination endpoint. Placeholder until supplied by Moosend. */
  get moosendEndpoint(): string {
    return (process.env.MOOSEND_TRACKING_ENDPOINT || "").trim();
  },
  /** HTTP header carrying the merchant's Moosend API key. Placeholder. */
  get moosendApiKeyHeader(): string {
    return (process.env.MOOSEND_API_KEY_HEADER || "X-Api-Key").trim();
  },
  get deliveryTimeoutMs(): number {
    return intEnv("MOOSEND_DELIVERY_TIMEOUT_MS", 10_000);
  },
  get maxAttempts(): number {
    return Math.max(1, intEnv("OUTBOX_MAX_ATTEMPTS", 8));
  },
  get orderFallbackDelaySeconds(): number {
    return intEnv("ORDER_FALLBACK_DELAY_SECONDS", 300);
  },
  get workerEnabled(): boolean {
    return boolEnv("WORKER_ENABLED", true);
  },
  get workerIntervalMs(): number {
    return Math.max(1_000, intEnv("WORKER_INTERVAL_MS", 15_000));
  },
  get retentionVisitorDays(): number {
    return Math.max(1, intEnv("RETENTION_VISITOR_DAYS", 90));
  },
  get retentionEventDays(): number {
    return Math.max(1, intEnv("RETENTION_EVENT_DAYS", 30));
  },
  get showLoginForm(): boolean {
    return boolEnv("SHOW_LOGIN_FORM", false);
  },
};

/** True when the app-level Moosend destination is configured. */
export function isDestinationConfigured(): boolean {
  const endpoint = config.moosendEndpoint;
  if (!endpoint) return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}
