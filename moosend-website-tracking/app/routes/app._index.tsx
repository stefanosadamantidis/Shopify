import { useEffect, useState } from "react";
import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useFetcher, useLoaderData } from "react-router";
import { useAppBridge } from "@shopify/app-bridge-react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { authenticate } from "../shopify.server";
import {
  handleDashboardAction,
  loadDashboard,
  type DashboardActionResult,
} from "../services/dashboard.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  return loadDashboard(session.shop, admin);
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const { session, admin } = await authenticate.admin(request);
  return handleDashboardAction(session.shop, admin, await request.formData());
};

const ITEM_CODE_OPTIONS = [
  { value: "SKU_OR_VARIANT_ID", label: "SKU (fallback: variant ID)" },
  { value: "VARIANT_ID", label: "Variant ID" },
  { value: "PRODUCT_ID", label: "Product ID" },
];

function StatusBadge({ ok, okText, notOkText, warn }: { ok: boolean; okText: string; notOkText: string; warn?: boolean }) {
  return (
    <s-badge tone={ok ? "success" : warn ? "warning" : "critical"}>
      {ok ? okText : notOkText}
    </s-badge>
  );
}

export default function Index() {
  const { shop, stats } = useLoaderData<typeof loader>();
  const fetcher = useFetcher<DashboardActionResult>();
  const shopify = useAppBridge();

  const [websiteId, setWebsiteId] = useState(shop.moosendWebsiteId);
  const [apiKey, setApiKey] = useState("");
  const [trackingEnabled, setTrackingEnabled] = useState(shop.trackingEnabled || !shop.configured);
  const [customEvents, setCustomEvents] = useState(shop.customEventsEnabled);
  const [webhookFallback, setWebhookFallback] = useState(shop.webhookPurchaseFallback);
  const [checkoutAsAdd, setCheckoutAsAdd] = useState(shop.checkoutAsAddToOrder);
  const [itemCodeSource, setItemCodeSource] = useState<string>(shop.itemCodeSource);

  const busyIntent =
    fetcher.state !== "idle" ? String(fetcher.formData?.get("intent") ?? "") : null;
  const result = fetcher.state === "idle" ? fetcher.data : undefined;
  const errors = result && !result.ok ? result.errors ?? {} : {};

  // Clear the API key input once a save succeeds (state adjusted during
  // render, as recommended by React, rather than inside an effect).
  const [handledResult, setHandledResult] = useState(result);
  if (result !== handledResult) {
    setHandledResult(result);
    if (result?.ok && result.intent === "save") setApiKey("");
  }

  useEffect(() => {
    if (result) shopify.toast.show(result.message, { isError: !result.ok });
  }, [result, shopify]);

  const submit = (intent: string, extra: Record<string, string> = {}) => {
    fetcher.submit({ intent, ...extra }, { method: "POST" });
  };

  const save = () =>
    submit("save", {
      moosendWebsiteId: websiteId,
      moosendApiKey: apiKey,
      trackingEnabled: String(trackingEnabled),
      customEventsEnabled: String(customEvents),
      webhookPurchaseFallback: String(webhookFallback),
      checkoutAsAddToOrder: String(checkoutAsAdd),
      itemCodeSource,
    });

  const loading = (intent: string) => (busyIntent === intent ? { loading: true } : {});
  const checked = (value: boolean) => (value ? { checked: true } : {});

  return (
    <s-page heading="Moosend Website Tracking">
      <s-button slot="primary-action" variant="primary" onClick={save} {...loading("save")}>
        Save
      </s-button>

      {!shop.destinationConfigured && (
        <s-banner tone="warning" heading="Moosend destination not configured">
          <s-paragraph>
            The app operator has not configured the Moosend tracking endpoint yet.
            Your settings are saved, but no events are collected or sent until it is available.
          </s-paragraph>
        </s-banner>
      )}
      {shop.pixelStatus === "ERROR" && (
        <s-banner tone="critical" heading="Web pixel is not connected">
          <s-paragraph>{shop.pixelError ?? "The web pixel could not be configured."}</s-paragraph>
          <s-button slot="secondary-actions" onClick={() => submit("reconnect")} {...loading("reconnect")}>
            Reconnect pixel
          </s-button>
        </s-banner>
      )}
      {shop.lastDeliveryError && (
        <s-banner tone="warning" heading="Recent delivery problem">
          <s-paragraph>
            {shop.lastDeliveryError}
            {shop.lastDeliveryErrorAt ? ` (${new Date(shop.lastDeliveryErrorAt).toLocaleString()})` : ""}
          </s-paragraph>
        </s-banner>
      )}

      <s-section heading="Setup status">
        <s-stack direction="block" gap="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <StatusBadge ok={shop.configured} okText="Connected" notOkText="Not connected" />
            <s-text>Moosend account (Website ID and API key)</s-text>
          </s-stack>
          <s-stack direction="inline" gap="base" alignItems="center">
            <StatusBadge ok={shop.pixelStatus === "CONNECTED"} okText="Connected" notOkText="Not connected" />
            <s-text>Shopify web pixel (Settings › Customer events)</s-text>
          </s-stack>
          <s-stack direction="inline" gap="base" alignItems="center">
            <StatusBadge ok={shop.active} okText="Active" notOkText="Inactive" warn />
            <s-text>Storefront and checkout tracking</s-text>
            {shop.inactiveReason && <s-text color="subdued">{shop.inactiveReason}</s-text>}
          </s-stack>
        </s-stack>
      </s-section>

      <s-section heading="Connect Moosend">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            In Moosend, go to More › Websites, select your website, and copy the
            website ID. Create or copy an API key from your Moosend account settings.
          </s-paragraph>
          <s-text-field
            label="Moosend website ID"
            name="moosendWebsiteId"
            value={websiteId}
            onChange={(e) => setWebsiteId(e.currentTarget.value)}
            error={errors.moosendWebsiteId}
            autocomplete="off"
          ></s-text-field>
          <s-password-field
            label="Moosend API key"
            name="moosendApiKey"
            value={apiKey}
            onChange={(e) => setApiKey(e.currentTarget.value)}
            error={errors.moosendApiKey}
            details={
              shop.hasApiKey
                ? `Saved key: ${shop.apiKeyMasked ?? "••••"}. Leave blank to keep it.`
                : "Stored encrypted on our servers. Never shown on your storefront."
            }
            autocomplete="off"
          ></s-password-field>
          <s-checkbox
            label="Enable tracking"
            details="Send storefront and checkout activity to Moosend for visitors who have given consent."
            onChange={(e) => setTrackingEnabled(e.currentTarget.checked)}
            {...checked(trackingEnabled)}
          ></s-checkbox>
        </s-stack>
      </s-section>

      <s-section heading="Tracking options">
        <s-stack direction="block" gap="base">
          <s-select
            label="Product identifier sent to Moosend"
            value={itemCodeSource}
            onChange={(e) => setItemCodeSource(e.currentTarget.value)}
            details="Must match the product codes used in your Moosend product recommendations."
          >
            {ITEM_CODE_OPTIONS.map((option) => (
              <s-option key={option.value} value={option.value}>
                {option.label}
              </s-option>
            ))}
          </s-select>
          <s-checkbox
            label="Recover purchases when the thank-you page doesn't load"
            details="Uses the order webhook to report purchases from visitors already tracked with consent. Duplicates are prevented automatically."
            onChange={(e) => setWebhookFallback(e.currentTarget.checked)}
            {...checked(webhookFallback)}
          ></s-checkbox>
          <s-checkbox
            label="Treat items that go straight to checkout as added to cart"
            details={`Moosend needs an "added to order" event before a purchase. Enable this to cover "Buy it now" and express checkout buttons, which skip the cart.`}
            onChange={(e) => setCheckoutAsAdd(e.currentTarget.checked)}
            {...checked(checkoutAsAdd)}
          ></s-checkbox>
          <s-checkbox
            label="Send additional custom events"
            details="Searches, collection views, cart views, checkout starts and cart removals, sent as Moosend custom events."
            onChange={(e) => setCustomEvents(e.currentTarget.checked)}
            {...checked(customEvents)}
          ></s-checkbox>
        </s-stack>
      </s-section>

      <s-section heading="Troubleshooting">
        <s-stack direction="inline" gap="base">
          <s-button onClick={() => submit("test")} {...loading("test")}>
            Send test event
          </s-button>
          <s-button onClick={() => submit("reconnect")} {...loading("reconnect")}>
            Reconnect web pixel
          </s-button>
          <s-button onClick={() => submit("retry_failed")} {...loading("retry_failed")}>
            Retry failed events
          </s-button>
          {shop.hasApiKey && (
            <s-button tone="critical" variant="secondary" onClick={() => submit("disconnect")} {...loading("disconnect")}>
              Disconnect Moosend
            </s-button>
          )}
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="Last 24 hours">
        <s-stack direction="block" gap="small-200">
          <s-text>Delivered: {stats.DELIVERED}</s-text>
          <s-text>Queued: {stats.PENDING + stats.SENDING}</s-text>
          <s-text>Failed: {stats.FAILED}</s-text>
          <s-text>
            Last delivery: {shop.lastDeliveryAt ? new Date(shop.lastDeliveryAt).toLocaleString() : "none yet"}
          </s-text>
          <s-link href="/app/activity">View event activity</s-link>
        </s-stack>
      </s-section>

      <s-section slot="aside" heading="How it works">
        <s-paragraph>
          The app adds a Shopify web pixel that runs in Shopify&apos;s secure sandbox.
          It only runs for visitors who allow analytics and marketing tracking, and sends
          page views, product views, add-to-cart events and purchases to your Moosend account.
        </s-paragraph>
        <s-link href="/app/help">Setup guide and privacy</s-link>
      </s-section>
    </s-page>
  );
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
