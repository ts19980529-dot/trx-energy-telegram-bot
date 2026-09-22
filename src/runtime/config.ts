export type SecretProviderKind = "environment";

export interface UsdtReconciliationRuntimeConfig {
  readonly tronGridBaseUrl: string;
  readonly tronHeadBaseUrl: string;
  readonly tronSolidifiedBaseUrl: string;
  readonly httpTimeoutMs: number;
  readonly scanIntervalMs: number;
  readonly maxOrdersPerRun: number;
  readonly maxPagesPerNamespace: number;
  readonly tronGridPageSize: number;
}

export interface UsdtPaymentRuntimeConfig {
  readonly toAddress: string;
  readonly tokenContractAddress: string;
  readonly requiredConfirmations: number;
  readonly attributionMaxOffsetAtomic: bigint;
  readonly reconciliation: UsdtReconciliationRuntimeConfig;
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
  "USDT_TRON_GRID_BASE_URL",
  "USDT_TRON_HEAD_BASE_URL",
  "USDT_TRON_SOLIDIFIED_BASE_URL",
  "USDT_TRON_HTTP_TIMEOUT_MS",
  "USDT_SCAN_INTERVAL_MS",
  "USDT_SCAN_MAX_ORDERS",
  "USDT_SCAN_MAX_PAGES",
  "USDT_TRON_GRID_PAGE_SIZE",
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

function requiredValue(
  env: NodeJS.ProcessEnv,
  key: string,
): string {
  const value = trimmed(env, key);

  if (value === undefined) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function parseUsdtPaymentConfig(
  env: NodeJS.ProcessEnv,
): UsdtPaymentRuntimeConfig | undefined {
  const configuredKeys = USDT_REQUIRED_KEYS.filter(
    (key) => trimmed(env, key) !== undefined,
  );
  const quoteTtl = trimmed(env, "USDT_QUOTE_TTL_MS");

  if (configuredKeys.length === 0 && quoteTtl === undefined) {
    return undefined;
  }

  if (quoteTtl !== undefined) {
    throw new Error(
      "USDT_QUOTE_TTL_MS is not supported until payment expiry reconciliation is implemented",
    );
  }

  const missingKeys = USDT_REQUIRED_KEYS.filter(
    (key) => trimmed(env, key) === undefined,
  );

  if (missingKeys.length > 0) {
    throw new Error(
      `USDT payment configuration is incomplete: missing ${missingKeys.join(", ")}`,
    );
  }

  const tronGridPageSize = parsePositiveSafeInteger(
    requiredValue(env, "USDT_TRON_GRID_PAGE_SIZE"),
    "USDT_TRON_GRID_PAGE_SIZE",
  );

  if (tronGridPageSize > 200) {
    throw new Error(
      "USDT_TRON_GRID_PAGE_SIZE must not exceed 200",
    );
  }

  return {
    toAddress: requiredValue(env, "USDT_PAYMENT_ADDRESS"),
    tokenContractAddress: requiredValue(
      env,
      "USDT_TOKEN_CONTRACT_ADDRESS",
    ),
    requiredConfirmations: parsePositiveSafeInteger(
      requiredValue(env, "USDT_REQUIRED_CONFIRMATIONS"),
      "USDT_REQUIRED_CONFIRMATIONS",
    ),
    attributionMaxOffsetAtomic: parseNonNegativeBigInt(
      requiredValue(
        env,
        "USDT_ATTRIBUTION_MAX_OFFSET_MICROS",
      ),
      "USDT_ATTRIBUTION_MAX_OFFSET_MICROS",
    ),
    reconciliation: {
      tronGridBaseUrl: requiredValue(
        env,
        "USDT_TRON_GRID_BASE_URL",
      ),
      tronHeadBaseUrl: requiredValue(
        env,
        "USDT_TRON_HEAD_BASE_URL",
      ),
      tronSolidifiedBaseUrl: requiredValue(
        env,
        "USDT_TRON_SOLIDIFIED_BASE_URL",
      ),
      httpTimeoutMs: parsePositiveSafeInteger(
        requiredValue(env, "USDT_TRON_HTTP_TIMEOUT_MS"),
        "USDT_TRON_HTTP_TIMEOUT_MS",
      ),
      scanIntervalMs: parsePositiveSafeInteger(
        requiredValue(env, "USDT_SCAN_INTERVAL_MS"),
        "USDT_SCAN_INTERVAL_MS",
      ),
      maxOrdersPerRun: parsePositiveSafeInteger(
        requiredValue(env, "USDT_SCAN_MAX_ORDERS"),
        "USDT_SCAN_MAX_ORDERS",
      ),
      maxPagesPerNamespace: parsePositiveSafeInteger(
        requiredValue(env, "USDT_SCAN_MAX_PAGES"),
        "USDT_SCAN_MAX_PAGES",
      ),
      tronGridPageSize,
    },
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
