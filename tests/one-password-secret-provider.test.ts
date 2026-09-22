import { describe, expect, it } from "vitest";

import {
  OnePasswordSecretProvider,
  type OnePasswordClientFactory,
} from "../src/adapters/secrets/one-password-secret-provider.js";

describe("OnePasswordSecretProvider", () => {
  it("returns undefined for an unconfigured secret without creating a client", async () => {
    let clientCreated = false;
    const factory: OnePasswordClientFactory = async () => {
      clientCreated = true;

      return {
        secrets: {
          resolve: async () => "unexpected",
        },
      };
    };
    const provider = new OnePasswordSecretProvider(
      {
        serviceAccountToken: "service-account-token",
        secretReferences: {},
      },
      factory,
    );

    await expect(provider.getSecret("BOT_TOKEN")).resolves.toBeUndefined();
    expect(clientCreated).toBe(false);
  });

  it("resolves configured op references and reuses one authenticated client", async () => {
    const references: string[] = [];
    let clientCreations = 0;
    const factory: OnePasswordClientFactory = async (token) => {
      expect(token).toBe("service-account-token");
      clientCreations += 1;

      return {
        secrets: {
          resolve: async (secretReference) => {
            references.push(secretReference);
            return "resolved-secret";
          },
        },
      };
    };
    const provider = new OnePasswordSecretProvider(
      {
        serviceAccountToken: "service-account-token",
        secretReferences: {
          BOT_TOKEN:
            "op://trx-energy-telegram-bot-prod/Telegram Bot/BOT_TOKEN",
        },
      },
      factory,
    );

    await expect(provider.getSecret("BOT_TOKEN")).resolves.toBe(
      "resolved-secret",
    );
    await expect(provider.getSecret("BOT_TOKEN")).resolves.toBe(
      "resolved-secret",
    );

    expect(clientCreations).toBe(1);
    expect(references).toEqual([
      "op://trx-energy-telegram-bot-prod/Telegram Bot/BOT_TOKEN",
      "op://trx-energy-telegram-bot-prod/Telegram Bot/BOT_TOKEN",
    ]);
  });

  it("rejects a non-op secret reference before contacting 1Password", async () => {
    let clientCreated = false;
    const provider = new OnePasswordSecretProvider(
      {
        serviceAccountToken: "service-account-token",
        secretReferences: {
          BOT_TOKEN: "plaintext-secret",
        },
      },
      async () => {
        clientCreated = true;

        return {
          secrets: {
            resolve: async () => "unexpected",
          },
        };
      },
    );

    await expect(provider.getSecret("BOT_TOKEN")).rejects.toThrow(
      /must start with op:\/\//,
    );
    expect(clientCreated).toBe(false);
  });

  it("rejects an empty service account token", () => {
    expect(
      () =>
        new OnePasswordSecretProvider({
          serviceAccountToken: "   ",
          secretReferences: {},
        }),
    ).toThrow(/OP_SERVICE_ACCOUNT_TOKEN/);
  });
});
