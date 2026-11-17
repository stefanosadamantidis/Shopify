# Known issues and limitations

| # | Issue | Status | Details / next step |
| - | - | - | - |
| 1 | Moosend wire contract unknown | OPEN (external) | Endpoint, auth header and payload are placeholders. Adapt `app/services/moosend/client.server.ts`. |
| 2 | Native binaries blocked on dev machine (Windows Application Control) | WORKED AROUND | WASM esbuild/rollup + crypto warm-up (SETUP.md §7). Shopify CLI bundling still blocked locally. |
| 3 | `shopify app config validate` / `security check` not run | OPEN | Need Partner login + linked client_id. |
| 4 | Checkout token correlation (pixel `checkout.token` ↔ webhook `checkout_token`) | INFERRED | Verify on a dev store; if they differ, the webhook fallback reports `no_consented_visitor` (safe failure). |
| 5 | Buy-now/express checkout lacks ADDED_TO_ORDER | DOCUMENTED | Optional merchant setting; off by default. |
| 6 | PII requires PCD approval | DOCUMENTED | Visitors anonymous until approved. |
| 7 | Collector rate limiting is per instance | DOCUMENTED | Add edge/WAF limits when scaling out. |
| 8 | `npm audit` reports transitive vulnerabilities from template deps | OPEN | Review `npm audit`; template pins/overrides `qs`. Re-check after updating Shopify packages. |
| 9 | `@shopify/shopify-app-react-router` v4 exists (template uses ^3) | DECISION | Kept the official template's tested version set; evaluate v4 upgrade later. |
| 10 | `shamefully-hoist` npmrc warning with npm 12 | COSMETIC | From template `.npmrc`. |
| 11 | Per-shop Shopify access/refresh tokens stored unencrypted in `Session` table | OPEN (VERIFIED in code) | Template default (`PrismaSessionStorage`). Mitigate with encrypted DB storage + restricted access; optionally wrap session storage with AES-GCM using `APP_ENCRYPTION_KEY`. Moosend API keys are already encrypted. |
