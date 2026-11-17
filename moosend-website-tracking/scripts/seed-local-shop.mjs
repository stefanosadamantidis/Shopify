// Creates (or resets) a fake, fully configured store in the LOCAL database so
// the tracking pipeline can be exercised without a Shopify Partner account.
// Usage: npm run seed:local     (reads .env via --env-file)
import { createCipheriv, randomBytes } from "node:crypto";
import { PrismaClient } from "@prisma/client";

export const LOCAL_SHOP = "local-test.myshopify.com";
export const LOCAL_INGEST_KEY = "local-dev-ingest-key-000000";

const rawKey = process.env.APP_ENCRYPTION_KEY;
if (!rawKey || Buffer.from(rawKey, "base64").length !== 32) {
  console.error("APP_ENCRYPTION_KEY is missing or invalid in .env (needs 32 bytes, base64).");
  process.exit(1);
}

// Same format as app/lib/crypto.server.ts (v1:<iv>:<tag>:<ciphertext>).
function encrypt(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(rawKey, "base64"), iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(":");
}

const prisma = new PrismaClient();
await prisma.shop.deleteMany({ where: { shopDomain: LOCAL_SHOP } });
await prisma.shop.create({
  data: {
    shopDomain: LOCAL_SHOP,
    ingestKey: LOCAL_INGEST_KEY,
    trackingEnabled: true,
    customEventsEnabled: true,
    moosendWebsiteId: "97C425C7-928B-4856-BC02-C72074C8586C",
    moosendApiKeyEnc: encrypt(process.env.MOCK_MOOSEND_API_KEY || "local-test-api-key"),
  },
});
await prisma.$disconnect();
console.log(`Seeded ${LOCAL_SHOP} (ingest key: ${LOCAL_INGEST_KEY})`);
