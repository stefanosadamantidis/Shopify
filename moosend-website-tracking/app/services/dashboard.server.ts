import { config, isDestinationConfigured } from "../config.server";
import { randomToken } from "../lib/crypto.server";
import { buildPayload, deliverToMoosend } from "./moosend/client.server";
import type { ItemCodeSource } from "./moosend/types";
import { getDeliveryStats, retryFailedEvents } from "./outbox.server";
import {
  disconnectMoosend,
  ensureShop,
  getApiKey,
  toShopView,
  updateSettings,
  type ShopView,
} from "./shop.server";
import {
  needsPixelSync,
  syncWebPixel,
  type AdminGraphqlClient,
} from "./webpixel.server";
import { kickWorker } from "./worker.server";

export type DashboardActionResult =
  | { intent: string; ok: true; message: string }
  | { intent: string; ok: false; message: string; errors?: Record<string, string> };

export async function loadDashboard(shopDomain: string, admin: AdminGraphqlClient) {
  let shop = await ensureShop(shopDomain);
  // Self-heal: reconnect the pixel if it is missing, failed previously, or
  // its settings are stale (e.g. the app URL changed).
  if (needsPixelSync(shop)) {
    await syncWebPixel(admin, shop);
    shop = await ensureShop(shopDomain);
  }
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const stats = await getDeliveryStats(shop.id, since);
  return { shop: toShopView(shop), stats };
}

function bool(formData: FormData, name: string): boolean {
  const value = formData.get(name);
  return value === "on" || value === "true" || value === "1";
}

export async function sendConnectionTest(shopDomain: string): Promise<DashboardActionResult> {
  const shop = await ensureShop(shopDomain);
  const apiKey = getApiKey(shop);
  if (!apiKey || !shop.moosendWebsiteId) {
    return { intent: "test", ok: false, message: "Save your Moosend Website ID and API key first." };
  }
  if (!isDestinationConfigured()) {
    return {
      intent: "test",
      ok: false,
      message: "The Moosend destination endpoint is not configured on the server yet.",
    };
  }
  const payload = buildPayload({
    event: {
      type: "CUSTOM",
      name: "SHOPIFY_CONNECTION_TEST",
      trackerMethod: "SHOPIFY_CONNECTION_TEST",
      eventId: `test:${randomToken(12)}`,
      occurredAt: new Date().toISOString(),
      data: { message: "Connection test from the Moosend Website Tracking Shopify app" },
      source: "admin_test",
    },
    websiteId: shop.moosendWebsiteId,
    shopDomain: shop.shopDomain,
    anonymousId: "connection-test",
    email: null,
    name: null,
  });
  const result = await deliverToMoosend({
    endpoint: config.moosendEndpoint,
    apiKey,
    apiKeyHeader: config.moosendApiKeyHeader,
    payload,
    timeoutMs: config.deliveryTimeoutMs,
  });
  return result.ok
    ? { intent: "test", ok: true, message: `Test event accepted (HTTP ${result.status}).` }
    : { intent: "test", ok: false, message: `Test event failed: ${result.error ?? "unknown error"}` };
}

export async function handleDashboardAction(
  shopDomain: string,
  admin: AdminGraphqlClient,
  formData: FormData,
): Promise<DashboardActionResult> {
  const intent = String(formData.get("intent") || "");

  switch (intent) {
    case "save": {
      const result = await updateSettings(shopDomain, {
        moosendWebsiteId: String(formData.get("moosendWebsiteId") || ""),
        moosendApiKey: String(formData.get("moosendApiKey") || ""),
        trackingEnabled: bool(formData, "trackingEnabled"),
        customEventsEnabled: bool(formData, "customEventsEnabled"),
        webhookPurchaseFallback: bool(formData, "webhookPurchaseFallback"),
        checkoutAsAddToOrder: bool(formData, "checkoutAsAddToOrder"),
        itemCodeSource: String(formData.get("itemCodeSource") || "SKU_OR_VARIANT_ID") as ItemCodeSource,
      });
      if (!result.ok) {
        return { intent, ok: false, message: "Please fix the highlighted fields.", errors: result.errors };
      }
      const pixel = await syncWebPixel(admin, result.shop);
      return pixel.ok
        ? { intent, ok: true, message: "Settings saved." }
        : { intent, ok: false, message: `Settings saved, but the web pixel could not be updated: ${pixel.error}` };
    }
    case "test":
      return sendConnectionTest(shopDomain);
    case "reconnect": {
      const shop = await ensureShop(shopDomain);
      const pixel = await syncWebPixel(admin, shop);
      return pixel.ok
        ? { intent, ok: true, message: "Web pixel connected." }
        : { intent, ok: false, message: `Web pixel could not be connected: ${pixel.error}` };
    }
    case "disconnect": {
      const shop = await disconnectMoosend(shopDomain);
      if (shop) await syncWebPixel(admin, shop);
      return { intent, ok: true, message: "Moosend disconnected. Tracking is turned off." };
    }
    case "retry_failed": {
      const shop = await ensureShop(shopDomain);
      const count = await retryFailedEvents(shop.id);
      kickWorker();
      return { intent, ok: true, message: `${count} failed event(s) queued for retry.` };
    }
    default:
      return { intent, ok: false, message: "Unknown action." };
  }
}

export type { ShopView };
