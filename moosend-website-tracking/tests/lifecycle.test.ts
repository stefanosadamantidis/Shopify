import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import { authenticate } from "../app/shopify.server";
import { onAuthenticated } from "../app/services/install.server";
import {
  ensureShop,
  getApiKey,
  markUninstalled,
  updateSettings,
} from "../app/services/shop.server";
import {
  buildPixelSettings,
  needsPixelSync,
  syncWebPixel,
} from "../app/services/webpixel.server";
import { handleDashboardAction, loadDashboard } from "../app/services/dashboard.server";
import { ingestPixelBatch } from "../app/services/pixel/ingest.server";
import { action as uninstalledAction } from "../app/routes/webhooks.app.uninstalled";
import { action as ordersCreateAction } from "../app/routes/webhooks.orders.create";
import { action as dataRequestAction } from "../app/routes/webhooks.customers.data_request";
import { action as customersRedactAction } from "../app/routes/webhooks.customers.redact";
import { action as shopRedactAction } from "../app/routes/webhooks.shop.redact";
import { getComplianceReport } from "../app/services/privacy.server";
import {
  createActiveShop,
  envelope,
  fakeAdmin,
  resetDb,
  signedWebhookRequest,
  teeItem,
} from "./helpers";

type ActionFn = (args: { request: Request; params: Record<string, string>; context: unknown }) => Promise<Response>;

async function callAction(action: unknown, request: Request): Promise<Response> {
  try {
    return await (action as ActionFn)({ request, params: {}, context: {} });
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

function pixelAdmin(existingId: string | null = null) {
  return fakeAdmin((query, variables) => {
    if (query.includes("query MoosendWebPixel")) return { data: { webPixel: existingId ? { id: existingId } : null } };
    if (query.includes("webPixelCreate")) {
      return { data: { webPixelCreate: { userErrors: [], webPixel: { id: "gid://shopify/WebPixel/1", settings: variables } } } };
    }
    if (query.includes("webPixelUpdate")) {
      return { data: { webPixelUpdate: { userErrors: [], webPixel: { id: variables?.id, settings: variables } } } };
    }
    return { data: {} };
  });
}

function pixelSettingsFromCall(call: { variables?: Record<string, unknown> }) {
  return JSON.parse((call.variables?.webPixel as { settings: string }).settings);
}

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
});

describe("installation and authentication", () => {
  it("does not render the embedded app without a valid Shopify session (OAuth/token exchange first)", async () => {
    const request = new Request(
      "https://moosend-app.test/app?shop=alpha.myshopify.com&host=YWxwaGEubXlzaG9waWZ5LmNvbS9hZG1pbg&embedded=1",
    );
    let thrown: unknown;
    try {
      await authenticate.admin(request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect([302, 401]).toContain((thrown as Response).status);
  });

  it("rejects requests with a forged session token", async () => {
    const request = new Request("https://moosend-app.test/app?shop=alpha.myshopify.com", {
      headers: { Authorization: "Bearer forged.token.value" },
    });
    let thrown: unknown;
    try {
      await authenticate.admin(request);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(401);
  });

  it("provisions the tenant and connects the web pixel right after auth (idle until configured)", async () => {
    const admin = pixelAdmin();
    const result = await onAuthenticated({ session: { shop: "alpha.myshopify.com" }, admin });
    expect(result.ok).toBe(true);
    const shop = await prisma.shop.findUniqueOrThrow({ where: { shopDomain: "alpha.myshopify.com" } });
    expect(shop).toMatchObject({ pixelStatus: "CONNECTED", webPixelId: "gid://shopify/WebPixel/1" });
    expect(shop.ingestKey.length).toBeGreaterThanOrEqual(24);
    const createCall = admin.calls.find((c) => c.query.includes("webPixelCreate"))!;
    expect(pixelSettingsFromCall(createCall)).toEqual({
      collectorUrl: "https://moosend-app.test/api/pixel/events",
      ingestKey: shop.ingestKey,
      enabled: "false",
      customEvents: "false",
    });
  });

  it("updates an existing pixel instead of creating a duplicate", async () => {
    const admin = pixelAdmin("gid://shopify/WebPixel/42");
    await onAuthenticated({ session: { shop: "alpha.myshopify.com" }, admin });
    expect(admin.calls.some((c) => c.query.includes("webPixelCreate"))).toBe(false);
    expect(admin.calls.find((c) => c.query.includes("webPixelUpdate"))?.variables?.id).toBe("gid://shopify/WebPixel/42");
  });

  it("records pixel errors for the merchant UI instead of failing the install", async () => {
    const admin = fakeAdmin((query) =>
      query.includes("webPixelCreate")
        ? { data: { webPixelCreate: { userErrors: [{ code: "INVALID", field: ["settings"], message: "Invalid settings" }], webPixel: null } } }
        : { data: { webPixel: null } },
    );
    const result = await onAuthenticated({ session: { shop: "alpha.myshopify.com" }, admin });
    expect(result).toEqual({ ok: false, error: "Invalid settings" });
    expect(await prisma.shop.findUniqueOrThrow({ where: { shopDomain: "alpha.myshopify.com" } })).toMatchObject({
      pixelStatus: "ERROR",
      pixelError: "Invalid settings",
    });
  });

  it("detects stale pixel settings (e.g. app URL change) and re-syncs from the dashboard", async () => {
    await onAuthenticated({ session: { shop: "alpha.myshopify.com" }, admin: pixelAdmin() });
    let shop = await prisma.shop.findUniqueOrThrow({ where: { shopDomain: "alpha.myshopify.com" } });
    expect(needsPixelSync(shop)).toBe(false);

    const previousUrl = process.env.SHOPIFY_APP_URL;
    process.env.SHOPIFY_APP_URL = "https://new-domain.example";
    try {
      expect(needsPixelSync(shop)).toBe(true);
      const admin = pixelAdmin("gid://shopify/WebPixel/1");
      await loadDashboard("alpha.myshopify.com", admin);
      const update = admin.calls.find((c) => c.query.includes("webPixelUpdate"))!;
      expect(pixelSettingsFromCall(update).collectorUrl).toBe("https://new-domain.example/api/pixel/events");
      shop = await prisma.shop.findUniqueOrThrow({ where: { shopDomain: "alpha.myshopify.com" } });
      expect(needsPixelSync(shop)).toBe(false);
    } finally {
      process.env.SHOPIFY_APP_URL = previousUrl;
    }
  });

  it("restores the configuration on reinstall and keeps a stable ingest key", async () => {
    const shop = await createActiveShop();
    await markUninstalled(shop.shopDomain);
    const reinstalled = await ensureShop(shop.shopDomain);
    expect(reinstalled.uninstalledAt).toBeNull();
    expect(reinstalled.ingestKey).toBe(shop.ingestKey);
    expect(reinstalled.moosendWebsiteId).toBe(shop.moosendWebsiteId);
    expect(buildPixelSettings(reinstalled).enabled).toBe("true");
  });
});

describe("configuration changes", () => {
  it("validates input and requires an API key on first save", async () => {
    await ensureShop("alpha.myshopify.com");
    const bad = await updateSettings("alpha.myshopify.com", {
      moosendWebsiteId: "<script>",
      trackingEnabled: true,
      customEventsEnabled: false,
      webhookPurchaseFallback: true,
      checkoutAsAddToOrder: false,
      itemCodeSource: "SKU_OR_VARIANT_ID",
    });
    expect(bad.ok).toBe(false);
    const noKey = await updateSettings("alpha.myshopify.com", {
      moosendWebsiteId: "97C425C7-928B-4856-BC02-C72074C8586C",
      trackingEnabled: true,
      customEventsEnabled: false,
      webhookPurchaseFallback: true,
      checkoutAsAddToOrder: false,
      itemCodeSource: "SKU_OR_VARIANT_ID",
    });
    expect(noKey).toEqual({ ok: false, errors: { moosendApiKey: "Enter your Moosend API key." } });
  });

  it("saves settings, encrypts the API key and enables the pixel", async () => {
    await ensureShop("alpha.myshopify.com");
    const admin = pixelAdmin("gid://shopify/WebPixel/7");
    const form = new FormData();
    form.set("intent", "save");
    form.set("moosendWebsiteId", "97C425C7-928B-4856-BC02-C72074C8586C");
    form.set("moosendApiKey", "my-moosend-key");
    form.set("trackingEnabled", "true");
    form.set("customEventsEnabled", "true");
    form.set("webhookPurchaseFallback", "true");
    form.set("checkoutAsAddToOrder", "false");
    form.set("itemCodeSource", "VARIANT_ID");
    const result = await handleDashboardAction("alpha.myshopify.com", admin, form);
    expect(result).toMatchObject({ ok: true, message: "Settings saved." });

    const shop = await prisma.shop.findUniqueOrThrow({ where: { shopDomain: "alpha.myshopify.com" } });
    expect(shop.moosendApiKeyEnc).not.toContain("my-moosend-key");
    expect(getApiKey(shop)).toBe("my-moosend-key");
    expect(shop.itemCodeSource).toBe("VARIANT_ID");
    const update = admin.calls.find((c) => c.query.includes("webPixelUpdate"))!;
    expect(pixelSettingsFromCall(update)).toMatchObject({ enabled: "true", customEvents: "true" });
  });

  it("keeps the stored key when the field is left blank and disables the pixel when tracking is turned off", async () => {
    const shop = await createActiveShop();
    const result = await updateSettings(shop.shopDomain, {
      moosendWebsiteId: "NEW-SITE-ID-123",
      moosendApiKey: "",
      trackingEnabled: false,
      customEventsEnabled: false,
      webhookPurchaseFallback: true,
      checkoutAsAddToOrder: false,
      itemCodeSource: "SKU_OR_VARIANT_ID",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getApiKey(result.shop)).toBe("moosend-secret-key");
    const admin = pixelAdmin("gid://shopify/WebPixel/7");
    await syncWebPixel(admin, result.shop);
    expect(pixelSettingsFromCall(admin.calls.at(-1)!).enabled).toBe("false");
  });

  it("disconnecting Moosend removes the key, stops tracking and cancels queued events", async () => {
    const shop = await createActiveShop();
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] });
    const form = new FormData();
    form.set("intent", "disconnect");
    await handleDashboardAction(shop.shopDomain, pixelAdmin("gid://shopify/WebPixel/7"), form);
    const updated = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(updated).toMatchObject({ moosendApiKeyEnc: null, trackingEnabled: false });
    expect(await prisma.outboxEvent.findFirstOrThrow()).toMatchObject({ status: "CANCELLED" });
  });
});

describe("webhooks", () => {
  it("app/uninstalled removes sessions, marks the shop and cancels pending events", async () => {
    const shop = await createActiveShop();
    await prisma.session.create({
      data: { id: "offline_alpha.myshopify.com", shop: shop.shopDomain, state: "", accessToken: "token" },
    });
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] });

    const response = await callAction(
      uninstalledAction,
      signedWebhookRequest("app/uninstalled", shop.shopDomain, { id: 1 }, { path: "/webhooks/app/uninstalled" }),
    );
    expect(response.status).toBe(200);
    expect(await prisma.session.count()).toBe(0);
    const updated = await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } });
    expect(updated.uninstalledAt).not.toBeNull();
    expect(updated.pixelStatus).toBe("NOT_CONNECTED");
    expect(await prisma.outboxEvent.findFirstOrThrow()).toMatchObject({ status: "CANCELLED" });
    // Inactive shops no longer accept storefront events.
    expect(await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] })).toMatchObject({
      status: "ignored",
    });

    // Redelivery is idempotent.
    const again = await callAction(
      uninstalledAction,
      signedWebhookRequest("app/uninstalled", shop.shopDomain, { id: 1 }, { path: "/webhooks/app/uninstalled" }),
    );
    expect(again.status).toBe(200);
  });

  it.each([
    ["customers/data_request", dataRequestAction],
    ["customers/redact", customersRedactAction],
    ["shop/redact", shopRedactAction],
    ["orders/create", ordersCreateAction],
  ])("%s returns 401 for an invalid HMAC", async (topic, action) => {
    const response = await callAction(
      action,
      signedWebhookRequest(topic, "alpha.myshopify.com", { shop_domain: "alpha.myshopify.com" }, { tamper: true }),
    );
    expect(response.status).toBe(401);
  });

  it("customers/data_request stores an encrypted report for the merchant", async () => {
    const shop = await createActiveShop();
    const identity = { email: "jane@example.com", firstName: "Jane", lastName: null, customerId: "77" };
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed", { identity })] });

    const response = await callAction(
      dataRequestAction,
      signedWebhookRequest("customers/data_request", shop.shopDomain, {
        shop_id: 1,
        shop_domain: shop.shopDomain,
        customer: { id: 77, email: "jane@example.com", phone: null },
        orders_requested: [],
        data_request: { id: 9999 },
      }),
    );
    expect(response.status).toBe(200);
    const request = await prisma.complianceRequest.findFirstOrThrow();
    expect(request.summary).toBe("1 visitor record(s), 0 tracked order(s)");
    expect(request.reportEnc).not.toContain("jane");
    const report = JSON.parse((await getComplianceReport(shop.id, request.id))!);
    expect(report.visitors[0]).toMatchObject({ email: "jane@example.com", anonymousVisitorId: "client-1" });
  });

  it("customers/redact deletes the customer's visitor data, queued events and orders", async () => {
    const shop = await createActiveShop();
    const identity = { email: "jane@example.com", firstName: null, lastName: null, customerId: null };
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed", { identity })] });
    await ingestPixelBatch({
      v: 1,
      key: shop.ingestKey,
      events: [envelope("page_viewed", { clientId: "client-2" })],
    });

    const response = await callAction(
      customersRedactAction,
      signedWebhookRequest("customers/redact", shop.shopDomain, {
        shop_id: 1,
        shop_domain: shop.shopDomain,
        customer: { id: 191167, email: "JANE@example.com", phone: null },
        orders_to_redact: [5550001],
      }),
    );
    expect(response.status).toBe(200);
    const visitors = await prisma.visitor.findMany();
    expect(visitors.map((v) => v.clientId)).toEqual(["client-2"]);
    const remaining = await prisma.outboxEvent.findMany();
    expect(remaining.every((r) => r.visitorKey === "client-2")).toBe(true);
  });

  it("shop/redact erases all data for that shop only", async () => {
    const alpha = await createActiveShop("alpha.myshopify.com");
    const beta = await createActiveShop("beta.myshopify.com");
    await ingestPixelBatch({ v: 1, key: alpha.ingestKey, events: [envelope("page_viewed")] });
    await ingestPixelBatch({ v: 1, key: beta.ingestKey, events: [envelope("page_viewed")] });

    const response = await callAction(
      shopRedactAction,
      signedWebhookRequest("shop/redact", alpha.shopDomain, { shop_id: 1, shop_domain: alpha.shopDomain }),
    );
    expect(response.status).toBe(200);
    expect(await prisma.shop.findMany({ select: { shopDomain: true } })).toEqual([{ shopDomain: "beta.myshopify.com" }]);
    expect(await prisma.outboxEvent.count({ where: { shopId: alpha.id } })).toBe(0);
    expect(await prisma.visitor.count({ where: { shopId: alpha.id } })).toBe(0);
    expect(await prisma.outboxEvent.count({ where: { shopId: beta.id } })).toBe(1);
  });

  it("orders/create schedules the purchase fallback for a consented visitor", async () => {
    const shop = await createActiveShop();
    await ingestPixelBatch({
      v: 1,
      key: shop.ingestKey,
      events: [envelope("checkout_started", { checkout: { token: "tok-9", orderId: null, currency: "EUR", total: 24.04, items: [teeItem] } })],
    });
    const response = await callAction(
      ordersCreateAction,
      signedWebhookRequest("orders/create", shop.shopDomain, {
        id: 777,
        checkout_token: "tok-9",
        currency: "EUR",
        total_price: "24.04",
        line_items: [{ variant_id: 222, product_id: 111, sku: "TEE-RED-M", title: "Cow T-Shirt", quantity: 2, price: "12.02" }],
      }),
    );
    expect(response.status).toBe(200);
    expect(await prisma.orderTracking.findFirstOrThrow()).toMatchObject({ orderId: "777", status: "PENDING_FALLBACK" });
    const row = await prisma.outboxEvent.findFirstOrThrow({ where: { eventType: "ORDER_COMPLETED" } });
    expect(row.holdsSequence).toBe(false);
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now() + 250_000);
  });
});
