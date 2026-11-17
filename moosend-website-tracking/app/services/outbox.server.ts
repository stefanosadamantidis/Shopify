import type { OutboxEvent, Prisma, Shop } from "@prisma/client";
import prisma from "../db.server";
import { config, isDestinationConfigured } from "../config.server";
import { decrypt, encrypt } from "../lib/crypto.server";
import { logger } from "../lib/logger.server";
import {
  buildPayload,
  deliverToMoosend,
  type DeliveryRequest,
  type DeliveryResult,
} from "./moosend/client.server";
import type { MoosendEventPayload, OutboundEvent } from "./moosend/types";
import { getApiKey } from "./shop.server";

export const OUTBOX_STATUS = {
  PENDING: "PENDING",
  SENDING: "SENDING",
  DELIVERED: "DELIVERED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
} as const;

export const ORDER_STATUS = {
  SENT_PIXEL: "SENT_PIXEL",
  PENDING_FALLBACK: "PENDING_FALLBACK",
  SENT_WEBHOOK: "SENT_WEBHOOK",
  SKIPPED_NO_VISITOR: "SKIPPED_NO_VISITOR",
} as const;

type Tx = Prisma.TransactionClient;

export interface EnqueueOptions {
  shop: Pick<Shop, "id" | "shopDomain" | "moosendWebsiteId">;
  visitorKey: string;
  identity: { email: string | null; name: string | null };
  availableAt?: Date;
  holdsSequence?: boolean;
  orderId?: string | null;
}

/** Writes Moosend events to the outbox, preserving the given order. */
export async function enqueueEvents(
  tx: Tx,
  events: OutboundEvent[],
  options: EnqueueOptions,
): Promise<number> {
  const base = Date.now();
  let index = 0;
  for (const event of events) {
    const payload = buildPayload({
      event,
      websiteId: options.shop.moosendWebsiteId ?? "",
      shopDomain: options.shop.shopDomain,
      anonymousId: options.visitorKey,
      email: options.identity.email,
      name: options.identity.name,
    });
    await tx.outboxEvent.create({
      data: {
        shopId: options.shop.id,
        visitorKey: options.visitorKey,
        eventType: event.type,
        payloadEnc: encrypt(JSON.stringify(payload)),
        availableAt: options.availableAt ?? new Date(),
        holdsSequence: options.holdsSequence ?? true,
        orderId: options.orderId ?? null,
        // Strictly increasing timestamps keep per-visitor ordering stable.
        createdAt: new Date(base + index),
      },
    });
    index += 1;
  }
  return events.length;
}

export function backoffMs(attempts: number): number {
  const base = 30_000 * 2 ** Math.max(0, attempts - 1);
  return Math.min(base, 60 * 60 * 1000);
}

export interface ProcessStats {
  delivered: number;
  failed: number;
  retried: number;
  cancelled: number;
  deferred: number;
  skipped: number;
}

export interface ProcessOptions {
  now?: Date;
  limit?: number;
  shopId?: string;
  deliver?: (request: DeliveryRequest) => Promise<DeliveryResult>;
}

export function decodePayload(row: Pick<OutboxEvent, "payloadEnc">): MoosendEventPayload {
  return JSON.parse(decrypt(row.payloadEnc)) as MoosendEventPayload;
}

async function finish(id: string, data: Prisma.OutboxEventUpdateInput) {
  await prisma.outboxEvent.update({ where: { id }, data: { ...data, lockedUntil: null } });
}

/**
 * Delivers due outbox events. Safe to run concurrently: rows are claimed with
 * a conditional update before delivery.
 */
export async function processOutbox(options: ProcessOptions = {}): Promise<ProcessStats> {
  const now = options.now ?? new Date();
  const deliver = options.deliver ?? deliverToMoosend;
  const stats: ProcessStats = {
    delivered: 0,
    failed: 0,
    retried: 0,
    cancelled: 0,
    deferred: 0,
    skipped: 0,
  };

  const due = await prisma.outboxEvent.findMany({
    where: {
      ...(options.shopId ? { shopId: options.shopId } : {}),
      OR: [
        { status: OUTBOX_STATUS.PENDING, availableAt: { lte: now } },
        { status: OUTBOX_STATUS.SENDING, lockedUntil: { lt: now } },
      ],
    },
    orderBy: { createdAt: "asc" },
    take: options.limit ?? 100,
  });
  if (!due.length) return stats;

  // Events waiting for a retry block later events of the same visitor so that
  // Moosend receives them in order (e.g. ADDED_TO_ORDER before ORDER_COMPLETED).
  const waiting = await prisma.outboxEvent.findMany({
    where: {
      status: OUTBOX_STATUS.PENDING,
      availableAt: { gt: now },
      holdsSequence: true,
      shopId: { in: [...new Set(due.map((row) => row.shopId))] },
    },
    select: { shopId: true, visitorKey: true, createdAt: true },
  });
  const blockedSince = new Map<string, Date>();
  const block = (key: string, at: Date) => {
    const existing = blockedSince.get(key);
    if (!existing || at < existing) blockedSince.set(key, at);
  };
  for (const row of waiting) block(`${row.shopId}|${row.visitorKey}`, row.createdAt);

  const shops = new Map<string, Shop | null>();
  const getShopById = async (id: string) => {
    if (!shops.has(id)) shops.set(id, await prisma.shop.findUnique({ where: { id } }));
    return shops.get(id) ?? null;
  };

  for (const row of due) {
    const key = `${row.shopId}|${row.visitorKey}`;
    const blockedAt = blockedSince.get(key);
    if (row.holdsSequence && blockedAt && blockedAt < row.createdAt) {
      stats.skipped += 1;
      continue;
    }

    const claimed = await prisma.outboxEvent.updateMany({
      where: { id: row.id, status: row.status, attempts: row.attempts },
      data: { status: OUTBOX_STATUS.SENDING, lockedUntil: new Date(now.getTime() + 60_000) },
    });
    if (claimed.count !== 1) {
      stats.skipped += 1;
      continue;
    }

    const shop = await getShopById(row.shopId);
    if (!shop || shop.uninstalledAt || !shop.trackingEnabled) {
      await finish(row.id, { status: OUTBOX_STATUS.CANCELLED, lastError: "Tracking inactive for shop" });
      stats.cancelled += 1;
      continue;
    }

    let apiKey: string | null = null;
    try {
      apiKey = getApiKey(shop);
    } catch (error) {
      logger.error("Unable to decrypt Moosend API key", { shop: shop.shopDomain, error });
    }
    if (!apiKey || !shop.moosendWebsiteId) {
      await finish(row.id, { status: OUTBOX_STATUS.CANCELLED, lastError: "Moosend not connected" });
      stats.cancelled += 1;
      continue;
    }

    if (!isDestinationConfigured()) {
      // Hold events without consuming attempts until the endpoint is configured.
      await finish(row.id, {
        status: OUTBOX_STATUS.PENDING,
        availableAt: new Date(now.getTime() + 5 * 60_000),
        lastError: "Moosend destination endpoint is not configured",
      });
      stats.deferred += 1;
      block(key, row.createdAt);
      continue;
    }

    // Webhook-sourced purchase fallback: only send if the pixel did not
    // already report this order (purchase deduplication).
    if (row.orderId && !row.holdsSequence) {
      const order = await prisma.orderTracking.findUnique({
        where: { shopId_orderId: { shopId: row.shopId, orderId: row.orderId } },
      });
      if (!order || order.status === ORDER_STATUS.SENT_PIXEL) {
        await finish(row.id, { status: OUTBOX_STATUS.CANCELLED, lastError: "Order already reported by web pixel" });
        stats.cancelled += 1;
        continue;
      }
      if (row.eventType === "ORDER_COMPLETED" && order.status === ORDER_STATUS.PENDING_FALLBACK) {
        const transitioned = await prisma.orderTracking.updateMany({
          where: { shopId: row.shopId, orderId: row.orderId, status: ORDER_STATUS.PENDING_FALLBACK },
          data: { status: ORDER_STATUS.SENT_WEBHOOK },
        });
        if (transitioned.count !== 1) {
          await finish(row.id, { status: OUTBOX_STATUS.CANCELLED, lastError: "Order already reported by web pixel" });
          stats.cancelled += 1;
          continue;
        }
      }
    }

    let payload: MoosendEventPayload;
    try {
      payload = decodePayload(row);
    } catch (error) {
      await finish(row.id, { status: OUTBOX_STATUS.FAILED, lastError: "Corrupt payload" });
      logger.error("Corrupt outbox payload", { id: row.id, error });
      stats.failed += 1;
      continue;
    }

    const result = await deliver({
      endpoint: config.moosendEndpoint,
      apiKey,
      apiKeyHeader: config.moosendApiKeyHeader,
      payload,
      timeoutMs: config.deliveryTimeoutMs,
    });
    const attempts = row.attempts + 1;

    if (result.ok) {
      await finish(row.id, {
        status: OUTBOX_STATUS.DELIVERED,
        attempts,
        deliveredAt: new Date(),
        lastStatus: result.status,
        lastError: null,
      });
      await prisma.shop.update({ where: { id: shop.id }, data: { lastDeliveryAt: new Date() } });
      stats.delivered += 1;
      continue;
    }

    const errorMessage = (result.error ?? "Delivery failed").slice(0, 500);
    await prisma.shop.update({
      where: { id: shop.id },
      data: { lastDeliveryError: errorMessage, lastDeliveryErrorAt: new Date() },
    });

    if (result.retryable && attempts < config.maxAttempts) {
      await finish(row.id, {
        status: OUTBOX_STATUS.PENDING,
        attempts,
        availableAt: new Date(now.getTime() + backoffMs(attempts)),
        lastError: errorMessage,
        lastStatus: result.status,
      });
      stats.retried += 1;
      if (row.holdsSequence) block(key, row.createdAt);
    } else {
      await finish(row.id, {
        status: OUTBOX_STATUS.FAILED,
        attempts,
        lastError: errorMessage,
        lastStatus: result.status,
      });
      stats.failed += 1;
      logger.warn("Moosend delivery failed permanently", {
        shop: shop.shopDomain,
        eventType: row.eventType,
        status: result.status,
        error: errorMessage,
      });
    }
  }

  return stats;
}

/** Re-queues permanently failed events for a shop (merchant action). */
export async function retryFailedEvents(shopId: string): Promise<number> {
  const result = await prisma.outboxEvent.updateMany({
    where: { shopId, status: OUTBOX_STATUS.FAILED },
    data: { status: OUTBOX_STATUS.PENDING, attempts: 0, availableAt: new Date(), lastError: null },
  });
  return result.count;
}

export async function getDeliveryStats(shopId: string, since: Date) {
  const grouped = await prisma.outboxEvent.groupBy({
    by: ["status"],
    where: { shopId, createdAt: { gte: since } },
    _count: { _all: true },
  });
  const counts: Record<string, number> = {
    PENDING: 0,
    SENDING: 0,
    DELIVERED: 0,
    FAILED: 0,
    CANCELLED: 0,
  };
  for (const group of grouped) counts[group.status] = group._count._all;
  return counts;
}
