import { describe, expect, it } from "vitest";

import { NodeFetchTronDelegationTransport } from "../src/adapters/tron/tron-delegation-http-transport.js";
import type { TronHttpTransportConfig } from "../src/adapters/tron/tron-http-transport.js";

const TXID = "a".repeat(64);
const EXPIRATION_MS = 1_800_000_000_000;
const OWNER = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
const RECIPIENT = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

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

function delegationTransaction(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    txID: TXID,
    raw_data: {
      expiration: EXPIRATION_MS,
      contract: [
        {
          type: "DelegateResourceContract",
          parameter: {
            value: {
              owner_address: OWNER,
              receiver_address: RECIPIENT,
              balance: 18_055_556,
              resource: "ENERGY",
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

function reclaimTransaction(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    txID: TXID,
    raw_data: {
      expiration: EXPIRATION_MS,
      contract: [
        {
          type: "UnDelegateResourceContract",
          parameter: {
            value: {
              owner_address: OWNER,
              receiver_address: RECIPIENT,
              balance: 18_055_556,
              resource: "ENERGY",
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

describe("NodeFetchTronDelegationTransport", () => {
  it("reads Energy resource and delegation capacity with the API key", async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const fetchImpl = async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push([input, init]);
      const url = input.toString();

      if (url.endsWith("/wallet/getaccountresource")) {
        return response({
          TotalEnergyLimit: "180000000000",
          TotalEnergyWeight: "50000000",
        });
      }

      if (url.endsWith("/wallet/getcandelegatedmaxsize")) {
        return response({ max_size: "99000000" });
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const transport = new NodeFetchTronDelegationTransport(
      { ...baseConfig, apiKey: " secret-key " },
      fetchImpl,
    );

    await expect(
      transport.getEnergyResourceSnapshot(OWNER),
    ).resolves.toEqual({
      totalEnergyLimit: 180_000_000_000n,
      totalEnergyWeight: 50_000_000n,
    });

    await expect(
      transport.getCanDelegatedEnergySun(OWNER),
    ).resolves.toBe(99_000_000n);

    expect(calls).toHaveLength(2);

    for (const [, init] of calls) {
      const headers = init?.headers as Record<string, string>;
      expect(headers["TRON-PRO-API-KEY"]).toBe("secret-key");
      expect(headers["content-type"]).toBe("application/json");
      expect(init?.method).toBe("POST");
    }

    expect(calls[0]![0]).toBe(
      "https://head.example.test/wallet/getaccountresource",
    );
    expect(calls[0]![1]?.body).toBe(
      JSON.stringify({
        address: OWNER,
        visible: true,
      }),
    );

    expect(calls[1]![0]).toBe(
      "https://head.example.test/wallet/getcandelegatedmaxsize",
    );
    expect(calls[1]![1]?.body).toBe(
      JSON.stringify({
        owner_address: OWNER,
        type: 1,
        visible: true,
      }),
    );
  });

  it("builds a direct DelegateResource transaction with exact SUN balance", async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const fetchImpl = async (
      input: string | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      calls.push([input, init]);
      return response(delegationTransaction());
    };

    const transport = new NodeFetchTronDelegationTransport(
      baseConfig,
      fetchImpl,
    );

    await expect(
      transport.buildEnergyDelegation({
        ownerAddress: OWNER,
        recipientAddress: RECIPIENT,
        balanceSun: 18_055_556n,
      }),
    ).resolves.toEqual({
      txid: TXID,
      transaction: delegationTransaction(),
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]![0]).toBe(
      "https://head.example.test/wallet/delegateresource",
    );
    expect(calls[0]![1]?.body).toBe(
      JSON.stringify({
        owner_address: OWNER,
        receiver_address: RECIPIENT,
        balance: 18_055_556,
        resource: "ENERGY",
        lock: false,
        visible: true,
      }),
    );
  });

  it("maps successful and duplicate broadcasts to accepted", async () => {
    const responses = [
      { result: true },
      { result: false, code: "DUP_TRANSACTION_ERROR" },
    ];
    let index = 0;

    const transport = new NodeFetchTronDelegationTransport(
      baseConfig,
      async () => response(responses[index++]!),
    );

    await expect(
      transport.broadcastSignedTransaction({
        ...delegationTransaction(),
        signature: ["sig"],
      }),
    ).resolves.toBe("accepted");

    await expect(
      transport.broadcastSignedTransaction({
        ...delegationTransaction(),
        signature: ["sig"],
      }),
    ).resolves.toBe("accepted");
  });

  it("keeps ambiguous broadcast failures unknown instead of releasing balance", async () => {
    const falseTransport = new NodeFetchTronDelegationTransport(
      baseConfig,
      async () =>
        response({
          result: false,
          code: "SERVER_BUSY",
        }),
    );

    await expect(
      falseTransport.broadcastSignedTransaction(
        delegationTransaction(),
      ),
    ).resolves.toBe("unknown");

    const networkTransport = new NodeFetchTronDelegationTransport(
      baseConfig,
      async () => response({ error: "gateway" }, 503),
    );

    await expect(
      networkTransport.broadcastSignedTransaction(
        delegationTransaction(),
      ),
    ).resolves.toBe("unknown");
  });

  it("marks a solidified successful DelegateResource transaction completed", async () => {
    const fetchImpl = async (
      input: string | URL,
    ): Promise<Response> => {
      const url = input.toString();

      if (
        url.endsWith(
          "/walletsolidity/gettransactionbyid",
        )
      ) {
        return response(
          delegationTransaction({
            ret: [{ contractRet: "SUCCESS" }],
          }),
        );
      }

      if (
        url.endsWith(
          "/walletsolidity/gettransactioninfobyid",
        )
      ) {
        return response({});
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const transport = new NodeFetchTronDelegationTransport(
      baseConfig,
      fetchImpl,
    );

    await expect(
      transport.getTransactionObservation({ txid: TXID, expirationAt: new Date(EXPIRATION_MS) }),
    ).resolves.toEqual({ status: "completed" });
  });

  it("keeps a head-only transaction processing until solidity confirms it", async () => {
    const fetchImpl = async (
      input: string | URL,
    ): Promise<Response> => {
      const url = input.toString();

      if (url.includes("/walletsolidity/")) {
        return response({});
      }

      if (url.endsWith("/wallet/gettransactionbyid")) {
        return response(delegationTransaction());
      }

      throw new Error(`Unexpected URL: ${url}`);
    };

    const transport = new NodeFetchTronDelegationTransport(
      baseConfig,
      fetchImpl,
    );

    await expect(
      transport.getTransactionObservation({ txid: TXID, expirationAt: new Date(EXPIRATION_MS) }),
    ).resolves.toEqual({ status: "processing" });
  });

  it("keeps absence unknown until the solidified chain reaches expiration", async () => {
    const transport = new NodeFetchTronDelegationTransport(
      baseConfig,
      async (input) => {
        const url = input.toString();
        if (url.endsWith("/walletsolidity/getnowblock")) {
          return response({
            block_header: {
              raw_data: { timestamp: EXPIRATION_MS - 1 },
            },
          });
        }
        return response({});
      },
    );

    await expect(
      transport.getTransactionObservation({
        txid: TXID,
        expirationAt: new Date(EXPIRATION_MS),
      }),
    ).resolves.toEqual({ status: "unknown" });
  });

  it("fails closed on a mismatched txid or wrong contract type", async () => {
    const wrongTxidTransport =
      new NodeFetchTronDelegationTransport(
        baseConfig,
        async (input) => {
          const url = input.toString();

          if (
            url.endsWith(
              "/walletsolidity/gettransactionbyid",
            )
          ) {
            return response(
              delegationTransaction({
                txID: "b".repeat(64),
              }),
            );
          }

          return response({});
        },
      );

    await expect(
      wrongTxidTransport.getTransactionObservation({ txid: TXID, expirationAt: new Date(EXPIRATION_MS) }),
    ).resolves.toEqual({ status: "unknown" });

    const wrongTypeTransport =
      new NodeFetchTronDelegationTransport(
        baseConfig,
        async (input) => {
          const url = input.toString();

          if (
            url.endsWith(
              "/walletsolidity/gettransactionbyid",
            )
          ) {
            return response({
              ...delegationTransaction(),
              raw_data: {
                contract: [
                  {
                    type: "TransferContract",
                  },
                ],
              },
            });
          }

          return response({});
        },
      );

    await expect(
      wrongTypeTransport.getTransactionObservation({ txid: TXID, expirationAt: new Date(EXPIRATION_MS) }),
    ).resolves.toEqual({ status: "unknown" });
  });

  it("rejects unsafe delegation amounts before a network call", async () => {
    let callCount = 0;
    const transport = new NodeFetchTronDelegationTransport(
      baseConfig,
      async () => {
        callCount += 1;
        return response({});
      },
    );

    await expect(
      transport.buildEnergyDelegation({
        ownerAddress: OWNER,
        recipientAddress: RECIPIENT,
        balanceSun:
          BigInt(Number.MAX_SAFE_INTEGER) + 1n,
      }),
    ).rejects.toThrow(/safe JSON integer range/);

    expect(callCount).toBe(0);
  });
  it("proves absence only after head and solidity miss the tx and solidified time reaches expiration", async () => {
    const calls: string[] = [];
    const transport = new NodeFetchTronDelegationTransport(
      baseConfig,
      async (input, init) => {
        const url = input.toString();
        calls.push(`${init?.method ?? ""} ${url}`);
        if (url.endsWith("/walletsolidity/getnowblock")) {
          return response({
            block_header: {
              raw_data: { timestamp: EXPIRATION_MS },
            },
          });
        }
        return response({});
      },
    );

    await expect(
      transport.getTransactionObservation({
        txid: TXID,
        expirationAt: new Date(EXPIRATION_MS),
      }),
    ).resolves.toEqual({
      status: "absent",
      solidifiedObservedAt: new Date(EXPIRATION_MS),
    });
    expect(calls.some((call) => call.startsWith("GET ") && call.endsWith("/walletsolidity/getnowblock"))).toBe(true);
  });

  it("builds exact UnDelegateResource and observes only that contract type", async () => {
    const calls: Array<[string | URL, RequestInit | undefined]> = [];
    const builder = new NodeFetchTronDelegationTransport(
      baseConfig,
      async (input, init) => {
        calls.push([input, init]);
        return response(reclaimTransaction());
      },
    );

    await expect(
      builder.buildEnergyReclaim({
        ownerAddress: OWNER,
        recipientAddress: RECIPIENT,
        balanceSun: 18_055_556n,
      }),
    ).resolves.toEqual({
      txid: TXID,
      transaction: reclaimTransaction(),
    });
    expect(calls[0]?.[0]).toBe(
      "https://head.example.test/wallet/undelegateresource",
    );
    expect(calls[0]?.[1]?.body).toBe(
      JSON.stringify({
        owner_address: OWNER,
        receiver_address: RECIPIENT,
        balance: 18_055_556,
        resource: "ENERGY",
        visible: true,
      }),
    );

    const observer = new NodeFetchTronDelegationTransport(
      baseConfig,
      async (input) => {
        const url = input.toString();
        if (url.endsWith("/walletsolidity/gettransactionbyid")) {
          return response(reclaimTransaction({ ret: [{ contractRet: "SUCCESS" }] }));
        }
        if (url.endsWith("/walletsolidity/gettransactioninfobyid")) {
          return response({});
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    );
    await expect(
      observer.getReclaimTransactionObservation({
        txid: TXID,
        expirationAt: new Date(EXPIRATION_MS),
      }),
    ).resolves.toEqual({ status: "completed" });

    const wrongContract = new NodeFetchTronDelegationTransport(
      baseConfig,
      async (input) => {
        const url = input.toString();
        if (url.endsWith("/walletsolidity/gettransactionbyid")) {
          return response(delegationTransaction({ ret: [{ contractRet: "SUCCESS" }] }));
        }
        if (url.endsWith("/walletsolidity/gettransactioninfobyid")) {
          return response({});
        }
        throw new Error(`Unexpected URL: ${url}`);
      },
    );
    await expect(
      wrongContract.getReclaimTransactionObservation({
        txid: TXID,
        expirationAt: new Date(EXPIRATION_MS),
      }),
    ).resolves.toEqual({ status: "unknown" });
  });


});
