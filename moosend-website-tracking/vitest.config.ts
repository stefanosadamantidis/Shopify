import { defineConfig } from "vitest/config";

const testEnv = {
  NODE_ENV: "test",
  DATABASE_URL: "file:./test.sqlite",
  APP_ENCRYPTION_KEY: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
  SHOPIFY_API_KEY: "test-api-key",
  SHOPIFY_API_SECRET: "test-api-secret",
  SHOPIFY_APP_URL: "https://moosend-app.test",
  SCOPES: "read_customer_events,read_orders,write_pixels",
  MOOSEND_TRACKING_ENDPOINT: "http://127.0.0.1:9/track",
  MOOSEND_API_KEY_HEADER: "X-Api-Key",
  ORDER_FALLBACK_DELAY_SECONDS: "300",
  WORKER_ENABLED: "false",
};

// Make the values visible to globalSetup (main process) as well as workers.
Object.assign(process.env, testEnv);

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    globalSetup: ["tests/global-setup.ts"],
    env: testEnv,
    // Tests share one SQLite database file.
    fileParallelism: false,
    pool: "forks",
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
