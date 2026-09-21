import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "../../db/schema.js";

export type AppDatabase = NodePgDatabase<typeof schema>;

export interface PostgresResource {
  readonly db: AppDatabase;
  ping(): Promise<void>;
  assertSchemaReady(): Promise<void>;
  close(): Promise<void>;
}

export function createPostgresResource(connectionString: string): PostgresResource {
  const pool = new Pool({ connectionString });
  const db = drizzle(pool, { schema });

  return {
    db,

    async ping(): Promise<void> {
      await pool.query("select 1");
    },

    async assertSchemaReady(): Promise<void> {
      const result = await pool.query<{ users_table: string | null }>(
        "select to_regclass('public.users')::text as users_table",
      );

      if (result.rows[0]?.users_table === null || result.rows[0] === undefined) {
        throw new Error("Database schema is not ready");
      }
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
