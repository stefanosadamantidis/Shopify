import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import { ensureShop } from "../services/shop.server";
import {
  getComplianceReport,
  listComplianceRequests,
} from "../services/privacy.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session } = await authenticate.admin(request);
  const shop = await ensureShop(session.shop);
  const reportId = new URL(request.url).searchParams.get("report");
  const report = reportId ? await getComplianceReport(shop.id, reportId) : null;
  return {
    requests: await listComplianceRequests(shop.id),
    report: report ? JSON.stringify(JSON.parse(report), null, 2) : null,
  };
};

export default function Help() {
  const { requests, report } = useLoaderData<typeof loader>();

  return (
    <s-page heading="Help & privacy">
      <s-section heading="Setup guide">
        <s-ordered-list>
          <s-list-item>
            In Moosend, add your store under More › Websites and copy the website ID.
          </s-list-item>
          <s-list-item>
            Copy an API key from your Moosend account settings.
          </s-list-item>
          <s-list-item>
            On the app home page, enter both values, keep &quot;Enable tracking&quot; selected, and click Save.
          </s-list-item>
          <s-list-item>
            Click &quot;Send test event&quot; to confirm Moosend accepts events.
          </s-list-item>
          <s-list-item>
            In Shopify, open Settings › Customer events and check that the Moosend Website
            Tracking app pixel shows as Connected.
          </s-list-item>
          <s-list-item>
            Visit your online store, view a product, add it to the cart and place a test order.
            The events appear under Event activity within a minute.
          </s-list-item>
        </s-ordered-list>
      </s-section>

      <s-section heading="What is tracked">
        <s-unordered-list>
          <s-list-item>Page views (Moosend page view)</s-list-item>
          <s-list-item>Product views (Moosend product view)</s-list-item>
          <s-list-item>Add to cart (Moosend added to order)</s-list-item>
          <s-list-item>Purchases (Moosend order completed)</s-list-item>
          <s-list-item>
            Visitor identification by email when a logged-in customer browses or a buyer enters
            their email at checkout
          </s-list-item>
          <s-list-item>
            Optional custom events: searches, collection views, cart views, checkout starts and cart removals
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Privacy and consent">
        <s-paragraph>
          The tracking pixel only runs for visitors who allow analytics and marketing
          tracking and haven&apos;t opted out of the sale or sharing of their data, according to
          your store&apos;s cookie banner and privacy settings. The app doesn&apos;t collect
          addresses, phone numbers, payment details or IP addresses. Visitor records are
          deleted after 90 days of inactivity, and all store data is deleted 48 hours after
          you uninstall the app.
        </s-paragraph>
        <s-paragraph>
          Before you turn on tracking, check that your store&apos;s privacy policy mentions
          Moosend as an email marketing processor.
        </s-paragraph>
      </s-section>

      <s-section heading="Known limitations">
        <s-unordered-list>
          <s-list-item>
            Email identification requires Shopify approval for protected customer data
            (email). Until then, visitors are tracked anonymously.
          </s-list-item>
          <s-list-item>
            Moosend counts a purchase only if the product was first added to the order.
            &quot;Buy it now&quot; and express checkouts skip the cart. Enable the matching
            tracking option to cover them.
          </s-list-item>
          <s-list-item>
            Activity from visitors who decline tracking isn&apos;t collected, and their
            purchases aren&apos;t reported.
          </s-list-item>
        </s-unordered-list>
      </s-section>

      <s-section heading="Customer privacy requests">
        {requests.length === 0 ? (
          <s-paragraph>No customer data requests have been received.</s-paragraph>
        ) : (
          <s-table>
            <s-table-header-row>
              <s-table-header>Received</s-table-header>
              <s-table-header>Type</s-table-header>
              <s-table-header>Summary</s-table-header>
              <s-table-header>Report</s-table-header>
            </s-table-header-row>
            <s-table-body>
              {requests.map((request) => (
                <s-table-row key={request.id}>
                  <s-table-cell>{new Date(request.createdAt).toLocaleString()}</s-table-cell>
                  <s-table-cell>{request.topic}</s-table-cell>
                  <s-table-cell>{request.summary}</s-table-cell>
                  <s-table-cell>
                    {request.hasReport ? (
                      <s-link href={`/app/help?report=${request.id}`}>View data</s-link>
                    ) : (
                      "-"
                    )}
                  </s-table-cell>
                </s-table-row>
              ))}
            </s-table-body>
          </s-table>
        )}
        {report && (
          <s-box padding="base" borderWidth="base" borderRadius="base" background="subdued">
            <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
              <code>{report}</code>
            </pre>
          </s-box>
        )}
      </s-section>

      <s-section slot="aside" heading="Support">
        <s-paragraph>
          Need help? Visit the{" "}
          <s-link href="/support" target="_blank">
            support page
          </s-link>{" "}
          or read our{" "}
          <s-link href="/privacy" target="_blank">
            privacy policy
          </s-link>
          .
        </s-paragraph>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
