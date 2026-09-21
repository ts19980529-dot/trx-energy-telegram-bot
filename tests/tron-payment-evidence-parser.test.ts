import { describe, expect, it } from "vitest";

import {
  parseTronPaymentEvidence,
} from "../src/adapters/tron/tron-payment-evidence-parser.js";
import type { PaymentIdentity } from "../src/core/payments/payment-observation.js";

const TXID = "a".repeat(64);
const OWNER = `41${"11".repeat(20)}`;
const TO = `41${"22".repeat(20)}`;
const TOKEN_20 = "33".repeat(20);
const FROM_TOPIC = `${"00".repeat(12)}${"11".repeat(20)}`;
const TO_TOPIC = `${"00".repeat(12)}${"22".repeat(20)}`;
const TRANSFER_TOPIC =
  "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const AMOUNT_WORD = (17_000_000n).toString(16).padStart(64, "0");

const trxIdentity: PaymentIdentity = {
  asset: "TRX",
  txid: TXID,
  tokenContractAddress: null,
  eventIndex: null,
};

const usdtIdentity: PaymentIdentity = {
  asset: "USDT",
  txid: TXID,
  tokenContractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  eventIndex: 1,
};

function trxTransaction(overrides: Record<string, unknown> = {}) {
  return {
    txID: TXID.toUpperCase(),
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

function triggerTransaction(overrides: Record<string, unknown> = {}) {
  return {
    txID: TXID,
    ret: [{ contractRet: "SUCCESS" }],
    raw_data: {
      contract: [
        {
          type: "TriggerSmartContract",
          parameter: {
            value: {
              owner_address: OWNER,
              contract_address: `41${TOKEN_20}`,
              data: "a9059cbb",
            },
          },
        },
      ],
    },
    ...overrides,
  };
}

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    id: TXID,
    blockNumber: 70_000_000,
    blockTimeStamp: 1_790_000_000_000,
    receipt: { result: "SUCCESS" },
    log: [
      {
        address: "44".repeat(20),
        topics: [TRANSFER_TOPIC, FROM_TOPIC, TO_TOPIC],
        data: AMOUNT_WORD,
      },
      {
        address: TOKEN_20,
        topics: [TRANSFER_TOPIC, FROM_TOPIC, TO_TOPIC],
        data: AMOUNT_WORD,
      },
    ],
    ...overrides,
  };
}

describe("TRON transaction/receipt payment evidence parser", () => {
  it("parses a top-level TRX TransferContract without inventing confirmations", () => {
    expect(
      parseTronPaymentEvidence({
        identity: trxIdentity,
        view: "solidified",
        confirmations: 4,
        transaction: trxTransaction(),
        transactionInfo: receipt({ receipt: {} }),
      }),
    ).toEqual({
      kind: "evidence",
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
  });

  it("uses receipt failure when an ordinary TRX receipt explicitly reports failure", () => {
    const result = parseTronPaymentEvidence({
      identity: trxIdentity,
      view: "solidified",
      confirmations: 1,
      transaction: trxTransaction(),
      transactionInfo: receipt({ receipt: { result: "FAILED" } }),
    });

    expect(result).toMatchObject({
      kind: "evidence",
      evidence: { executionStatus: "failed" },
    });
  });

  it("does not treat a non-TransferContract transaction as top-level TRX payment", () => {
    expect(
      parseTronPaymentEvidence({
        identity: trxIdentity,
        view: "solidified",
        confirmations: 1,
        transaction: triggerTransaction(),
        transactionInfo: receipt(),
      }),
    ).toEqual({ kind: "no_match" });
  });

  it("fails closed on an unsafe numeric TRX amount", () => {
    const transaction = trxTransaction();
    const rawData = transaction.raw_data as {
      contract: Array<{ parameter: { value: Record<string, unknown> } }>;
    };
    rawData.contract[0]!.parameter.value.amount = Number.MAX_SAFE_INTEGER + 1;

    expect(
      parseTronPaymentEvidence({
        identity: trxIdentity,
        view: "solidified",
        confirmations: 1,
        transaction,
        transactionInfo: receipt(),
      }),
    ).toEqual({ kind: "malformed" });
  });

  it("parses exactly the requested successful TRC-20 Transfer event", () => {
    expect(
      parseTronPaymentEvidence({
        identity: usdtIdentity,
        view: "solidified",
        confirmations: 3,
        transaction: triggerTransaction(),
        transactionInfo: receipt(),
      }),
    ).toEqual({
      kind: "evidence",
      evidence: {
        asset: "USDT",
        txid: TXID,
        tokenContractAddress: {
          encoding: "hex41",
          value: `41${TOKEN_20}`,
        },
        eventIndex: 1,
        fromAddress: { encoding: "hex41", value: OWNER },
        toAddress: { encoding: "hex41", value: TO },
        amountAtomic: "17000000",
        confirmations: 3,
        evidenceSource: "solidified_node",
        executionStatus: "success",
        blockNumber: "70000000",
        blockTimestampMs: "1790000000000",
      },
    });
  });

  it("maps a head parse to fullnode evidence without claiming solidification", () => {
    const result = parseTronPaymentEvidence({
      identity: usdtIdentity,
      view: "head",
      confirmations: 0,
      transaction: triggerTransaction(),
      transactionInfo: receipt(),
    });

    expect(result).toMatchObject({
      kind: "evidence",
      evidence: {
        evidenceSource: "fullnode",
        confirmations: 0,
      },
    });
  });

  it("skips failed smart-contract receipts before reading Transfer logs", () => {
    expect(
      parseTronPaymentEvidence({
        identity: usdtIdentity,
        view: "solidified",
        confirmations: 1,
        transaction: triggerTransaction(),
        transactionInfo: receipt({ receipt: { result: "REVERT" } }),
      }),
    ).toEqual({ kind: "no_match" });
  });

  it("does not scan another log when the requested event position is absent", () => {
    expect(
      parseTronPaymentEvidence({
        identity: {
          ...usdtIdentity,
          eventIndex: 7,
        },
        view: "solidified",
        confirmations: 1,
        transaction: triggerTransaction(),
        transactionInfo: receipt(),
      }),
    ).toEqual({ kind: "no_match" });
  });

  it("rejects a non-Transfer topic at the requested event position", () => {
    const info = receipt();
    const logs = info.log as Array<Record<string, unknown>>;
    logs[1] = {
      ...logs[1],
      topics: ["00".repeat(32), FROM_TOPIC, TO_TOPIC],
    };

    expect(
      parseTronPaymentEvidence({
        identity: usdtIdentity,
        view: "solidified",
        confirmations: 1,
        transaction: triggerTransaction(),
        transactionInfo: info,
      }),
    ).toEqual({ kind: "no_match" });
  });

  it("fails closed on malformed TRC-20 address topics or uint256 data", () => {
    const badTopicInfo = receipt();
    const badTopicLogs = badTopicInfo.log as Array<Record<string, unknown>>;
    badTopicLogs[1] = {
      ...badTopicLogs[1],
      topics: [TRANSFER_TOPIC, "bad", TO_TOPIC],
    };

    expect(
      parseTronPaymentEvidence({
        identity: usdtIdentity,
        view: "solidified",
        confirmations: 1,
        transaction: triggerTransaction(),
        transactionInfo: badTopicInfo,
      }),
    ).toEqual({ kind: "malformed" });

    const badDataInfo = receipt();
    const badDataLogs = badDataInfo.log as Array<Record<string, unknown>>;
    badDataLogs[1] = {
      ...badDataLogs[1],
      data: "01",
    };

    expect(
      parseTronPaymentEvidence({
        identity: usdtIdentity,
        view: "solidified",
        confirmations: 1,
        transaction: triggerTransaction(),
        transactionInfo: badDataInfo,
      }),
    ).toEqual({ kind: "malformed" });
  });

  it("fails closed when transaction body and receipt do not belong to the requested TXID", () => {
    expect(
      parseTronPaymentEvidence({
        identity: usdtIdentity,
        view: "solidified",
        confirmations: 1,
        transaction: triggerTransaction({ txID: "b".repeat(64) }),
        transactionInfo: receipt(),
      }),
    ).toEqual({ kind: "malformed" });

    expect(
      parseTronPaymentEvidence({
        identity: usdtIdentity,
        view: "solidified",
        confirmations: 1,
        transaction: triggerTransaction(),
        transactionInfo: receipt({ id: "b".repeat(64) }),
      }),
    ).toEqual({ kind: "malformed" });
  });

  it("rejects invalid caller-supplied confirmation depth rather than fabricating it", () => {
    expect(
      parseTronPaymentEvidence({
        identity: trxIdentity,
        view: "solidified",
        confirmations: -1,
        transaction: trxTransaction(),
        transactionInfo: receipt(),
      }),
    ).toEqual({ kind: "malformed" });
  });
});
