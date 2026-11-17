import type { LoaderFunctionArgs } from "react-router";
import { redirect, Form, useLoaderData } from "react-router";

import { config } from "../../config.server";
import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  // App Store requirement 2.3.1: merchants must not be asked to type their
  // shop domain. The manual form is available for local development only.
  return { showForm: config.showLoginForm };
};

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();

  return (
    <div className={styles.index}>
      <div className={styles.content}>
        <h1 className={styles.heading}>Moosend Website Tracking for Shopify</h1>
        <p className={styles.text}>
          Connect your Shopify store to Moosend and use storefront activity to trigger
          email automations, with your customers&apos; privacy choices respected.
        </p>
        {showForm && (
          <Form className={styles.form} method="post" action="/auth/login">
            <label className={styles.label}>
              <span>Shop domain (development only)</span>
              <input className={styles.input} type="text" name="shop" />
              <span>e.g: my-shop-domain.myshopify.com</span>
            </label>
            <button className={styles.button} type="submit">
              Log in
            </button>
          </Form>
        )}
        <ul className={styles.list}>
          <li>
            <strong>Track the shopper journey</strong>. Send page views, product views,
            add-to-cart events and purchases to Moosend.
          </li>
          <li>
            <strong>Identify customers</strong>. Link activity to known contacts when
            customers log in or enter their email at checkout.
          </li>
          <li>
            <strong>Respect consent</strong>. Built on Shopify web pixels, so tracking
            follows your store&apos;s cookie banner and privacy settings.
          </li>
        </ul>
        <p className={styles.text}>
          Install the app from the Shopify App Store. Read our{" "}
          <a href="/privacy">privacy policy</a> or visit the <a href="/support">support page</a>.
        </p>
      </div>
    </div>
  );
}
