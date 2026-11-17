import { z } from "zod";
import type { Shop } from "@prisma/client";
import prisma from "../db.server";
import { isDestinationConfigured } from "../config.server";
import { decryptNullable, encrypt, maskSecret, randomToken } from "../lib/crypto.server";
import { ITEM_CODE_SOURCES, type ItemCodeSource } from "./moosend/types";
import type { ShopTrackingSettings } from "./moosend/mapping";

export const PIXEL_STATUS = {
  NOT_CONNECTED: "NOT_CONNECTED",
  CONNECTED: "CONNECTED",
  ERROR: "ERROR",
} as const;

/** Creates the tenant record on first install and re-activates it on reinstall. */
export async function ensureShop(shopDomain: string): Promise<Shop> {
  return prisma.shop.upsert({
    where: { shopDomain },
    create: { shopDomain, ingestKey: randomToken(24) },
    update: { uninstalledAt: null },
  });
}

export async function getShop(shopDomain: string): Promise<Shop | null> {
  return prisma.shop.findUnique({ where: { shopDomain } });
}

export function isShopConfigured(shop: Shop): boolean {
  return Boolean(shop.moosendWebsiteId && shop.moosendApiKeyEnc);
}

/** True when storefront events should be collected and delivered for the shop. */
export function isTrackingActive(shop: Shop): boolean {
  return (
    !shop.uninstalledAt &&
    shop.trackingEnabled &&
    isShopConfigured(shop) &&
    isDestinationConfigured()
  );
}

export function getTrackingSettings(shop: Shop): ShopTrackingSettings {
  const source = ITEM_CODE_SOURCES.includes(shop.itemCodeSource as ItemCodeSource)
    ? (shop.itemCodeSource as ItemCodeSource)
    : "SKU_OR_VARIANT_ID";
  return {
    itemCodeSource: source,
    customEventsEnabled: shop.customEventsEnabled,
    checkoutAsAddToOrder: shop.checkoutAsAddToOrder,
  };
}

export function getApiKey(shop: Shop): string | null {
  return decryptNullable(shop.moosendApiKeyEnc);
}

export const settingsSchema = z.object({
  moosendWebsiteId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9-]{8,64}$/, "Enter the Website ID shown in Moosend (letters, numbers and dashes)."),
  // Blank means "keep the stored key".
  moosendApiKey: z
    .string()
    .trim()
    .max(256, "API key is too long.")
    .optional()
    .transform((value) => (value ? value : undefined)),
  trackingEnabled: z.boolean(),
  customEventsEnabled: z.boolean(),
  webhookPurchaseFallback: z.boolean(),
  checkoutAsAddToOrder: z.boolean(),
  itemCodeSource: z.enum(ITEM_CODE_SOURCES as [ItemCodeSource, ...ItemCodeSource[]]),
});

export type SettingsInput = z.input<typeof settingsSchema>;

export type SettingsResult =
  | { ok: true; shop: Shop }
  | { ok: false; errors: Record<string, string> };

export async function updateSettings(
  shopDomain: string,
  input: SettingsInput,
): Promise<SettingsResult> {
  const parsed = settingsSchema.safeParse(input);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      errors[String(issue.path[0] ?? "form")] = issue.message;
    }
    return { ok: false, errors };
  }
  const shop = await getShop(shopDomain);
  if (!shop) return { ok: false, errors: { form: "Shop not found." } };

  const data = parsed.data;
  if (!data.moosendApiKey && !shop.moosendApiKeyEnc) {
    return { ok: false, errors: { moosendApiKey: "Enter your Moosend API key." } };
  }

  const updated = await prisma.shop.update({
    where: { id: shop.id },
    data: {
      moosendWebsiteId: data.moosendWebsiteId,
      ...(data.moosendApiKey ? { moosendApiKeyEnc: encrypt(data.moosendApiKey) } : {}),
      trackingEnabled: data.trackingEnabled,
      customEventsEnabled: data.customEventsEnabled,
      webhookPurchaseFallback: data.webhookPurchaseFallback,
      checkoutAsAddToOrder: data.checkoutAsAddToOrder,
      itemCodeSource: data.itemCodeSource,
    },
  });
  if (!updated.trackingEnabled) {
    await cancelPendingEvents(updated.id, "Tracking disabled by merchant");
  }
  return { ok: true, shop: updated };
}

/** Removes the Moosend credentials and stops tracking. */
export async function disconnectMoosend(shopDomain: string): Promise<Shop | null> {
  const shop = await getShop(shopDomain);
  if (!shop) return null;
  const updated = await prisma.shop.update({
    where: { id: shop.id },
    data: { moosendApiKeyEnc: null, trackingEnabled: false },
  });
  await cancelPendingEvents(shop.id, "Moosend disconnected");
  return updated;
}

export async function cancelPendingEvents(shopId: string, reason: string) {
  await prisma.outboxEvent.updateMany({
    where: { shopId, status: { in: ["PENDING", "SENDING"] } },
    data: { status: "CANCELLED", lastError: reason, lockedUntil: null },
  });
}

/** app/uninstalled: stop all processing; data is erased on shop/redact. */
export async function markUninstalled(shopDomain: string): Promise<void> {
  const shop = await getShop(shopDomain);
  if (!shop) return;
  await prisma.shop.update({
    where: { id: shop.id },
    data: {
      uninstalledAt: new Date(),
      webPixelId: null,
      pixelStatus: PIXEL_STATUS.NOT_CONNECTED,
      pixelError: null,
    },
  });
  await cancelPendingEvents(shop.id, "App uninstalled");
}

export interface ShopView {
  shopDomain: string;
  trackingEnabled: boolean;
  moosendWebsiteId: string;
  apiKeyMasked: string | null;
  hasApiKey: boolean;
  itemCodeSource: ItemCodeSource;
  customEventsEnabled: boolean;
  webhookPurchaseFallback: boolean;
  checkoutAsAddToOrder: boolean;
  pixelStatus: string;
  pixelError: string | null;
  pixelSyncedAt: string | null;
  lastDeliveryAt: string | null;
  lastDeliveryError: string | null;
  lastDeliveryErrorAt: string | null;
  destinationConfigured: boolean;
  configured: boolean;
  active: boolean;
}

/** Browser-safe projection of the shop record (never includes secrets). */
export function toShopView(shop: Shop): ShopView {
  let apiKeyMasked: string | null = null;
  try {
    apiKeyMasked = maskSecret(getApiKey(shop));
  } catch {
    apiKeyMasked = shop.moosendApiKeyEnc ? "••••••••" : null;
  }
  return {
    shopDomain: shop.shopDomain,
    trackingEnabled: shop.trackingEnabled,
    moosendWebsiteId: shop.moosendWebsiteId ?? "",
    apiKeyMasked,
    hasApiKey: Boolean(shop.moosendApiKeyEnc),
    itemCodeSource: getTrackingSettings(shop).itemCodeSource,
    customEventsEnabled: shop.customEventsEnabled,
    webhookPurchaseFallback: shop.webhookPurchaseFallback,
    checkoutAsAddToOrder: shop.checkoutAsAddToOrder,
    pixelStatus: shop.pixelStatus,
    pixelError: shop.pixelError,
    pixelSyncedAt: shop.pixelSyncedAt?.toISOString() ?? null,
    lastDeliveryAt: shop.lastDeliveryAt?.toISOString() ?? null,
    lastDeliveryError: shop.lastDeliveryError,
    lastDeliveryErrorAt: shop.lastDeliveryErrorAt?.toISOString() ?? null,
    destinationConfigured: isDestinationConfigured(),
    configured: isShopConfigured(shop),
    active: isTrackingActive(shop),
  };
}
