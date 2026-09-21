import { describe, expect, it } from "vitest";

import {
  TronReadAdapterError,
  TronReadPaymentFinalityVerifier,
} from "../src/adapters/tron/tron-read-finality-verifier.js";
import {
  resolveTronReadEndpoint,
  tronReadOperations,
} from "../src/adapters/tron/tron-read-endpoints.js";
import type { PaymentIdentity } from "../src/core/payments/payment-observation.js";
import type {
  TronPaymentEvidenceReader,
  TronReadOutcome,
  TronReadView,
} from "../src/core/payments/tron-read-source.js";
import type {
  RawTronPaymentEvidence,
  TronAddressCodec,
  TronEncodedAddress,
} from "../src/core/payments/tron-evidence-normalization.js";

const FROM = "TDpBe64DqirkRnmj6nYfRkrFt7Kf4ji7dD";
const TO = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";

const codec: TronAddressCodec = {
  name: "identity-test-codec",
  toBase58Check(address: TronEncodedAddress): string | undefined {
    return address.encoding === "base58check" ? address.value : undefined;
  },
};

const identity: PaymentIdentity = {
  asset: "USDT",
  txid: "b".repeat(64),
  tokenContractAddress: USDT,
  eventIndex: 7,
};

function solidifiedEvidence(
  overrides: Partial<Extract<RawTronPaymentEvidence, { asset: "USDT" }>> = {},
): Extract<RawTronPaymentEvidence, { asset: "USDT" }> {
  return {
    asset: "USDT",
    txid: "B".repeat(64),
    tokenContractAddress: { encoding: "base58check", value: USDT },
    eventIndex: 7,
    fromAddress: { encoding: "base58check", value: FROM },
    toAddress: { encoding: "base58check", value: TO },
    amountAtomic: "17000000",
    confirmations: 2,
    evidenceSource: "solidified_node",
    executionStatus: "success",
    blockNumber: "70000001",
    blockTimestampMs: "1790000001000",
    ...overrides,
  };
}

class FakeReader implements TronPaymentEvidenceReader {
  readonly name = "fake-reader";
  calls: Array<{ identity: PaymentIdentity; view: TronReadView }> = [];

  constructor(private readonly outcome: TronReadOutcome) {}

  async readPaymentEvidence(input: {
    readonly identity: PaymentIdentity;
    readonly view: TronReadView;
  }): Promise<TronReadOutcome> {
    this.calls.push(input);
    return this.outcome;
  }
}

describe("TRON read endpoint allowlist", () => {
  it("contains only the two read operations required for known-TX inspection", () => {
    expect(tronReadOperations).toEqual([
      "transaction_body",
      "transaction_info",
    ]);
  });

  it("maps head and solidified views only to official read-only paths", () => {
    expect(resolveTronReadEndpoint("head", "transaction_body")).toBe(
      "/wallet/gettransactionbyid",
    );
    expect(resolveTronReadEndpoint("head", "transaction_info")).toBe(
      "/wallet/gettransactioninfobyid",
    );
    expect(resolveTronReadEndpoint("solidified", "transaction_body")).toBe(
      "/walletsolidity/gettransactionbyid",
    );
    expect(resolveTronReadEndpoint("solidified", "transaction_info")).toBe(
      "/walletsolidity/gettransactioninfobyid",
    );
  });
});

describe("TronReadPaymentFinalityVerifier", () => {
  it("always requests the solidified view and returns normalized matching evidence", async () => {
    const reader = new FakeReader({
      kind: "found",
      evidence: solidifiedEvidence(),
    });
    const verifier = new TronReadPaymentFinalityVerifier(reader, codec);

    await expect(verifier.inspect(identity)).resolves.toMatchObject({
      asset: "USDT",
      txid: "b".repeat(64),
      tokenContractAddress: USDT,
      eventIndex: 7,
      solidified: true,
      evidenceSource: "solidified_node",
    });

    expect(reader.calls).toEqual([{ identity, view: "solidified" }]);
  });

  it("keeps a missing solidified result pending instead of treating it as failure", async () => {
    const reader = new FakeReader({ kind: "not_found" });
    const verifier = new TronReadPaymentFinalityVerifier(reader, codec);

    await expect(verifier.inspect(identity)).resolves.toBeUndefined();
  });

  it.each(["timeout", "rate_limited", "upstream_error"] as const)(
    "surfaces %s as adapter unavailability rather than not_found",
    async (reason) => {
      const reader = new FakeReader({ kind: "unavailable", reason });
      const verifier = new TronReadPaymentFinalityVerifier(reader, codec);

      await expect(verifier.inspect(identity)).rejects.toMatchObject({
        name: "TronReadAdapterError",
        reason,
      });
    },
  );

  it("fails closed when a supposed solidified read returns non-solidified evidence", async () => {
    const reader = new FakeReader({
      kind: "found",
      evidence: solidifiedEvidence({ evidenceSource: "fullnode" }),
    });
    const verifier = new TronReadPaymentFinalityVerifier(reader, codec);

    await expect(verifier.inspect(identity)).rejects.toEqual(
      new TronReadAdapterError("malformed_response"),
    );
  });

  it("fails closed when normalized evidence does not match the requested identity", async () => {
    const reader = new FakeReader({
      kind: "found",
      evidence: solidifiedEvidence({ eventIndex: 8 }),
    });
    const verifier = new TronReadPaymentFinalityVerifier(reader, codec);

    await expect(verifier.inspect(identity)).rejects.toEqual(
      new TronReadAdapterError("malformed_response"),
    );
  });

  it("fails closed when raw evidence cannot be normalized", async () => {
    const reader = new FakeReader({
      kind: "found",
      evidence: solidifiedEvidence({ txid: "not-a-txid" }),
    });
    const verifier = new TronReadPaymentFinalityVerifier(reader, codec);

    await expect(verifier.inspect(identity)).rejects.toEqual(
      new TronReadAdapterError("malformed_response"),
    );
  });
});
