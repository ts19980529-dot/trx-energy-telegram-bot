import { EnvironmentSecretProvider } from "../adapters/secrets/environment-secret-provider.js";
import { OnePasswordSecretProvider } from "../adapters/secrets/one-password-secret-provider.js";
import type {
  SecretName,
  SecretProvider,
} from "../core/secrets/secret-provider.js";
import type { SecretProviderKind } from "./config.js";

const ONEPASSWORD_REFERENCE_KEYS: Partial<
  Record<SecretName, string>
> = {
  BOT_TOKEN: "ONEPASSWORD_BOT_TOKEN_REF",
  TRON_API_KEY: "ONEPASSWORD_TRON_API_KEY_REF",
};

class OnePasswordRuntimeSecretProvider implements SecretProvider {
  readonly name = "1password";

  constructor(
    private readonly customerSecrets: SecretProvider,
    private readonly infrastructureSecrets: SecretProvider,
  ) {}

  async getSecret(name: SecretName): Promise<string | undefined> {
    if (name === "DATABASE_URL") {
      return this.infrastructureSecrets.getSecret(name);
    }

    return this.customerSecrets.getSecret(name);
  }
}

function nonBlank(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key];

  if (value === undefined || value.trim() === "") {
    return undefined;
  }

  return value;
}

function onePasswordReferences(
  env: NodeJS.ProcessEnv,
): Partial<Record<SecretName, string>> {
  const references: Partial<Record<SecretName, string>> = {};

  for (const [secretName, envKey] of Object.entries(
    ONEPASSWORD_REFERENCE_KEYS,
  ) as Array<[SecretName, string]>) {
    const value = nonBlank(env, envKey);

    if (value !== undefined) {
      references[secretName] = value;
    }
  }

  return references;
}

export function createSecretProvider(
  kind: SecretProviderKind,
  env: NodeJS.ProcessEnv,
): SecretProvider {
  const environmentSecrets = new EnvironmentSecretProvider(env);

  if (kind === "environment") {
    return environmentSecrets;
  }

  const serviceAccountToken = nonBlank(
    env,
    "OP_SERVICE_ACCOUNT_TOKEN",
  );

  if (serviceAccountToken === undefined) {
    throw new Error(
      "OP_SERVICE_ACCOUNT_TOKEN is required when SECRET_PROVIDER=1password",
    );
  }

  const customerSecrets = new OnePasswordSecretProvider({
    serviceAccountToken,
    secretReferences: onePasswordReferences(env),
  });

  return new OnePasswordRuntimeSecretProvider(
    customerSecrets,
    environmentSecrets,
  );
}
