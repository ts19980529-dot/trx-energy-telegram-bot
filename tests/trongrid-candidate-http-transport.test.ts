import { describe, expect, it } from "vitest";

import {
  NodeFetchTronGridUsdtCandidateHttpTransport,
  type TronGridCandidateHttpTransportConfig,
} from "../src/adapters/tron/trongrid-candidate-http-transport.js";

const baseConfig: TronGridCandidateHttpTransportConfig = {
  baseUrl: "https://api.example.test",
  timeoutMs: 5_000,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("NodeFetchTronGridUsdtCandidateHttpTransport", () => {
  it("queries only confirmed incoming TRC-20 transfers for the requested contract", async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const transport = new NodeFetchTronGridUsdtCandidateHttpTransport(
      { ...baseConfig, pageSize: 50 },
      async (input, init) => {
        calls.push([input, init]);
        return response({ data: [], meta: {} });
      },
    );

    await expect(
      transport.listIncomingUsdtTransfers({
        toAddress: "TDESTINATION",
        tokenContractAddress: "TUSDT",
      }),
    ).resolves.toMatchObject({ kind: "ok" });

    expect(calls).toHaveLength(1);

    const [rawUrl, init] = calls[0]!;
    const url = new URL(String(rawUrl));

    expect(url.origin).toBe("https://api.example.test");
    expect(url.pathname).toBe(
      "/v1/accounts/TDESTINATION/transactions/trc20",
    );
    expect(url.searchParams.get("only_confirmed")).toBe("true");
    expect(url.searchParams.get("only_to")).toBe("true");
    expect(url.searchParams.get("contract_address")).toBe("TUSDT");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("order_by")).toBe(
      "block_timestamp,desc",
    );
    expect(url.searchParams.has("fingerprint")).toBe(false);
    expect(init?.method).toBe("GET");
  });

  it("carries the exact pagination fingerprint without changing other query parameters", async () => {
    let requestedUrl: URL | undefined;

    const transport = new NodeFetchTronGridUsdtCandidateHttpTransport(
      baseConfig,
      async (input) => {
        requestedUrl = new URL(String(input));
        return response({ data: [], meta: {} });
      },
    );

    await transport.listIncomingUsdtTransfers({
      toAddress: "TDESTINATION",
      tokenContractAddress: "TUSDT",
      cursor: "next-page-fingerprint",
    });

    expect(requestedUrl?.searchParams.get("fingerprint")).toBe(
      "next-page-fingerprint",
    );
    expect(requestedUrl?.searchParams.get("only_confirmed")).toBe("true");
    expect(requestedUrl?.searchParams.get("only_to")).toBe("true");
    expect(requestedUrl?.searchParams.get("contract_address")).toBe(
      "TUSDT",
    );
  });

  it("adds TRON-PRO-API-KEY only when supplied", async () => {
    let headers: Record<string, string> | undefined;

    const transport = new NodeFetchTronGridUsdtCandidateHttpTransport(
      { ...baseConfig, apiKey: " secret-key " },
      async (_input, init) => {
        headers = init?.headers as Record<string, string>;
        return response({ data: [], meta: {} });
      },
    );

    await transport.listIncomingUsdtTransfers({
      toAddress: "TDESTINATION",
      tokenContractAddress: "TUSDT",
    });

    expect(headers?.["TRON-PRO-API-KEY"]).toBe("secret-key");
    expect(headers?.accept).toBe("application/json");
  });

  it("maps rate limits and access failures without treating them as an empty page", async () => {
    const cases: Array<[number, unknown, string]> = [
      [429, { error: "too many requests" }, "rate_limited"],
      [403, { error: "frequency limit exceeded" }, "rate_limited"],
      [403, { error: "forbidden" }, "access_denied"],
      [401, { error: "unauthorized" }, "access_denied"],
    ];

    for (const [status, body, reason] of cases) {
      const transport = new NodeFetchTronGridUsdtCandidateHttpTransport(
        baseConfig,
        async () => response(body, status),
      );

      await expect(
        transport.listIncomingUsdtTransfers({
          toAddress: "TDESTINATION",
          tokenContractAddress: "TUSDT",
        }),
      ).resolves.toEqual({
        kind: "unavailable",
        reason,
      });
    }
  });

  it("maps other non-2xx responses to upstream_error", async () => {
    const transport = new NodeFetchTronGridUsdtCandidateHttpTransport(
      baseConfig,
      async () => response({ error: "gateway" }, 503),
    );

    await expect(
      transport.listIncomingUsdtTransfers({
        toAddress: "TDESTINATION",
        tokenContractAddress: "TUSDT",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "upstream_error",
    });
  });

  it("fails closed on malformed JSON and non-object payloads", async () => {
    const invalidJson = new NodeFetchTronGridUsdtCandidateHttpTransport(
      baseConfig,
      async () => new Response("not-json", { status: 200 }),
    );

    await expect(
      invalidJson.listIncomingUsdtTransfers({
        toAddress: "TDESTINATION",
        tokenContractAddress: "TUSDT",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed_response",
    });

    const arrayPayload = new NodeFetchTronGridUsdtCandidateHttpTransport(
      baseConfig,
      async () => response([]),
    );

    await expect(
      arrayPayload.listIncomingUsdtTransfers({
        toAddress: "TDESTINATION",
        tokenContractAddress: "TUSDT",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed_response",
    });
  });

  it("maps aborted or timed-out fetches to timeout", async () => {
    const timeoutError = new Error("timed out");
    timeoutError.name = "TimeoutError";

    const transport = new NodeFetchTronGridUsdtCandidateHttpTransport(
      baseConfig,
      async () => {
        throw timeoutError;
      },
    );

    await expect(
      transport.listIncomingUsdtTransfers({
        toAddress: "TDESTINATION",
        tokenContractAddress: "TUSDT",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "timeout",
    });
  });

  it("rejects unsafe configuration before network access", () => {
    expect(
      () =>
        new NodeFetchTronGridUsdtCandidateHttpTransport({
          ...baseConfig,
          baseUrl: "https://user:pass@example.test",
        }),
    ).toThrow(/baseUrl/);

    expect(
      () =>
        new NodeFetchTronGridUsdtCandidateHttpTransport({
          ...baseConfig,
          baseUrl: "https://example.test/api",
        }),
    ).toThrow(/baseUrl/);

    expect(
      () =>
        new NodeFetchTronGridUsdtCandidateHttpTransport({
          ...baseConfig,
          timeoutMs: 0,
        }),
    ).toThrow(/timeoutMs/);

    expect(
      () =>
        new NodeFetchTronGridUsdtCandidateHttpTransport({
          ...baseConfig,
          pageSize: 201,
        }),
    ).toThrow(/pageSize/);

    expect(
      () =>
        new NodeFetchTronGridUsdtCandidateHttpTransport({
          ...baseConfig,
          apiKey: "   ",
        }),
    ).toThrow(/apiKey/);
  });

  it("rejects empty request fields before any network call", async () => {
    let callCount = 0;
    const transport = new NodeFetchTronGridUsdtCandidateHttpTransport(
      baseConfig,
      async () => {
        callCount += 1;
        return response({});
      },
    );

    expect(() =>
      transport.listIncomingUsdtTransfers({
        toAddress: "   ",
        tokenContractAddress: "TUSDT",
      }),
    ).toThrow(/toAddress/);

    expect(() =>
      transport.listIncomingUsdtTransfers({
        toAddress: "TDESTINATION",
        tokenContractAddress: "   ",
      }),
    ).toThrow(/tokenContractAddress/);

    expect(() =>
      transport.listIncomingUsdtTransfers({
        toAddress: "TDESTINATION",
        tokenContractAddress: "TUSDT",
        cursor: "   ",
      }),
    ).toThrow(/cursor/);

    expect(callCount).toBe(0);
  });
});
