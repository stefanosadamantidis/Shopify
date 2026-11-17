import { afterAll, beforeEach, describe, expect, it } from "vitest";
import prisma from "../app/db.server";
import { purgeExpiredData } from "../app/services/retention.server";
import { ingestPixelBatch } from "../app/services/pixel/ingest.server";
import { processOutbox } from "../app/services/outbox.server";
import { startMockMoosendServer } from "../app/services/moosend/mock-server";
import { createActiveShop, envelope, resetDb } from "./helpers";

beforeEach(resetDb);
afterAll(async () => {
  await prisma.$disconnect();
});

describe("data retention", () => {
  it("purges delivered events after 30 days and inactive visitors after 90 days", async () => {
    const mock = await startMockMoosendServer({ apiKey: "moosend-secret-key" });
    process.env.MOOSEND_TRACKING_ENDPOINT = `${mock.url}/track`;
    try {
      const shop = await createActiveShop();
      await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] });
      await processOutbox();
      expect(await prisma.outboxEvent.count({ where: { status: "DELIVERED" } })).toBe(1);

      const in31Days = new Date(Date.now() + 31 * 24 * 3600 * 1000);
      const first = await purgeExpiredData(in31Days);
      expect(first.outbox).toBe(1);
      expect(first.visitors).toBe(0);

      const in91Days = new Date(Date.now() + 91 * 24 * 3600 * 1000);
      const second = await purgeExpiredData(in91Days);
      expect(second.visitors).toBe(1);
      expect(await prisma.processedEvent.count()).toBe(0);
    } finally {
      await mock.close();
    }
  });

  it("never purges events that are still pending delivery", async () => {
    const shop = await createActiveShop();
    await ingestPixelBatch({ v: 1, key: shop.ingestKey, events: [envelope("page_viewed")] });
    await purgeExpiredData(new Date(Date.now() + 365 * 24 * 3600 * 1000));
    expect(await prisma.outboxEvent.count({ where: { status: "PENDING" } })).toBe(1);
  });
});
