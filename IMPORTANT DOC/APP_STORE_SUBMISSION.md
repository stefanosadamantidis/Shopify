# App Store submission package (public, fully visible listing)

Status: **ready for submission preparation – NOT submitted, NOT approved.** Publication
requires Shopify review. Items marked ☐ require human/external action.

## 1. Distribution

☐ Dev Dashboard → app → Distribution → **Public distribution (Shopify App Store)**. Do not choose custom/single-merchant or limited visibility.

## 2. Listing content (draft)

- **App name:** Moosend Website Tracking (must match `name` in `shopify.app.toml`, req. 4.1.1).
  ☐ Trademark: publish from the Moosend/Sitecore Partner account or obtain written permission (4.1.2, 4.4.3).
- **App card subtitle:** Send store activity to Moosend to power email automations.
- **App introduction:** Turn shoppers' browsing and buying activity into timely Moosend email automations.
- **App details:**
  Connect your store to your Moosend account in a few steps. The app adds a Shopify
  web pixel that sends page views, product views, add-to-cart events and purchases
  to Moosend, so you can build automations such as browse abandonment, cart reminders
  and post-purchase follow-ups. Customers who log in or enter their email at checkout
  are linked to their Moosend contact. Tracking follows your store's cookie banner and
  privacy settings: visitors who decline tracking aren't tracked.
- **Feature list:** Consent-aware Shopify web pixel · Page, product, cart and purchase events · Customer identification at login and checkout · Duplicate-free purchase reporting · Delivery status and troubleshooting tools.
- **Category/tags (suggested):** Marketing and conversion → Email marketing; Store data → Analytics. ☐ confirm in the form.
- **Pricing:** Free (no in-app charges implemented). ☐ If paid, implement Managed Pricing/Billing API first (1.2).
- **Languages:** English only (UI is English).
- **Sales channel requirement:** Select "Merchant must have online store" (4.3.1) – tracking runs on Online Store and checkout.
- **Integrations:** Moosend.
- No stats, superlatives, testimonials or pricing in text/images (4.2–4.3).

## 3. Visual assets (specifications – ☐ to be produced by design)

Dimensions below are Shopify's commonly documented listing specs (not re-fetched this
session) – confirm against the submission form before producing assets.

| Asset | Spec (Shopify) | Notes |
| - | - | - |
| App icon | 1200×1200 px JPG/PNG, no text-heavy design, no Shopify trademarks | Use authorized Moosend brand mark; no pricing |
| Feature media | 1600×900 px (16:9) image or video | Real UI, no browser chrome/desktop background |
| Screenshots | 1600×900 px, 3–6 unique | See capture plan below |
| Demo screencast | English or subtitled, shows onboarding end to end | Required (4.5.3) |

Screenshot capture plan (dev store, desktop 1600×900, crop to app frame only):
1. Home – Setup status all green ("Connected/Active").
2. Connect Moosend form with website ID filled (API key masked).
3. Tracking options section.
4. Event activity table with Delivered page/product/add/order events.
5. Help & privacy page (setup guide + privacy).
6. Shopify Settings → Customer events showing the app pixel Connected (crop to pixel row; avoid Shopify branding emphasis).

Screencast script: install from listing → permissions → app opens → enter Moosend IDs → Save → Send test event → storefront: accept cookie banner, view product, add to cart, checkout (Bogus gateway) → Event activity shows events → (optional) Moosend contact timeline.

## 4. Required URLs

| Field | URL |
| - | - |
| Privacy policy | `https://<app host>/privacy` (☐ fill placeholders + legal review) |
| Support / FAQ | `https://<app host>/support` |
| Support email | ☐ `SUPPORT_EMAIL` |
| App URL / redirect | `https://<app host>`, `https://<app host>/auth/callback` |

## 5. Review instructions (paste into submission form)

```
1. Install the app on your test store. You'll be taken to the app automatically.
2. Enter the Moosend test credentials below: Website ID: <...>, API key: <...>.
3. Keep "Enable tracking" selected and click Save. The setup status shows
   "Connected" for Moosend and the web pixel.
4. Click "Send test event" (a success message appears).
5. Visit the online store, accept the cookie banner, view a product, add it to the
   cart, and complete checkout with the Bogus gateway.
6. Open "Event activity" in the app to see the delivered events. The activity is also
   visible in the Moosend test account (login below) under Websites.
Moosend test login (no 2FA): <email> / <password>
```
☐ Create a dedicated Moosend test account exempt from 2FA/OTP (4.5.5) and keep it valid after publication.

## 6. Pre-submission checklist

- ☐ `shopify app config link` (production config), real URLs in `shopify.app.toml` incl. `network_access`.
- ☐ `shopify app config validate`, `shopify app build`, `shopify app security check` – zero blocking findings.
- ☑ `npm run validate` passes (typecheck, lint, 83 tests, build) – 2026-11-17.
- ☐ Real Moosend endpoint + header configured and verified end to end.
- ☐ Production deployed on HTTPS with PostgreSQL; `SHOW_LOGIN_FORM` unset/false.
- ☐ Protected customer data request submitted (Customer data; fields: Email, Name) with reasons: "identify the shopper in the merchant's Moosend account for email automations".
- ☐ `read_orders` justification ready: "orders/create webhook used to report purchases when the thank-you page doesn't load, deduplicated against web pixel events".
- ☐ Compliance webhooks reachable over HTTPS (in TOML ✓).
- ☐ Emergency developer contact set (4.5.6).
- ☐ Listing assets, screencast, test credentials.
- ☐ Install/uninstall/reinstall tested on a dev store; incognito Chrome test (1.1.1).
- ☐ Cookie banner test: decline → no requests to the collector.
- ☐ Privacy policy legal review; DPA available for merchants.
- ☐ `shopify app deploy` and release the version before submitting.

## 7. Outstanding external prerequisites

1. Moosend production tracking endpoint, authentication scheme and payload contract.
2. Moosend trademark/publishing authorization.
3. Shopify Partner account access (linking, deploy, security check, submission).
4. Protected customer data approval.
5. Hosting, domain, TLS, PostgreSQL, secrets management.
6. Legal: company details, privacy policy, DPA, subprocessors list.
