import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger.server";
import { handleOrderCreated, type OrderWebhookPayload } from "../services/orders.server";
import { kickWorker } from "../services/worker.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);

  try {
    const outcome = await handleOrderCreated(shop, payload as OrderWebhookPayload);
    logger.info(`Processed ${topic} webhook`, { shop, outcome });
    if (outcome === "scheduled") kickWorker();
  } catch (error) {
    // Non-2xx makes Shopify retry the delivery; processing is idempotent.
    logger.error(`Failed to process ${topic} webhook`, { shop, error });
    return new Response(null, { status: 500 });
  }
  return new Response();
};
