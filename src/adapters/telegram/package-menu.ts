import { InlineKeyboard } from "grammy";

import type { EnergyPackageSummary } from "../../application/telegram/ports.js";
import type { AdminRole } from "../../core/admin/roles.js";

const PACKAGE_CALLBACK_PREFIX = "package:view:";

export function formatUsdtMicros(value: bigint): string {
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

  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      id,
    )
  ) {
    return undefined;
  }

  return id;
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
