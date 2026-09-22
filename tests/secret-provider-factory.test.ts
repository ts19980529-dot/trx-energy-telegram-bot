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

  it("creates a lazy 1Password provider when the bootstrap token exists", async () => {
    const provider = createSecretProvider("1password", {
      OP_SERVICE_ACCOUNT_TOKEN: "service-account-token",
    });

    expect(provider.name).toBe("1password");
    await expect(provider.getSecret("BOT_TOKEN")).resolves.toBeUndefined();
  });

  it("fails closed when 1Password mode lacks its bootstrap token", () => {
    expect(() =>
      createSecretProvider("1password", {}),
    ).toThrow(/OP_SERVICE_ACCOUNT_TOKEN/);
  });
});
