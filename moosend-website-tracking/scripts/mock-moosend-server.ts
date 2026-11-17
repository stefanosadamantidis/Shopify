// Starts the mock Moosend receiver for local development.
// Usage: npm run mock:moosend
import {
  startMockMoosendServer,
  type MockFailMode,
} from "../app/services/moosend/mock-server.ts";

const port = Number(process.env.MOCK_MOOSEND_PORT || 4010);
const failMode = (process.env.MOCK_MOOSEND_FAIL_MODE || "none") as MockFailMode;

const mock = await startMockMoosendServer({
  port,
  host: "0.0.0.0",
  apiKey: process.env.MOCK_MOOSEND_API_KEY || undefined,
  apiKeyHeader: process.env.MOOSEND_API_KEY_HEADER || "X-Api-Key",
  failMode,
  log: true,
});

console.log(`[mock-moosend] listening on http://localhost:${port}/track (fail mode: ${failMode})`);
console.log(`[mock-moosend] inspect received events: GET http://localhost:${port}/events`);

const shutdown = () => {
  mock.close().finally(() => process.exit(0));
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
