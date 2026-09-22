import { describe, expect, it } from "vitest";

import {
  adminRoleLabel,
  formatPurchaseOrderInstructions,
  formatUsdtMicros,
  packageButtonLabel,
  packageCallbackData,
  packagePaymentCallbackData,
  parsePackageCallbackData,
  parsePackagePaymentCallbackData,
} from "../src/adapters/telegram/package-menu.js";

const id = "123e4567-e89b-12d3-a456-426614174000";

describe("Telegram package UI", () => {
  it("formats USDT micros without floating-point arithmetic", () => {
    expect(formatUsdtMicros(4_250_000n)).toBe("4.25");
    expect(formatUsdtMicros(4_000_001n)).toBe("4.000001");
  });

  it("builds stable package callback data", () => {
    expect(packageCallbackData(id)).toBe(`package:view:${id}`);
    expect(parsePackageCallbackData(`package:view:${id}`)).toBe(id);
    expect(parsePackageCallbackData("package:view:not-a-uuid")).toBeUndefined();
  });

  it("builds and parses payment method callback data", () => {
    expect(packagePaymentCallbackData(id, "USDT")).toBe(
      `package:pay:USDT:${id}`,
    );
    expect(
      parsePackagePaymentCallbackData(`package:pay:USDT:${id}`),
    ).toEqual({
      asset: "USDT",
      packageId: id,
    });
    expect(
      parsePackagePaymentCallbackData(`package:pay:TRX:${id}`),
    ).toEqual({
      asset: "TRX",
      packageId: id,
    });
    expect(
      parsePackagePaymentCallbackData("package:pay:BTC:not-a-uuid"),
    ).toBeUndefined();
  });

  it("renders exact USDT payment instructions from the frozen order snapshot", () => {
    expect(
      formatPurchaseOrderInstructions({
        id: "22222222-2222-4222-8222-222222222222",
        userId: "33333333-3333-4333-8333-333333333333",
        packageId: id,
        idempotencyKey: "telegram:purchase:callback-1",
        status: "waiting_payment",
        payment: {
          packageCodeSnapshot: "demo",
          countSnapshot: 3,
          priceUsdtMicrosSnapshot: 4_250_000n,
          paymentAttributionOffsetAtomic: 137n,
          paymentAsset: "USDT",
          paymentToAddressSnapshot: "TTEST_DESTINATION",
          paymentTokenContractAddressSnapshot: "TTEST_USDT",
          requiredConfirmationsSnapshot: 2,
          quotedAmountAtomic: 4_250_137n,
          quoteExpiresAt: new Date("2026-09-22T03:00:00.000Z"),
        },
        expectation: {
          asset: "USDT",
          tokenContractAddress: "TTEST_USDT",
          toAddress: "TTEST_DESTINATION",
          amountAtomic: 4_250_137n,
          requiredConfirmations: 2,
        },
      }),
    ).toContain("应付金额：4.250137 USDT");
  });

  it("renders package and admin labels in Chinese", () => {
    expect(
      packageButtonLabel({
        id,
        code: "demo",
        count: 3,
        priceUsdtMicros: 4_250_000n,
      }),
    ).toBe("3 笔 · 4.25 USDT");

    expect(adminRoleLabel("SUPER_ADMIN")).toBe("超级管理员");
  });
});
