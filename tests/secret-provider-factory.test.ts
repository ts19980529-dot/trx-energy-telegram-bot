import { describe, expect, it } from "vitest";

import { createSecretProvider } from "../src/runtime/secret-provider.js";

describe("createSecretProvider", () => {
  it("creates the existing environment provider without changing behavior", async () => {
    const provider = createSecretProvider("environment", {
      BOT_TOKEN: "environment-token",
    });

    expect(provider.name).toBe("environment");
    await expect(provider.getSecret("BOT_TOKEN")).resolves.toBe(
      "environment-token",
    );
  });

  it("routes infrastructure DATABASE_URL to Railway environment in 1Password mode", async () => {
    const provider = createSecretProvider("1password", {
      OP_SERVICE_ACCOUNT_TOKEN: "service-account-token",
      DATABASE_URL: "postgresql://infrastructure-database",
    });

    expect(provider.name).toBe("1password");
    await expect(provider.getSecret("DATABASE_URL")).resolves.toBe(
      "postgresql://infrastructure-database",
    );
  });

  it("does not fall back customer BOT_TOKEN to Railway environment in 1Password mode", async () => {
    const provider = createSecretProvider("1password", {
      OP_SERVICE_ACCOUNT_TOKEN: "service-account-token",
      BOT_TOKEN: "legacy-environment-token",
    });

    await expect(provider.getSecret("BOT_TOKEN")).resolves.toBeUndefined();
  });

  it("keeps unconfigured customer secrets lazy in 1Password mode", async () => {
    const provider = createSecretProvider("1password", {
      OP_SERVICE_ACCOUNT_TOKEN: "service-account-token",
    });

    expect(provider.name).toBe("1password");
    await expect(provider.getSecret("TRON_API_KEY")).resolves.toBeUndefined();
  });

  it("fails closed when 1Password mode lacks its bootstrap token", () => {
    expect(() =>
      createSecretProvider("1password", {}),
    ).toThrow(/OP_SERVICE_ACCOUNT_TOKEN/);
  });
});
