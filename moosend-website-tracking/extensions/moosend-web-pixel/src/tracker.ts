import type {
  CartLine,
  Checkout,
  CheckoutLineItem,
  ExtensionApi,
  ProductVariant,
} from "@shopify/web-pixels-extension";

/**
 * Moosend web pixel (strict sandbox).
 *
 * - Uses only the Web Pixels standard API (analytics, browser, init,
 *   settings, customerPrivacy) and fetch. No DOM access, no script injection.
 * - Shopify only loads the pixel when analytics + marketing consent is given
 *   and data sale is not opted out (see shopify.extension.toml). Consent
 *   changes during the session are honoured via customerPrivacy.subscribe.
 * - Sends a minimal, normalised payload to the app backend, which holds the
 *   Moosend API key server-side.
 */

export interface TrackerDeps {
  fetch?: typeof fetch;
}

interface PixelItem {
  productId: string | null;
  variantId: string | null;
  sku: string | null;
  title: string;
  variantTitle: string | null;
  url: string | null;
  image: string | null;
  price: number | null;
  currency: string | null;
  quantity: number;
  lineTotal: number | null;
  productType: string | null;
  vendor: string | null;
}

interface Identity {
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  customerId: string | null;
}

interface Envelope {
  id: string;
  name: string;
  ts: string;
  seq?: number;
  clientId: string;
  page: { url: string | null; referrer: string | null; title: string | null };
  consent: { analytics: boolean; marketing: boolean; saleOfData: boolean };
  identity?: Identity;
  item?: PixelItem;
  cart?: { currency: string | null; total: number | null; items: PixelItem[] };
  checkout?: {
    token: string | null;
    orderId: string | null;
    currency: string | null;
    total: number | null;
    items: PixelItem[];
  };
  search?: { query: string };
  collection?: { id: string | null; title: string | null };
}

interface BaseEvent {
  id: string;
  name: string;
  timestamp: string;
  seq?: number;
  clientId: string;
  context?: {
    document?: {
      location?: { href?: string; origin?: string; pathname?: string };
      referrer?: string;
      title?: string;
    };
  };
}

const MAX_ITEMS = 100;

/** Removes query strings/fragments (may contain PII or tokens) and masks checkout tokens. */
export function sanitizeUrl(raw: string | null | undefined, origin?: string | null): string | null {
  if (!raw) return null;
  try {
    const url = origin ? new URL(raw, origin) : new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    let path = url.pathname;
    if (/^\/checkouts?\//.test(path) || /\/checkouts\//.test(path)) path = "/checkout";
    return `${url.origin}${path}`;
  } catch {
    return null;
  }
}

export function absoluteImage(src: string | null | undefined): string | null {
  if (!src) return null;
  if (src.startsWith("//")) return `https:${src}`;
  return src;
}

function itemFromVariant(
  variant: ProductVariant | null | undefined,
  quantity: number,
  lineTotal: number | null,
  origin: string | null,
  fallbackTitle?: string | null,
): PixelItem | null {
  if (!variant) return null;
  const product = variant.product;
  return {
    productId: product?.id ?? null,
    variantId: variant.id ?? null,
    sku: variant.sku || null,
    title: product?.title || fallbackTitle || variant.title || "Item",
    variantTitle: variant.title ?? null,
    url: sanitizeUrl(product?.url ?? null, origin),
    image: absoluteImage(variant.image?.src),
    price: typeof variant.price?.amount === "number" ? variant.price.amount : null,
    currency: variant.price?.currencyCode ?? null,
    quantity,
    lineTotal,
    productType: product?.type || null,
    vendor: product?.vendor || null,
  };
}

function itemFromCartLine(line: CartLine | null | undefined, origin: string | null): PixelItem | null {
  if (!line) return null;
  return itemFromVariant(
    line.merchandise,
    line.quantity,
    typeof line.cost?.totalAmount?.amount === "number" ? line.cost.totalAmount.amount : null,
    origin,
  );
}

function itemFromCheckoutLine(line: CheckoutLineItem, origin: string | null): PixelItem | null {
  return itemFromVariant(
    line.variant,
    line.quantity,
    typeof line.finalLinePrice?.amount === "number" ? line.finalLinePrice.amount : null,
    origin,
    line.title,
  );
}

function compact<T>(values: Array<T | null>): T[] {
  return values.filter((value): value is T => value !== null).slice(0, MAX_ITEMS);
}

function checkoutPayload(checkout: Checkout | null | undefined, origin: string | null) {
  if (!checkout) return undefined;
  return {
    token: checkout.token ?? null,
    orderId: checkout.order?.id ?? null,
    currency: checkout.currencyCode ?? checkout.totalPrice?.currencyCode ?? null,
    total: typeof checkout.totalPrice?.amount === "number" ? checkout.totalPrice.amount : null,
    items: compact((checkout.lineItems ?? []).map((line) => itemFromCheckoutLine(line, origin))),
  };
}

function checkoutIdentity(checkout: Checkout | null | undefined): Identity | undefined {
  // `email` and names are only populated when Shopify has approved the app's
  // access to protected customer data; otherwise they are null.
  const email = checkout?.email ?? null;
  if (!email) return undefined;
  const address = checkout?.billingAddress ?? checkout?.shippingAddress ?? null;
  return {
    email,
    firstName: address?.firstName ?? null,
    lastName: address?.lastName ?? null,
    customerId: checkout?.order?.customer?.id ?? null,
  };
}

export function createTracker(api: ExtensionApi, deps: TrackerDeps = {}) {
  const { analytics, browser, init, settings, customerPrivacy } = api;
  const doFetch = deps.fetch ?? fetch;

  const collectorUrl = String(settings?.collectorUrl ?? "");
  const ingestKey = String(settings?.ingestKey ?? "");
  const enabled = settings?.enabled === "true";
  const customEvents = settings?.customEvents === "true";

  if (!enabled || !ingestKey || !/^https?:\/\//.test(collectorUrl)) {
    return { active: false as const };
  }

  let consent = {
    analytics: Boolean(init?.customerPrivacy?.analyticsProcessingAllowed),
    marketing: Boolean(init?.customerPrivacy?.marketingAllowed),
    saleOfData: Boolean(init?.customerPrivacy?.saleOfDataAllowed),
  };
  customerPrivacy?.subscribe?.("visitorConsentCollected", (event) => {
    const status = event.customerPrivacy;
    consent = {
      analytics: Boolean(status?.analyticsProcessingAllowed),
      marketing: Boolean(status?.marketingAllowed),
      saleOfData: Boolean(status?.saleOfDataAllowed),
    };
  });
  const allowed = () => consent.analytics && consent.marketing && consent.saleOfData;

  // Logged-in customer identity, sent once per page load with the first event.
  const customer = init?.data?.customer;
  let pendingIdentity: Identity | undefined = customer?.email
    ? {
        email: customer.email,
        firstName: customer.firstName ?? null,
        lastName: customer.lastName ?? null,
        customerId: customer.id ?? null,
      }
    : undefined;

  const send = (event: BaseEvent, extra: Partial<Envelope> = {}) => {
    if (!allowed()) return;
    const doc = event.context?.document;
    const origin = doc?.location?.origin ?? null;
    const envelope: Envelope = {
      id: event.id,
      name: event.name,
      ts: event.timestamp,
      seq: event.seq,
      clientId: event.clientId,
      page: {
        url: sanitizeUrl(doc?.location?.href ?? null),
        referrer: sanitizeUrl(doc?.referrer || null, origin),
        title: doc?.title ? doc.title.slice(0, 500) : null,
      },
      consent: { ...consent },
      ...extra,
    };
    if (!envelope.identity && pendingIdentity) envelope.identity = pendingIdentity;
    if (envelope.identity) pendingIdentity = undefined;

    const body = JSON.stringify({ v: 1, key: ingestKey, events: [envelope] });
    // text/plain keeps this a CORS "simple request" (no preflight).
    doFetch(collectorUrl, {
      method: "POST",
      body,
      keepalive: true,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
    }).catch(() => {
      browser?.sendBeacon?.(collectorUrl, body).catch(() => undefined);
    });
  };

  const originOf = (event: BaseEvent) => event.context?.document?.location?.origin ?? null;

  analytics.subscribe("page_viewed", (event) => {
    send(event);
  });

  analytics.subscribe("product_viewed", (event) => {
    const variant = event.data?.productVariant;
    const price = typeof variant?.price?.amount === "number" ? variant.price.amount : null;
    const item = itemFromVariant(variant, 1, price, originOf(event));
    if (item) send(event, { item });
  });

  analytics.subscribe("product_added_to_cart", (event) => {
    const item = itemFromCartLine(event.data?.cartLine, originOf(event));
    if (item) send(event, { item });
  });

  analytics.subscribe("checkout_started", (event) => {
    send(event, { checkout: checkoutPayload(event.data?.checkout, originOf(event)) });
  });

  analytics.subscribe("checkout_contact_info_submitted", (event) => {
    const checkout = event.data?.checkout;
    send(event, {
      checkout: checkoutPayload(checkout, originOf(event)),
      identity: checkoutIdentity(checkout),
    });
  });

  analytics.subscribe("checkout_completed", (event) => {
    const checkout = event.data?.checkout;
    send(event, {
      checkout: checkoutPayload(checkout, originOf(event)),
      identity: checkoutIdentity(checkout),
    });
  });

  if (customEvents) {
    analytics.subscribe("product_removed_from_cart", (event) => {
      const item = itemFromCartLine(event.data?.cartLine, originOf(event));
      if (item) send(event, { item });
    });

    analytics.subscribe("cart_viewed", (event) => {
      const cart = event.data?.cart;
      if (!cart) return;
      send(event, {
        cart: {
          currency: cart.cost?.totalAmount?.currencyCode ?? null,
          total: typeof cart.cost?.totalAmount?.amount === "number" ? cart.cost.totalAmount.amount : null,
          items: compact((cart.lines ?? []).map((line) => itemFromCartLine(line, originOf(event)))),
        },
      });
    });

    analytics.subscribe("collection_viewed", (event) => {
      const collection = event.data?.collection;
      if (!collection) return;
      send(event, { collection: { id: collection.id ?? null, title: collection.title ?? null } });
    });

    analytics.subscribe("search_submitted", (event) => {
      const query = event.data?.searchResult?.query;
      if (query) send(event, { search: { query: query.slice(0, 500) } });
    });
  }

  return { active: true as const };
}
