# Setup, configuration and deployment

App folder: `moosend-website-tracking/`. Requires Node ≥ 22.12 (validated with Node 26.13.1, npm 12.2.2).

## 1. Environment variables (`.env.example`)

| Variable | Required | Purpose |
| - | - | - |
| `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`, `SHOPIFY_APP_URL`, `SCOPES` | yes (CLI injects in dev) | Shopify app credentials |
| `DATABASE_URL` | yes | `file:dev.sqlite` (dev) / PostgreSQL URL (prod) |
| `APP_ENCRYPTION_KEY` | yes | 32-byte base64 key for AES-256-GCM. **Rotating it makes stored keys/emails unreadable.** |
| `MOOSEND_TRACKING_ENDPOINT` | yes for delivery | **Placeholder** – Moosend endpoint (mock: `http://localhost:4010/track`). Empty → pixel stays idle, nothing collected |
| `MOOSEND_API_KEY_HEADER` | no (`X-Api-Key`) | **Placeholder** header name for the merchant API key |
| `MOOSEND_DELIVERY_TIMEOUT_MS` | no (10000) | HTTP timeout |
| `OUTBOX_MAX_ATTEMPTS` | no (8) | Retry limit |
| `ORDER_FALLBACK_DELAY_SECONDS` | no (300) | Wait for pixel before webhook purchase fallback |
| `WORKER_ENABLED`, `WORKER_INTERVAL_MS` | no (true, 15000) | Background delivery worker |
| `RETENTION_VISITOR_DAYS`, `RETENTION_EVENT_DAYS` | no (90, 30) | Retention policy |
| `SHOW_LOGIN_FORM` | no (false) | Dev-only manual login form. **Keep false in production** |
| `SUPPORT_EMAIL`, `LEGAL_COMPANY_NAME`, `LEGAL_COMPANY_ADDRESS`, `PRIVACY_POLICY_UPDATED` | yes for listing | Shown on `/privacy` and `/support` |
| `MOCK_MOOSEND_PORT`, `MOCK_MOOSEND_API_KEY`, `MOCK_MOOSEND_FAIL_MODE` | dev | Mock receiver (`none`/`always500`/`always429`/`unauthorized`/`random`) |

Note: Prisma Client auto-loads `.env`, so values in a local `.env` also apply to `npm start`.

## 2. Local development

```bash
cd moosend-website-tracking
npm install
cp .env.example .env     # set APP_ENCRYPTION_KEY, MOOSEND_TRACKING_ENDPOINT=http://localhost:4010/track
npx prisma migrate deploy
npm run mock:moosend     # terminal 1
npm run dev              # terminal 2 – Shopify CLI login, select/create app + dev store
```

1. In the Dev Dashboard, select a distribution method (Public) and, for development,
   select protected customer data (customer data, email, name) so PII fields are available on dev stores.
2. Install on the dev store via the CLI link. The pixel is created automatically (idle).
3. In the app: enter a Moosend website ID and any API key (mock accepts any key unless
   `MOCK_MOOSEND_API_KEY` is set), keep "Enable tracking" checked, Save.
4. Shopify admin → Settings → Customer events: the app pixel shows **Connected**.
5. Browse the storefront (accept the cookie banner), add to cart, check out with the
   Bogus gateway. Inspect `GET http://localhost:4010/events` and the app's Event activity page.
6. Webhooks: `shopify app webhook trigger --topic orders/create ...` (sample payloads won't correlate to a visitor — expected `no_consented_visitor`).

## 3. Validation

```bash
npm run validate     # typecheck + lint + tests + build
shopify app config validate
shopify app build
shopify app security check
```

## 4. Production deployment

1. Hosting: any Node 22+ host with HTTPS (Fly.io, Render, Railway, GCP Cloud Run, etc.). Use the included `Dockerfile`.
2. Database: PostgreSQL. Change `provider = "sqlite"` → `"postgresql"` in `prisma/schema.prisma`,
   delete `prisma/migrations`, run `npx prisma migrate dev --name init` against a Postgres dev DB,
   commit the new migrations. Use encrypted storage and encrypted backups (PCD L2).
3. Set all env vars from §1 (secrets in the platform's secret manager).
4. Edit `shopify.app.toml`: `application_url`, `[auth] redirect_urls` (`https://<host>/auth/callback`),
   `[network_access] allowed_sources = ["https://<host>"]`, `[build] automatically_update_urls_on_dev = false` for the production config
   (consider a separate `shopify.app.production.toml` via `shopify app config link`).
5. `npm run deploy` (`shopify app deploy`) – releases app config + web pixel extension.
6. Run `npm run setup` (prisma generate + migrate deploy) on start (`docker-start` does this).
7. Scaling: the worker is in-process and safe across instances (atomic claims). The collector
   rate limiter is per instance – add an edge/WAF rate limit for multi-instance deployments.
8. Performance note: the collector receives one request per storefront event for every
   tracking merchant; size accordingly and keep the DB indexed (schema has the indexes).

## 5. Merchant installation

1. Install from the Shopify App Store → approve permissions (Shopify managed install).
2. App opens automatically; pixel is connected in idle mode.
3. Enter Moosend website ID (Moosend → More → Websites) and API key → Save.
4. Optional: "Send test event". Check Settings → Customer events shows Connected.

## 6. Uninstall / reinstall behavior

- Uninstall → sessions deleted, shop marked uninstalled, queued events cancelled; Shopify removes the app pixel (INFERRED from platform behavior).
- Within 48 h reinstall → settings restored, same ingest key, pixel re-created.
- After `shop/redact` (48 h) → all data deleted; a reinstall starts fresh.

## 7. Windows Application Control workaround (this development machine)

This machine blocks unsigned native Node binaries (`rollup.win32-x64-msvc.node`, `esbuild.exe`, `unrs-resolver` binding). Applied fixes:
- `package.json` `overrides`: `esbuild` → `esbuild-wasm@0.28.2`, `rollup` → `@rollup/wasm-node@4.68.5` (same versions, WebAssembly builds). Remove both overrides on unrestricted machines/CI for faster builds.
- `scripts/run.mjs` + `scripts/crypto-warmup.cjs`: on Windows, preloads OpenSSL RNG initialization; esbuild-wasm otherwise fails with `ERR_OSSL_ENTROPY_SOURCE_STRENGTH_TOO_WEAK`. Used by `build`, `typecheck`, `test`, and `shopify.web.toml` dev command. No-op on other OSes.
- ESLint uses the Node import resolver; `import/no-unresolved` is off for TS (tsc verifies resolution).
- Shopify CLI's own bundled esbuild is still blocked → run `shopify app build/dev/deploy` from an unrestricted machine, or ask IT to allow the binaries.
- npm 12 blocks install scripts by default; `allowScripts` in `package.json` approves Prisma/esbuild/@parcel/watcher.
