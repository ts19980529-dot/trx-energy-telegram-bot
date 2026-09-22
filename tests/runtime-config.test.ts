import { describe, expect, it } from "vitest";

import { parseRuntimeConfig } from "../src/runtime/config.js";

describe("parseRuntimeConfig", () => {
  it("defaults to environment secrets without inventing optional runtime configuration", () => {
    expect(parseRuntimeConfig({})).toEqual({
      secretProvider: "environment",
    });
  });

  it("accepts a positive numeric SUPER_ADMIN_ID", () => {
    expect(
      parseRuntimeConfig({
        SECRET_PROVIDER: "environment",
        SUPER_ADMIN_ID: "123456789",
      }),
    ).toEqual({
      secretProvider: "environment",
      superAdminId: 123456789n,
    });
  });

  it.each(["0", "-1", "abc", "1.5"])(
    "rejects invalid SUPER_ADMIN_ID %s",
    (value) => {
      expect(() =>
        parseRuntimeConfig({ SUPER_ADMIN_ID: value }),
      ).toThrow(/SUPER_ADMIN_ID/);
    },
  );

  it("keeps USDT payments disabled when no payment configuration exists", () => {
    expect(parseRuntimeConfig({}).usdtPayment).toBeUndefined();
  });

  it("parses a complete USDT payment runtime configuration", () => {
    expect(
      parseRuntimeConfig({
        USDT_PAYMENT_ADDRESS: "TTEST_PAYMENT_ADDRESS",
        USDT_TOKEN_CONTRACT_ADDRESS: "TTEST_USDT_CONTRACT",
        USDT_REQUIRED_CONFIRMATIONS: "2",
        USDT_ATTRIBUTION_MAX_OFFSET_MICROS: "9999",
        USDT_QUOTE_TTL_MS: "900000",
      }),
    ).toEqual({
      secretProvider: "environment",
      usdtPayment: {
        toAddress: "TTEST_PAYMENT_ADDRESS",
        tokenContractAddress: "TTEST_USDT_CONTRACT",
        requiredConfirmations: 2,
        attributionMaxOffsetAtomic: 9_999n,
        quoteTtlMs: 900_000,
      },
    });
  });

  it("fails closed for partial USDT payment configuration", () => {
    expect(() =>
      parseRuntimeConfig({
        USDT_PAYMENT_ADDRESS: "TTEST_PAYMENT_ADDRESS",
        USDT_REQUIRED_CONFIRMATIONS: "2",
      }),
    ).toThrow(/USDT payment configuration is incomplete/);
  });

  it.each([
    ["USDT_REQUIRED_CONFIRMATIONS", "0"],
    ["USDT_REQUIRED_CONFIRMATIONS", "abc"],
    ["USDT_ATTRIBUTION_MAX_OFFSET_MICROS", "-1"],
    ["USDT_QUOTE_TTL_MS", "0"],
  ] as const)(
    "rejects invalid USDT runtime value %s=%s",
    (key, value) => {
      expect(() =>
        parseRuntimeConfig({
          USDT_PAYMENT_ADDRESS: "TTEST_PAYMENT_ADDRESS",
          USDT_TOKEN_CONTRACT_ADDRESS: "TTEST_USDT_CONTRACT",
          USDT_REQUIRED_CONFIRMATIONS:
            key === "USDT_REQUIRED_CONFIRMATIONS" ? value : "2",
          USDT_ATTRIBUTION_MAX_OFFSET_MICROS:
            key === "USDT_ATTRIBUTION_MAX_OFFSET_MICROS"
              ? value
              : "9999",
          ...(key === "USDT_QUOTE_TTL_MS"
            ? { USDT_QUOTE_TTL_MS: value }
            : {}),
        }),
      ).toThrow();
    },
  );

  it("fails closed for an unimplemented SecretProvider", () => {
    expect(() =>
      parseRuntimeConfig({ SECRET_PROVIDER: "1password" }),
    ).toThrow(/SecretProvider/);
  });
});
