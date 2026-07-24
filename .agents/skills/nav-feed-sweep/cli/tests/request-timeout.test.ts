import { afterEach, describe, expect, test } from "bun:test";
import { fetchFeed } from "../src/helpers";

// A stalled upstream connection (accepted socket, no response) would otherwise
// hang the CLI forever - fetch has no default timeout. Assert the feed request
// wrapper carries an AbortSignal timeout. Fails on the pre-fix code (no signal).
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchFeed request timeout", () => {
  test("passes an AbortSignal timeout to fetch", async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = (async (_url: string | URL | Request, i?: RequestInit) => {
      init = i;
      return new Response(JSON.stringify({ items: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await fetchFeed("test-token", "/api/v1/feed");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});
