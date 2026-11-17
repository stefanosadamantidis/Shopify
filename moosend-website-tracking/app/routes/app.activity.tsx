import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { ensureShop } from "../services/shop.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  // Only operational metadata is exposed; event payloads (which may contain
  // an email address) are never sent to the browser.
  const rows = await prisma.outboxEvent.findMany({
    where: { shopId: shop.id },
    orderBy: { createdAt: "desc" },
    take: 50,
    select: {
      id: true,
      eventType: true,
      status: true,
      attempts: true,
      lastStatus: true,
      lastError: true,
      createdAt: true,
      deliveredAt: true,
      orderId: true,
    },
  });
  return {
    events: rows.map((row) => ({
      ...row,
      createdAt: row.createdAt.toISOString(),
      deliveredAt: row.deliveredAt?.toISOString() ?? null,
    })),
  };
};

const STATUS_TONE: Record<string, "success" | "info" | "critical" | "neutral" | "warning"> = {
  DELIVERED: "success",
  PENDING: "info",
  SENDING: "info",
  FAILED: "critical",
  CANCELLED: "neutral",
};

const EVENT_LABEL: Record<string, string> = {
  IDENTIFY: "Identify",
  PAGE_VIEW: "Page view",
  PRODUCT_VIEW: "Product view",
  ADDED_TO_ORDER: "Added to order",
  ORDER_COMPLETED: "Order completed",
  CUSTOM: "Custom event",
};

export default function Activity() {
  const { events } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Event activity">
      <s-section heading="Most recent events">
        {events.length === 0 ? (
          <s-paragraph>
            No events yet. Once tracking is active, visit your online store (and accept
            the cookie banner if one is shown) to generate activity.
          </s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Time</s-table-header>
              <s-table-header>Event</s-table-header>
              <s-table-header>Status</s-table-header>
              <s-table-header>Attempts</s-table-header>
              <s-table-header>Details</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {events.map((event) => (
                <s-table-row key={event.id}>
                  <s-table-cell>{new Date(event.createdAt).toLocaleString()}</s-table-cell>
                  <s-table-cell>
                    {EVENT_LABEL[event.eventType] ?? event.eventType}
                    {event.orderId ? ` (order ${event.orderId})` : ""}
                  </s-table-cell>
                  <s-table-cell>
                    <s-badge tone={STATUS_TONE[event.status] ?? "neutral"}>{event.status}</s-badge>
                  </s-table-cell>
                  <s-table-cell>{event.attempts}</s-table-cell>
                  <s-table-cell>
                    {event.lastError ?? (event.lastStatus ? `HTTP ${event.lastStatus}` : "")}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
