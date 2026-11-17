import prisma from "../db.server";
import { config } from "../config.server";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Applies the data retention policy documented in SHOPIFY_COMPLIANCE.md. */
export async function purgeExpiredData(now: Date = new Date()) {
  const eventCutoff = new Date(now.getTime() - config.retentionEventDays * DAY_MS);
  const visitorCutoff = new Date(now.getTime() - config.retentionVisitorDays * DAY_MS);
  const shortCutoff = new Date(now.getTime() - 7 * DAY_MS);

  const [outbox, processed, snapshots, orders, visitors, compliance] =
    await prisma.$transaction([
      prisma.outboxEvent.deleteMany({
        where: {
          createdAt: { lt: eventCutoff },
          status: { in: ["DELIVERED", "FAILED", "CANCELLED"] },
        },
      }),
      prisma.processedEvent.deleteMany({ where: { createdAt: { lt: shortCutoff } } }),
      prisma.checkoutSnapshot.deleteMany({ where: { updatedAt: { lt: shortCutoff } } }),
      prisma.orderTracking.deleteMany({ where: { createdAt: { lt: visitorCutoff } } }),
      prisma.visitor.deleteMany({ where: { lastSeenAt: { lt: visitorCutoff } } }),
      prisma.complianceRequest.deleteMany({ where: { createdAt: { lt: visitorCutoff } } }),
    ]);

  return {
    outbox: outbox.count,
    processed: processed.count,
    snapshots: snapshots.count,
    orders: orders.count,
    visitors: visitors.count,
    compliance: compliance.count,
  };
}
