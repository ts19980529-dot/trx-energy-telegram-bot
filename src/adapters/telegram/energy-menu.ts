import { InlineKeyboard } from "grammy";

import type {
  EnergyConsumptionSnapshot,
  EnergyOptionSummary,
} from "../../application/energy/energy-usage-service.js";

const HOME_MENU_CALLBACK = "menu:home";
const ENERGY_MENU_CALLBACK = "menu:energy";
const ENERGY_ORDERS_MENU_CALLBACK = "menu:energy-orders";
const PURCHASE_ORDERS_MENU_CALLBACK = "menu:purchase-orders";
const PACKAGE_MENU_CALLBACK = "menu:packages";
const ENERGY_CONFIRM_PREFIX = "energy:cf:";
const ENERGY_EXECUTE_PREFIX = "energy:go:";
const ENERGY_LEGACY_USE_PREFIX = "energy:use:";
const ENERGY_CANCEL_CALLBACK = "energy:cancel";
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
  energyHistoryEnabled = energyEnabled,
  purchaseHistoryEnabled = false,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (energyEnabled) {
    keyboard.text("使用能量", ENERGY_MENU_CALLBACK).row();
  }

  if (energyHistoryEnabled) {
    keyboard.text("我的能量订单", ENERGY_ORDERS_MENU_CALLBACK).row();
  }

  keyboard
    .text(
      purchaseEnabled ? "购买笔数" : "查看笔数套餐",
      PACKAGE_MENU_CALLBACK,
    )
    .row();

  if (purchaseHistoryEnabled) {
    keyboard.text("我的支付订单", PURCHASE_ORDERS_MENU_CALLBACK);
  }

  return keyboard;
}

export function isHomeMenuCallback(data: string): boolean {
  return data === HOME_MENU_CALLBACK;
}

export function isEnergyMenuCallback(data: string): boolean {
  return data === ENERGY_MENU_CALLBACK;
}

export function isEnergyOrdersMenuCallback(data: string): boolean {
  return data === ENERGY_ORDERS_MENU_CALLBACK;
}

export function isPurchaseOrdersMenuCallback(data: string): boolean {
  return data === PURCHASE_ORDERS_MENU_CALLBACK;
}

export function isPackageMenuCallback(data: string): boolean {
  return data === PACKAGE_MENU_CALLBACK;
}

function energySelectionCallbackData(
  prefix: string,
  optionCode: string,
  recipientAddress: string,
): string {
  if (!OPTION_CODE_PATTERN.test(optionCode)) {
    throw new Error("Energy option code is not callback-safe");
  }

  if (recipientAddress.length === 0) {
    throw new Error("Energy recipient address is empty");
  }

  const value = `${prefix}${optionCode}:${recipientAddress}`;

  if (Buffer.byteLength(value, "utf8") > 64) {
    throw new Error("Energy callback exceeds Telegram 64-byte limit");
  }

  return value;
}

function parseEnergySelectionCallbackData(
  data: string,
  prefix: string,
): EnergyUseSelection | undefined {
  if (!data.startsWith(prefix)) {
    return undefined;
  }

  const payload = data.slice(prefix.length);
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

export function energyConfirmCallbackData(
  optionCode: string,
  recipientAddress: string,
): string {
  return energySelectionCallbackData(
    ENERGY_CONFIRM_PREFIX,
    optionCode,
    recipientAddress,
  );
}

export function parseEnergyConfirmCallbackData(
  data: string,
): EnergyUseSelection | undefined {
  return parseEnergySelectionCallbackData(data, ENERGY_CONFIRM_PREFIX);
}

export function energyExecuteCallbackData(
  optionCode: string,
  recipientAddress: string,
): string {
  return energySelectionCallbackData(
    ENERGY_EXECUTE_PREFIX,
    optionCode,
    recipientAddress,
  );
}

export function parseEnergyExecuteCallbackData(
  data: string,
): EnergyUseSelection | undefined {
  return parseEnergySelectionCallbackData(data, ENERGY_EXECUTE_PREFIX);
}

export function energyUseCallbackData(
  optionCode: string,
  recipientAddress: string,
): string {
  return energySelectionCallbackData(
    ENERGY_LEGACY_USE_PREFIX,
    optionCode,
    recipientAddress,
  );
}

export function parseEnergyUseCallbackData(
  data: string,
): EnergyUseSelection | undefined {
  return parseEnergySelectionCallbackData(data, ENERGY_LEGACY_USE_PREFIX);
}

function formatEnergyAmount(amount: bigint): string {
  return amount % 1_000n === 0n
    ? `${amount / 1_000n}K`
    : amount.toLocaleString("en-US");
}

export function buildHomeKeyboard(): InlineKeyboard {
  return new InlineKeyboard().text("返回主菜单", HOME_MENU_CALLBACK);
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
        energyConfirmCallbackData(option.code, recipientAddress),
      )
      .row();
  }

  return keyboard.text("返回主菜单", HOME_MENU_CALLBACK);
}

export function buildEnergyConfirmationKeyboard(
  optionCode: string,
  recipientAddress: string,
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "确认使用",
      energyExecuteCallbackData(optionCode, recipientAddress),
    )
    .row()
    .text("取消", ENERGY_CANCEL_CALLBACK);
}

export function formatEnergyConfirmation(input: {
  readonly recipientAddress: string;
  readonly option: EnergyOptionSummary;
  readonly availableCount: number;
  readonly reservedCount: number;
}): string {
  return [
    "确认使用能量",
    "",
    `接收地址：${input.recipientAddress}`,
    `能量规格：${formatEnergyAmount(input.option.energyAmount)} Energy · ${input.option.countCost} 笔`,
    `当前可用笔数：${input.availableCount} 笔`,
    `当前预留笔数：${input.reservedCount} 笔`,
    "",
    `确认后将提交能量订单，并按规则预留/扣除 ${input.option.countCost} 笔。`,
    "请确认接收地址和能量规格无误。",
  ].join("\n");
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

export function energyOrderStatusLabel(
  status: EnergyConsumptionSnapshot["status"],
): string {
  switch (status) {
    case "created":
    case "reserved":
      return "等待投递";
    case "dispatching":
      return "投递中";
    case "completed":
      return "已到账";
    case "delivery_failed":
      return "释放中";
    case "released":
      return "已退回";
    case "cancelled":
      return "已取消";
  }
}

export function buildEnergyOrderListKeyboard(
  orders: readonly EnergyConsumptionSnapshot[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const order of orders) {
    keyboard
      .text(
        `${formatEnergyAmount(order.energyAmount)} · ${energyOrderStatusLabel(order.status)}`,
        energyStatusCallbackData(order.id),
      )
      .row();
  }

  return keyboard.text("返回主菜单", HOME_MENU_CALLBACK);
}

export function buildEnergyStatusKeyboard(
  orderId: string,
  refreshable: boolean,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  if (refreshable) {
    keyboard.text("刷新能量订单", energyStatusCallbackData(orderId)).row();
  }

  return keyboard
    .text("我的能量订单", ENERGY_ORDERS_MENU_CALLBACK)
    .row()
    .text("返回主菜单", HOME_MENU_CALLBACK);
}

export function formatEnergyOrder(order: EnergyConsumptionSnapshot): string {
  const status = energyOrderStatusLabel(order.status);

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
