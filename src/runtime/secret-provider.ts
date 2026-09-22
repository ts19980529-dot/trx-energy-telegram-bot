import { EnvironmentSecretProvider } from "../adapters/secrets/environment-secret-provider.js";
import { InfisicalSecretProvider } from "../adapters/secrets/infisical-secret-provider.js";
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

function requiredInfisicalBootstrapValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = env[key]?.trim();

  if (value === undefined || value === "") {
    throw new Error(
      `${key} is required when SECRET_PROVIDER=infisical`,
    );
  }

  return value;
}

export function createSecretProvider(
  kind: SecretProviderKind,
  env: NodeJS.ProcessEnv,
): SecretProvider {
  if (kind === "environment") {
    return new EnvironmentSecretProvider(env);
  }

  return new InfisicalSecretProvider({
    siteUrl:
      env.INFISICAL_SITE_URL?.trim() ||
      "https://app.infisical.com",
    projectId: requiredInfisicalBootstrapValue(
      env,
      "INFISICAL_PROJECT_ID",
    ),
    environment: requiredInfisicalBootstrapValue(
      env,
      "INFISICAL_ENVIRONMENT",
    ),
    secretPath: env.INFISICAL_SECRET_PATH?.trim() || "/",
    clientId: requiredInfisicalBootstrapValue(
      env,
      "INFISICAL_CLIENT_ID",
    ),
    clientSecret: requiredInfisicalBootstrapValue(
      env,
      "INFISICAL_CLIENT_SECRET",
    ),
  });
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
