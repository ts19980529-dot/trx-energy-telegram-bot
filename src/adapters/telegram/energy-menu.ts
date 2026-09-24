import { InlineKeyboard } from "grammy";

import type {
  EnergyConsumptionSnapshot,
  EnergyOptionSummary,
} from "../../application/energy/energy-usage-service.js";

const ENERGY_MENU_CALLBACK = "menu:energy";
const PACKAGE_MENU_CALLBACK = "menu:packages";
const ENERGY_USE_PREFIX = "energy:use:";
const ENERGY_STATUS_PREFIX = "energy:status:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPTION_CODE_PATTERN = /^[A-Za-z0-9_-]{1,16}$/;

export interface EnergyUseSelection {
  readonly optionCode: string;
  readonly recipientAddress: string;
}

export function buildMainMenuKeyboard(
  energyEnabled: boolean,
  purchaseEnabled: boolean,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (energyEnabled) {
    keyboard.text("使用能量", ENERGY_MENU_CALLBACK).row();
  }

  return keyboard.text(
    purchaseEnabled ? "购买笔数" : "查看笔数套餐",
    PACKAGE_MENU_CALLBACK,
  );
}

export function isEnergyMenuCallback(data: string): boolean {
  return data === ENERGY_MENU_CALLBACK;
}

export function isPackageMenuCallback(data: string): boolean {
  return data === PACKAGE_MENU_CALLBACK;
}

export function energyUseCallbackData(
  optionCode: string,
  recipientAddress: string,
): string {
  if (!OPTION_CODE_PATTERN.test(optionCode)) {
    throw new Error("Energy option code is not callback-safe");
  }

  const value = `${ENERGY_USE_PREFIX}${optionCode}:${recipientAddress}`;

  if (Buffer.byteLength(value, "utf8") > 64) {
    throw new Error("Energy callback exceeds Telegram 64-byte limit");
  }

  return value;
}

export function parseEnergyUseCallbackData(
  data: string,
): EnergyUseSelection | undefined {
  if (!data.startsWith(ENERGY_USE_PREFIX)) {
    return undefined;
  }

  const payload = data.slice(ENERGY_USE_PREFIX.length);
  const separator = payload.indexOf(":");

  if (separator <= 0) {
    return undefined;
  }

  const optionCode = payload.slice(0, separator);
  const recipientAddress = payload.slice(separator + 1);

  if (
    !OPTION_CODE_PATTERN.test(optionCode) ||
    recipientAddress.length === 0
  ) {
    return undefined;
  }

  return { optionCode, recipientAddress };
}

function formatEnergyAmount(amount: bigint): string {
  return amount % 1_000n === 0n
    ? `${amount / 1_000n}K`
    : amount.toLocaleString("en-US");
}

export function buildEnergyOptionKeyboard(
  options: readonly EnergyOptionSummary[],
  recipientAddress: string,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const option of options) {
    keyboard
      .text(
        `${formatEnergyAmount(option.energyAmount)} Energy · ${option.countCost} 笔`,
        energyUseCallbackData(option.code, recipientAddress),
      )
      .row();
  }

  return keyboard;
}

export function energyStatusCallbackData(orderId: string): string {
  return `${ENERGY_STATUS_PREFIX}${orderId}`;
}

export function parseEnergyStatusCallbackData(
  data: string,
): string | undefined {
  if (!data.startsWith(ENERGY_STATUS_PREFIX)) {
    return undefined;
  }

  const orderId = data.slice(ENERGY_STATUS_PREFIX.length);
  return UUID_PATTERN.test(orderId) ? orderId : undefined;
}

export function buildEnergyStatusKeyboard(
  orderId: string,
  refreshable: boolean,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (refreshable) {
    keyboard.text("刷新能量订单", energyStatusCallbackData(orderId));
  }

  return keyboard;
}

export function formatEnergyOrder(order: EnergyConsumptionSnapshot): string {
  const status = (() => {
    switch (order.status) {
      case "created":
      case "reserved":
        return "已创建，等待投递";
      case "dispatching":
        return "能量投递中";
      case "completed":
        return "能量已到账";
      case "delivery_failed":
        return "投递失败，正在释放笔数";
      case "released":
        return "投递失败，笔数已退回";
      case "cancelled":
        return "已取消";
    }
  })();

  return [
    "能量订单",
    "",
    `订单编号：${order.id}`,
    `接收地址：${order.recipientAddress}`,
    `能量：${formatEnergyAmount(order.energyAmount)} Energy`,
    `消耗笔数：${order.countCost} 笔`,
    `状态：${status}`,
    `可用笔数：${order.availableCount} 笔`,
    `预留笔数：${order.reservedCount} 笔`,
  ].join("\n");
}
