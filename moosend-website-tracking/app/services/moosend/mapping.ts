import type { PixelEnvelope, PixelItem } from "../pixel/schema";
import type {
  ItemCodeSource,
  MoosendProduct,
  OutboundEvent,
} from "./types";

/**
 * Pure Shopify -> Moosend mapping logic. No I/O, fully unit tested.
 * See IMPORTANT DOC/EVENT_MAPPING.md for the authoritative mapping table.
 */

export interface ShopTrackingSettings {
  itemCodeSource: ItemCodeSource;
  customEventsEnabled: boolean;
  checkoutAsAddToOrder: boolean;
}

export interface VisitorState {
  emailHash: string | null;
  addedItemCodes: string[];
}

export interface IdentityUpdate {
  email: string;
  emailHash: string;
  name: string | null;
  customerId: string | null;
}

export interface MappingResult {
  events: OutboundEvent[];
  identity: IdentityUpdate | null;
  addedItemCodes: string[];
  orderId: string | null;
  checkoutSnapshot: { token: string; items: PixelItem[] } | null;
}

export const MAX_TRACKED_ITEM_CODES = 200;

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Extracts the numeric part of a Shopify ID ("gid://shopify/Order/123" -> "123"). */
export function numericId(id: string | number | null | undefined): string | null {
  if (id === null || id === undefined) return null;
  const value = String(id).trim();
  if (!value) return null;
  const match = value.match(/(\d+)(?:\?.*)?$/);
  return match ? match[1] : value;
}

export function resolveItemCode(
  item: Pick<PixelItem, "sku" | "variantId" | "productId" | "title">,
  source: ItemCodeSource,
): string {
  const variantId = numericId(item.variantId);
  const productId = numericId(item.productId);
  const sku = item.sku?.trim() || null;
  switch (source) {
    case "PRODUCT_ID":
      return productId ?? variantId ?? sku ?? item.title;
    case "VARIANT_ID":
      return variantId ?? sku ?? productId ?? item.title;
    case "SKU_OR_VARIANT_ID":
    default:
      return sku ?? variantId ?? productId ?? item.title;
  }
}

export function toMoosendProduct(
  item: PixelItem,
  source: ItemCodeSource,
): MoosendProduct {
  const quantity = item.quantity > 0 ? item.quantity : 1;
  const price = round2(item.price ?? 0);
  const total = round2(item.lineTotal ?? price * quantity);
  const product: MoosendProduct = {
    itemCode: resolveItemCode(item, source),
    itemName: item.title,
    itemImage: item.image ?? "",
    itemPrice: price,
    itemUrl: item.url ?? "",
    itemQuantity: quantity,
    itemTotalPrice: total,
  };
  if (item.productType) product.itemCategory = item.productType;
  if (item.vendor) product.itemManufacturer = item.vendor;
  if (item.currency) product.currency = item.currency;
  if (item.variantTitle && item.variantTitle !== "Default Title") {
    product.variantTitle = item.variantTitle;
  }
  return product;
}

export function buildDisplayName(
  firstName?: string | null,
  lastName?: string | null,
): string | null {
  const name = [firstName, lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return name || null;
}

function eventBase(env: PixelEnvelope) {
  return {
    occurredAt: env.ts,
    page: {
      url: env.page.url ?? null,
      referrer: env.page.referrer ?? null,
      title: env.page.title ?? null,
    },
    source: "web_pixel" as const,
  };
}

export function buildIdentifyEvent(
  eventId: string,
  occurredAt: string,
  identity: { email: string; name: string | null },
  page?: OutboundEvent["page"],
  source: OutboundEvent["source"] = "web_pixel",
): OutboundEvent {
  const data: Record<string, unknown> = { email: identity.email };
  if (identity.name) data.name = identity.name;
  return {
    type: "IDENTIFY",
    name: "IDENTIFY",
    trackerMethod: "identify",
    eventId,
    occurredAt,
    data,
    page,
    source,
  };
}

export function buildAddToOrderEvent(
  eventId: string,
  occurredAt: string,
  product: MoosendProduct,
  page?: OutboundEvent["page"],
  source: OutboundEvent["source"] = "web_pixel",
): OutboundEvent {
  return {
    type: "ADDED_TO_ORDER",
    name: "ADDED_TO_ORDER",
    trackerMethod: "trackAddToOrder",
    eventId,
    occurredAt,
    data: { ...product },
    page,
    source,
  };
}

export function buildOrderCompletedEvent(
  eventId: string,
  occurredAt: string,
  order: {
    orderId: string | null;
    products: MoosendProduct[];
    total: number | null;
    currency: string | null;
  },
  page?: OutboundEvent["page"],
  source: OutboundEvent["source"] = "web_pixel",
): OutboundEvent {
  const computedTotal = round2(
    order.products.reduce((sum, product) => sum + product.itemTotalPrice, 0),
  );
  return {
    type: "ORDER_COMPLETED",
    name: "ORDER_COMPLETED",
    trackerMethod: "trackOrderCompleted",
    eventId,
    occurredAt,
    data: {
      products: order.products,
      orderId: order.orderId,
      orderTotal: order.total !== null ? round2(order.total) : computedTotal,
      currency: order.currency,
    },
    page,
    source,
  };
}

function customEvent(
  env: PixelEnvelope,
  name: string,
  data: Record<string, unknown>,
): OutboundEvent {
  return {
    type: "CUSTOM",
    name,
    trackerMethod: name,
    eventId: `${env.id}:custom`,
    data,
    ...eventBase(env),
  };
}

/**
 * Maps one Shopify customer event (as normalised by the web pixel) into an
 * ordered list of Moosend events. IDENTIFY is always placed first, honouring
 * Moosend's requirement that identification precedes other actions.
 */
export function mapPixelEvent(
  env: PixelEnvelope,
  settings: ShopTrackingSettings,
  visitor: VisitorState,
  hashEmail: (email: string) => string,
): MappingResult {
  const events: OutboundEvent[] = [];
  const base = eventBase(env);
  const addedItemCodes = [...visitor.addedItemCodes];
  let identity: IdentityUpdate | null = null;
  let orderId: string | null = null;
  let checkoutSnapshot: MappingResult["checkoutSnapshot"] = null;

  const email = env.identity?.email?.trim();
  if (email && EMAIL_PATTERN.test(email)) {
    const emailHash = hashEmail(email);
    const name = buildDisplayName(env.identity?.firstName, env.identity?.lastName);
    identity = {
      email,
      emailHash,
      name,
      customerId: numericId(env.identity?.customerId),
    };
    if (emailHash !== visitor.emailHash) {
      events.push(
        buildIdentifyEvent(`${env.id}:identify`, env.ts, { email, name }, base.page),
      );
    }
  }

  const rememberAdded = (code: string) => {
    const index = addedItemCodes.indexOf(code);
    if (index >= 0) addedItemCodes.splice(index, 1);
    addedItemCodes.push(code);
    while (addedItemCodes.length > MAX_TRACKED_ITEM_CODES) addedItemCodes.shift();
  };

  // Optional, merchant-controlled: map items that entered checkout without an
  // observed cart add (e.g. "Buy it now"/express checkout) to ADDED_TO_ORDER.
  const addMissingCheckoutItems = (items: PixelItem[]) => {
    if (!settings.checkoutAsAddToOrder) return;
    items.forEach((item, index) => {
      const product = toMoosendProduct(item, settings.itemCodeSource);
      if (addedItemCodes.includes(product.itemCode)) return;
      events.push({
        ...buildAddToOrderEvent(
          `${env.id}:add:${index}`,
          env.ts,
          product,
          base.page,
        ),
        data: { ...product, origin: "checkout_line_item" },
      });
      rememberAdded(product.itemCode);
    });
  };

  switch (env.name) {
    case "page_viewed": {
      events.push({
        type: "PAGE_VIEW",
        name: "PAGE_VIEW",
        trackerMethod: "trackPageView",
        eventId: `${env.id}:page`,
        data: { url: env.page.url ?? null },
        ...base,
      });
      break;
    }
    case "product_viewed": {
      if (!env.item) break;
      const product = toMoosendProduct(
        { ...env.item, quantity: 1 },
        settings.itemCodeSource,
      );
      events.push({
        type: "PRODUCT_VIEW",
        name: "PAGE_VIEWED",
        trackerMethod: "PAGE_VIEWED",
        eventId: `${env.id}:product`,
        data: { products: [{ product }] },
        ...base,
      });
      break;
    }
    case "product_added_to_cart": {
      if (!env.item) break;
      const product = toMoosendProduct(env.item, settings.itemCodeSource);
      events.push(
        buildAddToOrderEvent(`${env.id}:add`, env.ts, product, base.page),
      );
      rememberAdded(product.itemCode);
      break;
    }
    case "product_removed_from_cart": {
      if (!settings.customEventsEnabled || !env.item) break;
      events.push(
        customEvent(env, "REMOVED_FROM_ORDER", {
          ...toMoosendProduct(env.item, settings.itemCodeSource),
        }),
      );
      break;
    }
    case "cart_viewed": {
      if (!settings.customEventsEnabled || !env.cart) break;
      events.push(
        customEvent(env, "CART_VIEWED", {
          currency: env.cart.currency ?? null,
          cartTotal: env.cart.total ?? null,
          itemCount: env.cart.items.reduce((sum, i) => sum + i.quantity, 0),
          itemCodes: env.cart.items.map((i) =>
            resolveItemCode(i, settings.itemCodeSource),
          ),
        }),
      );
      break;
    }
    case "collection_viewed": {
      if (!settings.customEventsEnabled || !env.collection) break;
      events.push(
        customEvent(env, "COLLECTION_VIEWED", {
          collectionId: numericId(env.collection.id),
          collectionTitle: env.collection.title ?? null,
        }),
      );
      break;
    }
    case "search_submitted": {
      if (!settings.customEventsEnabled || !env.search) break;
      events.push(
        customEvent(env, "SEARCH_SUBMITTED", { query: env.search.query }),
      );
      break;
    }
    case "checkout_started": {
      if (!env.checkout) break;
      if (env.checkout.token) {
        checkoutSnapshot = { token: env.checkout.token, items: env.checkout.items };
      }
      addMissingCheckoutItems(env.checkout.items);
      if (settings.customEventsEnabled) {
        events.push(
          customEvent(env, "CHECKOUT_STARTED", {
            currency: env.checkout.currency ?? null,
            checkoutTotal: env.checkout.total ?? null,
            itemCount: env.checkout.items.reduce((s, i) => s + i.quantity, 0),
          }),
        );
      }
      break;
    }
    case "checkout_contact_info_submitted": {
      if (env.checkout?.token) {
        checkoutSnapshot = { token: env.checkout.token, items: env.checkout.items };
      }
      break;
    }
    case "checkout_completed": {
      if (!env.checkout) break;
      if (env.checkout.token) {
        checkoutSnapshot = { token: env.checkout.token, items: env.checkout.items };
      }
      addMissingCheckoutItems(env.checkout.items);
      orderId = numericId(env.checkout.orderId);
      const products = env.checkout.items.map((item) =>
        toMoosendProduct(item, settings.itemCodeSource),
      );
      events.push(
        buildOrderCompletedEvent(
          orderId ? `order:${orderId}:completed` : `${env.id}:order`,
          env.ts,
          {
            orderId,
            products,
            total: env.checkout.total ?? null,
            currency: env.checkout.currency ?? null,
          },
          base.page,
        ),
      );
      break;
    }
  }

  return { events, identity, addedItemCodes, orderId, checkoutSnapshot };
}
