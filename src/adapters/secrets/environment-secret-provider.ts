import type {
  SecretName,
  SecretProvider,
} from "../../core/secrets/secret-provider.js";

export class EnvironmentSecretProvider implements SecretProvider {
  readonly name = "environment";

  constructor(private readonly env: NodeJS.ProcessEnv) {}

  async getSecret(name: SecretName): Promise<string | undefined> {
    const value = this.env[name];

    if (value === undefined || value.trim() === "") {
      return undefined;
    }

    return value;
  }
}
