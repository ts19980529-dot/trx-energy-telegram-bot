import { InlineKeyboard } from "grammy";

import type { PurchaseOrderRecord } from "../../application/payments/purchase-order-service.js";
import type { EnergyPackageSummary } from "../../application/telegram/ports.js";
import type { AdminRole } from "../../core/admin/roles.js";
import type { PaymentAsset } from "../../core/payments/payment-observation.js";

const PACKAGE_CALLBACK_PREFIX = "package:view:";
const PACKAGE_PAYMENT_CALLBACK_PREFIX = "package:pay:";
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface PackagePaymentSelection {
  readonly asset: PaymentAsset;
  readonly packageId: string;
}

function formatSixDecimalAtomic(value: bigint): string {
  const sign = value < 0n ? "-" : "";
  const absolute = value < 0n ? -value : value;
  const whole = absolute / 1_000_000n;
  const remainder = absolute % 1_000_000n;

  if (remainder === 0n) {
    return `${sign}${whole}`;
  }

  const fraction = remainder
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");

  return `${sign}${whole}.${fraction}`;
}

export function formatUsdtMicros(value: bigint): string {
  return formatSixDecimalAtomic(value);
}

export function formatTrxSun(value: bigint): string {
  return formatSixDecimalAtomic(value);
}

export function packageButtonLabel(
  item: EnergyPackageSummary,
): string {
  return `${item.count} 笔 · ${formatUsdtMicros(item.priceUsdtMicros)} USDT`;
}

export function packageCallbackData(id: string): string {
  return `${PACKAGE_CALLBACK_PREFIX}${id}`;
}

export function parsePackageCallbackData(data: string): string | undefined {
  if (!data.startsWith(PACKAGE_CALLBACK_PREFIX)) {
    return undefined;
  }

  const id = data.slice(PACKAGE_CALLBACK_PREFIX.length);

  return UUID_PATTERN.test(id) ? id : undefined;
}

export function packagePaymentCallbackData(
  id: string,
  asset: PaymentAsset,
): string {
  return `${PACKAGE_PAYMENT_CALLBACK_PREFIX}${asset}:${id}`;
}

export function parsePackagePaymentCallbackData(
  data: string,
): PackagePaymentSelection | undefined {
  if (!data.startsWith(PACKAGE_PAYMENT_CALLBACK_PREFIX)) {
    return undefined;
  }

  const payload = data.slice(PACKAGE_PAYMENT_CALLBACK_PREFIX.length);
  const separator = payload.indexOf(":");

  if (separator <= 0) {
    return undefined;
  }

  const assetRaw = payload.slice(0, separator);
  const packageId = payload.slice(separator + 1);

  if (
    (assetRaw !== "USDT" && assetRaw !== "TRX") ||
    !UUID_PATTERN.test(packageId)
  ) {
    return undefined;
  }

  return {
    asset: assetRaw,
    packageId,
  };
}

export function buildPackageKeyboard(
  packages: readonly EnergyPackageSummary[],
): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  for (const item of packages) {
    keyboard.text(packageButtonLabel(item), packageCallbackData(item.id)).row();
  }

  return keyboard;
}

export function buildPaymentMethodKeyboard(
  packageId: string,
): InlineKeyboard {
  return new InlineKeyboard()
    .text(
      "USDT 支付",
      packagePaymentCallbackData(packageId, "USDT"),
    )
    .row()
    .text(
      "TRX 支付（暂未启用）",
      packagePaymentCallbackData(packageId, "TRX"),
    );
}

function formatUtcTimestamp(value: Date | null): string {
  if (value === null) {
    return "未设置";
  }

  return value
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

export function formatPurchaseOrderInstructions(
  order: PurchaseOrderRecord,
): string {
  const payment = order.payment;
  const amount =
    payment.paymentAsset === "USDT"
      ? formatUsdtMicros(payment.quotedAmountAtomic)
      : formatTrxSun(payment.quotedAmountAtomic);
  const assetLabel =
    payment.paymentAsset === "USDT" ? "USDT-TRC20" : "TRX";
  const amountUnit =
    payment.paymentAsset === "USDT" ? "USDT" : "TRX";

  return [
    "订单已创建",
    "",
    `订单编号：${order.id}`,
    `套餐：${payment.countSnapshot} 笔`,
    `支付方式：${assetLabel}`,
    `应付金额：${amount} ${amountUnit}`,
    `收款地址：${payment.paymentToAddressSnapshot}`,
    "订单状态：等待付款",
    `链上确认：${payment.requiredConfirmationsSnapshot} 次`,
    `有效期：${formatUtcTimestamp(payment.quoteExpiresAt)}`,
    "",
    "请严格按照以上金额转账，到账并完成链上确认后才会增加笔数余额。",
  ].join("\n");
}

export function adminRoleLabel(role: AdminRole): string {
  switch (role) {
    case "SUPER_ADMIN":
      return "超级管理员";
    case "ADMIN":
      return "管理员";
    case "OPERATOR":
      return "操作员";
    case "VIEWER":
      return "查看员";
  }
}
