import { describe, expect, it } from "vitest";

import { HttpTronReclaimSigner } from "../src/adapters/signer/http-tron-reclaim-signer.js";

const TXID = "a".repeat(64);

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpTronReclaimSigner", () => {
  it("uses dedicated authenticated reclaim signer routes", async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const signer = new HttpTronReclaimSigner(
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
        attemptKey: "delivery:attempt:1:reclaim:1",
        unsigned: {
          txid: TXID,
          transaction: { txID: TXID },
        },
      }),
    ).resolves.toMatchObject({ txid: TXID });

    expect(calls[0]?.[0]).toBe(
      "http://signer.railway.internal:8080/v1/reclaim/sign",
    );
    const headers = new Headers(calls[0]?.[1]?.headers);
    expect(headers.get("authorization")).toBe("Bearer signer-token");
  });

  it("maps dedicated reclaim recovery 404 to undefined", async () => {
    const signer = new HttpTronReclaimSigner(
      {
        baseUrl: "http://signer.railway.internal:8080",
        authToken: "token",
        timeoutMs: 3_000,
      },
      async () => response({ error: "not_found" }, 404),
    );

    await expect(
      signer.findSignedByAttemptKey("delivery:attempt:1:reclaim:1"),
    ).resolves.toBeUndefined();
  });
});
