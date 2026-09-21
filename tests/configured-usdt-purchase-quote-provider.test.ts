import { describe, expect, it } from "vitest";

import { ConfiguredUsdtPurchaseQuoteProvider } from "../src/adapters/payments/configured-usdt-purchase-quote-provider.js";
import { buildPurchaseOrderPaymentContract } from "../src/core/payments/purchase-order-payment.js";

const packageSnapshot = {
  packageCode: "energy-10",
  count: 10,
  priceUsdtMicros: 17_000_000n,
};

function provider(
  overrides: Partial<{
    toAddress: string;
    tokenContractAddress: string;
    requiredConfirmations: number;
    quoteTtlMs: number | null;
  }> = {},
): ConfiguredUsdtPurchaseQuoteProvider {
  return new ConfiguredUsdtPurchaseQuoteProvider({
    toAddress: "  TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL  ",
    tokenContractAddress:
      "  TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t  ",
    requiredConfirmations: 2,
    quoteTtlMs: null,
    ...overrides,
  });
}

describe("ConfiguredUsdtPurchaseQuoteProvider", () => {
  it("returns exact canonical USDT-micro economics without floating point conversion", async () => {
    await expect(
      provider().quote({
        package: packageSnapshot,
        asset: "USDT",
        requestedAt: new Date("2026-09-21T14:00:00.000Z"),
      }),
    ).resolves.toEqual({
      kind: "ready",
      quote: {
        asset: "USDT",
        toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        tokenContractAddress:
          "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        amountAtomic: 17_000_000n,
        requiredConfirmations: 2,
        expiresAt: null,
      },
    });
  });

  it("adds an expiry only when quote TTL is explicitly configured", async () => {
    const requestedAt = new Date("2026-09-21T14:00:00.000Z");

    await expect(
      provider({ quoteTtlMs: 120_000 }).quote({
        package: packageSnapshot,
        asset: "USDT",
        requestedAt,
      }),
    ).resolves.toEqual({
      kind: "ready",
      quote: {
        asset: "USDT",
        toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        tokenContractAddress:
          "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        amountAtomic: 17_000_000n,
        requiredConfirmations: 2,
        expiresAt: new Date("2026-09-21T14:02:00.000Z"),
      },
    });
  });

  it("keeps TRX unsupported instead of inventing an exchange-rate formula", async () => {
    await expect(
      provider().quote({
        package: packageSnapshot,
        asset: "TRX",
        requestedAt: new Date("2026-09-21T14:00:00.000Z"),
      }),
    ).resolves.toEqual({
      kind: "unsupported_asset",
      asset: "TRX",
    });
  });

  it("rejects malformed package or request timestamps", async () => {
    const configured = provider();

    await expect(
      configured.quote({
        package: { ...packageSnapshot, priceUsdtMicros: 0n },
        asset: "USDT",
        requestedAt: new Date("2026-09-21T14:00:00.000Z"),
      }),
    ).resolves.toEqual({ kind: "invalid_request" });

    await expect(
      configured.quote({
        package: packageSnapshot,
        asset: "USDT",
        requestedAt: new Date(Number.NaN),
      }),
    ).resolves.toEqual({ kind: "invalid_request" });
  });

  it("fails closed on invalid configuration", () => {
    expect(
      () =>
        provider({
          toAddress: "   ",
        }),
    ).toThrow(/toAddress/);

    expect(
      () =>
        provider({
          tokenContractAddress: "   ",
        }),
    ).toThrow(/tokenContractAddress/);

    expect(
      () =>
        provider({
          requiredConfirmations: 0,
        }),
    ).toThrow(/requiredConfirmations/);

    expect(
      () =>
        provider({
          quoteTtlMs: 1.5,
        }),
    ).toThrow(/quoteTtlMs/);
  });

  it("feeds directly into the existing purchase-order payment contract", async () => {
    const quoteResult = await provider().quote({
      package: packageSnapshot,
      asset: "USDT",
      requestedAt: new Date("2026-09-21T14:00:00.000Z"),
    });

    expect(quoteResult.kind).toBe("ready");

    if (quoteResult.kind !== "ready") {
      throw new Error("Expected a ready quote");
    }

    expect(
      buildPurchaseOrderPaymentContract({
        package: packageSnapshot,
        quote: quoteResult.quote,
      }),
    ).toMatchObject({
      kind: "ready",
      snapshot: {
        paymentAsset: "USDT",
        quotedAmountAtomic: 17_000_000n,
      },
      expectation: {
        asset: "USDT",
        amountAtomic: 17_000_000n,
      },
    });
  });
});
