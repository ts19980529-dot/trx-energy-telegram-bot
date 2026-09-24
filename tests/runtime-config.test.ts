import { describe, expect, it } from "vitest";

import { parseRuntimeConfig } from "../src/runtime/config.js";

const completeUsdtConfig = {
  USDT_PAYMENT_ADDRESS: "TTEST_PAYMENT_ADDRESS",
  USDT_TOKEN_CONTRACT_ADDRESS: "TTEST_USDT_CONTRACT",
  USDT_REQUIRED_CONFIRMATIONS: "2",
  USDT_ATTRIBUTION_MAX_OFFSET_MICROS: "9999",
  USDT_QUOTE_TTL_MS: "900000",
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


const completeEnergyConfig = {
  ENERGY_PROVIDER: "tron-own-pool",
  ENERGY_OWNER_ADDRESS: "TTEST_ENERGY_OWNER",
  ENERGY_TRON_HEAD_BASE_URL: "https://energy-head.example.test",
  ENERGY_TRON_SOLIDIFIED_BASE_URL:
    "https://energy-solid.example.test",
  ENERGY_TRON_HTTP_TIMEOUT_MS: "5000",
  ENERGY_SIGNER_BASE_URL: "http://signer.railway.internal:8080",
  ENERGY_SIGNER_HTTP_TIMEOUT_MS: "3000",
} satisfies NodeJS.ProcessEnv;

describe("parseRuntimeConfig", () => {
  it("defaults to environment secrets without inventing optional runtime configuration", () => {
    expect(parseRuntimeConfig({})).toEqual({
      secretProvider: "environment",
    });
  });

  it("accepts the Infisical SecretProvider", () => {
    expect(
      parseRuntimeConfig({ SECRET_PROVIDER: "infisical" }),
    ).toEqual({
      secretProvider: "infisical",
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
        quoteTtlMs: 900_000,
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

  it("requires a positive quote TTL for bounded reconciliation", () => {
    const { USDT_QUOTE_TTL_MS: _ttl, ...withoutTtl } =
      completeUsdtConfig;

    expect(() => parseRuntimeConfig(withoutTtl)).toThrow(
      /USDT payment configuration is incomplete/,
    );
  });

  it.each([
    ["USDT_REQUIRED_CONFIRMATIONS", "0"],
    ["USDT_ATTRIBUTION_MAX_OFFSET_MICROS", "-1"],
    ["USDT_QUOTE_TTL_MS", "0"],
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

  it("keeps Energy delivery disabled without Energy configuration", () => {
    expect(parseRuntimeConfig({}).tronEnergy).toBeUndefined();
  });

  it("parses a complete own-pool Energy runtime configuration", () => {
    expect(parseRuntimeConfig(completeEnergyConfig).tronEnergy).toEqual({
      providerName: "tron-own-pool",
      ownerAddress: "TTEST_ENERGY_OWNER",
      tronHeadBaseUrl: "https://energy-head.example.test",
      tronSolidifiedBaseUrl: "https://energy-solid.example.test",
      httpTimeoutMs: 5_000,
      signerBaseUrl: "http://signer.railway.internal:8080",
      signerHttpTimeoutMs: 3_000,
    });
  });

  it("fails closed for partial Energy configuration", () => {
    expect(() =>
      parseRuntimeConfig({
        ENERGY_PROVIDER: "tron-own-pool",
        ENERGY_OWNER_ADDRESS: "TTEST_ENERGY_OWNER",
      }),
    ).toThrow(/Energy provider configuration is incomplete/);
  });

  it("rejects unsupported Energy providers", () => {
    expect(() =>
      parseRuntimeConfig({
        ...completeEnergyConfig,
        ENERGY_PROVIDER: "third-party",
      }),
    ).toThrow(/ENERGY_PROVIDER/);
  });

  it.each([
    ["ENERGY_TRON_HTTP_TIMEOUT_MS", "0"],
    ["ENERGY_SIGNER_HTTP_TIMEOUT_MS", "0"],
  ] as const)(
    "rejects invalid Energy runtime value %s=%s",
    (key, value) => {
      expect(() =>
        parseRuntimeConfig({
          ...completeEnergyConfig,
          [key]: value,
        }),
      ).toThrow();
    },
  );

  it("fails closed for an unsupported SecretProvider", () => {
    expect(() =>
      parseRuntimeConfig({ SECRET_PROVIDER: "1password" }),
    ).toThrow(/SecretProvider/);
  });
});
