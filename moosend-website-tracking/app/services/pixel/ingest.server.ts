import { Prisma, type Shop, type Visitor } from "@prisma/client";
import prisma from "../../db.server";
import {
  decryptNullable,
  encrypt,
  encryptNullable,
  hashEmail,
} from "../../lib/crypto.server";
import { logger } from "../../lib/logger.server";
import { mapPixelEvent, type MappingResult } from "../moosend/mapping";
import { enqueueEvents, ORDER_STATUS, OUTBOX_STATUS } from "../outbox.server";
import { getTrackingSettings, isTrackingActive } from "../shop.server";
import { pixelBatchSchema, type PixelEnvelope } from "./schema";

export type EventOutcome =
  | "queued"
  | "duplicate"
  | "no_consent"
  | "no_events"
  | "error";

export type IngestResult =
  | { status: "invalid"; error: string }
  | { status: "ignored"; reason: string }
  | { status: "accepted"; outcomes: EventOutcome[]; queued: number };

/** Consent is enforced by Shopify before the pixel loads; this is defence in depth. */
export function hasTrackingConsent(env: PixelEnvelope): boolean {
  return env.consent.analytics && env.consent.marketing && env.consent.saleOfData;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
  );
}

function parseCodes(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.map(String) : [];
  } catch {
    return [];
  }
}

export async function ingestPixelBatch(body: unknown): Promise<IngestResult> {
  const parsed = pixelBatchSchema.safeParse(body);
  if (!parsed.success) {
    return { status: "invalid", error: parsed.error.issues[0]?.message ?? "Invalid payload" };
  }
  const batch = parsed.data;

  const shop = await prisma.shop.findUnique({ where: { ingestKey: batch.key } });
  if (!shop) return { status: "ignored", reason: "unknown_key" };
  if (!isTrackingActive(shop)) return { status: "ignored", reason: "tracking_inactive" };

  const ordered = [...batch.events].sort(
    (a, b) => (a.seq ?? 0) - (b.seq ?? 0) || a.ts.localeCompare(b.ts),
  );

  const outcomes: EventOutcome[] = [];
  let queued = 0;
  for (const env of ordered) {
    try {
      const result = await ingestEvent(shop, env);
      outcomes.push(result.outcome);
      queued += result.queued;
    } catch (error) {
      logger.error("Failed to ingest pixel event", {
        shop: shop.shopDomain,
        event: env.name,
        error,
      });
      outcomes.push("error");
    }
  }
  return { status: "accepted", outcomes, queued };
}

async function ingestEvent(
  shop: Shop,
  env: PixelEnvelope,
): Promise<{ outcome: EventOutcome; queued: number }> {
  if (!hasTrackingConsent(env)) return { outcome: "no_consent", queued: 0 };

  return prisma.$transaction(async (tx) => {
    try {
      await tx.processedEvent.create({
        data: { shopId: shop.id, sourceEventId: env.id },
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { outcome: "duplicate" as const, queued: 0 };
      throw error;
    }

    const visitor: Visitor = await tx.visitor.upsert({
      where: { shopId_clientId: { shopId: shop.id, clientId: env.clientId } },
      create: { shopId: shop.id, clientId: env.clientId },
      update: { lastSeenAt: new Date() },
    });

    const mapping: MappingResult = mapPixelEvent(
      env,
      getTrackingSettings(shop),
      { emailHash: visitor.emailHash, addedItemCodes: parseCodes(visitor.addedItemCodes) },
      hashEmail,
    );

    let events = mapping.events;

    // Purchase deduplication against the orders/create webhook fallback.
    if (mapping.orderId) {
      const claimed = await claimOrderForPixel(tx, shop.id, mapping.orderId, env.clientId);
      if (!claimed) {
        events = events.filter((event) => event.type !== "ORDER_COMPLETED");
      }
    }

    if (mapping.checkoutSnapshot) {
      const itemsJson = JSON.stringify(mapping.checkoutSnapshot.items);
      await tx.checkoutSnapshot.upsert({
        where: {
          shopId_checkoutToken: { shopId: shop.id, checkoutToken: mapping.checkoutSnapshot.token },
        },
        create: {
          shopId: shop.id,
          checkoutToken: mapping.checkoutSnapshot.token,
          clientId: env.clientId,
          itemsJson,
        },
        update: { clientId: env.clientId, itemsJson },
      });
    }

    let email = decryptNullable(visitor.emailEnc);
    let name = decryptNullable(visitor.nameEnc);
    const visitorUpdate: Prisma.VisitorUpdateInput = {
      addedItemCodes: JSON.stringify(mapping.addedItemCodes),
    };
    if (mapping.identity) {
      email = mapping.identity.email;
      name = mapping.identity.name ?? name;
      visitorUpdate.emailEnc = encrypt(mapping.identity.email);
      visitorUpdate.emailHash = mapping.identity.emailHash;
      if (mapping.identity.name) visitorUpdate.nameEnc = encryptNullable(mapping.identity.name);
      if (mapping.identity.customerId) visitorUpdate.customerId = mapping.identity.customerId;
      if (mapping.identity.emailHash !== visitor.emailHash) visitorUpdate.identifiedAt = new Date();
    }
    await tx.visitor.update({ where: { id: visitor.id }, data: visitorUpdate });

    if (!events.length) return { outcome: "no_events" as const, queued: 0 };

    const queuedCount = await enqueueEvents(tx, events, {
      shop,
      visitorKey: env.clientId,
      identity: { email, name },
    });
    return { outcome: "queued" as const, queued: queuedCount };
  });
}

/**
 * Returns true when the pixel is the first source to report the order (or
 * pre-empts a pending webhook fallback); false when the order was already
 * reported and must not be sent again.
 */
async function claimOrderForPixel(
  tx: Prisma.TransactionClient,
  shopId: string,
  orderId: string,
  clientId: string,
): Promise<boolean> {
  const existing = await tx.orderTracking.findUnique({
    where: { shopId_orderId: { shopId, orderId } },
  });
  if (!existing) {
    await tx.orderTracking.create({
      data: { shopId, orderId, source: "web_pixel", status: ORDER_STATUS.SENT_PIXEL, clientId },
    });
    return true;
  }
  if (existing.status === ORDER_STATUS.PENDING_FALLBACK || existing.status === ORDER_STATUS.SKIPPED_NO_VISITOR) {
    const updated = await tx.orderTracking.updateMany({
      where: { shopId, orderId, status: existing.status },
      data: { status: ORDER_STATUS.SENT_PIXEL, source: "web_pixel", clientId },
    });
    if (updated.count !== 1) return false;
    await tx.outboxEvent.updateMany({
      where: { shopId, orderId, holdsSequence: false, status: OUTBOX_STATUS.PENDING },
      data: { status: OUTBOX_STATUS.CANCELLED, lastError: "Order reported by web pixel" },
    });
    return true;
  }
  return false;
}
