import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import {
  startMockMoosendServer,
  type MockMoosendServer,
} from "../app/services/moosend/mock-server";
import { deliverToMoosend } from "../app/services/moosend/client.server";
import { backoffMs, processOutbox, retryFailedEvents } from "../app/services/outbox.server";
import { ingestPixelBatch } from "../app/services/pixel/ingest.server";
import { handleOrderCreated } from "../app/services/orders.server";
import { createActiveShop, envelope, resetDb, teeItem } from "./helpers";

let mock: MockMoosendServer;
const API_KEY = "moosend-secret-key";

beforeAll(async () => {
  mock = await startMockMoosendServer({ apiKey: API_KEY });
  process.env.MOOSEND_TRACKING_ENDPOINT = `${mock.url}/track`;
});

afterAll(async () => {
  await mock.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await resetDb();
  mock.reset();
});

const later = (ms: number) => new Date(Date.now() + ms);

describe("Moosend delivery", () => {
  it("delivers queued events to the destination with the API key header", async () => {
    const shop = await createActiveShop();
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] });
    const stats = await processOutbox();
    expect(stats.delivered).toBe(1);
    expect(mock.events).toHaveLength(1);
    expect(mock.events[0].headers["x-api-key"]).toBe("[redacted]");
    expect(mock.events[0].headers["idempotency-key"]).toBe(mock.events[0].body.eventId);
    expect(mock.events[0].body).toMatchObject({ event: "PAGE_VIEW", websiteId: shop.moosendWebsiteId });
    const row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row.status).toBe("DELIVERED");
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).lastDeliveryAt).not.toBeNull();
  });

  it("retries transient failures with exponential backoff", async () => {
    const shop = await createActiveShop();
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] });
    mock.setFailMode("always500");
    const first = await processOutbox();
    expect(first.retried).toBe(1);
    let row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row).toMatchObject({ status: "PENDING", attempts: 1, lastStatus: 500 });
    expect(row.availableAt.getTime()).toBeGreaterThan(Date.now() + 25_000);
    expect((await prisma.shop.findUniqueOrThrow({ where: { id: shop.id } })).lastDeliveryError).toContain("500");

    mock.setFailMode("none");
    const second = await processOutbox({ now: later(backoffMs(1) + 1000) });
    expect(second.delivered).toBe(1);
    row = await prisma.outboxEvent.findFirstOrThrow();
    expect(row).toMatchObject({ status: "DELIVERED", attempts: 2 });
  });

  it("does not retry authentication failures and lets the merchant retry later", async () => {
    const shop = await createActiveShop("alpha.myshopify.com", { apiKey: "wrong-key" });
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] });
    const stats = await processOutbox();
    expect(stats.failed).toBe(1);
    expect(await prisma.outboxEvent.findFirstOrThrow()).toMatchObject({ status: "FAILED", lastStatus: 401 });
    expect(await retryFailedEvents(shop.id)).toBe(1);
    expect(await prisma.outboxEvent.findFirstOrThrow()).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("marks events FAILED after the maximum number of attempts", async () => {
    process.env.OUTBOX_MAX_ATTEMPTS = "2";
    try {
      const shop = await createActiveShop();
      await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] });
      mock.setFailMode("always429");
      await processOutbox();
      await processOutbox({ now: later(backoffMs(1) + 1000) });
      expect(await prisma.outboxEvent.findFirstOrThrow()).toMatchObject({ status: "FAILED", attempts: 2 });
    } finally {
      delete process.env.OUTBOX_MAX_ATTEMPTS;
    }
  });

  it("keeps per-visitor ordering: later events wait while an earlier one is retried", async () => {
    const shop = await createActiveShop();
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("product_added_to_cart", { item: teeItem })] });
    mock.setFailMode("always500");
    await processOutbox();
    mock.setFailMode("none");
    const checkout = { token: "tok-1", orderId: "5550001", currency: "EUR", total: 24.04, items: [teeItem] };
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("checkout_completed", { checkout })] });

    const blocked = await processOutbox();
    expect(blocked.delivered).toBe(0);
    expect(blocked.skipped).toBe(1);

    await processOutbox({ now: later(backoffMs(1) + 1000) });
    expect(mock.events.map((e) => e.body.event)).toEqual(["ADDED_TO_ORDER", "ORDER_COMPLETED"]);
  });

  it("cancels events when the shop uninstalls or disables tracking", async () => {
    const shop = await createActiveShop();
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] });
    await prisma.shop.update({ where: { id: shop.id }, data: { trackingEnabled: false } });
    const stats = await processOutbox();
    expect(stats.cancelled).toBe(1);
    expect(mock.events).toHaveLength(0);
  });

  it("treats network errors and timeouts as retryable", async () => {
    const result = await deliverToMoosend({
      endpoint: "http://127.0.0.1:9/track",
      apiKey: "k",
      apiKeyHeader: "X-Api-Key",
      timeoutMs: 2000,
      payload: {
        schemaVersion: 1,
        eventId: "e",
        websiteId: "w",
        event: "PAGE_VIEW",
        trackerMethod: "trackPageView",
        occurredAt: new Date().toISOString(),
        visitor: { anonymousId: "a", email: null, name: null },
        context: { source: "admin_test", shopDomain: "s", url: null, referrer: null, pageTitle: null },
        data: {},
      },
    });
    expect(result).toMatchObject({ ok: false, retryable: true, status: null });
  });
});

describe("purchase deduplication (pixel vs orders/create webhook)", () => {
  const orderPayload = {
    id: 5550001,
    checkout_token: "tok-1",
    created_at: "2026-11-17T12:05:00Z",
    currency: "EUR",
    total_price: "24.04",
    email: "buyer@example.com",
    customer: { id: 88, email: "buyer@example.com", first_name: "Bob", last_name: "Buyer" },
    line_items: [
      { product_id: 111, variant_id: 222, sku: "TEE-RED-M", title: "Cow T-Shirt", variant_title: "Red / M", vendor: "Acme Co", quantity: 2, price: "12.02", total_discount: "0.00" },
    ],
  };
  const checkoutStarted = () =>
    envelope("checkout_started", {
      checkout: { token: "tok-1", orderId: null, currency: "EUR", total: 24.04, items: [teeItem] },
    });
  const checkoutCompleted = () =>
    envelope("checkout_completed", {
      checkout: { token: "tok-1", orderId: "5550001", currency: "EUR", total: 24.04, items: [teeItem] },
    });

  it("skips webhook purchases that cannot be tied to a consented visitor", async () => {
    await createActiveShop();
    expect(await handleOrderCreated("alpha.myshopify.com", orderPayload)).toBe("no_consented_visitor");
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it("does nothing when the merchant disabled the webhook fallback", async () => {
    const shop = await createActiveShop("alpha.myshopify.com", { webhookPurchaseFallback: false });
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [checkoutStarted()] });
    expect(await handleOrderCreated("alpha.myshopify.com", orderPayload)).toBe("fallback_disabled");
  });

  it("sends the webhook purchase once when the pixel never reports it", async () => {
    const shop = await createActiveShop();
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [checkoutStarted()] });
    expect(await handleOrderCreated("alpha.myshopify.com", orderPayload)).toBe("scheduled");
    // Redelivered webhook is ignored.
    expect(await handleOrderCreated("alpha.myshopify.com", orderPayload)).toBe("duplicate");

    expect((await processOutbox()).delivered).toBe(0); // waits for the pixel first
    await processOutbox({ now: later(301_000) });
    const sent = mock.events.map((e) => e.body);
    expect(sent.map((e) => e.event)).toEqual(["IDENTIFY", "ORDER_COMPLETED"]);
    expect(sent[1]).toMatchObject({
      eventId: "order:5550001:completed",
      visitor: { anonymousId: "client-1", email: "buyer@example.com" },
      context: { source: "orders_webhook" },
      data: {
        orderId: "5550001",
        products: [{ itemCode: "TEE-RED-M", itemUrl: teeItem.url, itemImage: teeItem.image, itemQuantity: 2 }],
      },
    });
    expect(await prisma.orderTracking.findFirstOrThrow()).toMatchObject({ status: "SENT_WEBHOOK" });
  });

  it("cancels the webhook fallback when the pixel reports the order", async () => {
    const shop = await createActiveShop();
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [checkoutStarted()] });
    await handleOrderCreated("alpha.myshopify.com", orderPayload);
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [checkoutCompleted()] });
    await processOutbox({ now: later(301_000) });
    const completed = mock.events.filter((e) => e.body.event === "ORDER_COMPLETED");
    expect(completed).toHaveLength(1);
    expect((completed[0].body.context as { source: string }).source).toBe("web_pixel");
    expect(await prisma.orderTracking.findFirstOrThrow()).toMatchObject({ status: "SENT_PIXEL" });
  });

  it("ignores the webhook when the pixel already reported the order", async () => {
    const shop = await createActiveShop();
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [checkoutStarted(), checkoutCompleted()] });
    expect(await handleOrderCreated("alpha.myshopify.com", orderPayload)).toBe("duplicate");
  });
});
