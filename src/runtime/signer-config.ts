import { parseSecretProviderKind, type SecretProviderKind } from "./config.js";

export interface SignerRuntimeConfig {
  readonly secretProvider: SecretProviderKind;
  readonly ownerAddress: string;
  readonly port: number;
}

function requiredValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = env[key]?.trim();

  if (value === undefined || value === "") {
    throw new Error(`${key} is required`);
  }

  return value;
}

function parsePort(value: string): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error("PORT must be a positive integer");
  }

  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error("PORT must be between 1 and 65535");
  }

  return port;
}

export function parseSignerRuntimeConfig(
  env: NodeJS.ProcessEnv,
): SignerRuntimeConfig {
  return {
    secretProvider: parseSecretProviderKind(env),
    ownerAddress: requiredValue(env, "TRON_SIGNER_OWNER_ADDRESS"),
    port: parsePort(requiredValue(env, "PORT")),
  };
}
