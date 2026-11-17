import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger.server";
import { handleShopRedact } from "../services/privacy.server";

// Mandatory compliance webhook, sent 48h after uninstall. Erases all shop data.
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic } = await authenticate.webhook(request);
  const result = await handleShopRedact(shop);
  logger.info(`Processed ${topic} webhook`, { shop, result });
  return new Response();
};
