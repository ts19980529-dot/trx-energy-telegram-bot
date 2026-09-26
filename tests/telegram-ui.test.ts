import { describe, expect, it } from "vitest";

import {
  adminRoleLabel,
  buildOrderStatusKeyboard,
  buildPackageKeyboard,
  buildPaymentMethodKeyboard,
  buildPurchaseOrderListKeyboard,
  formatPurchaseOrderInstructions,
  formatPurchaseOrderStatus,
  formatUsdtMicros,
  orderStatusCallbackData,
  parseOrderStatusCallbackData,
  packageButtonLabel,
  packageCallbackData,
  packagePaymentCallbackData,
  parsePackageCallbackData,
  parsePackagePaymentCallbackData,
  parsePurchaseOrdersPageCallbackData,
  purchaseOrdersPageCallbackData,
} from "../src/adapters/telegram/package-menu.js";

const id = "123e4567-e89b-12d3-a456-426614174000";

describe("Telegram package UI", () => {
  it("formats USDT micros without floating-point arithmetic", () => {
    expect(formatUsdtMicros(4_250_000n)).toBe("4.25");
    expect(formatUsdtMicros(4_000_001n)).toBe("4.000001");
  });

  it("keeps package selection navigable back to home", () => {
    const labels = buildPackageKeyboard([
      {
        id,
        code: "demo",
        count: 10,
        priceUsdtMicros: 17_000_000n,
      },
    ]).inline_keyboard.flat().map((button) => button.text);

    expect(labels).toEqual([
      "10 笔",
      "返回主菜单",
    ]);
  });

  it("builds stable package callback data", () => {
    expect(packageCallbackData(id)).toBe(`package:view:${id}`);
    expect(parsePackageCallbackData(`package:view:${id}`)).toBe(id);
    expect(parsePackageCallbackData("package:view:not-a-uuid")).toBeUndefined();
  });

  it("builds and parses payment method callback data", () => {
    expect(packagePaymentCallbackData(id, "USDT", "AbCd123_")).toBe(
      `package:pay:USDT:${id}:AbCd123_`,
    );
    expect(
      parsePackagePaymentCallbackData(`package:pay:USDT:${id}:AbCd123_`),
    ).toEqual({
      asset: "USDT",
      packageId: id,
      purchaseIntentId: "AbCd123_",
    });
    expect(
      parsePackagePaymentCallbackData(`package:pay:TRX:${id}:AbCd123_`),
    ).toEqual({
      asset: "TRX",
      packageId: id,
      purchaseIntentId: "AbCd123_",
    });
    expect(
      parsePackagePaymentCallbackData("package:pay:BTC:not-a-uuid"),
    ).toBeUndefined();
  });

  it("rejects legacy payment callbacks without a purchase intent", () => {
    expect(
      parsePackagePaymentCallbackData(`package:pay:USDT:${id}`),
    ).toBeUndefined();
  });

  it("only offers supported payment buttons", () => {
    const buttons = buildPaymentMethodKeyboard(id, "AbCd123_").inline_keyboard.flat();
    expect(buttons.map((button) => button.text)).toEqual([
      "USDT 支付",
      "返回套餐列表",
      "返回主菜单",
    ]);
    expect(buttons[0] && "callback_data" in buttons[0] ? buttons[0].callback_data : undefined)
      .toBe(`package:pay:USDT:${id}:AbCd123_`);
    expect(
      Buffer.byteLength(
        packagePaymentCallbackData(id, "USDT", "AbCd123_"),
        "utf8",
      ),
    ).toBeLessThanOrEqual(64);
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

  it("builds purchase-order recovery navigation", () => {
    const orderId = "22222222-2222-4222-8222-222222222222";
    const order = {
      id: orderId,
      status: "waiting_payment" as const,
      payment: {
        packageCodeSnapshot: "demo",
        countSnapshot: 10,
        priceUsdtMicrosSnapshot: 17_000_000n,
        paymentAttributionOffsetAtomic: 137n,
        paymentAsset: "USDT" as const,
        paymentToAddressSnapshot: "TTEST_DESTINATION",
        paymentTokenContractAddressSnapshot: "TTEST_USDT",
        requiredConfirmationsSnapshot: 2,
        quotedAmountAtomic: 17_000_137n,
        quoteExpiresAt: new Date("2026-09-22T03:00:00.000Z"),
      },
      availableCount: 0,
      updatedAt: new Date("2026-09-22T02:50:00.000Z"),
    };

    expect(
      buildPurchaseOrderListKeyboard([order])
        .inline_keyboard
        .flat()
        .map((button) => button.text),
    ).toEqual([
      "10 笔 · 17.000137U · 等待付款",
      "返回主菜单",
    ]);

    const statusKeyboard = buildOrderStatusKeyboard(
      orderId,
      true,
      "TTEST_DESTINATION",
    );
    expect(
      statusKeyboard.inline_keyboard.flat().map((button) => button.text),
    ).toEqual([
      "📋复制收款地址",
      "刷新订单状态",
      "我的支付订单",
      "返回主菜单",
    ]);
    const copyButton = statusKeyboard.inline_keyboard.flat()[0];
    expect(
      copyButton && "copy_text" in copyButton
        ? copyButton.copy_text.text
        : undefined,
    ).toBe("TTEST_DESTINATION");
  });

  it("builds callback-safe purchase history cursors", () => {
    const cursor = purchaseOrdersPageCallbackData("previous", id);
    expect(Buffer.byteLength(cursor, "utf8")).toBeLessThanOrEqual(64);
    expect(parsePurchaseOrdersPageCallbackData(cursor)).toEqual({
      direction: "previous",
      cursorId: id,
    });
  });

  it("builds and parses owned order status callback data", () => {
    const orderId = "22222222-2222-4222-8222-222222222222";

    expect(orderStatusCallbackData(orderId)).toBe(
      `order:status:${orderId}`,
    );
    expect(
      parseOrderStatusCallbackData(`order:status:${orderId}`),
    ).toBe(orderId);
    expect(
      parseOrderStatusCallbackData("order:status:not-a-uuid"),
    ).toBeUndefined();
  });

  it("keeps exact payment instructions visible after refreshing a pending order", () => {
    const message = formatPurchaseOrderStatus({
      id: "22222222-2222-4222-8222-222222222222",
      status: "waiting_payment",
      payment: {
        packageCodeSnapshot: "demo", countSnapshot: 10,
        priceUsdtMicrosSnapshot: 17_000_000n,
        paymentAttributionOffsetAtomic: 137n,
        paymentAsset: "USDT",
        paymentToAddressSnapshot: "TTEST_DESTINATION",
        paymentTokenContractAddressSnapshot: "TTEST_USDT",
        requiredConfirmationsSnapshot: 2,
        quotedAmountAtomic: 17_000_137n,
        quoteExpiresAt: new Date("2026-09-22T03:00:00.000Z"),
      },
      availableCount: 0,
      updatedAt: new Date("2026-09-22T02:50:00.000Z"),
    });
    expect(message).toContain("应付金额：17.000137 USDT");
    expect(message).toContain("支付方式：USDT-TRC20");
    expect(message).toContain("收款地址：TTEST_DESTINATION");
    expect(message).toContain("有效期：2026-09-22 03:00:00 UTC");
    expect(message).toContain("过期请重新下单");
    expect(message).toContain("\n收款地址：");
  });

  it("renders credited order status with the current package balance", () => {
    expect(
      formatPurchaseOrderStatus({
        id: "22222222-2222-4222-8222-222222222222",
        status: "credited",
        payment: {
          packageCodeSnapshot: "demo",
          countSnapshot: 10,
          priceUsdtMicrosSnapshot: 17_000_000n,
          paymentAttributionOffsetAtomic: 137n,
          paymentAsset: "USDT",
          paymentToAddressSnapshot: "TTEST_DESTINATION",
          paymentTokenContractAddressSnapshot: "TTEST_USDT",
          requiredConfirmationsSnapshot: 2,
          quotedAmountAtomic: 17_000_137n,
          quoteExpiresAt: null,
        },
        availableCount: 27,
        updatedAt: new Date("2026-09-22T03:00:00.000Z"),
      }),
    ).toContain("状态：支付成功，已入账");

    expect(
      formatPurchaseOrderStatus({
        id: "22222222-2222-4222-8222-222222222222",
        status: "credited",
        payment: {
          packageCodeSnapshot: "demo",
          countSnapshot: 10,
          priceUsdtMicrosSnapshot: 17_000_000n,
          paymentAttributionOffsetAtomic: 137n,
          paymentAsset: "USDT",
          paymentToAddressSnapshot: "TTEST_DESTINATION",
          paymentTokenContractAddressSnapshot: "TTEST_USDT",
          requiredConfirmationsSnapshot: 2,
          quotedAmountAtomic: 17_000_137n,
          quoteExpiresAt: null,
        },
        availableCount: 27,
        updatedAt: new Date("2026-09-22T03:00:00.000Z"),
      }),
    ).toContain("可用笔数余额：27 笔");
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
