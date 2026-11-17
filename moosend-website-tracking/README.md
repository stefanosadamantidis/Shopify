# Moosend Website Tracking for Shopify

A public Shopify app that sends storefront and checkout behavior (page views, product
views, add-to-cart events, purchases and customer identification) to a merchant's
Moosend account. It uses a Shopify **web pixel extension** in the strict sandbox, so
tracking respects each visitor's consent choices.

Built on Shopify's official React Router app template (Admin API `2026-10`, Polaris web
components, App Bridge, Prisma session storage, expiring offline tokens).

## Quick start

```bash
npm install
cp .env.example .env            # then fill in APP_ENCRYPTION_KEY etc.
npm run mock:moosend            # terminal 1: mock Moosend receiver on :4010
npm run dev                     # terminal 2: shopify app dev (needs Partner login)
```

## Scripts

| Script | Purpose |
| - | - |
| `npm run dev` | Run the app with Shopify CLI on a dev store |
| `npm run build` / `npm start` | Production build and server |
| `npm run typecheck` | React Router typegen + `tsc --noEmit` |
| `npm run lint` | ESLint |
| `npm test` | Vitest suite (SQLite test DB, mock Moosend receiver) |
| `npm run validate` | typecheck + lint + test + build |
| `npm run mock:moosend` | Local mock Moosend tracking endpoint |
| `npm run deploy` | `shopify app deploy` (app config + web pixel extension) |

## Documentation

All design, compliance, mapping, setup and App Store submission documentation lives
in the solution-level [`IMPORTANT DOC`](../IMPORTANT%20DOC/INDEX.md) folder.

> **Moosend endpoint placeholder:** The production Moosend tracking endpoint, auth
> header and wire format are not public. Configure them with
> `MOOSEND_TRACKING_ENDPOINT` / `MOOSEND_API_KEY_HEADER`, and adapt
> `app/services/moosend/client.server.ts` once Moosend supplies the contract.
