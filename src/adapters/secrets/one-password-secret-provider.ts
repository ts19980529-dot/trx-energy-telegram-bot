import { createClient } from "@1password/sdk";

import type {
  SecretName,
  SecretProvider,
} from "../../core/secrets/secret-provider.js";

export interface OnePasswordSecretsClient {
  readonly secrets: {
    resolve(secretReference: string): Promise<string>;
  };
}

export type OnePasswordClientFactory = (
  serviceAccountToken: string,
) => Promise<OnePasswordSecretsClient>;

export interface OnePasswordSecretProviderOptions {
  readonly serviceAccountToken: string;
  readonly secretReferences: Partial<Record<SecretName, string>>;
}

const defaultClientFactory: OnePasswordClientFactory = async (
  serviceAccountToken,
) =>
  createClient({
    auth: serviceAccountToken,
    integrationName: "trx-energy-telegram-bot",
    integrationVersion: "0.1.0",
  });

export class OnePasswordSecretProvider implements SecretProvider {
  readonly name = "1password";

  private clientPromise: Promise<OnePasswordSecretsClient> | undefined;

  constructor(
    private readonly options: OnePasswordSecretProviderOptions,
    private readonly clientFactory: OnePasswordClientFactory =
      defaultClientFactory,
  ) {
    if (options.serviceAccountToken.trim() === "") {
      throw new Error("OP_SERVICE_ACCOUNT_TOKEN is required");
    }
  }

  async getSecret(name: SecretName): Promise<string | undefined> {
    const secretReference = this.options.secretReferences[name]?.trim();

    if (secretReference === undefined || secretReference === "") {
      return undefined;
    }

    if (!secretReference.startsWith("op://")) {
      throw new Error(
        `${name} 1Password secret reference must start with op://`,
      );
    }

    const client = await this.getClient();
    const value = await client.secrets.resolve(secretReference);

    if (value.trim() === "") {
      return undefined;
    }

    return value;
  }

  private getClient(): Promise<OnePasswordSecretsClient> {
    this.clientPromise ??= this.clientFactory(
      this.options.serviceAccountToken,
    );

    return this.clientPromise;
  }
}
