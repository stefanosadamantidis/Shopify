import { afterEach, describe, expect, it } from "vitest";
import { config, isDestinationConfigured } from "../app/config.server";

const saved = { ...process.env };
afterEach(() => {
  process.env = { ...saved };
});

describe("configuration defaults", () => {
  it("hides the manual shop-domain login form unless explicitly enabled (App Store 2.3.1)", () => {
    delete process.env.SHOW_LOGIN_FORM;
    expect(config.showLoginForm).toBe(false);
    process.env.SHOW_LOGIN_FORM = "true";
    expect(config.showLoginForm).toBe(true);
  });

  it("treats a missing or invalid Moosend endpoint as not configured", () => {
    process.env.MOOSEND_TRACKING_ENDPOINT = "";
    expect(isDestinationConfigured()).toBe(false);
    process.env.MOOSEND_TRACKING_ENDPOINT = "not a url";
    expect(isDestinationConfigured()).toBe(false);
    process.env.MOOSEND_TRACKING_ENDPOINT = "https://tracking.example/track";
    expect(isDestinationConfigured()).toBe(true);
  });

  it("uses safe delivery defaults", () => {
    delete process.env.OUTBOX_MAX_ATTEMPTS;
    delete process.env.MOOSEND_API_KEY_HEADER;
    expect(config.maxAttempts).toBe(8);
    expect(config.moosendApiKeyHeader).toBe("X-Api-Key");
  });
});
