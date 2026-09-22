import { createPostgresResource } from "../adapters/database/postgres.js";
import { bootstrapCatalogIfNeeded } from "./catalog-bootstrap.js";
import { loadDatabaseUrl } from "./secret-provider.js";

async function main(): Promise<void> {
  const databaseUrl = loadDatabaseUrl(process.env);

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
