# Architecture

Project: `moosend-website-tracking/` (solution root: `C:\Users\stefa\source\repos\Shopify`).
The pre-existing `Shopify/` ASP.NET "Hello World" project in the solution is unrelated
and untouched.

Status legend: **VERIFIED** (code/tests/runtime/docs), **INFERRED**, **UNKNOWN**.

## 1. High-level flow

```
 Storefront / checkout (buyer's browser)
 ┌──────────────────────────────────────────────┐
 │ Shopify Web Pixels Manager (strict sandbox)  │
 │  └─ Moosend web pixel extension (~4 KB)      │  loads only with analytics +
 │      subscribes to standard customer events  │  marketing consent, no sale-of-
 │      normalizes minimal fields               │  data opt-out
 └──────────────┬───────────────────────────────┘
                │ fetch POST text/plain, keepalive (fallback browser.sendBeacon)
                ▼
 App backend (React Router, Node)            Shopify Admin
 ┌───────────────────────────────────────┐   ┌─────────────────────────────┐
 │ /api/pixel/events  (resource route)   │   │ OAuth / token exchange       │
 │   validate (zod) → rate limit →       │◄──┤ (managed install)            │
 │   shop lookup by ingestKey →          │   │ webhooks: orders/create,     │
 │   consent check → dedupe → map →      │   │ app/uninstalled, compliance  │
 │   encrypted outbox (Prisma)           │   └─────────────────────────────┘
 │ /webhooks/orders/create → fallback    │
 │ background worker → deliver w/ retry  │
 │ embedded admin UI (Polaris + AppBridge)│
 └──────────────┬────────────────────────┘
                │ POST JSON + API key header (server-side only)
                ▼
     Moosend tracking endpoint (configurable; mock in dev/tests)
```

## 2. Components (VERIFIED in code)

| Area | File(s) | Responsibility |
| - | - | - |
| App config | `shopify.app.toml` | Scopes, webhooks, compliance topics, `network_access`, embedded |
| Auth | `app/shopify.server.ts` | `shopifyApp` (AppStore distribution, API 2026-10, expiring offline tokens, `afterAuth` hook) |
| Install hook | `app/services/install.server.ts` | Provision `Shop` tenant + create/update web pixel |
| Tenant | `app/services/shop.server.ts` | Settings validation, encrypted API key, uninstall/reinstall, browser-safe view |
| Web pixel admin | `app/services/webpixel.server.ts` | `webPixel` query, `webPixelCreate`/`webPixelUpdate`, drift detection |
| Pixel extension | `extensions/moosend-web-pixel/` | Strict-sandbox pixel; `tracker.ts` holds the logic |
| Collector | `app/routes/api.pixel.events.tsx` → `app/services/pixel/collector.server.ts` | CORS, size/rate limits, JSON parsing |
| Ingestion | `app/services/pixel/ingest.server.ts`, `schema.ts` | Wire schema, consent defense-in-depth, dedupe, visitor state, order claim |
| Mapping | `app/services/moosend/mapping.ts`, `types.ts` | Pure Shopify → Moosend mapping |
| Delivery | `app/services/moosend/client.server.ts` | Single serialization point for the Moosend wire contract |
| Outbox | `app/services/outbox.server.ts` | Claiming, retries/backoff, per-visitor ordering, webhook-fallback gating |
| Worker | `app/services/worker.server.ts` (started from `app/entry.server.tsx`) | Interval delivery + hourly retention purge |
| Orders webhook | `app/services/orders.server.ts`, `app/routes/webhooks.orders.create.tsx` | Purchase reconciliation |
| Privacy | `app/services/privacy.server.ts`, `app/routes/webhooks.customers.*`, `webhooks.shop.redact.tsx` | GDPR compliance webhooks |
| Retention | `app/services/retention.server.ts` | Purges per policy |
| Admin UI | `app/routes/app.tsx`, `app._index.tsx`, `app.activity.tsx`, `app.help.tsx` | Setup, status, troubleshooting, privacy requests |
| Public pages | `app/routes/_index`, `privacy.tsx`, `support.tsx`, `auth.login` | Landing, privacy policy, support |
| Mock Moosend | `app/services/moosend/mock-server.ts`, `scripts/mock-moosend-server.ts` | Dev/test receiver with failure simulation |

## 3. Data model (Prisma, `prisma/schema.prisma`)

- `Session` – Shopify session storage (template; includes refresh-token fields).
- `Shop` – tenant root. `ingestKey` (public routing key), Moosend website ID,
  `moosendApiKeyEnc` (AES-256-GCM), options, pixel status/settings snapshot,
  delivery health. All other tables cascade-delete from `Shop`.
- `Visitor` – keyed by (shop, Shopify pixel `clientId`); encrypted email/name,
  keyed HMAC `emailHash` for lookups, item codes already sent as ADDED_TO_ORDER.
- `ProcessedEvent` – (shop, Shopify event id) idempotency ledger.
- `CheckoutSnapshot` – checkout token → visitor + item URLs/images (webhook correlation).
- `OrderTracking` – (shop, orderId) purchase dedupe state machine.
- `OutboxEvent` – encrypted Moosend payloads with delivery state.
- `ComplianceRequest` – log/report of compliance webhooks.

## 4. Key decisions (with rationale)

1. **Official template, not custom scaffolding** – Shopify React Router template
   (2026.10.09), pinned React Router 7.18.2 as the template does (7.18.3 broke actions
   behind proxies – template CHANGELOG). VERIFIED.
2. **Web pixel extension, strict sandbox, no script injection** – the only
   Shopify-supported way for apps to collect behavioral data that respects consent
   (`shopify.dev/docs/apps/launch/privacy-requirements`). Moosend's `mootrack` JS can't be
   loaded (no DOM in strict sandbox), so events are forwarded to the app backend.
3. **Backend relay instead of direct browser → Moosend** – keeps the merchant's API
   key server-side, allows dedupe/retry/correlation, and isolates the not-yet-known
   Moosend wire contract in one module.
4. **Pixel stays idle until configured** – created automatically after install with
   `enabled:"false"`; switched on only when the Moosend config is saved and the
   app-level endpoint exists (data minimization: no data collected without purpose).
5. **Consent** – `customer_privacy`: analytics=true, marketing=true, preferences=false,
   sale_of_data="enabled". Shopify won't load the pixel without consent; the pixel also
   reacts to `visitorConsentCollected`, and the server rejects events whose consent
   snapshot isn't fully granted (defense in depth).
6. **Collector is a resource route** – React Router's action CSRF origin check
   (`throwIfPotentialCSRFAttack`) only runs for document/single-fetch requests, not
   `handleResourceRequest` (VERIFIED in `node_modules/react-router/dist/development/index.js`).
   The pixel posts `text/plain` → CORS simple request (no preflight).
7. **Transactional outbox** – events persisted first, delivered asynchronously. Rows
   are claimed with conditional updates (safe with multiple instances). Exponential
   backoff 30s·2^(n-1) capped at 1h, max 8 attempts. 4xx except 408/425/429 are permanent.
8. **Per-visitor ordering** – a visitor's later events wait while an earlier one is
   being retried, so ADDED_TO_ORDER reaches Moosend before ORDER_COMPLETED.
9. **Purchase dedupe** – pixel `checkout_completed` is primary. `orders/create` webhook
   is a delayed fallback (default 300s) used only if the order can be correlated
   (checkout token) to a visitor tracked with consent. `OrderTracking` PK
   (shop, orderId) + conditional state transitions guarantee one ORDER_COMPLETED.
   Deterministic `eventId` `order:<id>:completed` is also sent as `Idempotency-Key`.
10. **Encryption at rest** – API keys, emails, names, outbox payloads and compliance
    reports with AES-256-GCM (`APP_ENCRYPTION_KEY`); emails looked up via keyed HMAC.
11. **No SSRF surface** – the Moosend endpoint is app-level env config, never merchant input.
12. **Pixel settings drift detection** – `pixelSettingsJson` snapshot; the dashboard
    re-syncs when the app URL/settings change.
13. **Windows Application Control workaround** (dev machine only) – see SETUP.md §7.
