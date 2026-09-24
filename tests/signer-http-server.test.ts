import { once } from "node:events";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import type {
  TronDelegationSigner,
  TronSignedDelegation,
  TronUnsignedDelegation,
} from "../src/adapters/energy/tron-own-pool-energy-provider.js";
import { createSignerHttpServer } from "../src/runtime/signer-http-server.js";

const TXID = "a".repeat(64);
const servers: ReturnType<typeof createSignerHttpServer>[] = [];

class FakeSigner implements TronDelegationSigner {
  signCalls = 0;
  recoverCalls = 0;

  async sign(input: {
    readonly attemptKey: string;
    readonly unsigned: TronUnsignedDelegation;
  }): Promise<TronSignedDelegation> {
    this.signCalls += 1;
    return {
      txid: input.unsigned.txid,
      transaction: {
        ...input.unsigned.transaction,
        txID: input.unsigned.txid,
        signature: ["1b".padStart(130, "0")],
      },
    };
  }

  async findSignedByAttemptKey(
    attemptKey: string,
  ): Promise<TronSignedDelegation | undefined> {
    this.recoverCalls += 1;
    if (attemptKey === "missing") return undefined;
    return {
      txid: TXID,
      transaction: {
        txID: TXID,
        signature: ["1b".padStart(130, "0")],
      },
    };
  }
}

async function startServer(signer: FakeSigner): Promise<string> {
  const server = createSignerHttpServer({
    signer,
    authToken: "shared-secret",
  });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) {
            resolve();
            return;
          }
          server.close(() => resolve());
        }),
    ),
  );
});

describe("TRON signer HTTP server", () => {
  it("rejects unauthorized requests before invoking the signer", async () => {
    const signer = new FakeSigner();
    const baseUrl = await startServer(signer);

    const response = await fetch(`${baseUrl}/v1/sign`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        attemptKey: "delivery:attempt:1",
        unsigned: { txid: TXID, transaction: { txID: TXID } },
      }),
    });

    expect(response.status).toBe(401);
    expect(signer.signCalls).toBe(0);
  });

  it("supports authenticated sign and durable recovery routes", async () => {
    const signer = new FakeSigner();
    const baseUrl = await startServer(signer);
    const headers = {
      authorization: "Bearer shared-secret",
      "content-type": "application/json",
    };

    const signed = await fetch(`${baseUrl}/v1/sign`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        attemptKey: "delivery:attempt:1",
        unsigned: { txid: TXID, transaction: { txID: TXID } },
      }),
    });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toMatchObject({ txid: TXID });

    const recovered = await fetch(`${baseUrl}/v1/recover`, {
      method: "POST",
      headers,
      body: JSON.stringify({ attemptKey: "delivery:attempt:1" }),
    });
    expect(recovered.status).toBe(200);
    expect(await recovered.json()).toMatchObject({ txid: TXID });

    const missing = await fetch(`${baseUrl}/v1/recover`, {
      method: "POST",
      headers,
      body: JSON.stringify({ attemptKey: "missing" }),
    });
    expect(missing.status).toBe(404);
    expect(signer.signCalls).toBe(1);
    expect(signer.recoverCalls).toBe(2);
  });
});
