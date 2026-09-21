import { describe, expect, it } from "vitest";

import {
  adminRoleLabel,
  formatUsdtMicros,
  packageButtonLabel,
  packageCallbackData,
  parsePackageCallbackData,
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
