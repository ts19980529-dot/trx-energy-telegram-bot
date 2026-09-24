import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "../../db/schema.js";

export type AppDatabase = NodePgDatabase<typeof schema>;

class SignerSchemaNotReadyError extends Error {
  constructor() {
    super("Signer journal schema is not ready");
    this.name = "SignerSchemaNotReadyError";
  }
}

function waitForPollingLease(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 500);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export interface PostgresResource {
  readonly db: AppDatabase;
  ping(): Promise<void>;
  assertSchemaReady(): Promise<void>;
  assertSignerSchemaReady(): Promise<void>;
  acquireTelegramPollingLease(signal: AbortSignal, onLost: () => void): Promise<(() => void) | undefined>;
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

    async assertSignerSchemaReady(): Promise<void> {
      // Query every signer-owned table and its journal columns before opening
      // the signing HTTP port. LIMIT 0 validates the deployed schema without
      // reading customer transactions or changing any data.
      try {
        await pool.query("select provider_name from public.provider_deliveries limit 0");
        await pool.query(
          "select attempt_key, signer_unsigned_txid, signer_unsigned_digest, signed_transaction, signed_at from public.provider_transaction_attempts limit 0",
        );
        await pool.query(
          "select attempt_key, signer_unsigned_txid, signer_unsigned_digest, signed_transaction, signed_at from public.provider_reclaim_attempts limit 0",
        );
      } catch (error) {
        if (typeof error === "object" && error !== null && "code" in error &&
          (error.code === "42P01" || error.code === "42703")) {
          throw new SignerSchemaNotReadyError();
        }
        throw error;
      }
    },

    async acquireTelegramPollingLease(signal, onLost) {
      // A dedicated session owns the lock for the full lifetime of long polling.
      // Session termination releases it even if the process crashes.
      while (!signal.aborted) {
        const client = await pool.connect();
        let held = false;
        let active = false;
        const connectionLost = (): void => {
          if (active) onLost();
        };
        client.on("error", connectionLost);
        client.on("end", connectionLost);
        try {
          const result = await client.query<{ acquired: boolean }>(
            "select pg_try_advisory_lock(7805591, 1) as acquired",
          );
          held = result.rows[0]?.acquired === true && !signal.aborted;
          if (result.rows[0]?.acquired === true && signal.aborted) {
            await client.query("select pg_advisory_unlock(7805591, 1)");
          }
          if (held) {
            active = true;
            return () => {
              active = false;
              client.off("error", connectionLost);
              client.off("end", connectionLost);
              client.release(true);
            };
          }
        } finally {
          if (!held) {
            client.off("error", connectionLost);
            client.off("end", connectionLost);
            client.release(true);
          }
        }
        await waitForPollingLease(signal);
      }
      return undefined;
    },

    async close(): Promise<void> {
      await pool.end();
    },
  };
}
