import { useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData } from "react-router";

import { config } from "../../config.server";
import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return { errors, showForm: config.showLoginForm };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (!config.showLoginForm) {
    return { errors: {}, showForm: false };
  }
  const errors = loginErrorMessage(await login(request));

  return { errors, showForm: true };
};

export default function Auth() {
  const loaderData = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const [shop, setShop] = useState("");
  const { errors, showForm } = actionData || loaderData;

  return (
    <>
      <script src="https://cdn.shopify.com/shopifycloud/polaris.js" />
      <s-page>
        {showForm ? (
          <Form method="post">
            <s-section heading="Log in (development only)">
              <s-text-field
                name="shop"
                label="Shop domain"
                details="example.myshopify.com"
                value={shop}
                onChange={(e) => setShop(e.currentTarget.value)}
                autocomplete="on"
                error={errors.shop}
              ></s-text-field>
              <s-button type="submit">Log in</s-button>
            </s-section>
          </Form>
        ) : (
          <s-section heading="Open the app from Shopify">
            <s-paragraph>
              To use Moosend Website Tracking, install it from the Shopify App Store,
              or open it from Apps in your Shopify admin.
            </s-paragraph>
          </s-section>
        )}
      </s-page>
    </>
  );
}
