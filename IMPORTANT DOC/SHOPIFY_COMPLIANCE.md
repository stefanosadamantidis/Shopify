# Shopify compliance verification

Research date: 2026-11-17. Admin API version in use: **2026-10** (latest stable).
Each row: requirement → official source → how the app meets it → status.

## 1. App Store requirements (shopify.dev/docs/apps/launch/shopify-app-store/app-store-requirements)

| # | Requirement | Implementation | Status |
| - | - | - | - |
| 1.1.1 | Session tokens; works without 3rd-party cookies | Template's token-exchange auth (`authenticate.admin`), App Bridge | VERIFIED (code + smoke test: embedded load bounces to `/auth/session-token`) |
| 1.1.2 | Use Shopify checkout | No checkout modification at all | VERIFIED |
| 1.1.4 | Factual information only | No fabricated events/identities; listing text has no stats | VERIFIED |
| 1.2 | Billing via Shopify | App is free (no charges). If paid plans are added, use Managed Pricing/Billing API | N/A – decision needed (APP_STORE_SUBMISSION.md) |
| 2.1.x | No errors, has UI | Embedded UI with status, troubleshooting; ErrorBoundary via `boundary.error` | VERIFIED locally; needs reviewer-store test |
| 2.2.1 | Uses Shopify APIs | GraphQL Admin `webPixel*`, webhooks | VERIFIED |
| 2.2.3 | Latest App Bridge | `AppProvider` loads `cdn.shopify.com/shopifycloud/app-bridge.js` | VERIFIED |
| 2.2.4 | GraphQL Admin API only | No REST calls (webhook payloads are JSON events, not REST API usage) | VERIFIED |
| 2.3.1 | No manual myshopify domain entry | Landing/login form hidden unless `SHOW_LOGIN_FORM=true` (dev) – test `config.test.ts` | VERIFIED |
| 2.3.2–2.3.4 | OAuth immediately after (re)install, redirect to UI | Shopify managed install + token exchange; `afterAuth` hook; UI never rendered unauthenticated (tests + smoke) | VERIFIED (locally); end-to-end install needs dev store |
| 3.1.1 | Valid TLS | Hosting requirement | PENDING (deployment) |
| 3.1.2 | Expiring offline tokens | `future.expiringOfflineAccessTokens: true`, refresh fields in `Session` | VERIFIED (config) |
| 3.2 | Minimal scopes | `read_customer_events`, `write_pixels` (required for pixels per docs), `read_orders` (orders/create fallback). No `read_all_orders`, no advanced DOM scope | VERIFIED; be ready to justify `read_orders` |
| 4.x | Listing quality | Draft content in APP_STORE_SUBMISSION.md | PENDING (manual) |
| 4.5.3/4.5.4 | Screencast + test credentials | Procedure in APP_STORE_SUBMISSION.md | PENDING (manual) |
| 4.5.6 | Emergency developer contact | Partner Dashboard setting | PENDING (manual) |
| 5.1.5 | Return collected data to merchant | Data goes to merchant's own Moosend account; Event activity page; data request reports | INFERRED compliant |

## 2. Web pixels (shopify.dev/docs/apps/build/marketing-analytics/build-web-pixels, web-pixels-api)

| Requirement | Implementation | Status |
| - | - | - |
| `runtime_context = "strict"` | `extensions/moosend-web-pixel/shopify.extension.toml` | VERIFIED |
| Settings only `single_line_text_field` | 4 fields, all single-line text | VERIFIED |
| Activate via `webPixelCreate` / `webPixelUpdate` | `webpixel.server.ts`; settings JSON matches TOML keys (tests) | VERIFIED (mocked Admin API); live call PENDING |
| Scopes `write_pixels`, `read_customer_events` | `shopify.app.toml` | VERIFIED |
| `customer_privacy` declared (all four) | analytics=true, marketing=true, preferences=false, sale_of_data="enabled" | VERIFIED |
| Use only sandbox APIs, no DOM | `tracker.ts` uses analytics/browser/init/settings/customerPrivacy + fetch; bundle has 0 DOM references | VERIFIED |
| Respond to consent changes | `customerPrivacy.subscribe('visitorConsentCollected')` | VERIFIED (tests) |
| Lightweight / no checkout slowdown | ~4 KB minified, async keepalive fetch, no awaits in handlers | VERIFIED |
| Declare network access | `[network_access] allowed_sources = ["https://<app domain>"]` | Configured with placeholder – replace before deploy |

## 3. Privacy & protected customer data

| Requirement (source) | Implementation | Status |
| - | - | - |
| Mandatory compliance webhooks, 401 on bad HMAC (`/docs/apps/build/compliance/privacy-law-compliance`) | 3 routes; `authenticate.webhook` throws 401; tests with real HMAC | VERIFIED (tests + smoke) |
| customers/data_request | Encrypted report viewable in Help & privacy | VERIFIED |
| customers/redact | Deletes visitors (by customer id/email hash), outbox, snapshots, orders | VERIFIED |
| shop/redact | Deletes Shop (cascade) and sessions | VERIFIED |
| PCD Level 1: minimum data | Pixel sends minimal normalized fields; no address/phone/payment/IP; `include_fields` on orders webhook | VERIFIED |
| PCD L1: consent | Pixel consent gating + server check; webhook fallback only for consented visitors | VERIFIED |
| PCD L1: retention | Delivered/failed events 30 d, visitors/orders 90 d, idempotency/snapshots 7 d, shop data on shop/redact | VERIFIED (tests) |
| PCD L1: encryption at rest/in transit | AES-256-GCM fields; TLS required for hosting; DB-level encryption recommended | Partially VERIFIED (hosting PENDING) |
| PCD L1: privacy policy / DPA | `/privacy` page template (placeholders) | PENDING legal review |
| PCD L2 (email/name) | Request in Dev Dashboard; L2 operational controls (backups encrypted, staff access, access logs, incident response) are organizational | PENDING (operator) |
| Request PCD access | Dev Dashboard → Access requests (needs distribution method selected) | PENDING (external) |

Without PCD approval: email/name fields are redacted/null → visitors stay anonymous;
orders webhooks for public apps require protected customer data access (INFERRED from
the PCD docs listing webhooks for orders as protected).

## 4. Security

- Moosend API key and Admin tokens never reach the browser (`toShopView` masks the key; pixel settings contain only `collectorUrl`, a public `ingestKey`, and flags). VERIFIED.
- Collector: schema validation, 64 KB limit, per-IP and per-key rate limits, identical response for unknown keys, no credentials accepted. VERIFIED (tests).
- Webhooks HMAC-verified by the official library. VERIFIED.
- No merchant-controlled outbound URLs (no SSRF). VERIFIED.
- Logs avoid PII (logger guidance; only shop domain/event type/status logged). VERIFIED by review.

## 5. Tools run

| Tool | Result |
| - | - |
| `npm run typecheck` | PASS |
| `npm run lint` | PASS |
| `npm test` (Vitest, 83 tests) | PASS |
| `npm run build` | PASS |
| Production smoke test (built server + mock Moosend) | PASS – events delivered, 401 on bad HMAC, auth bounce correct |
| `shopify app build` (CLI 5.0.1) | Config/extension TOML parsed; bundling blocked by Windows Application Control (native esbuild) – re-run on an unrestricted machine |
| `shopify app config validate` | Requires linked app (client_id) – PENDING |
| `shopify app security check` | Requires Partner login – PENDING (run before submission) |

## 6. Final audit – unresolved items before submission

1. Link app (`shopify app config link`), set production URLs in `shopify.app.toml` (app URL, redirect URL, `network_access`).
2. Run `shopify app config validate`, `shopify app build`, `shopify app security check` and fix findings.
3. Obtain the real Moosend endpoint/auth contract and validate delivery end to end.
4. Request protected customer data (customer data + email + name) with justification.
5. Complete privacy policy placeholders and legal review; set `SUPPORT_EMAIL`, `LEGAL_*` env vars.
6. Brand permission: "Moosend" is a trademark – the publisher must be Moosend/Sitecore or authorized (requirement 4.1.2/4.4.3).
7. Test on a dev store with a cookie banner: consent accept/decline, checkout token correlation, order ID format.
8. Production DB: PostgreSQL with encrypted storage/backups.
