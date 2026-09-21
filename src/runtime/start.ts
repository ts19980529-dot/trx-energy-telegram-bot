import { AdminAccessService } from "../application/telegram/admin-access-service.js";
import { PackageSelectionService } from "../application/telegram/package-selection-service.js";
import { TelegramStartService } from "../application/telegram/start-service.js";
import {
  PostgresEnergyPackageRepository,
  PostgresTelegramUserRepository,
} from "../adapters/database/postgres-telegram-repositories.js";
import { createPostgresResource } from "../adapters/database/postgres.js";
import { EnvironmentSecretProvider } from "../adapters/secrets/environment-secret-provider.js";
import {
  assertLongPollingAvailable,
  createTelegramBot,
  telegramAllowedUpdates,
} from "../adapters/telegram/create-bot.js";
import type {
  SecretName,
  SecretProvider,
} from "../core/secrets/secret-provider.js";
import { parseRuntimeConfig } from "./config.js";

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

async function main(): Promise<void> {
  const config = parseRuntimeConfig(process.env);
  const secretProvider = new EnvironmentSecretProvider(process.env);

  if (secretProvider.name !== config.secretProvider) {
    throw new Error("SecretProvider configuration mismatch");
  }

  const [botToken, databaseUrl] = await Promise.all([
    requireSecret(secretProvider, "BOT_TOKEN"),
    requireSecret(secretProvider, "DATABASE_URL"),
  ]);

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

    const bot = createTelegramBot(botToken, {
      start: startService,
      packageSelection,
      adminAccess,
    });

    await bot.init();
    await assertLongPollingAvailable(bot);

    const stop = (): void => {
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

      await bot.start({
        allowed_updates: [...telegramAllowedUpdates],
      });
    } finally {
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
