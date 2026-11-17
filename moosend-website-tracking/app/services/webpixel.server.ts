import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { config } from "../config.server";
import { isTrackingActive, PIXEL_STATUS } from "./shop.server";

/**
 * Creates or updates this app's web pixel on the merchant's store via the
 * GraphQL Admin API (webPixelCreate / webPixelUpdate). Requires the
 * `write_pixels` and `read_customer_events` scopes.
 *
 * Settings keys must match extensions/moosend-web-pixel/shopify.extension.toml.
 */

export interface AdminGraphqlClient {
  graphql: (
    query: string,
    options?: { variables?: Record<string, unknown> },
  ) => Promise<Response>;
}

export interface WebPixelSettings {
  collectorUrl: string;
  ingestKey: string;
  enabled: "true" | "false";
  customEvents: "true" | "false";
}

export const COLLECTOR_PATH = "/api/pixel/events";

export function buildPixelSettings(shop: Shop): WebPixelSettings {
  return {
    collectorUrl: `${config.appUrl}${COLLECTOR_PATH}`,
    ingestKey: shop.ingestKey,
    // The pixel stays idle (subscribes to nothing) until the merchant has
    // connected Moosend and enabled tracking - no data leaves the storefront.
    enabled: isTrackingActive(shop) ? "true" : "false",
    customEvents: shop.customEventsEnabled ? "true" : "false",
  };
}

/** True when the pixel is missing, failed, or its settings are out of date. */
export function needsPixelSync(shop: Shop): boolean {
  return (
    shop.pixelStatus !== PIXEL_STATUS.CONNECTED ||
    shop.pixelSettingsJson !== JSON.stringify(buildPixelSettings(shop))
  );
}

const WEB_PIXEL_QUERY = `#graphql
  query MoosendWebPixel {
    webPixel {
      id
      settings
    }
  }`;

const WEB_PIXEL_CREATE = `#graphql
  mutation MoosendWebPixelCreate($webPixel: WebPixelInput!) {
    webPixelCreate(webPixel: $webPixel) {
      userErrors { code field message }
      webPixel { id settings }
    }
  }`;

const WEB_PIXEL_UPDATE = `#graphql
  mutation MoosendWebPixelUpdate($id: ID!, $webPixel: WebPixelInput!) {
    webPixelUpdate(id: $id, webPixel: $webPixel) {
      userErrors { code field message }
      webPixel { id settings }
    }
  }`;

interface GraphqlResult<T> {
  data?: T;
  errors?: Array<{ message: string }> | { message?: string };
}

interface UserError {
  code?: string | null;
  field?: string[] | null;
  message: string;
}

async function run<T>(
  admin: AdminGraphqlClient,
  query: string,
  variables?: Record<string, unknown>,
): Promise<GraphqlResult<T>> {
  const response = await admin.graphql(query, variables ? { variables } : undefined);
  return (await response.json()) as GraphqlResult<T>;
}

function errorMessages(errors: GraphqlResult<unknown>["errors"]): string | null {
  if (!errors) return null;
  if (Array.isArray(errors)) {
    return errors.length ? errors.map((e) => e.message).join("; ") : null;
  }
  return errors.message ?? null;
}

async function findExistingPixelId(admin: AdminGraphqlClient): Promise<string | null> {
  try {
    const result = await run<{ webPixel: { id: string } | null }>(admin, WEB_PIXEL_QUERY);
    return result.data?.webPixel?.id ?? null;
  } catch {
    // The query errors when no pixel exists for this app on the shop.
    return null;
  }
}

export type PixelSyncResult =
  | { ok: true; webPixelId: string; settings: WebPixelSettings }
  | { ok: false; error: string };

export async function syncWebPixel(
  admin: AdminGraphqlClient,
  shop: Shop,
): Promise<PixelSyncResult> {
  const settings = buildPixelSettings(shop);
  const webPixel = { settings: JSON.stringify(settings) };

  let result: PixelSyncResult;
  try {
    let pixelId = shop.webPixelId ?? (await findExistingPixelId(admin));
    let userErrors: UserError[] = [];
    let topLevelError: string | null = null;
    let returnedId: string | null = null;

    if (pixelId) {
      try {
        const update = await run<{
          webPixelUpdate: { userErrors: UserError[]; webPixel: { id: string } | null };
        }>(admin, WEB_PIXEL_UPDATE, { id: pixelId, webPixel });
        topLevelError = errorMessages(update.errors);
        userErrors = update.data?.webPixelUpdate?.userErrors ?? [];
        returnedId = update.data?.webPixelUpdate?.webPixel?.id ?? null;
      } catch (error) {
        topLevelError = error instanceof Error ? error.message : String(error);
      }
      // Stored ID is stale (e.g. pixel removed); fall back to create.
      if (!returnedId && (topLevelError || userErrors.some((e) => e.code === "NOT_FOUND"))) {
        pixelId = null;
      }
    }

    if (!pixelId) {
      const create = await run<{
        webPixelCreate: { userErrors: UserError[]; webPixel: { id: string } | null };
      }>(admin, WEB_PIXEL_CREATE, { webPixel });
      topLevelError = errorMessages(create.errors);
      userErrors = create.data?.webPixelCreate?.userErrors ?? [];
      returnedId = create.data?.webPixelCreate?.webPixel?.id ?? null;

      if (!returnedId && userErrors.some((e) => e.code === "TAKEN")) {
        const existingId = await findExistingPixelId(admin);
        if (existingId) {
          const update = await run<{
            webPixelUpdate: { userErrors: UserError[]; webPixel: { id: string } | null };
          }>(admin, WEB_PIXEL_UPDATE, { id: existingId, webPixel });
          topLevelError = errorMessages(update.errors);
          userErrors = update.data?.webPixelUpdate?.userErrors ?? [];
          returnedId = update.data?.webPixelUpdate?.webPixel?.id ?? null;
        }
      }
    }

    if (returnedId) {
      result = { ok: true, webPixelId: returnedId, settings };
    } else {
      const message =
        userErrors.map((e) => e.message).join("; ") ||
        topLevelError ||
        "Unknown error while configuring the web pixel";
      result = { ok: false, error: message };
    }
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  await prisma.shop.update({
    where: { id: shop.id },
    data: result.ok
      ? {
          webPixelId: result.webPixelId,
          pixelStatus: PIXEL_STATUS.CONNECTED,
          pixelError: null,
          pixelSyncedAt: new Date(),
          pixelSettingsJson: webPixel.settings,
        }
      : { pixelStatus: PIXEL_STATUS.ERROR, pixelError: result.error.slice(0, 500) },
  });
  return result;
}
