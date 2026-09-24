import { EnergyUsageService } from "../application/energy/energy-usage-service.js";
import { PurchaseOrderCreationService } from "../application/payments/purchase-order-service.js";
import { PurchaseOrderStatusService } from "../application/payments/purchase-order-status-service.js";
import { UsdtPaymentReconciliationService } from "../application/payments/usdt-payment-reconciliation-service.js";
import { AdminAccessService } from "../application/telegram/admin-access-service.js";
import { PackageSelectionService } from "../application/telegram/package-selection-service.js";
import { TelegramStartService } from "../application/telegram/start-service.js";
import { PostgresEnergyProviderAttemptJournal } from "../adapters/database/postgres-energy-provider-attempt-journal.js";
import { PostgresEnergyProviderJournal } from "../adapters/database/postgres-energy-provider-journal.js";
import { PostgresEnergyUsageRepository } from "../adapters/database/postgres-energy-usage-repository.js";
import { PostgresPackageCreditRepository } from "../adapters/database/postgres-package-credit-repository.js";
import { PostgresPaymentLifecycleRepository } from "../adapters/database/postgres-payment-lifecycle-repository.js";
import { PostgresPurchaseOrderStatusRepository } from "../adapters/database/postgres-purchase-order-status-repository.js";
import {
  PostgresPurchaseOrderCustomerRepository,
  PostgresPurchaseOrderRepository,
} from "../adapters/database/postgres-purchase-order-repository.js";
import {
  PostgresEnergyPackageRepository,
  PostgresTelegramUserRepository,
} from "../adapters/database/postgres-telegram-repositories.js";
import { PostgresUsdtReconciliationOrderRepository } from "../adapters/database/postgres-usdt-payment-reconciliation-order-repository.js";
import { createPostgresResource } from "../adapters/database/postgres.js";
import { TronOwnPoolEnergyProvider } from "../adapters/energy/tron-own-pool-energy-provider.js";
import { ConfiguredUsdtPurchaseQuoteProvider } from "../adapters/payments/configured-usdt-purchase-quote-provider.js";
import { HttpTronDelegationSigner } from "../adapters/signer/http-tron-delegation-signer.js";
import {
  createSecretProvider,
  loadRuntimeSecrets,
} from "./secret-provider.js";
import {
  assertLongPollingAvailable,
  createTelegramBot,
  telegramAllowedUpdates,
} from "../adapters/telegram/create-bot.js";
import { NodeTronAddressCodec } from "../adapters/tron/node-tron-address-codec.js";
import { NodeFetchTronDelegationTransport } from "../adapters/tron/tron-delegation-http-transport.js";
import { HttpTronConfirmationDepthProvider } from "../adapters/tron/tron-http-confirmation-depth-provider.js";
import { HttpTronPaymentEvidenceReader } from "../adapters/tron/tron-http-payment-evidence-reader.js";
import { NodeFetchTronReadHttpTransport } from "../adapters/tron/tron-http-transport.js";
import {
  TronReadAdapterError,
  TronReadPaymentFinalityVerifier,
} from "../adapters/tron/tron-read-finality-verifier.js";
import { NodeFetchTronGridUsdtCandidateHttpTransport } from "../adapters/tron/trongrid-candidate-http-transport.js";
import {
  TronGridCandidateAdapterError,
  TronGridUsdtPaymentDetector,
} from "../adapters/tron/trongrid-usdt-payment-detector.js";
import type {
  TronAddressCodec,
  TronEncodedAddress,
} from "../core/payments/tron-evidence-normalization.js";
import { parseRuntimeConfig } from "./config.js";
import { PaymentReconciliationLoop } from "./payment-reconciliation-loop.js";

function canonicalTronAddress(
  codec: TronAddressCodec,
  value: string,
  field: string,
): string {
  const trimmed = value.trim();
  const encoded: TronEncodedAddress =
    /^41[0-9a-fA-F]{40}$/.test(trimmed)
      ? { encoding: "hex41", value: trimmed }
      : { encoding: "base58check", value: trimmed };
  const canonical = codec.toBase58Check(encoded);

  if (canonical === undefined) {
    throw new Error(`${field} must be a valid TRON address`);
  }

  return canonical;
}

function retryablePaymentReadError(error: unknown): boolean {
  return (
    error instanceof TronGridCandidateAdapterError ||
    error instanceof TronReadAdapterError
  );
}

function logRetryablePaymentReadError(error: unknown): void {
  if (error instanceof TronGridCandidateAdapterError) {
    console.error(
      `Payment reconciliation source unavailable: trongrid:${error.reason}`,
    );
    return;
  }

  if (error instanceof TronReadAdapterError) {
    console.error(
      `Payment reconciliation source unavailable: tron-read:${error.reason}`,
    );
    return;
  }

  console.error("Payment reconciliation source unavailable");
}

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const secretProvider = createSecretProvider(
    config.secretProvider,
    process.env,
  );

  if (secretProvider.name !== config.secretProvider) {
    throw new Error("SecretProvider configuration mismatch");
  }

  const {
    botToken,
    databaseUrl,
    tronApiKey,
    tronSignerAuthToken,
  } = await loadRuntimeSecrets(secretProvider, {
    env: process.env,
    nodeEnv: process.env.NODE_ENV,
    usdtEnabled: config.usdtPayment !== undefined,
    energyEnabled: config.tronEnergy !== undefined,
  });

  const postgres = createPostgresResource(databaseUrl);

  try {
    await postgres.ping();
    await postgres.assertSchemaReady();

    const users = new PostgresTelegramUserRepository(postgres.db);
    const packages = new PostgresEnergyPackageRepository(postgres.db);

    const startService = new TelegramStartService(users, packages);
    const packageSelection = new PackageSelectionService(users, packages);
    const adminAccess = new AdminAccessService(
      users,
      config.superAdminId,
    );

    const addressCodec = new NodeTronAddressCodec();
    let energyUsage: EnergyUsageService | undefined;

    if (config.tronEnergy !== undefined) {
      if (tronSignerAuthToken === undefined) {
        throw new Error("TRON signer auth token is missing");
      }

      const ownerAddress = canonicalTronAddress(
        addressCodec,
        config.tronEnergy.ownerAddress,
        "ENERGY_OWNER_ADDRESS",
      );
      const transport = new NodeFetchTronDelegationTransport({
        headBaseUrl: config.tronEnergy.tronHeadBaseUrl,
        solidifiedBaseUrl: config.tronEnergy.tronSolidifiedBaseUrl,
        timeoutMs: config.tronEnergy.httpTimeoutMs,
        ...(tronApiKey === undefined ? {} : { apiKey: tronApiKey }),
      });
      const signer = new HttpTronDelegationSigner({
        baseUrl: config.tronEnergy.signerBaseUrl,
        authToken: tronSignerAuthToken,
        timeoutMs: config.tronEnergy.signerHttpTimeoutMs,
      });
      const provider = new TronOwnPoolEnergyProvider(
        ownerAddress,
        transport,
        signer,
        new PostgresEnergyProviderJournal(postgres.db),
        new PostgresEnergyProviderAttemptJournal(postgres.db),
      );

      energyUsage = new EnergyUsageService(
        new PostgresEnergyUsageRepository(postgres.db),
        provider,
        addressCodec,
      );
    }

    let purchaseOrderCreation:
      | PurchaseOrderCreationService
      | undefined;
    let reconciliationLoop:
      | PaymentReconciliationLoop
      | undefined;

    if (config.usdtPayment !== undefined) {
      const toAddress = canonicalTronAddress(
        addressCodec,
        config.usdtPayment.toAddress,
        "USDT_PAYMENT_ADDRESS",
      );
      const tokenContractAddress = canonicalTronAddress(
        addressCodec,
        config.usdtPayment.tokenContractAddress,
        "USDT_TOKEN_CONTRACT_ADDRESS",
      );

      purchaseOrderCreation = new PurchaseOrderCreationService(
        new PostgresPurchaseOrderCustomerRepository(postgres.db),
        packages,
        new ConfiguredUsdtPurchaseQuoteProvider({
          toAddress,
          tokenContractAddress,
          requiredConfirmations:
            config.usdtPayment.requiredConfirmations,
          quoteTtlMs: config.usdtPayment.quoteTtlMs,
        }),
        new PostgresPurchaseOrderRepository(postgres.db),
        config.usdtPayment.attributionMaxOffsetAtomic,
      );

      const reconciliationConfig =
        config.usdtPayment.reconciliation;
      const candidateTransport =
        new NodeFetchTronGridUsdtCandidateHttpTransport({
          baseUrl: reconciliationConfig.tronGridBaseUrl,
          timeoutMs: reconciliationConfig.httpTimeoutMs,
          pageSize: reconciliationConfig.tronGridPageSize,
          ...(tronApiKey === undefined
            ? {}
            : { apiKey: tronApiKey }),
        });
      const detector = new TronGridUsdtPaymentDetector(
        candidateTransport,
        addressCodec,
      );
      const readTransport = new NodeFetchTronReadHttpTransport({
        headBaseUrl: reconciliationConfig.tronHeadBaseUrl,
        solidifiedBaseUrl:
          reconciliationConfig.tronSolidifiedBaseUrl,
        timeoutMs: reconciliationConfig.httpTimeoutMs,
        ...(tronApiKey === undefined
          ? {}
          : { apiKey: tronApiKey }),
      });
      const confirmationDepth =
        new HttpTronConfirmationDepthProvider(readTransport);
      const evidenceReader = new HttpTronPaymentEvidenceReader(
        readTransport,
        confirmationDepth,
      );
      const finality = new TronReadPaymentFinalityVerifier(
        evidenceReader,
        addressCodec,
      );
      const reconciliation =
        new UsdtPaymentReconciliationService(
          new PostgresUsdtReconciliationOrderRepository(
            postgres.db,
          ),
          detector,
          finality,
          new PostgresPaymentLifecycleRepository(postgres.db),
          new PostgresPackageCreditRepository(postgres.db),
          reconciliationConfig.maxOrdersPerRun,
          reconciliationConfig.maxPagesPerNamespace,
        );

      reconciliationLoop = new PaymentReconciliationLoop(
        reconciliation,
        reconciliationConfig.scanIntervalMs,
        retryablePaymentReadError,
        logRetryablePaymentReadError,
      );
    }

    const purchaseOrderStatus =
      purchaseOrderCreation === undefined
        ? undefined
        : new PurchaseOrderStatusService(
            new PostgresPurchaseOrderStatusRepository(postgres.db),
          );

    const bot = createTelegramBot(botToken, {
      start: startService,
      packageSelection,
      adminAccess,
      ...(energyUsage === undefined ? {} : { energyUsage }),
      ...(purchaseOrderCreation === undefined
        ? {}
        : { purchaseOrderCreation }),
      ...(purchaseOrderStatus === undefined
        ? {}
        : { purchaseOrderStatus }),
    });

    await bot.init();
    await assertLongPollingAvailable(bot);

    const reconciliationAbort = new AbortController();
    const reconciliationTask =
      reconciliationLoop?.run(reconciliationAbort.signal);

    const stop = (): void => {
      reconciliationAbort.abort();

      if (bot.isRunning()) {
        bot.stop();
      }
    };

    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    try {
      console.info(
        `Telegram bot initialized: @${bot.botInfo.username}`,
      );

      const botTask = bot.start({
        allowed_updates: [...telegramAllowedUpdates],
      });

      if (reconciliationTask === undefined) {
        await botTask;
      } else {
        await Promise.race([botTask, reconciliationTask]);
      }
    } finally {
      reconciliationAbort.abort();

      if (bot.isRunning()) {
        bot.stop();
      }

      if (reconciliationTask !== undefined) {
        await Promise.allSettled([reconciliationTask]);
      }

      process.off("SIGINT", stop);
      process.off("SIGTERM", stop);
    }
  } finally {
    await postgres.close();
  }
}

void main().catch((error: unknown) => {
  const errorName = error instanceof Error ? error.name : "UnknownError";
  console.error(`Application startup failed: ${errorName}`);
  process.exitCode = 1;
});
