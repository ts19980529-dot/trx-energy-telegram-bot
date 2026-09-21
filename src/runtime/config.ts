export type SecretProviderKind = "environment";

export interface RuntimeConfig {
  readonly secretProvider: SecretProviderKind;
  readonly superAdminId?: bigint;
}

const TELEGRAM_ID_MAX = 9_223_372_036_854_775_807n;

export function parseRuntimeConfig(
  env: NodeJS.ProcessEnv,
): RuntimeConfig {
  const secretProviderRaw = env.SECRET_PROVIDER?.trim() || "environment";

  if (secretProviderRaw !== "environment") {
    throw new Error("Configured SecretProvider is not implemented");
  }

  const superAdminIdRaw = env.SUPER_ADMIN_ID?.trim();

  if (superAdminIdRaw === undefined || superAdminIdRaw === "") {
    return {
      secretProvider: "environment",
    };
  }

  if (!/^[1-9][0-9]*$/.test(superAdminIdRaw)) {
    throw new Error("SUPER_ADMIN_ID must be a positive integer");
  }

  const superAdminId = BigInt(superAdminIdRaw);

  if (superAdminId > TELEGRAM_ID_MAX) {
    throw new Error("SUPER_ADMIN_ID exceeds PostgreSQL bigint range");
  }

  return {
    secretProvider: "environment",
    superAdminId,
  };
}
