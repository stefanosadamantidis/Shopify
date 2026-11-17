# Shopify → Moosend event mapping

Sources:
- Moosend: "Install website tracking" (docs.moosend.com KB 54430, updated 2025-09-11),
  "Tracking the actions of a website visitor" (KB 54482), `moosend/website-tracking-js`
  instructions.md. Content retrieved via web search snippets (direct fetch of
  docs.moosend.com failed with a transport error) – VERIFIED against snippet text.
- Shopify: Web Pixels API standard events (`shopify.dev/docs/api/web-pixels-api/standard-events`)
  and `@shopify/web-pixels-extension@2.18` type definitions – VERIFIED.

Implementation: `app/services/moosend/mapping.ts` (pure, unit-tested in `tests/mapping.test.ts`).

## 1. Moosend documented vocabulary

| Moosend call (JS) | Event name | Required data |
| - | - | - |
| `mootrack('identify', email[, name[, props]])` | IDENTIFY | email |
| `mootrack('trackPageView')` | PAGE_VIEW | url |
| `mootrack('PAGE_VIEWED', [{product}])` | product view | product object |
| `mootrack('trackAddToOrder', itemCode, itemPrice, itemUrl, itemQuantity, itemTotalPrice, itemName, itemImage[, props])` | ADDED_TO_ORDER | all listed are mandatory per KB 54430 |
| `mootrack('trackOrderCompleted', products[])` | ORDER_COMPLETED | product objects |
| `mootrack('<NAME>', {props})` | custom | free-form |

Documented rules: Identify must be triggered before other events (KB 54482);
ORDER_COMPLETED requires a prior ADDED_TO_ORDER for the same product (KB 54430).

## 2. Mapping table

| Shopify customer event | Moosend event | Notes |
| - | - | - |
| `page_viewed` | PAGE_VIEW (`trackPageView`) | URL without query/fragment |
| `product_viewed` | `PAGE_VIEWED` with `{products:[{product}]}` | quantity 1 |
| `product_added_to_cart` | ADDED_TO_ORDER (`trackAddToOrder`) | qty + line total from cart line |
| `checkout_completed` | IDENTIFY (if email new) → ORDER_COMPLETED | primary purchase source |
| `checkout_contact_info_submitted` | IDENTIFY (if email available) | also refreshes checkout snapshot |
| `checkout_started` | (snapshot only) / optional ADDED_TO_ORDER / optional CHECKOUT_STARTED | see options |
| logged-in customer (`init.data.customer`) | IDENTIFY with first event of the page | once per email |
| `orders/create` webhook | IDENTIFY (if needed) → ORDER_COMPLETED | delayed fallback, see §5 |
| `product_removed_from_cart` | custom `REMOVED_FROM_ORDER` | only if "custom events" on |
| `cart_viewed` | custom `CART_VIEWED` | only if "custom events" on |
| `collection_viewed` | custom `COLLECTION_VIEWED` | only if "custom events" on |
| `search_submitted` | custom `SEARCH_SUBMITTED` | only if "custom events" on |

Not used: `checkout_address_info_submitted`, `checkout_shipping_info_submitted`,
`payment_info_submitted`, DOM/advanced DOM events (not needed → data minimization;
advanced DOM also needs a restricted scope).

## 3. Product object

| Moosend field | Source (pixel) | Source (webhook) |
| - | - | - |
| itemCode | per setting: SKU→variant ID (default) / variant ID / product ID | same rule on line item |
| itemName | product title | line item title |
| itemImage | variant image (`//` → `https:`) | checkout snapshot image or "" |
| itemPrice | variant price amount | line item price |
| itemUrl | storefront origin + product.url, query stripped | checkout snapshot URL or "" |
| itemQuantity | cart/checkout line quantity | line item quantity |
| itemTotalPrice | cart line cost / `finalLinePrice` (after line discounts) | price×qty − total_discount |
| itemCategory | product type | snapshot product type |
| itemManufacturer | vendor | vendor |
| currency, variantTitle | extra props (allowed by Moosend) | extra props |

ORDER_COMPLETED data: `{ products, orderId, orderTotal, currency }`.

## 4. Canonical payload sent to the destination

```json
{
  "schemaVersion": 1,
  "eventId": "order:5550001:completed",
  "websiteId": "<merchant Moosend website ID>",
  "event": "ORDER_COMPLETED",
  "trackerMethod": "trackOrderCompleted",
  "occurredAt": "2026-11-17T12:00:00.000Z",
  "visitor": { "anonymousId": "<Shopify pixel clientId>", "email": "buyer@example.com", "name": "Jane Doe" },
  "context": { "source": "web_pixel", "shopDomain": "x.myshopify.com", "url": "...", "referrer": null, "pageTitle": "..." },
  "data": { "products": [ ... ], "orderId": "5550001", "orderTotal": 30.5, "currency": "EUR" }
}
```
Headers: `<MOOSEND_API_KEY_HEADER>: <merchant API key>`, `Idempotency-Key: <eventId>`.
**This envelope is the app's own contract (UNKNOWN whether Moosend accepts it).**
Adapt `serializePayload()` / `deliverToMoosend()` in `client.server.ts` once Moosend
supplies the endpoint specification.

## 5. Identity, ordering, duplicates

- **Anonymous visitors**: `anonymousId` = Shopify pixel `clientId`; no fabricated identity.
- **Identification**: only from real emails (logged-in customer, checkout email,
  order email). Emails/names are present only after Shopify approves protected
  customer data (email/name). Malformed emails are ignored.
- **IDENTIFY first**: placed before the triggering event in the same transaction;
  sent only when the visitor's email hash changes.
- **Guest checkout**: identified by checkout email (if approved) — no account needed.
- **Duplicates**: Shopify event `id` ledger; order PK; deterministic event IDs;
  `Idempotency-Key` header.
- **Ordering**: outbox `createdAt` strictly increasing per batch; per-visitor blocking
  during retries.

## 6. Limitations (documented, not worked around)

1. **Buy it now / express checkout** skip the cart → no `product_added_to_cart`, so
   Moosend may not attribute the order. Optional merchant setting
   "Treat items that go straight to checkout as added to cart" maps real checkout line
   items to ADDED_TO_ORDER (tagged `origin: checkout_line_item`); **off by default**.
2. **Visitors without consent** are never tracked; their purchases are not reported
   (the webhook fallback requires a consented visitor correlation).
3. **Thank-you page not loaded** → pixel `checkout_completed` missing → webhook
   fallback after 300 s (only for correlated visitors).
4. **PII depends on Shopify approval** (protected customer data level 2 for email/name).
5. **Checkout token correlation** between pixel `checkout.token` and webhook
   `checkout_token` is INFERRED from field naming; verify on a dev store.
6. **`checkout.order.id` format** (numeric vs GID) is normalized via `numericId()`; INFERRED.
7. IP address and user agent are not forwarded (Moosend's PHP tracker accepts them;
   omitted for data minimization). Moosend's own cookie-based visitor ID is not available
   in the sandbox; the Shopify `clientId` is used instead.
