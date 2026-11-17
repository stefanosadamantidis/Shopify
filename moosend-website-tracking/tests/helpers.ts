import { createHmac } from "node:crypto";
import prisma from "../app/db.server";
import { encrypt } from "../app/lib/crypto.server";
import type { PixelEnvelope } from "../app/services/pixel/schema";

export async function resetDb() {
  await prisma.outboxEvent.deleteMany();
  await prisma.processedEvent.deleteMany();
  await prisma.checkoutSnapshot.deleteMany();
  await prisma.orderTracking.deleteMany();
  await prisma.visitor.deleteMany();
  await prisma.complianceRequest.deleteMany();
  await prisma.shop.deleteMany();
  await prisma.session.deleteMany();
}

let counter = 0;

export async function createActiveShop(
  shopDomain = "alpha.myshopify.com",
  overrides: Partial<{
    trackingEnabled: boolean;
    customEventsEnabled: boolean;
    webhookPurchaseFallback: boolean;
    checkoutAsAddToOrder: boolean;
    apiKey: string;
    websiteId: string;
  }> = {},
) {
  counter += 1;
  return prisma.shop.create({
    data: {
      shopDomain,
      ingestKey: `ingest-key-${shopDomain}-${counter}-xxxxxxxx`,
      trackingEnabled: overrides.trackingEnabled ?? true,
      customEventsEnabled: overrides.customEventsEnabled ?? false,
      webhookPurchaseFallback: overrides.webhookPurchaseFallback ?? true,
      checkoutAsAddToOrder: overrides.checkoutAsAddToOrder ?? false,
      moosendWebsiteId: overrides.websiteId ?? "97C425C7-928B-4856-BC02-C72074C8586C",
      moosendApiKeyEnc: encrypt(overrides.apiKey ?? "moosend-secret-key"),
    },
  });
}

export function envelope(
  name: PixelEnvelope["name"],
  extra: Partial<PixelEnvelope> = {},
): PixelEnvelope {
  counter += 1;
  return {
    id: `evt-${counter}`,
    name,
    ts: new Date(Date.UTC(2026, 10, 17, 12, 0, counter % 60)).toISOString(),
    seq: counter,
    clientId: "client-1",
    page: { url: "https://alpha.example/products/tee", referrer: null, title: "Tee" },
    consent: { analytics: true, marketing: true, saleOfData: true },
    ...extra,
  };
}

export const teeItem = {
  productId: "gid://shopify/Product/111",
  variantId: "gid://shopify/ProductVariant/222",
  sku: "TEE-RED-M",
  title: "Cow T-Shirt",
  variantTitle: "Red / M",
  url: "https://alpha.example/products/cow-t-shirt",
  image: "https://cdn.shopify.com/tee.jpg",
  price: 12.02,
  currency: "EUR",
  quantity: 2,
  lineTotal: 24.04,
  productType: "T-Shirts",
  vendor: "Acme Co",
};

export function signedWebhookRequest(
  topic: string,
  shop: string,
  body: unknown,
  options: { secret?: string; tamper?: boolean; path?: string } = {},
) {
  const raw = JSON.stringify(body);
  const hmac = createHmac("sha256", options.secret ?? process.env.SHOPIFY_API_SECRET!)
    .update(raw, "utf8")
    .digest("base64");
  return new Request(`https://moosend-app.test${options.path ?? "/webhooks"}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Hmac-Sha256": options.tamper ? `x${hmac.slice(1)}` : hmac,
      "X-Shopify-Topic": topic,
      "X-Shopify-Shop-Domain": shop,
      "X-Shopify-API-Version": "2026-10",
      "X-Shopify-Webhook-Id": `wh-${Math.random().toString(36).slice(2)}`,
      "X-Shopify-Event-Id": `ev-${Math.random().toString(36).slice(2)}`,
      "X-Shopify-Triggered-At": new Date().toISOString(),
    },
    body: raw,
  });
}

/** Minimal Admin GraphQL client double that records calls. */
export function fakeAdmin(
  handler: (query: string, variables?: Record<string, unknown>) => unknown,
) {
  const calls: Array<{ query: string; variables?: Record<string, unknown> }> = [];
  return {
    calls,
    graphql: async (query: string, options?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: options?.variables });
      return new Response(JSON.stringify(handler(query, options?.variables)), {
        headers: { "Content-Type": "application/json" },
      });
    },
  };
}
