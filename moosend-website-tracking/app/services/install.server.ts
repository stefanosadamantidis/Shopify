import { logger } from "../lib/logger.server";
import { ensureShop } from "./shop.server";
import { syncWebPixel, type AdminGraphqlClient } from "./webpixel.server";

/**
 * Runs after OAuth/token exchange (install, reinstall, new offline token).
 * Provisions the tenant record and connects the web pixel automatically.
 * Errors are logged, not thrown, so the merchant still reaches the app UI,
 * where the pixel status and a "Reconnect" action are shown.
 */
export async function onAuthenticated({
  session,
  admin,
}: {
  session: { shop: string };
  admin: AdminGraphqlClient;
}) {
  const shop = await ensureShop(session.shop);
  const result = await syncWebPixel(admin, shop);
  if (!result.ok) {
    logger.warn("Web pixel sync failed after auth", { shop: session.shop, error: result.error });
  }
  return result;
}
