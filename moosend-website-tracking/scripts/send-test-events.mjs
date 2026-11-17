// Simulates the web pixel: sends a full shopper journey to the local collector,
// then prints what the mock Moosend receiver got.
// Usage: npm run events:local   (app on APP_URL, mock on MOCK_URL)
const APP_URL = process.env.APP_URL || "http://localhost:3000";
const MOCK_URL = process.env.MOCK_URL || `http://localhost:${process.env.MOCK_MOOSEND_PORT || 4010}`;
const INGEST_KEY = process.env.INGEST_KEY || "local-dev-ingest-key-000000";
const clientId = `local-visitor-${Date.now()}`;
const orderId = String(Date.now());
let seq = 0;

const item = {
  productId: "111", variantId: "222", sku: "COW-T-SHIRT", title: "Cow T-Shirt",
  variantTitle: "Red / M", url: "https://local-test.example/products/cow-t-shirt",
  image: "https://cdn.shopify.com/cow.jpg", price: 12.02, currency: "EUR",
  quantity: 2, lineTotal: 24.04, productType: "T-Shirts", vendor: "Acme Co",
};
const consent = { analytics: true, marketing: true, saleOfData: true };
const event = (name, extra = {}) => ({
  id: `${name}-${clientId}-${(seq += 1)}`,
  name,
  ts: new Date().toISOString(),
  seq,
  clientId,
  page: { url: "https://local-test.example/products/cow-t-shirt", referrer: null, title: "Cow T-Shirt" },
  consent,
  ...extra,
});
const checkout = (withOrder) => ({
  token: `tok-${clientId}`, orderId: withOrder ? orderId : null, currency: "EUR", total: 24.04, items: [item],
});

const journey = [
  event("page_viewed"),
  event("product_viewed", { item: { ...item, quantity: 1, lineTotal: 12.02 } }),
  event("product_added_to_cart", { item }),
  event("checkout_started", { checkout: checkout(false) }),
  event("checkout_completed", {
    checkout: checkout(true),
    identity: { email: "local.buyer@example.com", firstName: "Local", lastName: "Buyer", customerId: null },
  }),
];

for (const env of journey) {
  const res = await fetch(`${APP_URL}/api/pixel/events`, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=UTF-8" },
    body: JSON.stringify({ v: 1, key: INGEST_KEY, events: [env] }),
  });
  console.log(`${env.name.padEnd(28)} -> HTTP ${res.status}`);
}

console.log("\nWaiting for the delivery worker...");
await new Promise((resolve) => setTimeout(resolve, 3000));
try {
  const { events } = await (await fetch(`${MOCK_URL}/events`)).json();
  const mine = events.filter((e) => e.body?.visitor?.anonymousId === clientId);
  console.log(`Mock Moosend received ${mine.length} event(s) for ${clientId}:`);
  for (const e of mine) console.log(`  - ${e.body.event}`);
  if (!mine.length) console.log("  (none yet - see IMPORTANT DOC/HOW_TO_DEBUG.md troubleshooting)");
} catch {
  console.log(`Could not reach the mock receiver at ${MOCK_URL}. Is "npm run mock:moosend" running?`);
}
