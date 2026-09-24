import { describe, expect, it } from "vitest";

import {
  createSecretProvider,
  loadRuntimeSecrets,
  loadSignerRuntimeSecrets,
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

  it("creates the Infisical provider from bootstrap configuration", () => {
    const provider = createSecretProvider("infisical", {
      INFISICAL_PROJECT_ID: "project-id",
      INFISICAL_ENVIRONMENT: "prod",
      INFISICAL_CLIENT_ID: "client-id",
      INFISICAL_CLIENT_SECRET: "client-secret",
    });

    expect(provider.name).toBe("infisical");
  });

  it("fails closed when Infisical bootstrap configuration is incomplete", () => {
    expect(() =>
      createSecretProvider("infisical", {
        INFISICAL_PROJECT_ID: "project-id",
        INFISICAL_ENVIRONMENT: "prod",
        INFISICAL_CLIENT_ID: "client-id",
      }),
    ).toThrow(/INFISICAL_CLIENT_SECRET/);
  });
});

describe("loadRuntimeSecrets", () => {
  const baseSecrets = {
    BOT_TOKEN: "bot-token",
    DATABASE_URL: "postgresql://example.invalid/db",
  } satisfies NodeJS.ProcessEnv;

  it("loads DATABASE_URL from the deployment environment instead of the SecretProvider", async () => {
    const provider = createSecretProvider("environment", {
      BOT_TOKEN: "bot-token",
    });

    await expect(
      loadRuntimeSecrets(provider, {
        env: {
          DATABASE_URL: "postgresql://railway.invalid/db",
        },
        nodeEnv: "development",
        usdtEnabled: false,
        energyEnabled: false,
      }),
    ).resolves.toEqual({
      botToken: "bot-token",
      databaseUrl: "postgresql://railway.invalid/db",
    });
  });

  it("fails closed when DATABASE_URL is absent from the deployment environment", async () => {
    const provider = createSecretProvider("environment", {
      BOT_TOKEN: "bot-token",
      DATABASE_URL: "postgresql://provider.invalid/db",
    });

    await expect(
      loadRuntimeSecrets(provider, {
        env: {},
        nodeEnv: "development",
        usdtEnabled: false,
        energyEnabled: false,
      }),
    ).rejects.toThrow(/DATABASE_URL is not configured/);
  });

  it("fails closed when production USDT runtime has no TRON_API_KEY", async () => {
    const provider = createSecretProvider("environment", baseSecrets);

    await expect(
      loadRuntimeSecrets(provider, {
        env: baseSecrets,
        nodeEnv: "production",
        usdtEnabled: true,
        energyEnabled: false,
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
        env: baseSecrets,
        nodeEnv: " production ",
        usdtEnabled: true,
        energyEnabled: false,
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
        env: baseSecrets,
        nodeEnv: "development",
        usdtEnabled: true,
        energyEnabled: false,
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
        env: baseSecrets,
        nodeEnv: "production",
        usdtEnabled: false,
        energyEnabled: false,
      }),
    ).resolves.toEqual({
      botToken: "bot-token",
      databaseUrl: "postgresql://example.invalid/db",
    });
  });

  it("requires signer auth when Energy delivery is enabled", async () => {
    const provider = createSecretProvider("environment", {
      BOT_TOKEN: "bot-token",
      TRON_API_KEY: "tron-api-key",
    });

    await expect(
      loadRuntimeSecrets(provider, {
        env: {
          DATABASE_URL: "postgresql://example.invalid/db",
        },
        nodeEnv: "production",
        usdtEnabled: false,
        energyEnabled: true,
      }),
    ).rejects.toThrow(/TRON_SIGNER_AUTH_TOKEN/);
  });

  it("loads only signer secrets for the independent signer runtime", async () => {
    const provider = createSecretProvider("environment", {
      TRON_SIGNER_PRIVATE_KEY: "private-key",
      TRON_SIGNER_AUTH_TOKEN: "auth-token",
    });

    await expect(
      loadSignerRuntimeSecrets(provider, {
        DATABASE_URL: "postgresql://signer.invalid/db",
      }),
    ).resolves.toEqual({
      databaseUrl: "postgresql://signer.invalid/db",
      privateKey: "private-key",
      authToken: "auth-token",
    });
  });

});
