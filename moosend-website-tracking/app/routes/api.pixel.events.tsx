import type { ActionFunctionArgs } from "react-router";
import {
  collectorResponse,
  handleCollectorRequest,
} from "../services/pixel/collector.server";

// Resource route: receives events from the Moosend web pixel extension.
export const loader = async () =>
  collectorResponse(405, { error: "Method not allowed" });

export const action = async ({ request }: ActionFunctionArgs) =>
  handleCollectorRequest(request);
