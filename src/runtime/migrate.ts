import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createPostgresResource } from "../adapters/database/postgres.js";
import { loadDatabaseUrl } from "./secret-provider.js";

async function main(): Promise<void> {
  const databaseUrl = loadDatabaseUrl(process.env);

  const postgres = createPostgresResource(databaseUrl);

  try {
    await postgres.ping();
    await migrate(postgres.db, {
      migrationsFolder: "./drizzle",
    });
    await postgres.assertSchemaReady();
    console.info("Database migrations completed");
  } finally {
    await postgres.close();
  }
}

void main().catch((error: unknown) => {
  const errorName =
    error instanceof Error ? error.name : "UnknownError";
  console.error(`Database migration failed: ${errorName}`);
  process.exitCode = 1;
});
