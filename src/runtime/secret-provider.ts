import { EnvironmentSecretProvider } from "../adapters/secrets/environment-secret-provider.js";
import type {
  SecretName,
  SecretProvider,
} from "../core/secrets/secret-provider.js";
import type { SecretProviderKind } from "./config.js";

export interface RuntimeSecrets {
  readonly botToken: string;
  readonly databaseUrl: string;
  readonly tronApiKey?: string;
}

async function requireSecret(
  provider: SecretProvider,
  name: SecretName,
): Promise<string> {
  const value = await provider.getSecret(name);

  if (value === undefined) {
    throw new Error(`${name} is not configured`);
  }

  return value;
}

export function createSecretProvider(
  kind: SecretProviderKind,
  env: NodeJS.ProcessEnv,
): SecretProvider {
  if (kind !== "environment") {
    throw new Error("Configured SecretProvider is not implemented");
  }

  return new EnvironmentSecretProvider(env);
}

export async function loadRuntimeSecrets(
  provider: SecretProvider,
  input: {
    readonly nodeEnv: string | undefined;
    readonly usdtEnabled: boolean;
  },
): Promise<RuntimeSecrets> {
  const [botToken, databaseUrl] = await Promise.all([
    requireSecret(provider, "BOT_TOKEN"),
    requireSecret(provider, "DATABASE_URL"),
  ]);

  const requireTronApiKey =
    input.usdtEnabled && input.nodeEnv?.trim() === "production";
  const tronApiKey = requireTronApiKey
    ? await requireSecret(provider, "TRON_API_KEY")
    : await provider.getSecret("TRON_API_KEY");

  return {
    botToken,
    databaseUrl,
    ...(tronApiKey === undefined ? {} : { tronApiKey }),
  };
}
