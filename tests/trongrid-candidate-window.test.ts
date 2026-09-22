import { describe, expect, it } from "vitest";

import { NodeFetchTronGridUsdtCandidateHttpTransport } from "../src/adapters/tron/trongrid-candidate-http-transport.js";

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("TronGrid candidate scan window", () => {
  it("pins min/max timestamps across paginated account-history requests", async () => {
    const urls: URL[] = [];
    const transport = new NodeFetchTronGridUsdtCandidateHttpTransport(
      {
        baseUrl: "https://api.example.test",
        timeoutMs: 5_000,
        pageSize: 200,
      },
      async (input) => {
        urls.push(new URL(String(input)));
        return response({ data: [], meta: {} });
      },
    );

    await transport.listIncomingUsdtTransfers({
      toAddress: "TDESTINATION",
      tokenContractAddress: "TUSDT",
      minTimestampMs: 1_790_000_000_000,
      maxTimestampMs: 1_790_000_900_000,
      cursor: "same-window-page-2",
    });

    expect(urls).toHaveLength(1);
    expect(urls[0]?.searchParams.get("min_timestamp")).toBe(
      "1790000000000",
    );
    expect(urls[0]?.searchParams.get("max_timestamp")).toBe(
      "1790000900000",
    );
    expect(urls[0]?.searchParams.get("fingerprint")).toBe(
      "same-window-page-2",
    );
  });

  it("rejects invalid or reversed scan windows before fetch", () => {
    const transport = new NodeFetchTronGridUsdtCandidateHttpTransport({
      baseUrl: "https://api.example.test",
      timeoutMs: 5_000,
    });

    expect(() =>
      transport.listIncomingUsdtTransfers({
        toAddress: "TDESTINATION",
        tokenContractAddress: "TUSDT",
        minTimestampMs: -1,
      }),
    ).toThrow(/minTimestampMs/);

    expect(() =>
      transport.listIncomingUsdtTransfers({
        toAddress: "TDESTINATION",
        tokenContractAddress: "TUSDT",
        minTimestampMs: 2,
        maxTimestampMs: 1,
      }),
    ).toThrow(/must not exceed/);
  });
});
