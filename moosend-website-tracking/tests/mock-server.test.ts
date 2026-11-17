import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  startMockMoosendServer,
  type MockMoosendServer,
} from "../app/services/moosend/mock-server";

let mock: MockMoosendServer;
beforeAll(async () => {
  mock = await startMockMoosendServer({ apiKey: "secret" });
});
afterAll(async () => {
  await mock.close();
});

const valid = {
  eventId: "e-1",
  websiteId: "w",
  event: "PAGE_VIEW",
  occurredAt: "2026-11-17T00:00:00Z",
  visitor: { anonymousId: "a" },
  data: {},
};

function post(body: unknown, headers: Record<string, string> = { "X-Api-Key": "secret" }) {
  return fetch(`${mock.url}/track`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("mock Moosend receiver", () => {
  it("rejects requests without the expected API key", async () => {
    expect((await post(valid, {})).status).toBe(401);
  });

  it("validates required fields", async () => {
    expect((await post({ eventId: "x" })).status).toBe(422);
  });

  it("accepts valid events and treats repeated event IDs idempotently", async () => {
    expect((await post(valid)).status).toBe(202);
    const again = await post(valid);
    expect(await again.json()).toEqual({ accepted: true, duplicate: true });
    const list = await (await fetch(`${mock.url}/events`)).json();
    expect(list.count).toBe(1);
  });

  it("simulates failures on demand", async () => {
    expect((await post({ ...valid, eventId: "e-2" }, { "X-Api-Key": "secret", "x-mock-fail": "always500" })).status).toBe(500);
  });
});
