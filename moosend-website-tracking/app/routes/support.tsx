import type { MetaFunction } from "react-router";
import { useLoaderData } from "react-router";

export const meta: MetaFunction = () => [{ title: "Support - Moosend Website Tracking" }];

export const loader = async () => ({
  contact: process.env.SUPPORT_EMAIL || "[support email]",
});

const page: React.CSSProperties = {
  maxWidth: 760,
  margin: "40px auto",
  padding: "0 20px",
  fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  lineHeight: 1.6,
  color: "#303030",
};

export default function Support() {
  const { contact } = useLoaderData<typeof loader>();
  return (
    <main style={page}>
      <h1>Moosend Website Tracking: Support</h1>
      <p>Contact us at {contact}.</p>

      <h2>Getting started</h2>
      <ol>
        <li>Install the app from the Shopify App Store and approve the requested permissions.</li>
        <li>In Moosend, add your store under More › Websites and copy the website ID.</li>
        <li>In the app, enter your website ID and Moosend API key, then click Save.</li>
        <li>Click &quot;Send test event&quot; to check the connection.</li>
        <li>In Shopify, open Settings › Customer events and check that the app pixel shows as Connected.</li>
      </ol>

      <h2>Troubleshooting</h2>
      <ul>
        <li>
          <strong>No events appear:</strong> Make sure tracking is turned on and the pixel is
          connected. Visitors who decline tracking in your cookie banner aren&apos;t tracked.
        </li>
        <li>
          <strong>Events failed:</strong> Check that your Moosend API key is still valid, then
          use &quot;Retry failed events&quot; on the app home page.
        </li>
        <li>
          <strong>Visitors aren&apos;t identified by email:</strong> Email identification requires
          Shopify approval for protected customer data.
        </li>
      </ul>

      <p>
        <a href="/privacy">Privacy policy</a>
      </p>
    </main>
  );
}
