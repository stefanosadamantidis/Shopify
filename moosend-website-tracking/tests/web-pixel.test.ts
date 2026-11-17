import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { ExtensionApi } from "@shopify/web-pixels-extension";
import {
  absoluteImage,
  createTracker,
  sanitizeUrl,
} from "../extensions/moosend-web-pixel/src/tracker";
import { pixelBatchSchema } from "../app/services/pixel/schema";

type Handler = (event: unknown) => void;

const registered: { callback?: (api: ExtensionApi) => void } = {};
vi.mock("@shopify/web-pixels-extension", () => ({
  register: (callback: (api: ExtensionApi) => void) => {
    registered.callback = callback;
  },
}));

function makeApi(options: {
  settings?: Record<string, string>;
  consent?: Partial<Record<"analyticsProcessingAllowed" | "marketingAllowed" | "saleOfDataAllowed", boolean>>;
  customer?: Record<string, unknown> | null;
} = {}) {
  const handlers = new Map<string, Handler>();
  let consentHandler: Handler | undefined;
  const sendBeacon = vi.fn(async () => true);
  const api = {
    settings: options.settings ?? {
      collectorUrl: "https://moosend-app.test/api/pixel/events",
      ingestKey: "ingest-key-1234567890",
      enabled: "true",
      customEvents: "false",
    },
    analytics: {
      subscribe: (name: string, cb: Handler) => {
        handlers.set(name, cb);
        return () => true;
      },
    },
    browser: { sendBeacon, cookie: {}, localStorage: {}, sessionStorage: {} },
    init: {
      context: {},
      data: { customer: options.customer ?? null, cart: null, shop: {}, purchasingCompany: null },
      customerPrivacy: {
        analyticsProcessingAllowed: true,
        marketingAllowed: true,
        preferencesProcessingAllowed: false,
        saleOfDataAllowed: true,
        ...options.consent,
      },
    },
    customerPrivacy: {
      subscribe: (_name: string, cb: Handler) => {
        consentHandler = cb;
        return () => true;
      },
    },
    _pixelInfo: {},
  } as unknown as ExtensionApi;
  return {
    api,
    handlers,
    sendBeacon,
    emitConsent: (status: Record<string, boolean>) => consentHandler?.({ customerPrivacy: status }),
  };
}

const context = {
  document: {
    location: {
      href: "https://alpha.example/products/cow-t-shirt?variant=222&email=a@b.com#reviews",
      origin: "https://alpha.example",
      pathname: "/products/cow-t-shirt",
    },
    referrer: "https://google.com/search?q=cow",
    title: "Cow T-Shirt",
  },
};

const variant = {
  id: "222",
  sku: "TEE-RED-M",
  title: "Red / M",
  price: { amount: 12.02, currencyCode: "EUR" },
  image: { src: "//cdn.shopify.com/tee.jpg" },
  product: { id: "111", title: "Cow T-Shirt", url: "/products/cow-t-shirt?variant=222", type: "T-Shirts", vendor: "Acme Co" },
};

function baseEvent(name: string, data: unknown = {}) {
  return { id: `id-${name}`, name, timestamp: "2026-11-17T12:00:00.000Z", seq: 1, clientId: "client-1", context, data };
}

type FetchMock = Mock<typeof fetch>;

function sentBodies(fetchMock: FetchMock) {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

describe("web pixel extension", () => {
  let fetchMock: FetchMock;

  beforeEach(() => {
    fetchMock = vi.fn<typeof fetch>(async () => new Response(null, { status: 202 }));
  });

  it("registers through the Web Pixels API entry point", async () => {
    await import("../extensions/moosend-web-pixel/src/index");
    expect(typeof registered.callback).toBe("function");
  });

  it("stays idle when tracking is disabled in the pixel settings", () => {
    const { api, handlers } = makeApi({
      settings: { collectorUrl: "https://x.test/api", ingestKey: "k".repeat(20), enabled: "false", customEvents: "false" },
    });
    expect(createTracker(api, { fetch: fetchMock }).active).toBe(false);
    expect(handlers.size).toBe(0);
  });

  it("subscribes only to the standard events it needs (custom events opt-in)", () => {
    const { api, handlers } = makeApi();
    createTracker(api, { fetch: fetchMock });
    expect([...handlers.keys()].sort()).toEqual([
      "checkout_completed",
      "checkout_contact_info_submitted",
      "checkout_started",
      "page_viewed",
      "product_added_to_cart",
      "product_viewed",
    ]);
  });

  it("sends a sanitized page view as a CORS simple request with keepalive", () => {
    const { api, handlers } = makeApi();
    createTracker(api, { fetch: fetchMock });
    handlers.get("page_viewed")!(baseEvent("page_viewed"));

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://moosend-app.test/api/pixel/events");
    expect(init.keepalive).toBe(true);
    expect((init.headers as Record<string, string>)["Content-Type"]).toMatch(/^text\/plain/);
    const body = JSON.parse(init.body as string);
    expect(pixelBatchSchema.safeParse(body).success).toBe(true);
    expect(body.events[0].page).toEqual({
      url: "https://alpha.example/products/cow-t-shirt",
      referrer: "https://google.com/search",
      title: "Cow T-Shirt",
    });
  });

  it("normalizes product views and add-to-cart line items", () => {
    const { api, handlers } = makeApi();
    createTracker(api, { fetch: fetchMock });
    handlers.get("product_viewed")!(baseEvent("product_viewed", { productVariant: variant }));
    handlers.get("product_added_to_cart")!(
      baseEvent("product_added_to_cart", {
        cartLine: { merchandise: variant, quantity: 2, cost: { totalAmount: { amount: 24.04, currencyCode: "EUR" } } },
      }),
    );
    const [view, add] = sentBodies(fetchMock);
    expect(view.events[0].item).toMatchObject({
      sku: "TEE-RED-M",
      url: "https://alpha.example/products/cow-t-shirt",
      image: "https://cdn.shopify.com/tee.jpg",
      quantity: 1,
    });
    expect(add.events[0].item).toMatchObject({ quantity: 2, lineTotal: 24.04, price: 12.02, currency: "EUR" });
    for (const body of sentBodies(fetchMock)) expect(pixelBatchSchema.safeParse(body).success).toBe(true);
  });

  it("identifies logged-in customers once per page and includes checkout identity", () => {
    const { api, handlers } = makeApi({
      customer: { id: "77", email: "jane@example.com", firstName: "Jane", lastName: "Doe" },
    });
    createTracker(api, { fetch: fetchMock });
    handlers.get("page_viewed")!(baseEvent("page_viewed"));
    handlers.get("product_viewed")!(baseEvent("product_viewed", { productVariant: variant }));
    handlers.get("checkout_completed")!(
      baseEvent("checkout_completed", {
        checkout: {
          token: "tok-1",
          email: "buyer@example.com",
          currencyCode: "EUR",
          totalPrice: { amount: 30.5, currencyCode: "EUR" },
          billingAddress: { firstName: "Bob", lastName: "Buyer", address1: "secret street" },
          order: { id: "5550001", customer: { id: "88" } },
          lineItems: [
            { title: "Cow T-Shirt", quantity: 2, variant, finalLinePrice: { amount: 24.04, currencyCode: "EUR" } },
          ],
        },
      }),
    );
    const bodies = sentBodies(fetchMock);
    expect(bodies[0].events[0].identity).toEqual({
      email: "jane@example.com",
      firstName: "Jane",
      lastName: "Doe",
      customerId: "77",
    });
    expect(bodies[1].events[0].identity).toBeUndefined();
    const checkoutEvent = bodies[2].events[0];
    expect(checkoutEvent.identity.email).toBe("buyer@example.com");
    expect(checkoutEvent.checkout).toMatchObject({ token: "tok-1", orderId: "5550001", total: 30.5 });
    // Addresses are never forwarded.
    expect(JSON.stringify(checkoutEvent)).not.toContain("secret street");
    expect(pixelBatchSchema.safeParse(bodies[2]).success).toBe(true);
  });

  it("stops sending when the visitor withdraws consent and resumes when granted", () => {
    const { api, handlers, emitConsent } = makeApi();
    createTracker(api, { fetch: fetchMock });
    emitConsent({ analyticsProcessingAllowed: true, marketingAllowed: false, saleOfDataAllowed: true });
    handlers.get("page_viewed")!(baseEvent("page_viewed"));
    expect(fetchMock).not.toHaveBeenCalled();
    emitConsent({ analyticsProcessingAllowed: true, marketingAllowed: true, saleOfDataAllowed: true });
    handlers.get("page_viewed")!(baseEvent("page_viewed"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not send without initial consent", () => {
    const { api, handlers } = makeApi({ consent: { saleOfDataAllowed: false } });
    createTracker(api, { fetch: fetchMock });
    handlers.get("page_viewed")!(baseEvent("page_viewed"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("falls back to browser.sendBeacon when fetch fails", async () => {
    const { api, handlers, sendBeacon } = makeApi();
    const failing = vi.fn(async () => {
      throw new TypeError("network");
    });
    createTracker(api, { fetch: failing as unknown as typeof fetch });
    handlers.get("page_viewed")!(baseEvent("page_viewed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendBeacon).toHaveBeenCalledTimes(1);
  });

  it("subscribes to optional events when custom events are enabled", () => {
    const { api, handlers } = makeApi({
      settings: {
        collectorUrl: "https://moosend-app.test/api/pixel/events",
        ingestKey: "ingest-key-1234567890",
        enabled: "true",
        customEvents: "true",
      },
    });
    createTracker(api, { fetch: fetchMock });
    expect(handlers.has("search_submitted")).toBe(true);
    handlers.get("search_submitted")!(baseEvent("search_submitted", { searchResult: { query: "red tee", productVariants: [] } }));
    expect(sentBodies(fetchMock)[0].events[0].search).toEqual({ query: "red tee" });
  });
});

describe("URL helpers", () => {
  it("strips query strings, fragments and checkout tokens", () => {
    expect(sanitizeUrl("https://a.example/products/x?email=a@b.com#top")).toBe("https://a.example/products/x");
    expect(sanitizeUrl("https://a.example/checkouts/cn/abc123/information")).toBe("https://a.example/checkout");
    expect(sanitizeUrl("/products/x?variant=1", "https://a.example")).toBe("https://a.example/products/x");
    expect(sanitizeUrl("javascript:alert(1)")).toBeNull();
  });

  it("makes protocol-relative images absolute", () => {
    expect(absoluteImage("//cdn.shopify.com/a.jpg")).toBe("https://cdn.shopify.com/a.jpg");
  });
});
