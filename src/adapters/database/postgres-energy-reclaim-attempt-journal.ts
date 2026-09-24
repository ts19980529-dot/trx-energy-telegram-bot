import { asc, desc, eq, sql } from "drizzle-orm";

import {
  providerDeliveries,
  providerReclaimAttempts,
  providerTransactionAttempts,
} from "../../db/schema.js";
import type {
  EnergyReclaimAttemptJournal,
  ProviderReclaimAttemptEntry,
  ProviderReclaimAttemptStatus,
} from "../energy/tron-own-pool-energy-provider.js";
import type { AppDatabase } from "./postgres.js";

type ReclaimRow = typeof providerReclaimAttempts.$inferSelect;

function parseStatus(value: string): ProviderReclaimAttemptStatus {
  switch (value) {
    case "created":
    case "signed":
    case "accepted":
    case "processing":
    case "completed":
    case "failed":
    case "expired":
    case "unknown":
      return value;
    default:
      throw new Error(`Unsupported provider reclaim attempt status: ${value}`);
  }
}

function parseBroadcastResult(
  value: string | null,
): "accepted" | "rejected" | "unknown" | null {
  switch (value) {
    case null:
    case "accepted":
    case "rejected":
    case "unknown":
      return value;
    default:
      throw new Error(`Unsupported provider reclaim broadcast result: ${value}`);
  }
}

function parseChainStatus(
  value: string | null,
): "absent" | "processing" | "completed" | "failed" | "unknown" | null {
  switch (value) {
    case null:
    case "absent":
    case "processing":
    case "completed":
    case "failed":
    case "unknown":
      return value;
    default:
      throw new Error(`Unsupported provider reclaim chain status: ${value}`);
  }
}

function toEntry(row: ReclaimRow): ProviderReclaimAttemptEntry {
  return {
    id: row.id,
    sourceProviderTransactionAttemptId: row.sourceProviderTransactionAttemptId,
    attemptNumber: row.attemptNumber,
    attemptKey: row.attemptKey,
    txid: row.txid,
    expirationAt: row.expirationAt,
    status: parseStatus(row.status),
    lastBroadcastResult: parseBroadcastResult(row.lastBroadcastResult),
    lastChainStatus: parseChainStatus(row.lastChainStatus),
    lastChainObservedAt: row.lastChainObservedAt,
  };
}

export class PostgresEnergyReclaimAttemptJournal
  implements EnergyReclaimAttemptJournal
{
  constructor(
    private readonly db: AppDatabase,
    private readonly now: () => number = Date.now,
  ) {}

  async getOrCreateCurrentAttempt(input: {
    readonly sourceProviderTransactionAttemptId: string;
    readonly providerName: string;
  }): Promise<ProviderReclaimAttemptEntry> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(
          hashtext('energy-provider-reclaim-attempt'),
          hashtext(${input.sourceProviderTransactionAttemptId})
        )`,
      );

      const [source] = await tx
        .select({
          attempt: providerTransactionAttempts,
          providerName: providerDeliveries.providerName,
        })
        .from(providerTransactionAttempts)
        .innerJoin(
          providerDeliveries,
          eq(providerDeliveries.id, providerTransactionAttempts.providerDeliveryId),
        )
        .where(eq(providerTransactionAttempts.id, input.sourceProviderTransactionAttemptId))
        .limit(1)
        .for("update");

      if (source === undefined) throw new Error("Source delegation attempt is missing");
      if (source.providerName !== input.providerName) {
        throw new Error("Energy provider journal owner changed");
      }
      if (source.attempt.status !== "completed" || source.attempt.finalizedAt === null) {
        throw new Error("Energy reclaim requires a finalized delegation");
      }
      if (
        source.attempt.delegatedOwnerAddress === null ||
        source.attempt.delegatedReceiverAddress === null ||
        source.attempt.delegatedResource !== "ENERGY" ||
        source.attempt.delegatedBalanceSun === null
      ) {
        throw new Error("Energy reclaim source delegation binding is incomplete");
      }
      if (
        source.attempt.reclaimEligibleAt === null ||
        source.attempt.reclaimEligibleAt.getTime() > this.now()
      ) {
        throw new Error("Energy reclaim is not yet eligible");
      }

      const [latest] = await tx
        .select()
        .from(providerReclaimAttempts)
        .where(eq(providerReclaimAttempts.sourceProviderTransactionAttemptId, source.attempt.id))
        .orderBy(desc(providerReclaimAttempts.attemptNumber))
        .limit(1)
        .for("update");

      if (latest !== undefined && latest.status !== "expired") return toEntry(latest);

      const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
      const [created] = await tx
        .insert(providerReclaimAttempts)
        .values({
          sourceProviderTransactionAttemptId: source.attempt.id,
          attemptNumber,
          attemptKey: `${source.attempt.attemptKey}:reclaim:${attemptNumber}`,
          status: "created",
        })
        .returning();

      if (created === undefined) throw new Error("Provider reclaim attempt insert returned no row");
      return toEntry(created);
    });
  }

  async listAttempts(input: {
    readonly sourceProviderTransactionAttemptId: string;
    readonly providerName: string;
  }): Promise<readonly ProviderReclaimAttemptEntry[]> {
    const [source] = await this.db
      .select({ providerName: providerDeliveries.providerName })
      .from(providerTransactionAttempts)
      .innerJoin(
        providerDeliveries,
        eq(providerDeliveries.id, providerTransactionAttempts.providerDeliveryId),
      )
      .where(eq(providerTransactionAttempts.id, input.sourceProviderTransactionAttemptId))
      .limit(1);

    if (source === undefined) throw new Error("Source delegation attempt is missing");
    if (source.providerName !== input.providerName) {
      throw new Error("Energy provider journal owner changed");
    }

    const rows = await this.db
      .select()
      .from(providerReclaimAttempts)
      .where(eq(providerReclaimAttempts.sourceProviderTransactionAttemptId, input.sourceProviderTransactionAttemptId))
      .orderBy(asc(providerReclaimAttempts.attemptNumber));

    return rows.map(toEntry);
  }
}
