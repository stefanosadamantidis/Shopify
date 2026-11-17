import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import db from "../db.server";
import { logger } from "../lib/logger.server";
import { markUninstalled } from "../services/shop.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  logger.info(`Received ${topic} webhook`, { shop });

  // Webhooks can be delivered more than once and after the app was already
  // uninstalled, so every step here is idempotent. Shopify removes the app's
  // web pixel on uninstall; tenant data is erased on shop/redact.
  await db.session.deleteMany({ where: { shop } });
  await markUninstalled(shop);

  return new Response();
};
