import { describe, expect, it } from "vitest";

import { parseRuntimeConfig } from "../src/runtime/config.js";

const completeUsdtConfig = {
  USDT_PAYMENT_ADDRESS: "TTEST_PAYMENT_ADDRESS",
  USDT_TOKEN_CONTRACT_ADDRESS: "TTEST_USDT_CONTRACT",
  USDT_REQUIRED_CONFIRMATIONS: "2",
  USDT_ATTRIBUTION_MAX_OFFSET_MICROS: "9999",
  USDT_TRON_GRID_BASE_URL: "https://api.example.test",
  USDT_TRON_HEAD_BASE_URL: "https://fullnode.example.test",
  USDT_TRON_SOLIDIFIED_BASE_URL:
    "https://solidity.example.test",
  USDT_TRON_HTTP_TIMEOUT_MS: "5000",
  USDT_SCAN_INTERVAL_MS: "3000",
  USDT_SCAN_MAX_ORDERS: "500",
  USDT_SCAN_MAX_PAGES: "20",
  USDT_TRON_GRID_PAGE_SIZE: "200",
} satisfies NodeJS.ProcessEnv;

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

  it("parses a complete fail-closed USDT payment and reconciliation configuration", () => {
    expect(parseRuntimeConfig(completeUsdtConfig)).toEqual({
      secretProvider: "environment",
      usdtPayment: {
        toAddress: "TTEST_PAYMENT_ADDRESS",
        tokenContractAddress: "TTEST_USDT_CONTRACT",
        requiredConfirmations: 2,
        attributionMaxOffsetAtomic: 9_999n,
        reconciliation: {
          tronGridBaseUrl: "https://api.example.test",
          tronHeadBaseUrl: "https://fullnode.example.test",
          tronSolidifiedBaseUrl:
            "https://solidity.example.test",
          httpTimeoutMs: 5_000,
          scanIntervalMs: 3_000,
          maxOrdersPerRun: 500,
          maxPagesPerNamespace: 20,
          tronGridPageSize: 200,
        },
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

  it("refuses quote TTL until expiry reconciliation is implemented", () => {
    expect(() =>
      parseRuntimeConfig({
        ...completeUsdtConfig,
        USDT_QUOTE_TTL_MS: "900000",
      }),
    ).toThrow(/expiry reconciliation/);
  });

  it.each([
    ["USDT_REQUIRED_CONFIRMATIONS", "0"],
    ["USDT_ATTRIBUTION_MAX_OFFSET_MICROS", "-1"],
    ["USDT_TRON_HTTP_TIMEOUT_MS", "0"],
    ["USDT_SCAN_INTERVAL_MS", "0"],
    ["USDT_SCAN_MAX_ORDERS", "0"],
    ["USDT_SCAN_MAX_PAGES", "0"],
    ["USDT_TRON_GRID_PAGE_SIZE", "201"],
  ] as const)(
    "rejects invalid USDT runtime value %s=%s",
    (key, value) => {
      expect(() =>
        parseRuntimeConfig({
          ...completeUsdtConfig,
          [key]: value,
        }),
      ).toThrow();
    },
  );

  it("accepts the 1Password SecretProvider", () => {
    expect(
      parseRuntimeConfig({ SECRET_PROVIDER: "1password" }),
    ).toEqual({
      secretProvider: "1password",
    });
  });

  it("fails closed for an unknown SecretProvider", () => {
    expect(() =>
      parseRuntimeConfig({ SECRET_PROVIDER: "unsupported" }),
    ).toThrow(/SecretProvider/);
  });
});
