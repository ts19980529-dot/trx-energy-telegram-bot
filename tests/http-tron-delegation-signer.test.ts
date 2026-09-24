import { describe, expect, it } from "vitest";

import { HttpTronDelegationSigner } from "../src/adapters/signer/http-tron-delegation-signer.js";

const TXID = "a".repeat(64);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpTronDelegationSigner", () => {
  it("authenticates sign requests and returns the signed transaction", async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const signer = new HttpTronDelegationSigner(
      {
        baseUrl: "http://signer.railway.internal:8080",
        authToken: " signer-token ",
        timeoutMs: 3_000,
      },
      async (input, init) => {
        calls.push([input, init]);
        return response({
          txid: TXID,
          transaction: {
            txID: TXID,
            signature: ["1b".padStart(130, "0")],
          },
        });
      },
    );

    await expect(
      signer.sign({
        attemptKey: "delivery:attempt:1",
        unsigned: {
          txid: TXID,
          transaction: { txID: TXID },
        },
      }),
    ).resolves.toMatchObject({ txid: TXID });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe(
      "http://signer.railway.internal:8080/v1/sign",
    );
    const headers = new Headers(calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer signer-token");
    expect(headers.get("content-type")).toBe("application/json");
    expect(calls[0]?.[1]?.redirect).toBe("error");
  });

  it("maps signer recovery 404 to undefined", async () => {
    const signer = new HttpTronDelegationSigner(
      {
        baseUrl: "http://signer.railway.internal:8080",
        authToken: "token",
        timeoutMs: 3_000,
      },
      async () => response({ error: "not_found" }, 404),
    );

    await expect(
      signer.findSignedByAttemptKey("delivery:attempt:1"),
    ).resolves.toBeUndefined();
  });

  it("fails closed without exposing signer response details", async () => {
    const signer = new HttpTronDelegationSigner(
      {
        baseUrl: "http://signer.railway.internal:8080",
        authToken: "token",
        timeoutMs: 3_000,
      },
      async () => response({ private: "do-not-expose" }, 500),
    );

    await expect(
      signer.findSignedByAttemptKey("delivery:attempt:1"),
    ).rejects.toThrow("TRON signer request failed (500)");
  });
});
