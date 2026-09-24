import { migrate } from "drizzle-orm/node-postgres/migrator";

import { createPostgresResource } from "../adapters/database/postgres.js";
import { loadDatabaseUrl } from "./secret-provider.js";

function sanitizedMessage(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }

  return value.replace(
    /postgres(?:ql)?:\/\/[^@\s]+@/gi,
    "postgresql://***@",
  );
}

function migrationFailureDiagnostic(error: unknown): string {
  const diagnostics: Record<string, string> = {};
  const visited = new Set<unknown>();
  let current: unknown = error;

  for (let depth = 0; depth < 4; depth += 1) {
    if (
      typeof current !== "object" ||
      current === null ||
      visited.has(current)
    ) {
      break;
    }

    visited.add(current);
    const record = current as Record<string, unknown>;

    for (const key of [
      "name",
      "code",
      "schema",
      "table",
      "constraint",
      "column",
      "routine",
    ] as const) {
      const value = record[key];
      if (
        diagnostics[key] === undefined &&
        typeof value === "string" &&
        value.trim() !== ""
      ) {
        diagnostics[key] = value.trim();
      }
    }

    if (diagnostics.message === undefined) {
      const message = sanitizedMessage(record.message);
      if (message !== undefined) {
        diagnostics.message = message;
      }
    }

    current = record.cause;
  }

  return JSON.stringify(
    Object.keys(diagnostics).length === 0
      ? { name: "UnknownError" }
      : diagnostics,
  );
}

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
  console.error(
    `Database migration failed: ${migrationFailureDiagnostic(error)}`,
  );
  process.exitCode = 1;
});
