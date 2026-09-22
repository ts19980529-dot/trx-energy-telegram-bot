import { describe, expect, it } from "vitest";

import {
  createSecretProvider,
  loadRuntimeSecrets,
} from "../src/runtime/secret-provider.js";

describe("createSecretProvider", () => {
  it("creates the environment provider without changing behavior", async () => {
    const provider = createSecretProvider("environment", {
      BOT_TOKEN: "environment-token",
    });

    expect(provider.name).toBe("environment");
    await expect(provider.getSecret("BOT_TOKEN")).resolves.toBe(
      "environment-token",
    );
  });
});

describe("loadRuntimeSecrets", () => {
  const baseSecrets = {
    BOT_TOKEN: "bot-token",
    DATABASE_URL: "postgresql://example.invalid/db",
  } satisfies NodeJS.ProcessEnv;

  it("fails closed when production USDT runtime has no TRON_API_KEY", async () => {
    const provider = createSecretProvider("environment", baseSecrets);

    await expect(
      loadRuntimeSecrets(provider, {
        nodeEnv: "production",
        usdtEnabled: true,
      }),
    ).rejects.toThrow(/TRON_API_KEY is not configured/);
  });

  it("requires and returns TRON_API_KEY for production USDT runtime", async () => {
    const provider = createSecretProvider("environment", {
      ...baseSecrets,
      TRON_API_KEY: "tron-api-key",
    });

    await expect(
      loadRuntimeSecrets(provider, {
        nodeEnv: " production ",
        usdtEnabled: true,
      }),
    ).resolves.toEqual({
      botToken: "bot-token",
      databaseUrl: "postgresql://example.invalid/db",
      tronApiKey: "tron-api-key",
    });
  });

  it("keeps TRON_API_KEY optional outside production", async () => {
    const provider = createSecretProvider("environment", baseSecrets);

    await expect(
      loadRuntimeSecrets(provider, {
        nodeEnv: "development",
        usdtEnabled: true,
      }),
    ).resolves.toEqual({
      botToken: "bot-token",
      databaseUrl: "postgresql://example.invalid/db",
    });
  });

  it("does not require TRON_API_KEY when production USDT runtime is disabled", async () => {
    const provider = createSecretProvider("environment", baseSecrets);

    await expect(
      loadRuntimeSecrets(provider, {
        nodeEnv: "production",
        usdtEnabled: false,
      }),
    ).resolves.toEqual({
      botToken: "bot-token",
      databaseUrl: "postgresql://example.invalid/db",
    });
  });
});
