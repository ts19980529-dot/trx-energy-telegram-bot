import { describe, expect, it } from "vitest";

import { createSecretProvider } from "../src/runtime/secret-provider.js";

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
