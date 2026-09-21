import { describe, expect, it } from "vitest";

import {
  HttpTronPaymentEvidenceReader,
} from "../src/adapters/tron/tron-http-payment-evidence-reader.js";
import type {
  TronHttpReadResult,
  TronReadHttpTransport,
} from "../src/adapters/tron/tron-http-transport.js";
import type { PaymentIdentity } from "../src/core/payments/payment-observation.js";
import type {
  TronConfirmationDepthOutcome,
  TronConfirmationDepthProvider,
  TronReadView,
} from "../src/core/payments/tron-read-source.js";

const TXID = "a".repeat(64);
const OWNER = `41${"11".repeat(20)}`;
const TO = `41${"22".repeat(20)}`;

const identity: PaymentIdentity = {
  asset: "TRX",
  txid: TXID,
  tokenContractAddress: null,
  eventIndex: null,
};

function transaction(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    txID: TXID,
    ret: [{ contractRet: "SUCCESS" }],
    raw_data: {
      contract: [
        {
          type: "TransferContract",
          parameter: {
            value: {
              owner_address: OWNER,
              to_address: TO,
              amount: 1_000_000,
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

function transactionInfo(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: TXID,
    blockNumber: 70_000_000,
    blockTimeStamp: 1_790_000_000_000,
    receipt: { result: "SUCCESS" },
    ...overrides,
  };
}

class FakeTransport implements TronReadHttpTransport {
  readonly name = "fake-http";
  readonly calls: Array<{
    view: TronReadView;
    operation: "transaction_body" | "transaction_info";
    txid: string;
  }> = [];

  constructor(
    private readonly bodyResult: TronHttpReadResult,
    private readonly infoResult: TronHttpReadResult,
  ) {}

  async postTransactionRead(input: {
    readonly view: TronReadView;
    readonly operation: "transaction_body" | "transaction_info";
    readonly txid: string;
  }): Promise<TronHttpReadResult> {
    this.calls.push(input);

    return input.operation === "transaction_body"
      ? this.bodyResult
      : this.infoResult;
  }
}

class FakeDepthProvider implements TronConfirmationDepthProvider {
  readonly name = "fake-depth";
  readonly calls: Array<{
    view: TronReadView;
    transactionBlockNumber: string;
  }> = [];

  constructor(
    private readonly outcome: TronConfirmationDepthOutcome,
  ) {}

  async getConfirmationDepth(input: {
    readonly view: TronReadView;
    readonly transactionBlockNumber: string;
  }): Promise<TronConfirmationDepthOutcome> {
    this.calls.push(input);
    return this.outcome;
  }
}

function ok(body: Record<string, unknown>): TronHttpReadResult {
  return { kind: "ok", body };
}

describe("HttpTronPaymentEvidenceReader", () => {
  it("composes transaction body, receipt, confirmation depth and parser deterministically", async () => {
    const transport = new FakeTransport(
      ok(transaction()),
      ok(transactionInfo()),
    );
    const depth = new FakeDepthProvider({
      kind: "available",
      confirmations: 4,
    });
    const reader = new HttpTronPaymentEvidenceReader(transport, depth);

    await expect(
      reader.readPaymentEvidence({
        identity,
        view: "solidified",
      }),
    ).resolves.toEqual({
      kind: "found",
      evidence: {
        asset: "TRX",
        txid: TXID,
        tokenContractAddress: null,
        eventIndex: null,
        fromAddress: { encoding: "hex41", value: OWNER },
        toAddress: { encoding: "hex41", value: TO },
        amountAtomic: "1000000",
        confirmations: 4,
        evidenceSource: "solidified_node",
        executionStatus: "success",
        blockNumber: "70000000",
        blockTimestampMs: "1790000000000",
      },
    });

    expect(transport.calls).toEqual([
      {
        view: "solidified",
        operation: "transaction_body",
        txid: TXID,
      },
      {
        view: "solidified",
        operation: "transaction_info",
        txid: TXID,
      },
    ]);
    expect(depth.calls).toEqual([
      {
        view: "solidified",
        transactionBlockNumber: "70000000",
      },
    ]);
  });

  it("preserves the requested head view through transport, depth provider and parser", async () => {
    const transport = new FakeTransport(
      ok(transaction()),
      ok(transactionInfo()),
    );
    const depth = new FakeDepthProvider({
      kind: "available",
      confirmations: 0,
    });
    const reader = new HttpTronPaymentEvidenceReader(transport, depth);

    await expect(
      reader.readPaymentEvidence({
        identity,
        view: "head",
      }),
    ).resolves.toMatchObject({
      kind: "found",
      evidence: {
        evidenceSource: "fullnode",
        confirmations: 0,
      },
    });

    expect(depth.calls[0]).toEqual({
      view: "head",
      transactionBlockNumber: "70000000",
    });
  });

  it("gives transport unavailability precedence over not_found", async () => {
    const transport = new FakeTransport(
      { kind: "not_found" },
      { kind: "unavailable", reason: "timeout" },
    );
    const depth = new FakeDepthProvider({
      kind: "available",
      confirmations: 1,
    });
    const reader = new HttpTronPaymentEvidenceReader(transport, depth);

    await expect(
      reader.readPaymentEvidence({
        identity,
        view: "solidified",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "timeout",
    });

    expect(depth.calls).toHaveLength(0);
  });

  it("maps an absent body or receipt to not_found without asking for depth", async () => {
    for (const [bodyResult, infoResult] of [
      [{ kind: "not_found" }, ok(transactionInfo())],
      [ok(transaction()), { kind: "not_found" }],
    ] as const) {
      const transport = new FakeTransport(bodyResult, infoResult);
      const depth = new FakeDepthProvider({
        kind: "available",
        confirmations: 1,
      });
      const reader = new HttpTronPaymentEvidenceReader(transport, depth);

      await expect(
        reader.readPaymentEvidence({
          identity,
          view: "solidified",
        }),
      ).resolves.toEqual({ kind: "not_found" });

      expect(depth.calls).toHaveLength(0);
    }
  });

  it("fails closed when the receipt block number is missing or unsafe", async () => {
    for (const blockNumber of [undefined, -1, Number.MAX_SAFE_INTEGER + 1, "01"]) {
      const info = transactionInfo();

      if (blockNumber === undefined) {
        delete info.blockNumber;
      } else {
        info.blockNumber = blockNumber;
      }

      const reader = new HttpTronPaymentEvidenceReader(
        new FakeTransport(ok(transaction()), ok(info)),
        new FakeDepthProvider({
          kind: "available",
          confirmations: 1,
        }),
      );

      await expect(
        reader.readPaymentEvidence({
          identity,
          view: "solidified",
        }),
      ).resolves.toEqual({
        kind: "unavailable",
        reason: "malformed_response",
      });
    }
  });

  it("propagates confirmation-depth provider unavailability", async () => {
    const reader = new HttpTronPaymentEvidenceReader(
      new FakeTransport(ok(transaction()), ok(transactionInfo())),
      new FakeDepthProvider({
        kind: "unavailable",
        reason: "rate_limited",
      }),
    );

    await expect(
      reader.readPaymentEvidence({
        identity,
        view: "solidified",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "rate_limited",
    });
  });

  it("fails closed when the confirmation-depth provider violates its contract", async () => {
    const reader = new HttpTronPaymentEvidenceReader(
      new FakeTransport(ok(transaction()), ok(transactionInfo())),
      new FakeDepthProvider({
        kind: "available",
        confirmations: -1,
      }),
    );

    await expect(
      reader.readPaymentEvidence({
        identity,
        view: "solidified",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed_response",
    });
  });

  it("maps parser no_match to not_found instead of manufacturing evidence", async () => {
    const wrongTransaction = transaction();
    const rawData = wrongTransaction.raw_data as {
      contract: Array<Record<string, unknown>>;
    };
    rawData.contract[0] = {
      type: "TriggerSmartContract",
      parameter: { value: {} },
    };

    const reader = new HttpTronPaymentEvidenceReader(
      new FakeTransport(ok(wrongTransaction), ok(transactionInfo())),
      new FakeDepthProvider({
        kind: "available",
        confirmations: 1,
      }),
    );

    await expect(
      reader.readPaymentEvidence({
        identity,
        view: "solidified",
      }),
    ).resolves.toEqual({ kind: "not_found" });
  });

  it("maps malformed parser output to malformed_response", async () => {
    const malformedTransaction = transaction({ txID: "b".repeat(64) });
    const reader = new HttpTronPaymentEvidenceReader(
      new FakeTransport(ok(malformedTransaction), ok(transactionInfo())),
      new FakeDepthProvider({
        kind: "available",
        confirmations: 1,
      }),
    );

    await expect(
      reader.readPaymentEvidence({
        identity,
        view: "solidified",
      }),
    ).resolves.toEqual({
      kind: "unavailable",
      reason: "malformed_response",
    });
  });
});
