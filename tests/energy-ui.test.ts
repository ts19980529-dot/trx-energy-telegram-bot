import { describe, expect, it } from "vitest";

import {
  buildEnergyOptionKeyboard,
  buildEnergyOrderListKeyboard,
  buildMainMenuKeyboard,
  buildPersistentMainMenuKeyboard,
  energyOrdersPageCallbackData,
  energyStatusCallbackData,
  energyUseCallbackData,
  formatEnergyConfirmation,
  formatEnergyOrder,
  mainMenuLabels,
  parseEnergyOrdersPageCallbackData,
  parseEnergyStatusCallbackData,
  parseEnergyUseCallbackData,
} from "../src/adapters/telegram/energy-menu.js";

const recipient = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const orderId = "123e4567-e89b-12d3-a456-426614174000";

describe("Telegram Energy UI", () => {
  it("keeps Energy as a first-class main-menu service and package purchase as a separate entry", () => {
    const labels = buildMainMenuKeyboard(true, true).inline_keyboard
      .flat()
      .map((button) => button.text);

    expect(labels).toEqual(["使用能量", "我的能量订单", "购买笔数"]);
    expect(
      buildMainMenuKeyboard(false, true).inline_keyboard.flat().map((button) => button.text),
    ).toEqual(["购买笔数"]);
    expect(
      buildMainMenuKeyboard(false, false).inline_keyboard.flat().map((button) => button.text),
    ).toEqual(["查看笔数套餐"]);
    expect(
      buildMainMenuKeyboard(false, false, true, true)
        .inline_keyboard
        .flat()
        .map((button) => button.text),
    ).toEqual([
      "我的能量订单",
      "查看笔数套餐",
      "我的支付订单",
    ]);
    expect(
      buildMainMenuKeyboard(false, false, true, true, false)
        .inline_keyboard
        .flat()
        .map((button) => button.text),
    ).toEqual(["我的能量订单", "我的支付订单"]);
  });

  it("builds a persistent business keyboard for stable main navigation", () => {
    const keyboard = buildPersistentMainMenuKeyboard(true, true, true, true);
    const labels = keyboard.keyboard.flat().map((button) =>
      "text" in button ? button.text : undefined,
    );

    expect(labels).toEqual([
      mainMenuLabels.energy,
      mainMenuLabels.packages,
      mainMenuLabels.energyOrders,
      mainMenuLabels.purchaseOrders,
    ]);
    expect(keyboard.resize_keyboard).toBe(true);
    expect(keyboard.is_persistent).toBe(true);
  });

  it("builds callback-safe Energy selections within Telegram's 64-byte limit", () => {
    const callback = energyUseCallbackData("energy_131k", recipient);

    expect(Buffer.byteLength(callback, "utf8")).toBeLessThanOrEqual(64);
    expect(parseEnergyUseCallbackData(callback)).toEqual({
      optionCode: "energy_131k",
      recipientAddress: recipient,
    });
  });

  it("renders Energy options from repository-provided configuration rather than hard-coded handlers", () => {
    const keyboard = buildEnergyOptionKeyboard(
      [
        {
          id: "11111111-1111-4111-8111-111111111111",
          code: "energy_65k",
          energyAmount: 65_000n,
          countCost: 1,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          code: "energy_131k",
          energyAmount: 131_000n,
          countCost: 1,
        },
      ],
      recipient,
    );

    expect(
      keyboard.inline_keyboard.flat().map((button) => button.text),
    ).toEqual([
      "65K Energy · 1 笔",
      "131K Energy · 1 笔",
      "返回主菜单",
    ]);
  });

  it("builds a recoverable recent-order menu from owned Energy orders", () => {
    const keyboard = buildEnergyOrderListKeyboard([
      {
        id: orderId,
        userId: "33333333-3333-4333-8333-333333333333",
        optionCode: "energy_65k",
        recipientAddress: recipient,
        energyAmount: 65_000n,
        countCost: 1,
        status: "dispatching",
        availableCount: 9,
        reservedCount: 1,
        delivery: null,
      },
    ]);

    const buttons = keyboard.inline_keyboard.flat();
    expect(buttons[0]?.text).toContain("65K · T9yD1…");
    expect(buttons[0]?.text).toContain("投递中");
    expect(buttons.at(-1)?.text).toBe("返回主菜单");
    expect(
      buttons[0] && "callback_data" in buttons[0]
        ? buttons[0].callback_data
        : undefined,
    ).toBe(`energy:status:${orderId}`);
  });

  it("builds callback-safe Energy history cursors", () => {
    const next = energyOrdersPageCallbackData("next", orderId);
    expect(Buffer.byteLength(next, "utf8")).toBeLessThanOrEqual(64);
    expect(parseEnergyOrdersPageCallbackData(next)).toEqual({
      direction: "next",
      cursorId: orderId,
    });
  });

  it("explains reservation, final deduction, and failure release before confirmation", () => {
    const message = formatEnergyConfirmation({
      recipientAddress: recipient,
      option: {
        id: "11111111-1111-4111-8111-111111111111",
        code: "energy_65k",
        energyAmount: 65_000n,
        countCost: 1,
      },
      availableCount: 10,
      reservedCount: 0,
    });

    expect(message).toContain("先预留 1 笔");
    expect(message).toContain("投递成功后正式扣除");
    expect(message).toContain("投递失败会按规则退回");
  });

  it("builds stable Energy status callbacks and terminal order text", () => {
    expect(energyStatusCallbackData(orderId)).toBe(`energy:status:${orderId}`);
    expect(parseEnergyStatusCallbackData(`energy:status:${orderId}`)).toBe(orderId);

    expect(
      formatEnergyOrder({
        id: orderId,
        userId: "33333333-3333-4333-8333-333333333333",
        optionCode: "energy_65k",
        recipientAddress: recipient,
        energyAmount: 65_000n,
        countCost: 1,
        status: "completed",
        availableCount: 9,
        reservedCount: 0,
        delivery: {
          id: "44444444-4444-4444-8444-444444444444",
          idempotencyKey: `energy-delivery:${orderId}`,
          providerName: "fake-energy",
          providerOrderId: "provider-1",
          status: "completed",
        },
      }),
    ).toContain("能量：65K Energy");
  });
});
