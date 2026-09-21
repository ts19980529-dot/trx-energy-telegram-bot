import { describe, expect, it } from "vitest";

import {
  evaluatePaymentObservation,
  type PaymentExpectation,
} from "../src/core/payments/payment-observation.js";
import {
  normalizeTronPaymentEvidence,
  type RawTronPaymentEvidence,
  type TronAddressCodec,
  type TronEncodedAddress,
} from "../src/core/payments/tron-evidence-normalization.js";

const FROM_BASE58 = "TDpBe64DqirkRnmj6nYfRkrFt7Kf4ji7dD";
const TO_BASE58 = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
const USDT_BASE58 = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const FROM_HEX = `41${"11".repeat(20)}`;
const TO_HEX = `41${"22".repeat(20)}`;
const USDT_HEX = `41${"33".repeat(20)}`;

const addressMap = new Map<string, string>([
  [FROM_HEX, FROM_BASE58],
  [TO_HEX, TO_BASE58],
  [USDT_HEX, USDT_BASE58],
  [FROM_BASE58, FROM_BASE58],
  [TO_BASE58, TO_BASE58],
  [USDT_BASE58, USDT_BASE58],
]);

const codec: TronAddressCodec = {
  name: "test-codec",
  toBase58Check(address: TronEncodedAddress): string | undefined {
    return addressMap.get(address.value);
  },
};

function trxEvidence(
  overrides: Partial<Extract<RawTronPaymentEvidence, { asset: "TRX" }>> = {},
): Extract<RawTronPaymentEvidence, { asset: "TRX" }> {
  return {
    asset: "TRX",
    txid: "A".repeat(64),
    tokenContractAddress: null,
    eventIndex: null,
    fromAddress: { encoding: "hex41", value: FROM_HEX },
    toAddress: { encoding: "hex41", value: TO_HEX },
    amountAtomic: "1000000",
    confirmations: 2,
    evidenceSource: "fullnode",
    executionStatus: "success",
    blockNumber: "70000000",
    blockTimestampMs: "1790000000000",
    ...overrides,
  };
}

function usdtEvidence(
  overrides: Partial<Extract<RawTronPaymentEvidence, { asset: "USDT" }>> = {},
): Extract<RawTronPaymentEvidence, { asset: "USDT" }> {
  return {
    asset: "USDT",
    txid: "B".repeat(64),
    tokenContractAddress: { encoding: "hex41", value: USDT_HEX },
    eventIndex: 0,
    fromAddress: { encoding: "base58check", value: FROM_BASE58 },
    toAddress: { encoding: "hex41", value: TO_HEX },
    amountAtomic: "17000000",
    confirmations: 3,
    evidenceSource: "solidified_node",
    executionStatus: "success",
    blockNumber: "70000001",
    blockTimestampMs: "1790000001000",
    ...overrides,
  };
}

describe("TRON payment evidence normalization", () => {
  it("normalizes TRX addresses, txid, atomic amount and block metadata", () => {
    expect(normalizeTronPaymentEvidence(trxEvidence(), codec)).toEqual({
      asset: "TRX",
      txid: "a".repeat(64),
      tokenContractAddress: null,
      eventIndex: null,
      fromAddress: FROM_BASE58,
      toAddress: TO_BASE58,
      amountAtomic: 1_000_000n,
      confirmations: 2,
      solidified: false,
      evidenceSource: "fullnode",
      executionStatus: "success",
      blockNumber: 70_000_000n,
      blockTimestamp: new Date(1_790_000_000_000),
    });
  });

  it("normalizes TRC-20 contract/address identity and preserves event position", () => {
    const normalized = normalizeTronPaymentEvidence(
      usdtEvidence({ eventIndex: 7 }),
      codec,
    );

    expect(normalized).toEqual({
      asset: "USDT",
      txid: "b".repeat(64),
      tokenContractAddress: USDT_BASE58,
      eventIndex: 7,
      fromAddress: FROM_BASE58,
      toAddress: TO_BASE58,
      amountAtomic: 17_000_000n,
      confirmations: 3,
      solidified: true,
      evidenceSource: "solidified_node",
      executionStatus: "success",
      blockNumber: 70_000_001n,
      blockTimestamp: new Date(1_790_000_001_000),
    });
  });

  it("derives solidification only from authoritative evidence source", () => {
    expect(
      normalizeTronPaymentEvidence(
        usdtEvidence({ evidenceSource: "indexer" }),
        codec,
      )?.solidified,
    ).toBe(false);

    expect(
      normalizeTronPaymentEvidence(
        usdtEvidence({ evidenceSource: "solidified_index" }),
        codec,
      )?.solidified,
    ).toBe(true);
  });

  it("rejects malformed transaction IDs", () => {
    expect(
      normalizeTronPaymentEvidence(trxEvidence({ txid: "not-a-txid" }), codec),
    ).toBeUndefined();
  });

  it("parses atomic amounts as bigint and rejects unsafe numeric shapes", () => {
    const exact = normalizeTronPaymentEvidence(
      trxEvidence({ amountAtomic: "900719925474099312345" }),
      codec,
    );

    expect(exact?.amountAtomic).toBe(900719925474099312345n);

    for (const amountAtomic of ["0", "-1", "1.5", "01", "1e6"]) {
      expect(
        normalizeTronPaymentEvidence(trxEvidence({ amountAtomic }), codec),
      ).toBeUndefined();
    }
  });

  it("rejects invalid event positions and confirmation counts", () => {
    expect(
      normalizeTronPaymentEvidence(usdtEvidence({ eventIndex: -1 }), codec),
    ).toBeUndefined();

    expect(
      normalizeTronPaymentEvidence(
        trxEvidence({ confirmations: -1 }),
        codec,
      ),
    ).toBeUndefined();
  });

  it("rejects invalid block numbers and timestamps", () => {
    expect(
      normalizeTronPaymentEvidence(
        trxEvidence({ blockNumber: "-1" }),
        codec,
      ),
    ).toBeUndefined();

    expect(
      normalizeTronPaymentEvidence(
        trxEvidence({ blockTimestampMs: "99999999999999999" }),
        codec,
      ),
    ).toBeUndefined();
  });

  it("fails closed when the address codec cannot validate or convert an address", () => {
    const badCodec: TronAddressCodec = {
      name: "reject-all",
      toBase58Check(): string | undefined {
        return undefined;
      },
    };

    expect(
      normalizeTronPaymentEvidence(usdtEvidence(), badCodec),
    ).toBeUndefined();
  });

  it("feeds canonical solidified evidence into the existing payment evaluator", () => {
    const observation = normalizeTronPaymentEvidence(usdtEvidence(), codec);
    const expectation: PaymentExpectation = {
      asset: "USDT",
      tokenContractAddress: USDT_BASE58,
      toAddress: TO_BASE58,
      amountAtomic: 17_000_000n,
      requiredConfirmations: 2,
    };

    expect(observation).toBeDefined();
    expect(evaluatePaymentObservation(expectation, observation!)).toEqual({
      kind: "confirmed",
    });
  });

  it("keeps normalized FullNode evidence pending even when other fields match", () => {
    const observation = normalizeTronPaymentEvidence(
      trxEvidence({ confirmations: 30 }),
      codec,
    );
    const expectation: PaymentExpectation = {
      asset: "TRX",
      tokenContractAddress: null,
      toAddress: TO_BASE58,
      amountAtomic: 1_000_000n,
      requiredConfirmations: 1,
    };

    expect(observation).toBeDefined();
    expect(evaluatePaymentObservation(expectation, observation!)).toEqual({
      kind: "pending",
      reason: "not_solidified",
    });
  });
});
