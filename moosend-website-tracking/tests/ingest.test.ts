import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import { decodePayload } from "../app/services/outbox.server";
import { ingestPixelBatch } from "../app/services/pixel/ingest.server";
import {
  handleCollectorRequest,
  resetCollectorRateLimits,
} from "../app/services/pixel/collector.server";
import { createActiveShop, envelope, resetDb, teeItem } from "./helpers";

async function outboxFor(shopId: string) {
  const rows = await prisma.outboxEvent.findMany({ where: { shopId }, orderBy: { createdAt: "asc" } });
  return rows.map((row) => ({ row, payload: decodePayload(row) }));
}

function collectorRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://moosend-app.test/api/pixel/events", {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8", "X-Forwarded-For": "203.0.113.5", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("pixel ingestion", () => {
  beforeEach(async () => {
    await resetDb();
    resetCollectorRateLimits();
  });
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it("queues mapped events with the shop's Moosend website ID", async () => {
    const shop = await createActiveShop();
    const result = await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] });
    expect(result).toMatchObject({ status: "accepted", queued: 1 });
    const [first] = await outboxFor(shop.id);
    expect(first.payload).toMatchObject({
      event: "PAGE_VIEW",
      websiteId: "97C425C7-928B-4856-BC02-C72074C8586C",
      visitor: { anonymousId: "client-1", email: null },
    });
    // Payloads are encrypted at rest.
    expect(first.row.payloadEnc).not.toContain("PAGE_VIEW");
  });

  it("ignores events for unknown keys and inactive shops", async () => {
    const disabled = await createActiveShop("beta.myshopify.com", { trackingEnabled: false });
    expect(await ingestPixelBatch({ v: 1, key: "unknown-key-0000000000", events: [envelope("page_viewed")] }))
      .toEqual({ status: "ignored", reason: "unknown_key" });
    expect(await ingestPixelBatch({ v: 1, key: disabled.ingestKey, events: [envelope("page_viewed")] }))
      .toEqual({ status: "ignored", reason: "tracking_inactive" });
    expect(await prisma.outboxEvent.count()).toBe(0);
  });

  it("ignores events when the Moosend destination endpoint is not configured", async () => {
    const shop = await createActiveShop();
    const previous = process.env.MOOSEND_TRACKING_ENDPOINT;
    process.env.MOOSEND_TRACKING_ENDPOINT = "";
    try {
      const result = await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] });
      expect(result).toEqual({ status: "ignored", reason: "tracking_inactive" });
    } finally {
      process.env.MOOSEND_TRACKING_ENDPOINT = previous;
    }
  });

  it("rejects events without analytics + marketing + sale-of-data consent", async () => {
    const shop = await createActiveShop();
    const env = envelope("page_viewed", { consent: { analytics: true, marketing: false, saleOfData: true } });
    const result = await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [env] });
    expect(result).toMatchObject({ status: "accepted", outcomes: ["no_consent"], queued: 0 });
    expect(await prisma.visitor.count()).toBe(0);
  });

  it("deduplicates repeated Shopify event IDs", async () => {
    const shop = await createActiveShop();
    const env = envelope("product_added_to_cart", { item: teeItem });
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [env] });
    const second = await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [env] });
    expect(second).toMatchObject({ outcomes: ["duplicate"], queued: 0 });
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it("identifies visitors before other events and attaches the email to later events", async () => {
    const shop = await createActiveShop();
    const identity = { email: "jane@example.com", firstName: "Jane", lastName: "Doe", customerId: "77" };
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed", { identity })] });
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("product_added_to_cart", { item: teeItem })] });
    const rows = await outboxFor(shop.id);
    expect(rows.map((r) => r.payload.event)).toEqual(["IDENTIFY", "PAGE_VIEW", "ADDED_TO_ORDER"]);
    expect(rows[2].payload.visitor).toEqual({ anonymousId: "client-1", email: "jane@example.com", name: "Jane Doe" });
    const visitor = await prisma.visitor.findFirstOrThrow();
    expect(visitor.emailEnc).not.toContain("jane");
    expect(visitor.customerId).toBe("77");
  });

  it("isolates merchants: same visitor ID in two shops never shares state", async () => {
    const alpha = await createActiveShop("alpha.myshopify.com", { websiteId: "ALPHA-SITE-0001" });
    const beta = await createActiveShop("beta.myshopify.com", { websiteId: "BETA-SITE-0002" });
    const identity = { email: "jane@example.com", firstName: null, lastName: null, customerId: null };
    await ingestPixelBatch({ v: 1, key: alpha.ingestKey, events: [envelope("page_viewed", { identity })] });
    await ingestPixelBatch({ v: 1, key: beta.ingestKey, events: [envelope("page_viewed")] });

    const alphaRows = await outboxFor(alpha.id);
    const betaRows = await outboxFor(beta.id);
    expect(alphaRows.every((r) => r.payload.websiteId === "ALPHA-SITE-0001")).toBe(true);
    expect(betaRows.map((r) => r.payload.event)).toEqual(["PAGE_VIEW"]);
    expect(betaRows[0].payload.websiteId).toBe("BETA-SITE-0002");
    expect(betaRows[0].payload.visitor.email).toBeNull();
    expect(await prisma.visitor.count()).toBe(2);
  });

  it("reports each order only once even if checkout_completed is received twice", async () => {
    const shop = await createActiveShop();
    const checkout = { token: "tok-1", orderId: "5550001", currency: "EUR", total: 24.04, items: [teeItem] };
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("checkout_completed", { checkout })] });
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("checkout_completed", { checkout })] });
    const orders = (await outboxFor(shop.id)).filter((r) => r.payload.event === "ORDER_COMPLETED");
    expect(orders).toHaveLength(1);
    const tracking = await prisma.orderTracking.findFirstOrThrow();
    expect(tracking).toMatchObject({ orderId: "5550001", status: "SENT_PIXEL" });
  });
});

describe("collector endpoint", () => {
  beforeEach(async () => {
    await resetDb();
    resetCollectorRateLimits();
  });

  it("accepts valid batches with CORS headers", async () => {
    const shop = await createActiveShop();
    const response = await handleCollectorRequest(
      collectorRequest({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] }),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get("Access-Control-Allow-Origin")).toBe("*");
    expect(await prisma.outboxEvent.count()).toBe(1);
  });

  it("returns the same response for unknown keys (no key enumeration)", async () => {
    const response = await handleCollectorRequest(
      collectorRequest({ v: 1, key: "unknown-key-0000000000", events: [envelope("page_viewed")] }),
    );
    expect(response.status).toBe(202);
  });

  it("rejects invalid JSON, invalid schema and oversized bodies", async () => {
    expect((await handleCollectorRequest(collectorRequest("{not json"))).status).toBe(400);
    expect((await handleCollectorRequest(collectorRequest({ v: 2, key: "x", events: [] }))).status).toBe(400);
    const huge = JSON.stringify({ v: 1, key: "k".repeat(20), events: [], pad: "x".repeat(70_000) });
    expect((await handleCollectorRequest(collectorRequest(huge))).status).toBe(413);
  });

  it("answers preflight and rejects other methods", async () => {
    const options = await handleCollectorRequest(
      new Request("https://moosend-app.test/api/pixel/events", { method: "OPTIONS" }),
    );
    expect(options.status).toBe(204);
    expect(options.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    const put = await handleCollectorRequest(
      new Request("https://moosend-app.test/api/pixel/events", { method: "PUT", body: "{}" }),
    );
    expect(put.status).toBe(405);
  });

  it("rate limits abusive clients", async () => {
    let last = 0;
    for (let i = 0; i < 245; i += 1) {
      last = (await handleCollectorRequest(collectorRequest("{bad", { "X-Forwarded-For": "198.51.100.9" }))).status;
    }
    expect(last).toBe(429);
  });
});
