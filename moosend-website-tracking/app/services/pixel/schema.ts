import { z } from "zod";

/**
 * Wire contract between the web pixel extension
 * (extensions/moosend-web-pixel/src/tracker.ts) and the collector endpoint
 * (/api/pixel/events). The pixel only sends the minimum fields required to
 * build Moosend events.
 */

export const SUPPORTED_PIXEL_EVENTS = [
  "page_viewed",
  "product_viewed",
  "product_added_to_cart",
  "product_removed_from_cart",
  "cart_viewed",
  "collection_viewed",
  "search_submitted",
  "checkout_started",
  "checkout_contact_info_submitted",
  "checkout_completed",
] as const;

export type PixelEventName = (typeof SUPPORTED_PIXEL_EVENTS)[number];

const shortText = (max: number) => z.string().max(max);
const nullableText = (max: number) => z.string().max(max).nullable().optional();
const amount = z.number().finite().nullable().optional();

export const pixelItemSchema = z.object({
  productId: nullableText(128),
  variantId: nullableText(128),
  sku: nullableText(255),
  title: shortText(500),
  variantTitle: nullableText(500),
  url: nullableText(2048),
  image: nullableText(2048),
  price: amount,
  currency: nullableText(8),
  quantity: z.number().int().min(0).max(100_000),
  lineTotal: amount,
  productType: nullableText(255),
  vendor: nullableText(255),
});

export type PixelItem = z.infer<typeof pixelItemSchema>;

export const pixelEnvelopeSchema = z.object({
  id: z.string().min(1).max(128),
  name: z.enum(SUPPORTED_PIXEL_EVENTS),
  ts: z.string().min(1).max(64),
  seq: z.number().int().optional(),
  clientId: z.string().min(1).max(128),
  page: z.object({
    url: nullableText(2048),
    referrer: nullableText(2048),
    title: nullableText(500),
  }),
  consent: z.object({
    analytics: z.boolean(),
    marketing: z.boolean(),
    saleOfData: z.boolean(),
  }),
  identity: z
    .object({
      email: nullableText(320),
      firstName: nullableText(200),
      lastName: nullableText(200),
      customerId: nullableText(128),
    })
    .optional(),
  item: pixelItemSchema.optional(),
  cart: z
    .object({
      currency: nullableText(8),
      total: amount,
      items: z.array(pixelItemSchema).max(250),
    })
    .optional(),
  checkout: z
    .object({
      token: nullableText(255),
      orderId: nullableText(128),
      currency: nullableText(8),
      total: amount,
      items: z.array(pixelItemSchema).max(250),
    })
    .optional(),
  search: z.object({ query: shortText(500) }).optional(),
  collection: z
    .object({ id: nullableText(128), title: nullableText(500) })
    .optional(),
});

export type PixelEnvelope = z.infer<typeof pixelEnvelopeSchema>;

export const pixelBatchSchema = z.object({
  v: z.literal(1),
  key: z.string().min(16).max(128),
  events: z.array(pixelEnvelopeSchema).min(1).max(20),
});

export type PixelBatch = z.infer<typeof pixelBatchSchema>;

/** Hard limit on accepted request bodies (bytes). */
export const MAX_PIXEL_BODY_BYTES = 64 * 1024;
