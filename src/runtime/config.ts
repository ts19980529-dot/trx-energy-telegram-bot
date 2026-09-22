export type SecretProviderKind = "environment";

export interface UsdtPaymentRuntimeConfig {
  readonly toAddress: string;
  readonly tokenContractAddress: string;
  readonly requiredConfirmations: number;
  readonly attributionMaxOffsetAtomic: bigint;
  readonly quoteTtlMs?: number;
}

export interface RuntimeConfig {
  readonly secretProvider: SecretProviderKind;
  readonly superAdminId?: bigint;
  readonly usdtPayment?: UsdtPaymentRuntimeConfig;
}

const TELEGRAM_ID_MAX = 9_223_372_036_854_775_807n;

const USDT_REQUIRED_KEYS = [
  "USDT_PAYMENT_ADDRESS",
  "USDT_TOKEN_CONTRACT_ADDRESS",
  "USDT_REQUIRED_CONFIRMATIONS",
  "USDT_ATTRIBUTION_MAX_OFFSET_MICROS",
] as const;

const USDT_CONFIG_KEYS = [
  ...USDT_REQUIRED_KEYS,
  "USDT_QUOTE_TTL_MS",
] as const;

function trimmed(
  env: NodeJS.ProcessEnv,
  key: string,
): string | undefined {
  const value = env[key]?.trim();
  return value === undefined || value === "" ? undefined : value;
}

function parsePositiveSafeInteger(
  value: string,
  field: string,
): number {
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`${field} must be a positive integer`);
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${field} must be a positive safe integer`);
  }

  return parsed;
}

function parseNonNegativeBigInt(
  value: string,
  field: string,
): bigint {
  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${field} must be a non-negative integer`);
  }

  return BigInt(value);
}

function parseUsdtPaymentConfig(
  env: NodeJS.ProcessEnv,
): UsdtPaymentRuntimeConfig | undefined {
  const configuredKeys = USDT_CONFIG_KEYS.filter(
    (key) => trimmed(env, key) !== undefined,
  );

  if (configuredKeys.length === 0) {
    return undefined;
  }

  const missingKeys = USDT_REQUIRED_KEYS.filter(
    (key) => trimmed(env, key) === undefined,
  );

  if (missingKeys.length > 0) {
    throw new Error(
      `USDT payment configuration is incomplete: missing ${missingKeys.join(", ")}`,
    );
  }

  const toAddress = trimmed(env, "USDT_PAYMENT_ADDRESS");
  const tokenContractAddress = trimmed(
    env,
    "USDT_TOKEN_CONTRACT_ADDRESS",
  );
  const requiredConfirmationsRaw = trimmed(
    env,
    "USDT_REQUIRED_CONFIRMATIONS",
  );
  const attributionMaxOffsetRaw = trimmed(
    env,
    "USDT_ATTRIBUTION_MAX_OFFSET_MICROS",
  );

  if (
    toAddress === undefined ||
    tokenContractAddress === undefined ||
    requiredConfirmationsRaw === undefined ||
    attributionMaxOffsetRaw === undefined
  ) {
    throw new Error("USDT payment configuration is incomplete");
  }

  const quoteTtlRaw = trimmed(env, "USDT_QUOTE_TTL_MS");

  return {
    toAddress,
    tokenContractAddress,
    requiredConfirmations: parsePositiveSafeInteger(
      requiredConfirmationsRaw,
      "USDT_REQUIRED_CONFIRMATIONS",
    ),
    attributionMaxOffsetAtomic: parseNonNegativeBigInt(
      attributionMaxOffsetRaw,
      "USDT_ATTRIBUTION_MAX_OFFSET_MICROS",
    ),
    ...(quoteTtlRaw === undefined
      ? {}
      : {
          quoteTtlMs: parsePositiveSafeInteger(
            quoteTtlRaw,
            "USDT_QUOTE_TTL_MS",
          ),
        }),
  };
}

export function parseRuntimeConfig(
  env: NodeJS.ProcessEnv,
): RuntimeConfig {
  const secretProviderRaw = env.SECRET_PROVIDER?.trim() || "environment";

  if (secretProviderRaw !== "environment") {
    throw new Error("Configured SecretProvider is not implemented");
  }

  const superAdminIdRaw = env.SUPER_ADMIN_ID?.trim();
  let superAdminId: bigint | undefined;

  if (superAdminIdRaw !== undefined && superAdminIdRaw !== "") {
    if (!/^[1-9][0-9]*$/.test(superAdminIdRaw)) {
      throw new Error("SUPER_ADMIN_ID must be a positive integer");
    }

    superAdminId = BigInt(superAdminIdRaw);

    if (superAdminId > TELEGRAM_ID_MAX) {
      throw new Error("SUPER_ADMIN_ID exceeds PostgreSQL bigint range");
    }
  }

  const usdtPayment = parseUsdtPaymentConfig(env);

  return {
    secretProvider: "environment",
    ...(superAdminId === undefined ? {} : { superAdminId }),
    ...(usdtPayment === undefined ? {} : { usdtPayment }),
  };
}
