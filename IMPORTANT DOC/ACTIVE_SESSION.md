# Active session

**Current task:** Build a public, App Store–ready Shopify app for Moosend website tracking.
**Status:** IN PROGRESS – implementation complete and validated locally; external prerequisites outstanding.
**Last updated:** 2026-11-17

## Completed (verified)
- Researched Shopify (web pixels, privacy, PCD, App Store requirements, network_access, webPixel GraphQL) and Moosend tracking docs.
- Created `moosend-website-tracking/` from the official React Router template (API 2026-10).
- Implemented: web pixel extension, collector, ingestion, mapping, encrypted outbox + worker, orders/create fallback with dedupe, compliance webhooks, retention, embedded admin UI (home/activity/help), public privacy/support pages, mock Moosend receiver.
- `npm run validate`: typecheck ✓, lint ✓, 83/83 tests ✓, build ✓.
- Production smoke test (built server + mock): collector → worker → mock delivery ✓; bad HMAC → 401 ✓; auth bounce ✓.

## Relevant files
`moosend-website-tracking/shopify.app.toml`, `extensions/moosend-web-pixel/*`, `app/services/**`, `app/routes/**`, `prisma/schema.prisma`, `tests/**`.

## Errors encountered / solutions
- Windows Application Control blocks native rollup/esbuild/unrs binaries → WASM overrides, crypto warm-up runner, Node import resolver (SETUP.md §7).
- esbuild-wasm `ERR_OSSL_ENTROPY_SOURCE_STRENGTH_TOO_WEAK` → preload `scripts/crypto-warmup.cjs` (verified fix).
- Mock receiver idempotency memory leaked across tests → added `reset()`.

## Blockers / unfinished
1. Real Moosend endpoint/auth/payload contract (placeholder).
2. Shopify Partner login required for `config link/validate`, `app build`, `security check`, deploy.
3. Protected customer data request; trademark authorization; hosting; legal texts; listing assets.

## Recommended next actions
1. Link the app and run CLI validations on an unrestricted machine.
2. Dev-store test: consent accept/decline, checkout-token correlation, order ID format (KNOWN_ISSUES #4).
3. Integrate the real Moosend endpoint in `client.server.ts`; rerun tests.
4. Work through APP_STORE_SUBMISSION.md checklist.
