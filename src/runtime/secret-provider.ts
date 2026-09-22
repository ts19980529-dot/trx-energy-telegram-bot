import { EnvironmentSecretProvider } from "../adapters/secrets/environment-secret-provider.js";
import type { SecretProvider } from "../core/secrets/secret-provider.js";
import type { SecretProviderKind } from "./config.js";

export function createSecretProvider(
  kind: SecretProviderKind,
  env: NodeJS.ProcessEnv,
): SecretProvider {
  if (kind !== "environment") {
    throw new Error("Configured SecretProvider is not implemented");
  }

  return new EnvironmentSecretProvider(env);
}
