import { createPostgresResource } from "../adapters/database/postgres.js";
import { bootstrapCatalogIfNeeded } from "./catalog-bootstrap.js";
import { parseSecretProviderKind } from "./config.js";
import { createSecretProvider } from "./secret-provider.js";

async function main(): Promise<void> {
  const secrets = createSecretProvider(
    parseSecretProviderKind(process.env),
    process.env,
  );
  const databaseUrl = await secrets.getSecret("DATABASE_URL");

  if (databaseUrl === undefined) {
    throw new Error("DATABASE_URL is not configured");
  }

  const postgres = createPostgresResource(databaseUrl);

  try {
    await postgres.ping();
    await postgres.assertSchemaReady();

    const result = await bootstrapCatalogIfNeeded(postgres.db);
    console.info(`Catalog bootstrap completed: ${result}`);
  } finally {
    await postgres.close();
  }
}

void main().catch((error: unknown) => {
  const errorName =
    error instanceof Error ? error.name : "UnknownError";
  console.error(`Catalog bootstrap failed: ${errorName}`);
  process.exitCode = 1;
});
