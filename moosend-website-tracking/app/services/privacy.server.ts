import prisma from "../db.server";
import { decryptNullable, encrypt, hashEmail } from "../lib/crypto.server";
import { numericId } from "./moosend/mapping";

/**
 * Mandatory compliance webhooks (customers/data_request, customers/redact,
 * shop/redact). https://shopify.dev/docs/apps/build/compliance/privacy-law-compliance
 */

interface CustomerRef {
  id?: number | string | null;
  email?: string | null;
  phone?: string | null;
}

export interface CustomersDataRequestPayload {
  shop_domain?: string;
  customer?: CustomerRef;
  orders_requested?: Array<number | string>;
  data_request?: { id?: number | string };
}

export interface CustomersRedactPayload {
  shop_domain?: string;
  customer?: CustomerRef;
  orders_to_redact?: Array<number | string>;
}

async function findCustomerVisitors(shopId: string, customer?: CustomerRef) {
  const customerId = numericId(customer?.id ?? null);
  const emailHash = customer?.email ? hashEmail(customer.email) : null;
  const or = [
    ...(customerId ? [{ customerId }] : []),
    ...(emailHash ? [{ emailHash }] : []),
  ];
  if (!or.length) return [];
  return prisma.visitor.findMany({ where: { shopId, OR: or } });
}

function orderIds(values?: Array<number | string>): string[] {
  return (values ?? []).map((v) => numericId(v)).filter((v): v is string => Boolean(v));
}

export async function handleCustomersDataRequest(
  shopDomain: string,
  payload: CustomersDataRequestPayload,
) {
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) return { found: false as const };

  const visitors = await findCustomerVisitors(shop.id, payload.customer);
  const requestedOrders = orderIds(payload.orders_requested);
  const orders = await prisma.orderTracking.findMany({
    where: {
      shopId: shop.id,
      OR: [
        { orderId: { in: requestedOrders } },
        ...(visitors.length ? [{ clientId: { in: visitors.map((v) => v.clientId) } }] : []),
      ],
    },
  });

  const report = {
    generatedAt: new Date().toISOString(),
    customerId: numericId(payload.customer?.id ?? null),
    description:
      "Data stored by Moosend Website Tracking for this customer. Behavioral events are forwarded to the merchant's Moosend account; request Moosend-held data from Moosend directly.",
    visitors: visitors.map((v) => ({
      anonymousVisitorId: v.clientId,
      email: decryptNullable(v.emailEnc),
      name: decryptNullable(v.nameEnc),
      identifiedAt: v.identifiedAt?.toISOString() ?? null,
      lastSeenAt: v.lastSeenAt.toISOString(),
    })),
    trackedOrders: orders.map((o) => ({
      orderId: o.orderId,
      source: o.source,
      status: o.status,
      trackedAt: o.createdAt.toISOString(),
    })),
  };

  await prisma.complianceRequest.create({
    data: {
      shopId: shop.id,
      topic: "customers/data_request",
      requestId: payload.data_request?.id ? String(payload.data_request.id) : null,
      reportEnc: encrypt(JSON.stringify(report)),
      summary: `${visitors.length} visitor record(s), ${orders.length} tracked order(s)`,
    },
  });
  return { found: true as const, visitors: visitors.length, orders: orders.length };
}

export async function handleCustomersRedact(
  shopDomain: string,
  payload: CustomersRedactPayload,
) {
  const shop = await prisma.shop.findUnique({ where: { shopDomain } });
  if (!shop) return { found: false as const };

  const visitors = await findCustomerVisitors(shop.id, payload.customer);
  const clientIds = visitors.map((v) => v.clientId);
  const redactOrders = orderIds(payload.orders_to_redact);

  const result = await prisma.$transaction(async (tx) => {
    const outbox = await tx.outboxEvent.deleteMany({
      where: {
        shopId: shop.id,
        OR: [
          ...(clientIds.length ? [{ visitorKey: { in: clientIds } }] : []),
          ...(redactOrders.length ? [{ orderId: { in: redactOrders } }] : []),
        ],
      },
    });
    const snapshots = clientIds.length
      ? await tx.checkoutSnapshot.deleteMany({ where: { shopId: shop.id, clientId: { in: clientIds } } })
      : { count: 0 };
    const orders = await tx.orderTracking.deleteMany({
      where: {
        shopId: shop.id,
        OR: [
          ...(redactOrders.length ? [{ orderId: { in: redactOrders } }] : []),
          ...(clientIds.length ? [{ clientId: { in: clientIds } }] : []),
        ],
      },
    });
    const removedVisitors = await tx.visitor.deleteMany({
      where: { shopId: shop.id, id: { in: visitors.map((v) => v.id) } },
    });
    return {
      visitors: removedVisitors.count,
      outbox: outbox.count,
      snapshots: snapshots.count,
      orders: orders.count,
    };
  });

  await prisma.complianceRequest.create({
    data: {
      shopId: shop.id,
      topic: "customers/redact",
      summary: `Deleted ${result.visitors} visitor(s), ${result.outbox} queued event(s), ${result.orders} order record(s)`,
    },
  });
  return { found: true as const, ...result };
}

/** Erases every record held for the shop, including sessions. */
export async function handleShopRedact(shopDomain: string) {
  const [shops, sessions] = await prisma.$transaction([
    prisma.shop.deleteMany({ where: { shopDomain } }),
    prisma.session.deleteMany({ where: { shop: shopDomain } }),
  ]);
  return { shops: shops.count, sessions: sessions.count };
}

export async function listComplianceRequests(shopId: string) {
  const rows = await prisma.complianceRequest.findMany({
    where: { shopId },
    orderBy: { createdAt: "desc" },
    take: 50,
  });
  return rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    summary: row.summary,
    createdAt: row.createdAt.toISOString(),
    hasReport: Boolean(row.reportEnc),
  }));
}

export async function getComplianceReport(shopId: string, id: string): Promise<string | null> {
  const row = await prisma.complianceRequest.findFirst({ where: { id, shopId } });
  return decryptNullable(row?.reportEnc);
}
