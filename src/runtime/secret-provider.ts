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
  DATABASE_URL: "ONEPASSWORD_DATABASE_URL_REF",
  TRON_API_KEY: "ONEPASSWORD_TRON_API_KEY_REF",
};

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
  if (kind === "environment") {
    return new EnvironmentSecretProvider(env);
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

  return new OnePasswordSecretProvider({
    serviceAccountToken,
    secretReferences: onePasswordReferences(env),
  });
}
