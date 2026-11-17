import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger.server";
import {
  handleCustomersRedact,
  type CustomersRedactPayload,
} from "../services/privacy.server";

// Mandatory compliance webhook. Invalid HMAC -> 401 (thrown by authenticate.webhook).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const result = await handleCustomersRedact(shop, payload as CustomersRedactPayload);
  logger.info(`Processed ${topic} webhook`, { shop, result });
  return new Response();
};
