import { and, asc, desc, eq, lte, sql } from "drizzle-orm";

import {
  providerDeliveries,
  providerReclaimAttempts,
  providerTransactionAttempts,
} from "../../db/schema.js";
import type {
  EnergyReclaimAttemptJournal,
  ProviderBroadcastResult,
  ProviderChainStatus,
  ProviderReclaimAttemptEntry,
  ProviderReclaimAttemptStatus,
  TronDelegationBinding,
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

  async listDueSources(limit: number): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Reclaim scan limit must be between 1 and 100");
    }
    const rows = await this.db
      .select({ id: providerTransactionAttempts.id })
      .from(providerTransactionAttempts)
      .innerJoin(providerDeliveries, eq(providerDeliveries.id, providerTransactionAttempts.providerDeliveryId))
      .where(and(
        eq(providerDeliveries.providerName, "tron-own-pool"),
        eq(providerTransactionAttempts.status, "completed"),
        lte(providerTransactionAttempts.reclaimEligibleAt, new Date(this.now())),
        sql`not exists (
          select 1 from provider_reclaim_attempts r
          where r.source_provider_transaction_attempt_id = ${providerTransactionAttempts.id}
            and r.status in ('completed', 'failed')
        )`,
      ))
      .orderBy(asc(providerTransactionAttempts.reclaimEligibleAt))
      .limit(limit);
    return rows.map((row) => row.id);
  }

  async getSourceBinding(sourceId: string): Promise<TronDelegationBinding> {
    const [row] = await this.db.select().from(providerTransactionAttempts)
      .where(eq(providerTransactionAttempts.id, sourceId)).limit(1);
    if (
      row?.status !== "completed" || row.finalizedAt === null ||
      row.reclaimEligibleAt === null || row.reclaimEligibleAt.getTime() > this.now() ||
      row.delegatedOwnerAddress === null || row.delegatedReceiverAddress === null ||
      row.delegatedResource !== "ENERGY" || row.delegatedBalanceSun === null
    ) throw new Error("Reclaim source is not eligible or bound");
    return {
      ownerAddress: row.delegatedOwnerAddress,
      receiverAddress: row.delegatedReceiverAddress,
      resource: "ENERGY",
      balanceSun: row.delegatedBalanceSun,
    };
  }

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

  async claimTransaction(input: {
    readonly attemptKey: string;
    readonly txid: string;
    readonly expirationAt: Date;
  }): Promise<ProviderReclaimAttemptEntry> {
    if (!/^[0-9a-fA-F]{64}$/.test(input.txid) ||
      Number.isNaN(input.expirationAt.getTime())) {
      throw new Error("Invalid reclaim transaction identity");
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(providerReclaimAttempts)
        .where(eq(providerReclaimAttempts.attemptKey, input.attemptKey))
        .limit(1).for("update");
      if (row === undefined) throw new Error("Reclaim attempt is missing");
      const txid = input.txid.toLowerCase();
      if (row.txid !== null) {
        if (row.txid !== txid || row.expirationAt?.getTime() !== input.expirationAt.getTime()) {
          throw new Error("Reclaim transaction identity changed");
        }
        return toEntry(row);
      }
      if (row.status !== "created" || row.signerUnsignedTxid !== txid ||
        row.signedTransaction === null) {
        throw new Error("Reclaim transaction has not been durably signed");
      }
      const [updated] = await tx.update(providerReclaimAttempts)
        .set({ txid, expirationAt: input.expirationAt, status: "signed", updatedAt: new Date() })
        .where(eq(providerReclaimAttempts.id, row.id)).returning();
      if (updated === undefined) throw new Error("Reclaim transaction claim failed");
      return toEntry(updated);
    });
  }

  async recordState(input: {
    readonly attemptKey: string;
    readonly status: ProviderReclaimAttemptStatus;
    readonly lastBroadcastResult?: ProviderBroadcastResult;
    readonly lastChainStatus?: ProviderChainStatus;
    readonly lastChainObservedAt?: Date;
  }): Promise<ProviderReclaimAttemptEntry> {
    if (input.status === "created" || input.status === "signed") {
      throw new Error("Reclaim state cannot move backwards");
    }
    return this.db.transaction(async (tx) => {
      const [row] = await tx.select().from(providerReclaimAttempts)
        .where(eq(providerReclaimAttempts.attemptKey, input.attemptKey))
        .limit(1).for("update");
      if (row === undefined || row.txid === null || row.expirationAt === null) {
        throw new Error("Reclaim attempt has no transaction identity");
      }
      if (["completed", "failed", "expired"].includes(row.status)) {
        if (row.status !== input.status) throw new Error("Reclaim terminal state cannot change");
        return toEntry(row);
      }
      const observedAt = input.lastChainObservedAt ?? row.lastChainObservedAt;
      if (input.status === "expired" && (
        input.lastChainStatus !== "absent" || observedAt === null ||
        observedAt.getTime() < row.expirationAt.getTime()
      )) throw new Error("Reclaim cannot expire without solidified absence after expiration");
      if ((input.status === "completed" || input.status === "failed") &&
        input.lastChainStatus !== input.status) {
        throw new Error("Reclaim terminal outcome requires chain evidence");
      }
      const timestamp = new Date();
      const [updated] = await tx.update(providerReclaimAttempts).set({
        status: input.status,
        lastBroadcastResult: input.lastBroadcastResult ?? row.lastBroadcastResult,
        lastChainStatus: input.lastChainStatus ?? row.lastChainStatus,
        lastChainObservedAt: observedAt,
        broadcastAcceptedAt: row.broadcastAcceptedAt ??
          (input.lastBroadcastResult === "accepted" ? timestamp : null),
        finalizedAt: input.status === "completed" ? timestamp : row.finalizedAt,
        updatedAt: timestamp,
      }).where(eq(providerReclaimAttempts.id, row.id)).returning();
      if (updated === undefined) throw new Error("Reclaim state update failed");
      return toEntry(updated);
    });
  }
}
