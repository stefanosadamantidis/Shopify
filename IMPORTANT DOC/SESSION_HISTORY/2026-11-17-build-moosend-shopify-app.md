# 2026-11-17 – Build Moosend public Shopify app

- OpenCode session ID: not available to the agent.
- Related previous session: none (fresh project; no prior IMPORTANT DOC existed).

## Objective
Build from scratch a production-ready, multi-tenant, public Shopify App Store app that sends
Moosend website-tracking events via Shopify-compliant mechanisms, with tests and submission materials.

## Work performed
- Research: shopify.dev (build-web-pixels, web-pixels-api, pixel-privacy, standard events, checkout_completed, protected-customer-data, privacy-requirements, privacy-law-compliance, app-store-requirements, app-configuration, declare-network-access, webPixel/webPixelUpdate); Moosend KB 54430/54482 (via search snippets) and website-tracking-js repo.
- Downloaded official template `Shopify/shopify-app-template-react-router` (2026.10.09) and extension template `web-pixel-extension`.
- Implemented app (see ARCHITECTURE.md) and 9 test files (83 tests).
- Ran typecheck, lint, tests, build, production smoke test; attempted Shopify CLI 5.0.1 validations.

## Technical discoveries (VERIFIED)
- `customer_privacy` uses booleans + `sale_of_data` enum; pixel settings only `single_line_text_field`.
- Pixel PII fields require protected customer data approval.
- `[network_access] allowed_sources` must declare the server the pixel calls.
- React Router CSRF origin check skips resource routes.
- `authenticate.admin` returns 410 for bot user agents (incl. Node fetch) – not an error.
- Prisma Client auto-loads `.env`.
- esbuild-wasm needs OpenSSL RNG warm-up on this machine.

## Problems
- Native binaries blocked by Application Control (worked around; CLI bundling still blocked).
- `shopify app config validate` / `security check` need Partner auth (not run).

## Decisions
See ARCHITECTURE.md §4 (backend relay, idle pixel until configured, outbox, webhook fallback only for consented visitors, checkout-as-add-to-order opt-in, template version set).

## Verification
typecheck PASS · lint PASS · 83/83 tests PASS · build PASS · smoke test PASS (2026-11-17).

## Status: IN PROGRESS
## Remaining work / next steps
See ACTIVE_SESSION.md and APP_STORE_SUBMISSION.md §6–7.
