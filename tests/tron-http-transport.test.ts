import { describe, expect, it } from "vitest";

import {
  NodeFetchTronReadHttpTransport,
  type TronHttpTransportConfig,
} from "../src/adapters/tron/tron-http-transport.js";

const TXID = "A".repeat(64);

const baseConfig: TronHttpTransportConfig = {
  headBaseUrl: "https://head.example.test",
  solidifiedBaseUrl: "https://solid.example.test",
  timeoutMs: 5_000,
};

function response(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("NodeFetchTronReadHttpTransport", () => {
  it("uses the allowlisted head endpoint with POST and normalized txid", async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const fetchImpl = async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push([input, init]);
      return response({ txID: TXID.toLowerCase() });
    };
    const transport = new NodeFetchTronReadHttpTransport(baseConfig, fetchImpl);

    await expect(
      transport.postTransactionRead({
        view: "head",
        operation: "transaction_body",
        txid: TXID,
      }),
    ).resolves.toMatchObject({ kind: "ok" });

    expect(calls).toHaveLength(1);
    const [url, init] = calls[0]!;

    expect(url).toBe(
      "https://head.example.test/wallet/gettransactionbyid",
    );
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ value: TXID.toLowerCase() }));
  });

  it("uses the solidified base URL for finality reads", async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const fetchImpl = async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push([input, init]);
      return response({ id: TXID.toLowerCase() });
    };
    const transport = new NodeFetchTronReadHttpTransport(baseConfig, fetchImpl);

    await transport.postTransactionRead({
      view: "solidified",
      operation: "transaction_info",
      txid: TXID,
    });

    expect(calls[0]![0]).toBe(
      "https://solid.example.test/walletsolidity/gettransactioninfobyid",
    );
  });

  it("adds TRON-PRO-API-KEY only when supplied", async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const fetchImpl = async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push([input, init]);
      return response({ id: TXID.toLowerCase() });
    };
    const transport = new NodeFetchTronReadHttpTransport(
      { ...baseConfig, apiKey: " secret-key " },
      fetchImpl,
    );

    await transport.postTransactionRead({
      view: "solidified",
      operation: "transaction_info",
      txid: TXID,
    });

    const headers = calls[0]![1]?.headers as Record<string, string>;

    expect(headers["TRON-PRO-API-KEY"]).toBe("secret-key");
    expect(headers["content-type"]).toBe("application/json");
  });

  it("maps an empty object to not_found instead of failure", async () => {
    const transport = new NodeFetchTronReadHttpTransport(
      baseConfig,
      async () => response({}),
    );

    await expect(
      transport.postTransactionRead({
        view: "solidified",
        operation: "transaction_info",
        txid: TXID,
      }),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("maps HTTP 200 Error bodies to upstream_error", async () => {
    const transport = new NodeFetchTronReadHttpTransport(
      baseConfig,
      async () => response({ Error: "node exception" }),
    );

    await expect(
      transport.postTransactionRead({
        view: "solidified",
        operation: "transaction_info",
        txid: TXID,
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "upstream_error",
    });
  });

  it("maps rate limits and access failures without treating them as not_found", async () => {
    const cases: Array<[number, unknown, string]> = [
      [429, { error: "too many requests" }, "rate_limited"],
      [403, { error: "frequency limit exceeded" }, "rate_limited"],
      [403, { error: "forbidden" }, "access_denied"],
      [401, { error: "unauthorized" }, "access_denied"],
    ];

    for (const [status, body, reason] of cases) {
      const transport = new NodeFetchTronReadHttpTransport(
        baseConfig,
        async () => response(body, status),
      );

      await expect(
        transport.postTransactionRead({
          view: "solidified",
          operation: "transaction_info",
          txid: TXID,
        }),
      ).resolves.toEqual({
        kind: "unavailable",
        reason,
      });
    }
  });

  it("maps other non-2xx responses to upstream_error", async () => {
    const transport = new NodeFetchTronReadHttpTransport(
      baseConfig,
      async () => response({ error: "gateway" }, 503),
    );

    await expect(
      transport.postTransactionRead({
        view: "head",
        operation: "transaction_body",
        txid: TXID,
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "upstream_error",
    });
  });

  it("fails closed on invalid JSON responses", async () => {
    const transport = new NodeFetchTronReadHttpTransport(
      baseConfig,
      async () => new Response("not-json", { status: 200 }),
    );

    await expect(
      transport.postTransactionRead({
        view: "head",
        operation: "transaction_body",
        txid: TXID,
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed_response",
    });
  });

  it("maps aborted or timed-out fetches to timeout", async () => {
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";

    const transport = new NodeFetchTronReadHttpTransport(
      baseConfig,
      async () => {
        throw timeoutError;
      },
    );

    await expect(
      transport.postTransactionRead({
        view: "head",
        operation: "transaction_body",
        txid: TXID,
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "timeout",
    });
  });

  it("rejects unsafe base URLs and malformed configuration", () => {
    expect(
      () =>
        new NodeFetchTronReadHttpTransport({
          ...baseConfig,
          headBaseUrl: "https://user:pass@example.test",
        }),
    ).toThrow(/headBaseUrl/);

    expect(
      () =>
        new NodeFetchTronReadHttpTransport({
          ...baseConfig,
          solidifiedBaseUrl: "https://solid.example.test/api",
        }),
    ).toThrow(/solidifiedBaseUrl/);

    expect(
      () =>
        new NodeFetchTronReadHttpTransport({
          ...baseConfig,
          timeoutMs: 0,
        }),
    ).toThrow(/timeoutMs/);

    expect(
      () =>
        new NodeFetchTronReadHttpTransport({
          ...baseConfig,
          apiKey: "   ",
        }),
    ).toThrow(/apiKey/);
  });

  it("rejects malformed txids before any network call", async () => {
    let callCount = 0;
    const fetchImpl = async (): Promise<Response> => {
      callCount += 1;
      return response({});
    };
    const transport = new NodeFetchTronReadHttpTransport(baseConfig, fetchImpl);

    await expect(
      transport.postTransactionRead({
        view: "head",
        operation: "transaction_body",
        txid: "bad-txid",
      }),
    ).rejects.toThrow(/txid/);

    expect(callCount).toBe(0);
  });
});
