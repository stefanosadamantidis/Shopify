import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { logger } from "../lib/logger.server";
import {
  handleCustomersDataRequest,
  type CustomersDataRequestPayload,
} from "../services/privacy.server";

// Mandatory compliance webhook. Invalid HMAC -> 401 (thrown by authenticate.webhook).
export const action = async ({ request }: ActionFunctionArgs) => {
  const { shop, topic, payload } = await authenticate.webhook(request);
  const result = await handleCustomersDataRequest(
    shop,
    payload as CustomersDataRequestPayload,
  );
  logger.info(`Processed ${topic} webhook`, { shop, result });
  return new Response();
};
