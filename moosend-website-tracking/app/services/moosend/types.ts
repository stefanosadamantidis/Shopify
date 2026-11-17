/**
 * Moosend event vocabulary, derived from Moosend's official website tracking
 * documentation (JS library `mootrack` / PHP tracker):
 *   identify            -> IDENTIFY
 *   trackPageView       -> PAGE_VIEW
 *   'PAGE_VIEWED' + product info (product view snippet)
 *   trackAddToOrder     -> ADDED_TO_ORDER
 *   trackOrderCompleted -> ORDER_COMPLETED
 *   custom events       -> mootrack('<EVENT_NAME>', {props})
 *
 * The HTTP wire contract of Moosend's tracking endpoint is NOT publicly
 * documented. `MoosendEventPayload` is this app's canonical JSON envelope and
 * is serialised in a single place (client.server.ts) so it can be adapted once
 * Moosend supplies the production endpoint contract.
 */

export type MoosendEventType =
  | "IDENTIFY"
  | "PAGE_VIEW"
  | "PRODUCT_VIEW"
  | "ADDED_TO_ORDER"
  | "ORDER_COMPLETED"
  | "CUSTOM";

export interface MoosendProduct {
  itemCode: string;
  itemName: string;
  itemImage: string;
  itemPrice: number;
  itemUrl: string;
  itemQuantity: number;
  itemTotalPrice: number;
  itemCategory?: string;
  itemManufacturer?: string;
  itemSupplier?: string;
  /** Extra props (allowed by Moosend as additional product properties). */
  currency?: string;
  variantTitle?: string;
}

export type EventSource = "web_pixel" | "orders_webhook" | "admin_test";

export interface OutboundEvent {
  type: MoosendEventType;
  /** Moosend event name, e.g. PAGE_VIEW, ADDED_TO_ORDER or a custom name. */
  name: string;
  /** Documented mootrack method / call this event corresponds to. */
  trackerMethod: string;
  /** Deterministic ID used for idempotent delivery. */
  eventId: string;
  occurredAt: string;
  data: Record<string, unknown>;
  page?: { url: string | null; referrer: string | null; title: string | null };
  source: EventSource;
}

export interface MoosendEventPayload {
  schemaVersion: 1;
  eventId: string;
  websiteId: string;
  event: string;
  trackerMethod: string;
  occurredAt: string;
  visitor: {
    /** Shopify web pixel clientId (anonymous, first-party). */
    anonymousId: string;
    email: string | null;
    name: string | null;
  };
  context: {
    source: EventSource;
    shopDomain: string;
    url: string | null;
    referrer: string | null;
    pageTitle: string | null;
  };
  data: Record<string, unknown>;
}

export type ItemCodeSource = "SKU_OR_VARIANT_ID" | "VARIANT_ID" | "PRODUCT_ID";

export const ITEM_CODE_SOURCES: ItemCodeSource[] = [
  "SKU_OR_VARIANT_ID",
  "VARIANT_ID",
  "PRODUCT_ID",
];
