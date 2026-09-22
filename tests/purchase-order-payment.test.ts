import { describe, expect, it } from "vitest";

import {
  buildPurchaseOrderPaymentContract,
  paymentExpectationFromOrderSnapshot,
  type PurchaseOrderPaymentSnapshot,
} from "../src/core/payments/purchase-order-payment.js";

const usdtPackage = {
  packageCode: "energy-10",
  count: 10,
  priceUsdtMicros: 17_000_000n,
};

describe("purchase-order payment contract", () => {
  it("creates an immutable USDT payment snapshot and matching expectation", () => {
    const expiry = new Date("2026-09-21T14:00:00.000Z");

    const result = buildPurchaseOrderPaymentContract({
      package: usdtPackage,
      quote: {
        asset: "USDT",
        toAddress: "  TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL  ",
        tokenContractAddress:
          "  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t  ",
        amountAtomic: 17_000_000n,
        requiredConfirmations: 2,
        expiresAt: expiry,
      },
    });

    expect(result).toEqual({
      kind: "ready",
      snapshot: {
        packageCodeSnapshot: "energy-10",
        countSnapshot: 10,
        priceUsdtMicrosSnapshot: 17_000_000n,
        paymentAttributionOffsetAtomic: 0n,
        paymentAsset: "USDT",
        paymentToAddressSnapshot:
          "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        paymentTokenContractAddressSnapshot:
          "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        requiredConfirmationsSnapshot: 2,
        quotedAmountAtomic: 17_000_000n,
        quoteExpiresAt: expiry,
      },
      expectation: {
        asset: "USDT",
        tokenContractAddress:
          "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        amountAtomic: 17_000_000n,
        requiredConfirmations: 2,
      },
    });

    if (result.kind === "ready") {
      expect(result.snapshot.quoteExpiresAt).not.toBe(expiry);
      expect(result.snapshot.quoteExpiresAt?.getTime()).toBe(
        expiry.getTime(),
      );
    }
  });

  it("rejects a USDT quote whose atomic amount differs from the canonical package price", () => {
    expect(
      buildPurchaseOrderPaymentContract({
        package: usdtPackage,
        quote: {
          asset: "USDT",
          toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
          tokenContractAddress:
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
          amountAtomic: 16_999_999n,
          requiredConfirmations: 1,
        },
      }),
    ).toEqual({
      kind: "invalid",
      reason: "usdt_amount_mismatch",
    });
  });

  it("applies an explicit non-negative USDT attribution offset without changing the canonical package price", () => {
    const result = buildPurchaseOrderPaymentContract({
      package: usdtPackage,
      quote: {
        asset: "USDT",
        toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        tokenContractAddress:
          "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        amountAtomic: 17_000_000n,
        requiredConfirmations: 2,
      },
      attributionOffsetAtomic: 137n,
    });

    expect(result).toMatchObject({
      kind: "ready",
      snapshot: {
        priceUsdtMicrosSnapshot: 17_000_000n,
        paymentAttributionOffsetAtomic: 137n,
        quotedAmountAtomic: 17_000_137n,
      },
      expectation: {
        amountAtomic: 17_000_137n,
      },
    });
  });

  it("rejects negative USDT attribution offsets and any TRX attribution offset", () => {
    expect(
      buildPurchaseOrderPaymentContract({
        package: usdtPackage,
        quote: {
          asset: "USDT",
          toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
          tokenContractAddress:
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
          amountAtomic: 17_000_000n,
          requiredConfirmations: 1,
        },
        attributionOffsetAtomic: -1n,
      }),
    ).toEqual({
      kind: "invalid",
      reason: "invalid_attribution_offset",
    });

    expect(
      buildPurchaseOrderPaymentContract({
        package: usdtPackage,
        quote: {
          asset: "TRX",
          toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
          tokenContractAddress: null,
          amountAtomic: 50_000_000n,
          requiredConfirmations: 1,
        },
        attributionOffsetAtomic: 1n,
      }),
    ).toEqual({
      kind: "invalid",
      reason: "invalid_attribution_offset",
    });
  });

  it("requires a token contract for USDT and forbids one for top-level TRX", () => {
    expect(
      buildPurchaseOrderPaymentContract({
        package: usdtPackage,
        quote: {
          asset: "USDT",
          toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
          tokenContractAddress: null,
          amountAtomic: 17_000_000n,
          requiredConfirmations: 1,
        },
      }),
    ).toEqual({
      kind: "invalid",
      reason: "asset_contract_mismatch",
    });

    expect(
      buildPurchaseOrderPaymentContract({
        package: usdtPackage,
        quote: {
          asset: "TRX",
          toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
          tokenContractAddress:
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
          amountAtomic: 50_000_000n,
          requiredConfirmations: 1,
        },
      }),
    ).toEqual({
      kind: "invalid",
      reason: "asset_contract_mismatch",
    });
  });

  it("accepts an explicit positive TRX quote without deriving an exchange-rate formula", () => {
    const result = buildPurchaseOrderPaymentContract({
      package: usdtPackage,
      quote: {
        asset: "TRX",
        toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        tokenContractAddress: null,
        amountAtomic: 55_123_456n,
        requiredConfirmations: 3,
        expiresAt: new Date("2026-09-21T14:05:00.000Z"),
      },
    });

    expect(result).toMatchObject({
      kind: "ready",
      snapshot: {
        paymentAsset: "TRX",
        paymentTokenContractAddressSnapshot: null,
        quotedAmountAtomic: 55_123_456n,
      },
      expectation: {
        asset: "TRX",
        tokenContractAddress: null,
        amountAtomic: 55_123_456n,
        requiredConfirmations: 3,
      },
    });
  });

  it("rejects invalid package snapshots before any order economics are frozen", () => {
    for (const packageInput of [
      { ...usdtPackage, packageCode: "   " },
      { ...usdtPackage, count: 0 },
      { ...usdtPackage, count: 1.5 },
      { ...usdtPackage, priceUsdtMicros: 0n },
    ]) {
      expect(
        buildPurchaseOrderPaymentContract({
          package: packageInput,
          quote: {
            asset: "USDT",
            toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
            tokenContractAddress:
              "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
            amountAtomic: 17_000_000n,
            requiredConfirmations: 1,
          },
        }),
      ).toEqual({
        kind: "invalid",
        reason: "invalid_package_snapshot",
      });
    }
  });

  it("rejects invalid destination, amount, confirmation depth or expiry", () => {
    const invalidQuotes = [
      {
        toAddress: " ",
        amountAtomic: 17_000_000n,
        requiredConfirmations: 1,
      },
      {
        toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        amountAtomic: 0n,
        requiredConfirmations: 1,
      },
      {
        toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        amountAtomic: 17_000_000n,
        requiredConfirmations: 0,
      },
      {
        toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        amountAtomic: 17_000_000n,
        requiredConfirmations: 1.5,
      },
    ];

    for (const quote of invalidQuotes) {
      expect(
        buildPurchaseOrderPaymentContract({
          package: usdtPackage,
          quote: {
            asset: "USDT",
            tokenContractAddress:
              "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
            ...quote,
          },
        }),
      ).toEqual({
        kind: "invalid",
        reason: "invalid_quote",
      });
    }

    expect(
      buildPurchaseOrderPaymentContract({
        package: usdtPackage,
        quote: {
          asset: "USDT",
          toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
          tokenContractAddress:
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
          amountAtomic: 17_000_000n,
          requiredConfirmations: 1,
          expiresAt: new Date(Number.NaN),
        },
      }),
    ).toEqual({
      kind: "invalid",
      reason: "invalid_quote",
    });
  });

  it("fails closed when a persisted snapshot cannot satisfy payment invariants", () => {
    const corrupted: PurchaseOrderPaymentSnapshot = {
      packageCodeSnapshot: "energy-10",
      countSnapshot: 10,
      priceUsdtMicrosSnapshot: 17_000_000n,
      paymentAsset: "USDT",
      paymentToAddressSnapshot:
        "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
      paymentTokenContractAddressSnapshot:
        "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      requiredConfirmationsSnapshot: 2,
      quotedAmountAtomic: 18_000_000n,
      quoteExpiresAt: null,
    };

    expect(
      paymentExpectationFromOrderSnapshot(corrupted),
    ).toBeUndefined();
  });

  it("reconstructs PaymentExpectation only from persisted immutable snapshots", () => {
    const persisted: PurchaseOrderPaymentSnapshot = {
      packageCodeSnapshot: "energy-20",
      countSnapshot: 20,
      priceUsdtMicrosSnapshot: 34_000_000n,
      paymentAsset: "TRX",
      paymentToAddressSnapshot:
        "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
      paymentTokenContractAddressSnapshot: null,
      requiredConfirmationsSnapshot: 4,
      quotedAmountAtomic: 100_000_000n,
      quoteExpiresAt: new Date("2026-09-21T14:10:00.000Z"),
    };

    expect(
      paymentExpectationFromOrderSnapshot(persisted),
    ).toEqual({
      asset: "TRX",
      tokenContractAddress: null,
      toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
      amountAtomic: 100_000_000n,
      requiredConfirmations: 4,
    });
  });
});
