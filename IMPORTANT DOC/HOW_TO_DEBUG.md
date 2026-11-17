# How to run and debug the app

Project folder: `C:\Users\stefa\source\repos\Shopify\moosend-website-tracking`
All commands are PowerShell, run from that folder unless stated otherwise.
Verified on this machine on 2026-11-17 (Mode A fully; Mode B steps follow Shopify docs and must be run with a Partner login).

---

## 0. One-time setup (both modes)

- **Install prerequisites**
  - Node.js 22.12 or newer (`node --version`).
  - Git (optional).
  - Chrome or Edge (for browser DevTools).
  - **Shopify CLI** (Mode B only — `npm run dev` calls `shopify app dev`):
    - `npm install -g @shopify/cli@latest`
    - Close and reopen PowerShell, then check `shopify version`.
    - If you get `'shopify' is not recognized`, the CLI isn't installed (or the terminal wasn't reopened).
    - No global install possible? Use `npx @shopify/cli@latest app dev` instead of `npm run dev`.
- **Install dependencies**
  - `npm install`
  - If npm reports blocked install scripts, they're already approved in `package.json` → `allowScripts`. Re-run `npm install`.
- **Create your local `.env`**
  - `copy .env.example .env` (skip if `.env` already exists — it does on this machine).
  - Generate an encryption key: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
  - Put it in `.env` as `APP_ENCRYPTION_KEY=...`.
  - Set `MOOSEND_TRACKING_ENDPOINT=http://localhost:4010/track` (the mock receiver).
  - For Mode A also add:
    - `SHOPIFY_API_KEY=local-no-partner`
    - `SHOPIFY_API_SECRET=local-no-partner`
    - `SHOPIFY_APP_URL=http://localhost:3000`
    - `PORT=3000`
    - `WORKER_INTERVAL_MS=3000` (faster retries while debugging)
  - Optional: `SHOW_LOGIN_FORM=true` (shows the dev-only shop login form on `/`).
  - Never commit `.env`. It's in `.gitignore`.
- **Create the local database**
  - `npx prisma migrate deploy`
  - This creates `prisma/dev.sqlite`.
- **Sanity check**
  - `npm run validate` → typecheck, lint, 83 tests and production build must all pass.

---

## Mode A — without a Partner account

What works here:
- The server, public pages, the pixel event collector, mapping, delivery queue, retries and the mock Moosend.
- The app's database contents and logs.

What doesn't:
- The admin screens (`/app/...`) need the Shopify admin, which needs Mode B.
- The real web pixel needs a Shopify storefront, which needs Mode B.

### A1. Run the automated tests

- All tests: `npm test`
- One file: `node scripts/run.mjs vitest run tests/ingest.test.ts`
- One test by name: `node scripts/run.mjs vitest run -t "deduplicates repeated Shopify event IDs"`
- Watch mode (re-runs on save): `npm run test:watch`
- Test files and what they cover:
  - `tests/mapping.test.ts` — Shopify → Moosend mapping.
  - `tests/web-pixel.test.ts` — pixel extension logic, consent, URL cleanup.
  - `tests/ingest.test.ts` — collector, dedupe, store isolation, identify ordering.
  - `tests/delivery.test.ts` — delivery, retries, ordering, purchase dedupe with the webhook.
  - `tests/lifecycle.test.ts` — install/auth, settings, uninstall, compliance webhooks.
  - `tests/retention.test.ts`, `tests/config.test.ts`, `tests/crypto.test.ts`, `tests/mock-server.test.ts`.
- Tests use their own database (`prisma/test.sqlite`, rebuilt each run) and start their own mock receiver. Your dev data is never touched.

### A2. Run the full pipeline locally (simulated storefront)

- **Terminal 1** — start the mock Moosend receiver:
  - `npm run mock:moosend`
  - Listens on `http://localhost:4010/track` and prints every event it receives.
- **Terminal 2** — build and start the app:
  - `npm run build`
  - `npm run seed:local` — creates the fake store `local-test.myshopify.com` with tracking enabled and ingest key `local-dev-ingest-key-000000`. Re-running resets it.
  - `npm run start:local` — production server on `http://localhost:3000` with `.env` loaded.
- **Terminal 3** — simulate a shopper:
  - `npm run events:local`
  - Sends page view → product view → add to cart → checkout started → checkout completed (with email).
  - Expected output: 5 × `HTTP 202`, then the mock lists `PAGE_VIEW`, `PAGE_VIEWED`, `ADDED_TO_ORDER`, `CHECKOUT_STARTED`, `IDENTIFY`, `ORDER_COMPLETED`.
- **Browser checks**
  - `http://localhost:3000/` — landing page.
  - `http://localhost:3000/privacy` and `/support` — public pages.
  - `http://localhost:4010/events` — full JSON exactly as it would go to Moosend (API key shown as `[redacted]`).
  - `http://localhost:3000/app` — shows a blank "bounce" page. **This is expected without Shopify.**
- **Reset the mock's memory**
  - `Invoke-RestMethod -Method Delete http://localhost:4010/events`

### A3. Simulate Moosend failures

- Stop the mock (`Ctrl+C`) and restart it with a fail mode:
  - `$env:MOCK_MOOSEND_FAIL_MODE="always500"; npm run mock:moosend` — retried with backoff (30 s, 60 s, 120 s, …).
  - `always429` — rate-limited, retried.
  - `unauthorized` — permanent failure (`FAILED`), not retried.
  - `random` — 50 % failures.
  - Require a specific API key: `$env:MOCK_MOOSEND_API_KEY="local-test-api-key"` (must match the key used by `seed:local`).
- Clear the fail mode afterwards: `Remove-Item Env:MOCK_MOOSEND_FAIL_MODE`.
- Watch event states change in the database (see A5).
- Failed events can be requeued from the app's admin home page ("Retry failed events", Mode B), or directly in Prisma Studio by setting `status` back to `PENDING`.

### A4. Debug the server with breakpoints

- Build first: `npm run build`.
- Start in debug mode: `npm run start:debug`
  - Prints `Debugger listening on ws://127.0.0.1:9229/...`.
- **Attach with Chrome/Edge**
  - Open `chrome://inspect` (or `edge://inspect`) → "Open dedicated DevTools for Node".
  - Sources tab → `build/server/index.js` (the built bundle; readable but not your `.ts` files).
- **Attach with VS Code**
  - Run and Debug → "Attach to Node Process" → pick the process on port 9229.
- **Attach with Visual Studio**
  - Debug → Attach to Process → Connection type "JavaScript and TypeScript (Chrome DevTools/V8 Inspector)" → target `ws://127.0.0.1:9229`.
- **Useful breakpoint locations** (search for these function names in the bundle):
  - `handleCollectorRequest` — every incoming pixel request.
  - `ingestPixelBatch` / `ingestEvent` — validation, consent, dedupe, mapping.
  - `mapPixelEvent` — Shopify → Moosend mapping.
  - `processOutbox` — delivery loop.
  - `deliverToMoosend` — the actual HTTP call to Moosend.
  - `handleOrderCreated` — order webhook fallback.
- Then trigger traffic with `npm run events:local`.
- Tip: breakpoints in TypeScript source are easiest in tests (A6), because the tests run the `.ts` files directly.

### A5. Inspect the database

- `npx prisma studio` → opens `http://localhost:5555`.
- Tables to look at:
  - `Shop` — settings, pixel status, `lastDeliveryError`.
  - `OutboxEvent` — every Moosend event: `status` (PENDING/SENDING/DELIVERED/FAILED/CANCELLED), `attempts`, `lastError`, `availableAt`. `payloadEnc` is encrypted on purpose.
  - `Visitor` — one row per shopper (email/name encrypted).
  - `OrderTracking` — purchase dedupe state (`SENT_PIXEL`, `PENDING_FALLBACK`, `SENT_WEBHOOK`, `SKIPPED_NO_VISITOR`).
  - `ProcessedEvent` — event IDs already received (duplicate protection).
- To see a decrypted payload, use the mock receiver output (`http://localhost:4010/events`) instead.
- Reset everything: stop the app, delete `prisma\dev.sqlite`, run `npx prisma migrate deploy`, then `npm run seed:local`.

### A6. Debug tests with breakpoints (TypeScript source)

- **VS Code**
  - Open a JavaScript Debug Terminal (Command Palette → "JavaScript Debug Terminal").
  - Run `node scripts/run.mjs vitest run tests/ingest.test.ts`.
  - Breakpoints in `app/**/*.ts` and `tests/**/*.ts` are hit directly.
- **Any inspector**
  - `node scripts/run.mjs vitest run tests/ingest.test.ts --inspect-brk --no-file-parallelism`
  - Attach via `chrome://inspect`, then press Resume.
- Quick print debugging: add `console.log(...)`. The app logger stays quiet in tests except for errors.

### A7. Read the logs

- The server logs every request and worker activity in the terminal, e.g.:
  - `POST /api/pixel/events 202` — event accepted.
  - `INFO Background delivery worker started`.
  - `WARN Moosend delivery failed permanently {...}` — check `status` and `error`.
- The mock logs one line per received event.
- Logs never contain emails or API keys (by design).

---

## Mode B — with a free Partner account (real Shopify)

What works here: everything, including the admin screens, the real web pixel on a storefront, real webhooks and the install/uninstall flow.

### B1. Accounts and store

- Create a Shopify Partner account (see [section C](#c-setting-up-a-free-shopify-partner-account)).
- Create a dev store (Dev Dashboard → Stores → Create store → Dev, or `npx @shopify/cli@latest store create dev --name "moosend-test" --demo-data`).
  - Use `--demo-data` so there are products to test with.
- Dev stores are always password protected. Find the storefront password in the store admin: Online Store → Preferences → Password protection.

### B2. Start the app connected to Shopify

- **Terminal 1:** `npm run mock:moosend`
- **Terminal 2:** `npm run dev` (runs `shopify app dev`).
  - First run:
    - Log in to Shopify in the browser.
    - "Create this project as a new app?" → **Yes**, name: `Moosend Website Tracking`.
    - The CLI fills `client_id` in `shopify.app.toml`.
  - Choose your dev store.
  - The CLI starts a public tunnel, applies the TOML config (scopes, webhooks) and installs the extension.
  - Press **p** to open the app in the store admin and approve the permissions.
- `.env` values for `SHOPIFY_*` are overridden by the CLI automatically.
- **On this PC:** if `npm run dev` fails with `spawn UNKNOWN` or "Application Control policy has blocked this file", Windows is blocking the CLI's native tools. Run Mode B in WSL or on another machine, or ask IT to allow `node_modules` binaries (see SETUP.md §7).

### B3. Allow customer data in development (for email/name tests)

- Dev Dashboard → your app → Settings → **Access requests** → Protected customer data → **Manage**.
- Select "Customer data", then the fields **Email** and **Name**, give a reason, and Save.
- This requires a distribution method to be selected first: Distribution → **Public**.
- Without this, events still flow, but visitors stay anonymous (no IDENTIFY events).

### B4. Configure and test the full flow

- In the app (store admin → Apps → Moosend Website Tracking):
  - Website ID: `97C425C7-928B-4856-BC02-C72074C8586C` (any valid ID for the mock).
  - API key: any value (or the value of `MOCK_MOOSEND_API_KEY` if set).
  - Keep "Enable tracking" checked → **Save**.
  - Click **Send test event** → the mock prints `SHOPIFY_CONNECTION_TEST`.
- Check the pixel: store admin → **Settings → Customer events** → the app pixel shows **Connected**.
- Make a test purchase:
  - Settings → Payments → enable the test payment gateway ("Bogus").
  - Open the storefront (enter the store password).
  - Browse → view a product → add to cart → check out.
  - Bogus gateway card number: `1` = success, `2` = failure. Any name, future expiry and CVV.
- Verify:
  - The app's **Event activity** page shows each event and its status.
  - The mock terminal and `http://localhost:4010/events` show the payloads.

### B5. Debug the web pixel in the browser

- Open the storefront → F12 (DevTools).
- **Network tab**
  - Filter `pixel/events`.
  - Each storefront action sends one POST with status `202`.
  - Click a request → Payload to see exactly what the pixel sent.
- **Console**
  - The pixel runs in a sandboxed worker/iframe.
  - Use the console context dropdown (top-left, usually "top") to select the `web-pixel-sandbox…` context for the app's pixel.
  - Temporary `console.log` calls in `extensions/moosend-web-pixel/src/tracker.ts` appear there. The CLI hot-reloads the extension while `npm run dev` runs.
- **No requests at all?**
  - Pixel not Connected → app home → **Reconnect web pixel**.
  - Tracking disabled or Moosend not saved → the pixel stays idle by design.
  - No consent → see B6.
  - `MOOSEND_TRACKING_ENDPOINT` empty → the pixel stays idle (banner in the app).

### B6. Test consent (cookie banner)

- Store admin → Settings → **Customer privacy** → turn on the cookie banner, for your region or all regions.
- Open the storefront in a private window:
  - **Decline** → no `pixel/events` requests at all (expected).
  - **Accept** → requests start.
- To reset your choice, clear cookies or open a new private window.

### B7. Debug the server and admin UI

- Server logs are printed in the `npm run dev` terminal.
- Breakpoints:
  - Stop `npm run dev`, set `$env:NODE_OPTIONS="--inspect"`, and run `npm run dev` again.
  - Attach as in A4 (port 9229). In dev mode, source maps map to your `.ts` files.
  - Remove the variable afterwards: `Remove-Item Env:NODE_OPTIONS`.
- Admin UI (React): use the browser DevTools while the app is open in the store admin. The app runs inside an iframe — select it in the console context dropdown.
- GraphiQL for the Admin API: press **g** in the `npm run dev` terminal. Try `query { webPixel { id settings } }` to see the pixel's settings.

### B8. Test webhooks

- **Real events**
  - Place a test order → `orders/create` is delivered automatically (logged as `Processed orders/create webhook`).
  - Uninstall the app from the store admin → `app/uninstalled`.
- **Manual trigger**
  - `npx @shopify/cli@latest app webhook trigger` → choose the topic (e.g. `customers/redact`, `shop/redact`, `orders/create`), delivery method HTTP, and address `https://<tunnel-url>/webhooks/<topic>`.
  - Sample payloads use fake IDs, so expect results like `no_consented_visitor` for orders. That's the safe, correct behavior.
- Delivery history and failures: Dev Dashboard → your app → **Logs**.

### B9. Test install, uninstall and reinstall

- Uninstall: store admin → Settings → Apps → Moosend Website Tracking → Uninstall.
  - Check that `Shop.uninstalledAt` is set (Prisma Studio) and the pixel disappears from Customer events.
- Reinstall: run `npm run dev` again (or use the install link the CLI prints).
  - The app opens, previous settings are restored, and the pixel reconnects.
- Also test in a Chrome incognito window (App Store requirement: works without third-party cookies).

---

## C. Setting up a free Shopify Partner account

- **Sign up (free)**
  - Go to `https://www.shopify.com/partners` → **Join now** (or `https://partners.shopify.com/signup`).
  - Use your company email. Using an email with a Shopify ID makes later logins easier.
  - Fill in the business details:
    - Business name: your company (e.g. Moosend/Sitecore) — this becomes the **Partner organization**.
    - Business type / primary focus: "Build apps for Shopify merchants" (or similar).
  - Verify your email from the confirmation message.
- **Organization settings** (Partner Dashboard → Settings)
  - Fill in business details and contact information.
  - Set the **emergency developer contact** (required before App Store submission).
  - Identity verification is only needed to install other partners' apps on dev stores. Your own app is exempt.
- **Open the Dev Dashboard**
  - `https://dev.shopify.com/dashboard/`, logged in with the same account.
  - Apps and dev stores are managed here.
- **Create a dev store**
  - Dev Dashboard → **Stores** → **Create store** → type **Dev**.
  - Name: e.g. `moosend-tracking-test`. The `myshopify.com` URL can't be changed later.
  - Plan: **Basic** is enough. Use **Plus** only if you want to test Plus-only checkout features.
  - Create the store, then log in to its admin.
  - CLI alternative: `npx @shopify/cli@latest store create dev --name "moosend-tracking-test" --demo-data`.
- **Prepare the store**
  - Add products if you didn't use demo data (Products → Add product, with an image, price and SKU).
  - Settings → Payments → enable the test (Bogus) gateway.
  - Online Store → Preferences → copy the storefront password.
  - Optional: Settings → Customer privacy → enable the cookie banner (for consent testing).
- **Create/link the app** (one time)
  - In the project: `npm run dev` → log in → "Create as a new app" → name `Moosend Website Tracking`.
  - Or Dev Dashboard → Apps → Create app, then `npm run config:link` in the project and pick it.
  - Dev Dashboard → your app → **Distribution** → choose **Public distribution**. Needed for the App Store and for protected customer data requests.
- **Invite colleagues** (optional)
  - Partner Dashboard → Settings → Team → invite users with app-development permissions.
  - To give them access to the dev store: store admin → Settings → Users → add staff.
- **Costs and limits**
  - Partner accounts and dev stores are free.
  - Up to 250 dev stores per organization.
  - Dev stores can't take real payments, and are always password protected.

---

## Troubleshooting

| Symptom | Likely cause | Fix |
| - | - | - |
| `'shopify' is not recognized as an internal or external command` | Shopify CLI not installed globally | `npm install -g @shopify/cli@latest`, reopen PowerShell (or use `npx @shopify/cli@latest app dev`) |
| `Application Control policy has blocked this file` / `spawn UNKNOWN` | Windows blocks native binaries | Use the provided npm scripts (they use WASM builds); run the Shopify CLI in WSL or on another machine |
| `ERR_OSSL_ENTROPY_SOURCE_STRENGTH_TOO_WEAK` | esbuild-wasm started without `scripts/run.mjs` | Use `npm run build/test/typecheck`, or prefix commands with `node scripts/run.mjs` |
| `APP_ENCRYPTION_KEY is not set` | Missing `.env` value | Add a 32-byte base64 key (section 0) |
| `events:local` shows 202 but mock receives nothing | Store not seeded, tracking off, or endpoint empty | `npm run seed:local`; check `MOOSEND_TRACKING_ENDPOINT` in `.env`; restart `start:local` |
| Mock receives nothing, events stay `PENDING` | Mock not running or wrong port | Start `npm run mock:moosend`; events retry automatically (or wait `WORKER_INTERVAL_MS`) |
| Events `FAILED` with `HTTP 401` | API key mismatch with `MOCK_MOOSEND_API_KEY` | Align the keys; re-seed or re-save in the app; "Retry failed events" |
| `/app` shows a blank page locally | No Shopify session (Mode A) | Expected; use Mode B for admin screens |
| `/app` returns 410 to scripts/curl | Library blocks bot user agents | Expected; use a browser |
| Pixel shows "Disconnected" in Customer events | Pixel not created or URL changed | App home → **Reconnect web pixel** (also happens automatically when you open the app) |
| No IDENTIFY events in Mode B | Protected customer data not selected | Do B3 |
| Purchase missing in Moosend for "Buy it now" | No add-to-cart happened | Expected limitation; optional setting "Treat items that go straight to checkout as added to cart" |
| `Port 3000 already in use` | Old server still running | Close the other terminal, or `Get-Process node` then `Stop-Process -Id <id>` |
| Tests fail after schema change | Prisma client outdated | `npx prisma generate`, then `npm test` |

---

## Command cheat sheet

| Command | What it does |
| - | - |
| `npm test` | Run all tests |
| `npm run validate` | Typecheck + lint + tests + build |
| `npm run mock:moosend` | Mock Moosend on :4010 |
| `npm run build` | Production build |
| `npm run seed:local` | Create the fake local store (Mode A) |
| `npm run start:local` | Start the built app with `.env` (Mode A) |
| `npm run start:debug` | Same, with debugger on :9229 |
| `npm run events:local` | Simulate a shopper journey |
| `npx prisma studio` | Browse the database |
| `npm run dev` | Run with Shopify (Mode B) |
