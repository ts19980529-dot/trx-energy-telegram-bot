import { describe, expect, it } from "vitest";

import {
  TronGridCandidateAdapterError,
  TronGridUsdtPaymentDetector,
} from "../src/adapters/tron/trongrid-usdt-payment-detector.js";
import type {
  TronGridCandidatePageResult,
  TronGridUsdtCandidateHttpTransport,
} from "../src/adapters/tron/trongrid-candidate-http-transport.js";
import type {
  TronAddressCodec,
  TronEncodedAddress,
} from "../src/core/payments/tron-evidence-normalization.js";

const DESTINATION = `T${"1".repeat(33)}`;
const TOKEN = `T${"2".repeat(33)}`;
const SENDER = `T${"3".repeat(33)}`;
const OTHER_DESTINATION = `T${"4".repeat(33)}`;
const TXID = "A".repeat(64);
const SECOND_TXID = "B".repeat(64);

const EVENT_SENDER = `0x${"11".repeat(20)}`;
const EVENT_DESTINATION = `0x${"22".repeat(20)}`;
const EVENT_OTHER_DESTINATION = `0x${"44".repeat(20)}`;

class FakeAddressCodec implements TronAddressCodec {
  readonly name = "fake-address-codec";

  toBase58Check(
    address: TronEncodedAddress,
  ): string | undefined {
    if (address.encoding === "base58check") {
      return address.value;
    }

    if (address.value === `41${"11".repeat(20)}`) {
      return SENDER;
    }

    if (address.value === `41${"22".repeat(20)}`) {
      return DESTINATION;
    }

    if (address.value === `41${"44".repeat(20)}`) {
      return OTHER_DESTINATION;
    }

    return undefined;
  }
}

class FakeTransport implements TronGridUsdtCandidateHttpTransport {
  readonly name = "fake-trongrid";
  readonly historyCalls: Array<{
    toAddress: string;
    tokenContractAddress: string;
    cursor?: string;
  }> = [];
  readonly eventCalls: string[] = [];

  constructor(
    private readonly historyResult: TronGridCandidatePageResult,
    private readonly eventResults: ReadonlyMap<
      string,
      TronGridCandidatePageResult
    >,
  ) {}

  async listIncomingUsdtTransfers(input: {
    readonly toAddress: string;
    readonly tokenContractAddress: string;
    readonly cursor?: string;
  }): Promise<TronGridCandidatePageResult> {
    this.historyCalls.push(input);
    return this.historyResult;
  }

  async listTransactionEvents(input: {
    readonly transactionId: string;
  }): Promise<TronGridCandidatePageResult> {
    this.eventCalls.push(input.transactionId);

    return (
      this.eventResults.get(input.transactionId) ?? {
        kind: "ok",
        body: { success: true, data: [] },
      }
    );
  }
}

function history(
  transactionIds: readonly string[],
  fingerprint?: string,
): TronGridCandidatePageResult {
  return {
    kind: "ok",
    body: {
      success: true,
      data: transactionIds.map((transactionId) => ({
        transaction_id: transactionId,
      })),
      meta:
        fingerprint === undefined
          ? {}
          : { fingerprint },
    },
  };
}

function transferEvent(input: {
  transactionId?: string;
  eventIndex?: number;
  contractAddress?: string;
  to?: string;
  from?: string;
  value?: string;
  eventName?: string;
} = {}): Record<string, unknown> {
  return {
    block_number: 70_000_000,
    block_timestamp: 1_790_000_000_000,
    contract_address: input.contractAddress ?? TOKEN,
    event_index: input.eventIndex ?? 7,
    event_name: input.eventName ?? "Transfer",
    result: {
      from: input.from ?? EVENT_SENDER,
      to: input.to ?? EVENT_DESTINATION,
      value: input.value ?? "17000000",
    },
    transaction_id: input.transactionId ?? TXID,
  };
}

function events(
  transactionId: string,
  items: readonly Record<string, unknown>[],
): TronGridCandidatePageResult {
  return {
    kind: "ok",
    body: {
      success: true,
      data: items.map((item) => ({
        ...item,
        transaction_id: transactionId,
      })),
    },
  };
}

describe("TronGridUsdtPaymentDetector", () => {
  it("discovers an indexed USDT candidate with exact transaction and event identity", async () => {
    const transport = new FakeTransport(
      history([TXID], "next-fingerprint"),
      new Map([
        [
          TXID.toLowerCase(),
          events(TXID.toLowerCase(), [transferEvent()]),
        ],
      ]),
    );
    const detector = new TronGridUsdtPaymentDetector(
      transport,
      new FakeAddressCodec(),
    );

    await expect(
      detector.findCandidates({
        asset: "USDT",
        tokenContractAddress: TOKEN,
        toAddress: DESTINATION,
        cursor: "current-fingerprint",
      }),
    ).resolves.toEqual({
      observations: [
        {
          asset: "USDT",
          txid: TXID.toLowerCase(),
          tokenContractAddress: TOKEN,
          eventIndex: 7,
          fromAddress: SENDER,
          toAddress: DESTINATION,
          amountAtomic: 17_000_000n,
          confirmations: 0,
          solidified: false,
          evidenceSource: "indexer",
          executionStatus: "unknown",
          blockNumber: 70_000_000n,
          blockTimestamp: new Date(1_790_000_000_000),
        },
      ],
      nextCursor: "next-fingerprint",
    });

    expect(transport.historyCalls).toEqual([
      {
        toAddress: DESTINATION,
        tokenContractAddress: TOKEN,
        cursor: "current-fingerprint",
      },
    ]);
    expect(transport.eventCalls).toEqual([
      TXID.toLowerCase(),
    ]);
  });

  it("filters unrelated events but preserves the exact matching event_index", async () => {
    const transport = new FakeTransport(
      history([TXID]),
      new Map([
        [
          TXID.toLowerCase(),
          events(TXID.toLowerCase(), [
            transferEvent({
              eventIndex: 1,
              eventName: "Approval",
            }),
            transferEvent({
              eventIndex: 2,
              contractAddress: `T${"5".repeat(33)}`,
            }),
            transferEvent({
              eventIndex: 3,
              to: EVENT_OTHER_DESTINATION,
            }),
            transferEvent({
              eventIndex: 9,
            }),
          ]),
        ],
      ]),
    );
    const detector = new TronGridUsdtPaymentDetector(
      transport,
      new FakeAddressCodec(),
    );

    const result = await detector.findCandidates({
      asset: "USDT",
      tokenContractAddress: TOKEN,
      toAddress: DESTINATION,
    });

    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]).toMatchObject({
      txid: TXID.toLowerCase(),
      eventIndex: 9,
      tokenContractAddress: TOKEN,
      toAddress: DESTINATION,
    });
  });

  it("deduplicates repeated history rows and duplicate event identities", async () => {
    const duplicate = transferEvent({ eventIndex: 4 });
    const transport = new FakeTransport(
      history([TXID, TXID, SECOND_TXID]),
      new Map([
        [
          TXID.toLowerCase(),
          events(TXID.toLowerCase(), [duplicate, duplicate]),
        ],
        [
          SECOND_TXID.toLowerCase(),
          events(SECOND_TXID.toLowerCase(), [
            transferEvent({
              transactionId: SECOND_TXID,
              eventIndex: 5,
            }),
          ]),
        ],
      ]),
    );
    const detector = new TronGridUsdtPaymentDetector(
      transport,
      new FakeAddressCodec(),
    );

    const result = await detector.findCandidates({
      asset: "USDT",
      tokenContractAddress: TOKEN,
      toAddress: DESTINATION,
    });

    expect(result.observations).toHaveLength(2);
    expect(transport.eventCalls).toEqual([
      TXID.toLowerCase(),
      SECOND_TXID.toLowerCase(),
    ]);
  });

  it("does not use the USDT detector for TRX requests", async () => {
    const transport = new FakeTransport(
      history([TXID]),
      new Map(),
    );
    const detector = new TronGridUsdtPaymentDetector(
      transport,
      new FakeAddressCodec(),
    );

    await expect(
      detector.findCandidates({
        asset: "TRX",
        tokenContractAddress: null,
        toAddress: DESTINATION,
      }),
    ).resolves.toEqual({ observations: [] });

    expect(transport.historyCalls).toHaveLength(0);
    expect(transport.eventCalls).toHaveLength(0);
  });

  it("fails closed on malformed transaction ids from history", async () => {
    const detector = new TronGridUsdtPaymentDetector(
      new FakeTransport(
        history(["bad-txid"]),
        new Map(),
      ),
      new FakeAddressCodec(),
    );

    await expect(
      detector.findCandidates({
        asset: "USDT",
        tokenContractAddress: TOKEN,
        toAddress: DESTINATION,
      }),
    ).rejects.toMatchObject({
      name: "TronGridCandidateAdapterError",
      reason: "malformed_response",
    });
  });

  it("fails closed on malformed matching Transfer event payloads", async () => {
    const malformed = transferEvent();
    malformed.result = {
      from: EVENT_SENDER,
      to: EVENT_DESTINATION,
      value: "not-a-number",
    };

    const detector = new TronGridUsdtPaymentDetector(
      new FakeTransport(
        history([TXID]),
        new Map([
          [
            TXID.toLowerCase(),
            events(TXID.toLowerCase(), [malformed]),
          ],
        ]),
      ),
      new FakeAddressCodec(),
    );

    await expect(
      detector.findCandidates({
        asset: "USDT",
        tokenContractAddress: TOKEN,
        toAddress: DESTINATION,
      }),
    ).rejects.toMatchObject({
      name: "TronGridCandidateAdapterError",
      reason: "malformed_response",
    });
  });

  it("propagates indexed-source availability failures explicitly", async () => {
    const detector = new TronGridUsdtPaymentDetector(
      new FakeTransport(
        {
          kind: "unavailable",
          reason: "rate_limited",
        },
        new Map(),
      ),
      new FakeAddressCodec(),
    );

    await expect(
      detector.findCandidates({
        asset: "USDT",
        tokenContractAddress: TOKEN,
        toAddress: DESTINATION,
      }),
    ).rejects.toEqual(
      new TronGridCandidateAdapterError("rate_limited"),
    );
  });

  it("rejects invalid USDT request addresses before contacting TronGrid", async () => {
    const transport = new FakeTransport(
      history([TXID]),
      new Map(),
    );
    const detector = new TronGridUsdtPaymentDetector(
      transport,
      new FakeAddressCodec(),
    );

    await expect(
      detector.findCandidates({
        asset: "USDT",
        tokenContractAddress: "invalid",
        toAddress: DESTINATION,
      }),
    ).rejects.toThrow(/tokenContractAddress/);

    expect(transport.historyCalls).toHaveLength(0);
  });
});
