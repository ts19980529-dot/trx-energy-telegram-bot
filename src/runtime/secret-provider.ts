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
  readonly tronSignerAuthToken?: string;
}

export interface SignerRuntimeSecrets {
  readonly databaseUrl: string;
  readonly privateKey: string;
  readonly authToken: string;
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

export function loadDatabaseUrl(
  env: NodeJS.ProcessEnv,
): string {
  const value = env.DATABASE_URL;

  if (value === undefined || value.trim() === "") {
    throw new Error("DATABASE_URL is not configured");
  }

  return value;
}

export async function loadRuntimeSecrets(
  provider: SecretProvider,
  input: {
    readonly env: NodeJS.ProcessEnv;
    readonly nodeEnv: string | undefined;
    readonly usdtEnabled: boolean;
    readonly energyEnabled: boolean;
  },
): Promise<RuntimeSecrets> {
  const botToken = await requireSecret(provider, "BOT_TOKEN");
  const databaseUrl = loadDatabaseUrl(input.env);

  const requireTronApiKey =
    (input.usdtEnabled || input.energyEnabled) &&
    input.nodeEnv?.trim() === "production";
  const tronApiKey = requireTronApiKey
    ? await requireSecret(provider, "TRON_API_KEY")
    : await provider.getSecret("TRON_API_KEY");
  // The bot's Infisical identity must not gain access to the signer private key.
  // Its shared transport token may instead be scoped to its Railway service.
  const tronSignerAuthToken = input.energyEnabled
    ? input.env.TRON_SIGNER_AUTH_TOKEN?.trim() ||
      await requireSecret(provider, "TRON_SIGNER_AUTH_TOKEN")
    : undefined;

  return {
    botToken,
    databaseUrl,
    ...(tronApiKey === undefined ? {} : { tronApiKey }),
    ...(tronSignerAuthToken === undefined
      ? {}
      : { tronSignerAuthToken }),
  };
}

export async function loadSignerRuntimeSecrets(
  provider: SecretProvider,
  env: NodeJS.ProcessEnv,
): Promise<SignerRuntimeSecrets> {
  return {
    databaseUrl: loadDatabaseUrl(env),
    privateKey: await requireSecret(
      provider,
      "TRON_SIGNER_PRIVATE_KEY",
    ),
    authToken: await requireSecret(
      provider,
      "TRON_SIGNER_AUTH_TOKEN",
    ),
  };
}
