import { describe, expect, it } from "vitest";
import {
  mapPixelEvent,
  numericId,
  resolveItemCode,
  toMoosendProduct,
  type ShopTrackingSettings,
} from "../app/services/moosend/mapping";
import { buildPayload } from "../app/services/moosend/client.server";
import { envelope, teeItem } from "./helpers";

const settings: ShopTrackingSettings = {
  itemCodeSource: "SKU_OR_VARIANT_ID",
  customEventsEnabled: false,
  checkoutAsAddToOrder: false,
};
const anonymous = { emailHash: null, addedItemCodes: [] as string[] };
const hash = (email: string) => `h:${email.toLowerCase()}`;

describe("identifier helpers", () => {
  it("extracts numeric IDs from GIDs and plain values", () => {
    expect(numericId("gid://shopify/Order/123456")).toBe("123456");
    expect(numericId(987)).toBe("987");
    expect(numericId(null)).toBeNull();
  });

  it("resolves item codes according to the configured source", () => {
    expect(resolveItemCode(teeItem, "SKU_OR_VARIANT_ID")).toBe("TEE-RED-M");
    expect(resolveItemCode({ ...teeItem, sku: null }, "SKU_OR_VARIANT_ID")).toBe("222");
    expect(resolveItemCode(teeItem, "VARIANT_ID")).toBe("222");
    expect(resolveItemCode(teeItem, "PRODUCT_ID")).toBe("111");
  });

  it("builds Moosend product objects with mandatory and optional fields", () => {
    expect(toMoosendProduct(teeItem, "SKU_OR_VARIANT_ID")).toEqual({
      itemCode: "TEE-RED-M",
      itemName: "Cow T-Shirt",
      itemImage: "https://cdn.shopify.com/tee.jpg",
      itemPrice: 12.02,
      itemUrl: "https://alpha.example/products/cow-t-shirt",
      itemQuantity: 2,
      itemTotalPrice: 24.04,
      itemCategory: "T-Shirts",
      itemManufacturer: "Acme Co",
      currency: "EUR",
      variantTitle: "Red / M",
    });
  });

  it("computes line totals when Shopify omits them", () => {
    const product = toMoosendProduct({ ...teeItem, lineTotal: null, quantity: 3 }, "VARIANT_ID");
    expect(product.itemTotalPrice).toBe(36.06);
  });
});

describe("mapPixelEvent", () => {
  it("maps page_viewed to PAGE_VIEW (trackPageView)", () => {
    const result = mapPixelEvent(envelope("page_viewed"), settings, anonymous, hash);
    expect(result.events).toHaveLength(1);
    expect(result.events[0]).toMatchObject({
      type: "PAGE_VIEW",
      name: "PAGE_VIEW",
      trackerMethod: "trackPageView",
      data: { url: "https://alpha.example/products/tee" },
    });
  });

  it("maps product_viewed to Moosend's PAGE_VIEWED product payload", () => {
    const result = mapPixelEvent(envelope("product_viewed", { item: teeItem }), settings, anonymous, hash);
    expect(result.events[0]).toMatchObject({
      type: "PRODUCT_VIEW",
      name: "PAGE_VIEWED",
      data: { products: [{ product: { itemCode: "TEE-RED-M", itemQuantity: 1, itemPrice: 12.02 } }] },
    });
  });

  it("maps product_added_to_cart to ADDED_TO_ORDER and remembers the item", () => {
    const result = mapPixelEvent(envelope("product_added_to_cart", { item: teeItem }), settings, anonymous, hash);
    expect(result.events[0]).toMatchObject({
      type: "ADDED_TO_ORDER",
      trackerMethod: "trackAddToOrder",
      data: { itemCode: "TEE-RED-M", itemQuantity: 2, itemTotalPrice: 24.04 },
    });
    expect(result.addedItemCodes).toEqual(["TEE-RED-M"]);
  });

  it("maps checkout_completed to IDENTIFY followed by ORDER_COMPLETED", () => {
    const env = envelope("checkout_completed", {
      identity: { email: "Buyer@Example.com", firstName: "Jane", lastName: "Doe", customerId: null },
      checkout: {
        token: "tok-1",
        orderId: "gid://shopify/OrderIdentity/5550001",
        currency: "EUR",
        total: 30.5,
        items: [teeItem],
      },
    });
    const result = mapPixelEvent(env, settings, { emailHash: null, addedItemCodes: ["TEE-RED-M"] }, hash);
    expect(result.events.map((e) => e.type)).toEqual(["IDENTIFY", "ORDER_COMPLETED"]);
    expect(result.events[0].data).toEqual({ email: "Buyer@Example.com", name: "Jane Doe" });
    expect(result.events[1]).toMatchObject({
      eventId: "order:5550001:completed",
      data: { orderId: "5550001", orderTotal: 30.5, currency: "EUR", products: [{ itemCode: "TEE-RED-M" }] },
    });
    expect(result.orderId).toBe("5550001");
    expect(result.checkoutSnapshot?.token).toBe("tok-1");
  });

  it("does not re-identify a visitor that is already identified with the same email", () => {
    const env = envelope("page_viewed", {
      identity: { email: "buyer@example.com", firstName: null, lastName: null, customerId: "77" },
    });
    const result = mapPixelEvent(env, settings, { emailHash: hash("buyer@example.com"), addedItemCodes: [] }, hash);
    expect(result.events.map((e) => e.type)).toEqual(["PAGE_VIEW"]);
    expect(result.identity?.customerId).toBe("77");
  });

  it("ignores malformed emails instead of fabricating an identity", () => {
    const env = envelope("page_viewed", {
      identity: { email: "not-an-email", firstName: null, lastName: null, customerId: null },
    });
    const result = mapPixelEvent(env, settings, anonymous, hash);
    expect(result.identity).toBeNull();
    expect(result.events.map((e) => e.type)).toEqual(["PAGE_VIEW"]);
  });

  it("only emits custom events when the merchant enabled them", () => {
    const search = envelope("search_submitted", { search: { query: "red tee" } });
    expect(mapPixelEvent(search, settings, anonymous, hash).events).toHaveLength(0);
    const enabled = mapPixelEvent(search, { ...settings, customEventsEnabled: true }, anonymous, hash);
    expect(enabled.events[0]).toMatchObject({ type: "CUSTOM", name: "SEARCH_SUBMITTED", data: { query: "red tee" } });
  });

  it("optionally maps checkout items without a cart add to ADDED_TO_ORDER before the order", () => {
    const env = envelope("checkout_completed", {
      checkout: { token: "t", orderId: "9", currency: "EUR", total: 24.04, items: [teeItem] },
    });
    const off = mapPixelEvent(env, settings, anonymous, hash);
    expect(off.events.map((e) => e.type)).toEqual(["ORDER_COMPLETED"]);
    const on = mapPixelEvent(env, { ...settings, checkoutAsAddToOrder: true }, anonymous, hash);
    expect(on.events.map((e) => e.type)).toEqual(["ADDED_TO_ORDER", "ORDER_COMPLETED"]);
    expect(on.events[0].data).toMatchObject({ origin: "checkout_line_item" });
    const alreadyAdded = mapPixelEvent(
      env,
      { ...settings, checkoutAsAddToOrder: true },
      { emailHash: null, addedItemCodes: ["TEE-RED-M"] },
      hash,
    );
    expect(alreadyAdded.events.map((e) => e.type)).toEqual(["ORDER_COMPLETED"]);
  });
});

describe("buildPayload", () => {
  it("produces the canonical Moosend envelope", () => {
    const [event] = mapPixelEvent(envelope("page_viewed"), settings, anonymous, hash).events;
    const payload = buildPayload({
      event,
      websiteId: "site-1",
      shopDomain: "alpha.myshopify.com",
      anonymousId: "client-1",
      email: null,
      name: null,
    });
    expect(payload).toMatchObject({
      schemaVersion: 1,
      websiteId: "site-1",
      event: "PAGE_VIEW",
      trackerMethod: "trackPageView",
      visitor: { anonymousId: "client-1", email: null },
      context: { source: "web_pixel", shopDomain: "alpha.myshopify.com" },
    });
  });
});
