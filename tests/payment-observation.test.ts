import { describe, expect, it } from "vitest";

import {
  evaluatePaymentObservation,
  paymentIdentityOf,
  type PaymentExpectation,
  type PaymentObservation,
} from "../src/core/payments/payment-observation.js";

type UsdtObservation = Extract<PaymentObservation, { asset: "USDT" }>;
type TrxObservation = Extract<PaymentObservation, { asset: "TRX" }>;

const usdtExpectation: PaymentExpectation = {
  asset: "USDT",
  tokenContractAddress: "TUSDT_CONTRACT",
  toAddress: "TPAYMENT_DESTINATION",
  amountAtomic: 17_000_000n,
  requiredConfirmations: 1,
};

function usdtObservation(
  overrides: Partial<UsdtObservation> = {},
): UsdtObservation {
  return {
    asset: "USDT",
    txid: "a".repeat(64),
    tokenContractAddress: "TUSDT_CONTRACT",
    eventIndex: 0,
    fromAddress: "TSENDER",
    toAddress: "TPAYMENT_DESTINATION",
    amountAtomic: 17_000_000n,
    confirmations: 1,
    solidified: true,
    evidenceSource: "solidified_node",
    executionStatus: "success",
    blockNumber: 123n,
    ...overrides,
  };
}

function trxObservation(
  overrides: Partial<TrxObservation> = {},
): TrxObservation {
  return {
    asset: "TRX",
    txid: "b".repeat(64),
    tokenContractAddress: null,
    eventIndex: null,
    fromAddress: "TSENDER",
    toAddress: "TPAYMENT_DESTINATION",
    amountAtomic: 1_000_000n,
    confirmations: 1,
    solidified: true,
    evidenceSource: "solidified_node",
    executionStatus: "success",
    blockNumber: 124n,
    ...overrides,
  };
}

describe("payment observation contract", () => {
  it("confirms an exact USDT match only with authoritative solidified evidence", () => {
    expect(
      evaluatePaymentObservation(usdtExpectation, usdtObservation()),
    ).toEqual({ kind: "confirmed" });
  });

  it("keeps a matching observation pending until it is solidified", () => {
    expect(
      evaluatePaymentObservation(
        usdtExpectation,
        usdtObservation({
          solidified: false,
          evidenceSource: "fullnode",
          confirmations: 30,
        }),
      ),
    ).toEqual({ kind: "pending", reason: "not_solidified" });
  });

  it("does not allow an indexer result to become final confirmation", () => {
    expect(
      evaluatePaymentObservation(
        usdtExpectation,
        usdtObservation({
          solidified: true,
          evidenceSource: "indexer",
        }),
      ),
    ).toEqual({
      kind: "pending",
      reason: "non_authoritative_finality_source",
    });
  });

  it("does not classify an unfinalized failed receipt as a final failure", () => {
    expect(
      evaluatePaymentObservation(
        usdtExpectation,
        usdtObservation({
          solidified: false,
          evidenceSource: "fullnode",
          executionStatus: "failed",
        }),
      ),
    ).toEqual({ kind: "pending", reason: "not_solidified" });
  });

  it("rejects an explicitly failed execution only after authoritative finality", () => {
    expect(
      evaluatePaymentObservation(
        usdtExpectation,
        usdtObservation({ executionStatus: "failed" }),
      ),
    ).toEqual({ kind: "rejected", reason: "execution_failed" });
  });

  it("keeps an authoritative but execution-unknown receipt pending", () => {
    expect(
      evaluatePaymentObservation(
        usdtExpectation,
        usdtObservation({ executionStatus: "unknown" }),
      ),
    ).toEqual({ kind: "pending", reason: "execution_unknown" });
  });

  it("enforces the configured confirmation-depth policy in addition to finality", () => {
    expect(
      evaluatePaymentObservation(
        { ...usdtExpectation, requiredConfirmations: 3 },
        usdtObservation({ confirmations: 2 }),
      ),
    ).toEqual({ kind: "pending", reason: "insufficient_confirmations" });
  });

  it("never auto-confirms asset, contract, destination, or amount mismatches", () => {
    expect(
      evaluatePaymentObservation(
        usdtExpectation,
        trxObservation({ amountAtomic: 17_000_000n }),
      ),
    ).toEqual({ kind: "mismatch", reason: "asset_mismatch" });

    expect(
      evaluatePaymentObservation(
        usdtExpectation,
        usdtObservation({ tokenContractAddress: "TOTHER_CONTRACT" }),
      ),
    ).toEqual({ kind: "mismatch", reason: "token_contract_mismatch" });

    expect(
      evaluatePaymentObservation(
        usdtExpectation,
        usdtObservation({ toAddress: "TOTHER_DESTINATION" }),
      ),
    ).toEqual({ kind: "mismatch", reason: "destination_mismatch" });

    expect(
      evaluatePaymentObservation(
        usdtExpectation,
        usdtObservation({ amountAtomic: 16_999_999n }),
      ),
    ).toEqual({ kind: "mismatch", reason: "amount_mismatch" });
  });

  it("rejects malformed normalized observations before business matching", () => {
    const malformed = usdtObservation({ eventIndex: -1 });

    expect(evaluatePaymentObservation(usdtExpectation, malformed)).toEqual({
      kind: "invalid",
      reason: "invalid_observation",
    });
  });

  it("derives the stable business identity for TRX and TRC-20", () => {
    expect(paymentIdentityOf(trxObservation())).toEqual({
      asset: "TRX",
      txid: "b".repeat(64),
      tokenContractAddress: null,
      eventIndex: null,
    });

    expect(paymentIdentityOf(usdtObservation({ eventIndex: 7 }))).toEqual({
      asset: "USDT",
      txid: "a".repeat(64),
      tokenContractAddress: "TUSDT_CONTRACT",
      eventIndex: 7,
    });
  });
});
