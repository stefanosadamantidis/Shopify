import { Prisma } from "@prisma/client";
import prisma from "../db.server";
import { config } from "../config.server";
import {
  decryptNullable,
  encrypt,
  encryptNullable,
  hashEmail,
} from "../lib/crypto.server";
import {
  buildDisplayName,
  buildIdentifyEvent,
  buildOrderCompletedEvent,
  numericId,
  round2,
  toMoosendProduct,
} from "./moosend/mapping";
import type { OutboundEvent } from "./moosend/types";
import { enqueueEvents, ORDER_STATUS } from "./outbox.server";
import type { PixelItem } from "./pixel/schema";
import { getShop, getTrackingSettings, isTrackingActive } from "./shop.server";

/**
 * orders/create webhook handling.
 *
 * The web pixel's checkout_completed event is the primary purchase signal.
 * The webhook is a reliability fallback for orders whose thank-you page never
 * loaded. To respect the buyer's consent decision, a webhook purchase is only
 * forwarded when it can be correlated (via checkout token) to a storefront
 * visitor whose events were collected by the consent-gated web pixel.
 */

interface WebhookLineItem {
  product_id?: number | string | null;
  variant_id?: number | string | null;
  sku?: string | null;
  title?: string | null;
  name?: string | null;
  variant_title?: string | null;
  vendor?: string | null;
  quantity?: number | null;
  price?: string | number | null;
  total_discount?: string | number | null;
}

export interface OrderWebhookPayload {
  id?: number | string;
  admin_graphql_api_id?: string;
  checkout_token?: string | null;
  created_at?: string;
  currency?: string | null;
  total_price?: string | number | null;
  email?: string | null;
  customer?: {
    id?: number | string | null;
    email?: string | null;
    first_name?: string | null;
    last_name?: string | null;
  } | null;
  line_items?: WebhookLineItem[];
}

export type OrderWebhookOutcome =
  | "ignored_inactive"
  | "fallback_disabled"
  | "invalid"
  | "duplicate"
  | "no_consented_visitor"
  | "scheduled";

function toNumber(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseSnapshotItems(raw: string | undefined): PixelItem[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? (value as PixelItem[]) : [];
  } catch {
    return [];
  }
}

export function webhookLineToItem(
  line: WebhookLineItem,
  currency: string | null,
  snapshot: PixelItem[],
): PixelItem {
  const variantId = numericId(line.variant_id ?? null);
  const match = snapshot.find((item) => numericId(item.variantId) === variantId);
  const quantity = Math.max(0, Math.trunc(line.quantity ?? 0));
  const price = toNumber(line.price) ?? 0;
  const discount = toNumber(line.total_discount) ?? 0;
  return {
    productId: numericId(line.product_id ?? null),
    variantId,
    sku: line.sku || null,
    title: line.title || line.name || match?.title || "Item",
    variantTitle: line.variant_title || null,
    url: match?.url ?? null,
    image: match?.image ?? null,
    price,
    currency,
    quantity,
    lineTotal: round2(price * quantity - discount),
    productType: match?.productType ?? null,
    vendor: line.vendor || match?.vendor || null,
  };
}

export async function handleOrderCreated(
  shopDomain: string,
  payload: OrderWebhookPayload,
): Promise<OrderWebhookOutcome> {
  const shop = await getShop(shopDomain);
  if (!shop || !isTrackingActive(shop)) return "ignored_inactive";
  if (!shop.webhookPurchaseFallback) return "fallback_disabled";

  const orderId = numericId(payload.id ?? payload.admin_graphql_api_id ?? null);
  if (!orderId) return "invalid";

  const snapshot = payload.checkout_token
    ? await prisma.checkoutSnapshot.findUnique({
        where: {
          shopId_checkoutToken: { shopId: shop.id, checkoutToken: payload.checkout_token },
        },
      })
    : null;

  if (!snapshot) {
    try {
      await prisma.orderTracking.create({
        data: {
          shopId: shop.id,
          orderId,
          source: "orders_webhook",
          status: ORDER_STATUS.SKIPPED_NO_VISITOR,
          customerId: numericId(payload.customer?.id ?? null),
        },
      });
    } catch (error) {
      if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002")) {
        throw error;
      }
    }
    return "no_consented_visitor";
  }

  return prisma.$transaction(async (tx) => {
    try {
      await tx.orderTracking.create({
        data: {
          shopId: shop.id,
          orderId,
          source: "orders_webhook",
          status: ORDER_STATUS.PENDING_FALLBACK,
          clientId: snapshot.clientId,
          customerId: numericId(payload.customer?.id ?? null),
        },
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return "duplicate" as const;
      }
      throw error;
    }

    const settings = getTrackingSettings(shop);
    const currency = payload.currency ?? null;
    const snapshotItems = parseSnapshotItems(snapshot.itemsJson);
    const products = (payload.line_items ?? [])
      .filter((line) => (line.quantity ?? 0) > 0)
      .map((line) =>
        toMoosendProduct(webhookLineToItem(line, currency, snapshotItems), settings.itemCodeSource),
      );
    const occurredAt = payload.created_at ?? new Date().toISOString();

    const visitor = await tx.visitor.upsert({
      where: { shopId_clientId: { shopId: shop.id, clientId: snapshot.clientId } },
      create: { shopId: shop.id, clientId: snapshot.clientId },
      update: {},
    });
    let email = decryptNullable(visitor.emailEnc);
    let name = decryptNullable(visitor.nameEnc);

    const events: OutboundEvent[] = [];
    // The email is only present when the app is approved for protected
    // customer data (email field); otherwise Shopify redacts it.
    const orderEmail = (payload.email || payload.customer?.email || "").trim();
    if (orderEmail) {
      const emailHash = hashEmail(orderEmail);
      if (emailHash !== visitor.emailHash) {
        const orderName = buildDisplayName(payload.customer?.first_name, payload.customer?.last_name);
        events.push(
          buildIdentifyEvent(`order:${orderId}:identify`, occurredAt, { email: orderEmail, name: orderName }, undefined, "orders_webhook"),
        );
        email = orderEmail;
        name = orderName ?? name;
        await tx.visitor.update({
          where: { id: visitor.id },
          data: {
            emailEnc: encrypt(orderEmail),
            emailHash,
            nameEnc: encryptNullable(name),
            identifiedAt: new Date(),
            customerId: numericId(payload.customer?.id ?? null),
          },
        });
      }
    }

    events.push(
      buildOrderCompletedEvent(
        `order:${orderId}:completed`,
        occurredAt,
        { orderId, products, total: toNumber(payload.total_price), currency },
        undefined,
        "orders_webhook",
      ),
    );

    await enqueueEvents(tx, events, {
      shop,
      visitorKey: snapshot.clientId,
      identity: { email, name },
      orderId,
      holdsSequence: false,
      // Give the web pixel's checkout_completed event time to arrive first.
      availableAt: new Date(Date.now() + config.orderFallbackDelaySeconds * 1000),
    });
    return "scheduled" as const;
  });
}
