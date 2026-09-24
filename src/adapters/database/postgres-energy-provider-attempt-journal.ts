import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";

import {
  providerDeliveries,
  providerTransactionAttempts,
} from "../../db/schema.js";
import type { AppDatabase } from "./postgres.js";

import type {
  EnergyProviderAttemptJournal,
  ProviderBroadcastResult,
  ProviderChainStatus,
  ProviderTransactionAttemptEntry,
  ProviderTransactionAttemptStatus,
} from "../energy/tron-own-pool-energy-provider.js";
type AttemptRow = typeof providerTransactionAttempts.$inferSelect;

function parseAttemptStatus(value: string): ProviderTransactionAttemptStatus {
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
      throw new Error(`Unsupported provider transaction attempt status: ${value}`);
  }
}

function parseBroadcastResult(value: string | null): ProviderBroadcastResult | null {
  switch (value) {
    case null:
    case "accepted":
    case "rejected":
    case "unknown":
      return value;
    default:
      throw new Error(`Unsupported provider broadcast result: ${value}`);
  }
}

function parseChainStatus(value: string | null): ProviderChainStatus | null {
  switch (value) {
    case null:
    case "absent":
    case "processing":
    case "completed":
    case "failed":
    case "unknown":
      return value;
    default:
      throw new Error(`Unsupported provider chain status: ${value}`);
  }
}

function toAttempt(row: AttemptRow): ProviderTransactionAttemptEntry {
  return {
    id: row.id,
    providerDeliveryId: row.providerDeliveryId,
    attemptNumber: row.attemptNumber,
    attemptKey: row.attemptKey,
    txid: row.txid,
    expirationAt: row.expirationAt,
    status: parseAttemptStatus(row.status),
    lastBroadcastResult: parseBroadcastResult(row.lastBroadcastResult),
    lastChainStatus: parseChainStatus(row.lastChainStatus),
    lastChainObservedAt: row.lastChainObservedAt,
  };
}

function normalizeTxid(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new Error("Provider transaction attempt txid must be a 64-character hexadecimal string");
  }
  return normalized;
}

function transitionAllowed(
  current: ProviderTransactionAttemptStatus,
  next: ProviderTransactionAttemptStatus,
): boolean {
  if (current === next) return true;
  switch (current) {
    case "created":
      return next === "signed" || next === "failed";
    case "signed":
      return ["accepted", "processing", "failed", "expired", "unknown"].includes(next);
    case "accepted":
      return ["processing", "completed", "failed", "expired", "unknown"].includes(next);
    case "processing":
      return ["completed", "failed", "expired", "unknown"].includes(next);
    case "unknown":
      return ["accepted", "processing", "completed", "failed", "expired"].includes(next);
    case "completed":
    case "failed":
    case "expired":
      return false;
  }
}

export class PostgresEnergyProviderAttemptJournal
  implements EnergyProviderAttemptJournal
{
  constructor(private readonly db: AppDatabase) {}

  async getOrCreateCurrentAttempt(input: {
    readonly idempotencyKey: string;
    readonly providerName: string;
  }): Promise<ProviderTransactionAttemptEntry> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(
          hashtext('energy-provider-attempt'),
          hashtext(${input.idempotencyKey})
        )`,
      );

      const [delivery] = await tx
        .select({ id: providerDeliveries.id, providerName: providerDeliveries.providerName })
        .from(providerDeliveries)
        .where(eq(providerDeliveries.idempotencyKey, input.idempotencyKey))
        .limit(1)
        .for("update");

      if (delivery === undefined) throw new Error("Energy provider journal row is missing");
      if (delivery.providerName !== input.providerName) throw new Error("Energy provider journal owner changed");

      const [latest] = await tx
        .select()
        .from(providerTransactionAttempts)
        .where(eq(providerTransactionAttempts.providerDeliveryId, delivery.id))
        .orderBy(desc(providerTransactionAttempts.attemptNumber))
        .limit(1)
        .for("update");

      if (latest !== undefined && latest.status !== "expired") return toAttempt(latest);

      const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
      const [created] = await tx
        .insert(providerTransactionAttempts)
        .values({
          providerDeliveryId: delivery.id,
          attemptNumber,
          attemptKey: `${input.idempotencyKey}:attempt:${attemptNumber}`,
          status: "created",
        })
        .returning();

      if (created === undefined) throw new Error("Provider transaction attempt insert returned no row");
      return toAttempt(created);
    });
  }

  async claimAttemptTransaction(input: {
    readonly attemptKey: string;
    readonly providerName: string;
    readonly txid: string;
    readonly expirationAt: Date;
  }): Promise<ProviderTransactionAttemptEntry> {
    const txid = normalizeTxid(input.txid);
    if (Number.isNaN(input.expirationAt.getTime())) throw new Error("Provider transaction expiration is invalid");

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(
          hashtext('energy-provider-attempt-claim'),
          hashtext(${input.attemptKey})
        )`,
      );

      const [selected] = await tx
        .select({ attempt: providerTransactionAttempts, providerName: providerDeliveries.providerName })
        .from(providerTransactionAttempts)
        .innerJoin(providerDeliveries, eq(providerDeliveries.id, providerTransactionAttempts.providerDeliveryId))
        .where(eq(providerTransactionAttempts.attemptKey, input.attemptKey))
        .limit(1)
        .for("update");

      if (selected === undefined) throw new Error("Provider transaction attempt is missing");
      if (selected.providerName !== input.providerName) throw new Error("Energy provider journal owner changed");

      if (selected.attempt.txid !== null) {
        if (
          selected.attempt.txid !== txid ||
          selected.attempt.expirationAt === null ||
          selected.attempt.expirationAt.getTime() !== input.expirationAt.getTime()
        ) throw new Error("Energy provider transaction attempt identity changed");
        return toAttempt(selected.attempt);
      }

      if (selected.attempt.status !== "created") throw new Error("Unsigned provider transaction attempt is not in created state");

      const [updated] = await tx
        .update(providerTransactionAttempts)
        .set({ txid, expirationAt: input.expirationAt, status: "signed", updatedAt: new Date() })
        .where(and(
          eq(providerTransactionAttempts.id, selected.attempt.id),
          eq(providerTransactionAttempts.status, "created"),
          isNull(providerTransactionAttempts.txid),
        ))
        .returning();

      if (updated === undefined) throw new Error("Provider transaction attempt claim lost its state");

      await tx
        .update(providerDeliveries)
        .set({ providerOrderId: txid, updatedAt: new Date() })
        .where(eq(providerDeliveries.id, selected.attempt.providerDeliveryId));

      return toAttempt(updated);
    });
  }

  async recordAttemptState(input: {
    readonly attemptKey: string;
    readonly providerName: string;
    readonly status: ProviderTransactionAttemptStatus;
    readonly lastBroadcastResult?: ProviderBroadcastResult;
    readonly lastChainStatus?: ProviderChainStatus;
    readonly lastChainObservedAt?: Date;
  }): Promise<ProviderTransactionAttemptEntry> {
    if (input.status === "created" || input.status === "signed") throw new Error("Provider transaction attempt state must advance beyond signed");

    if (
      input.lastChainObservedAt !== undefined &&
      Number.isNaN(input.lastChainObservedAt.getTime())
    ) {
      throw new Error("Provider chain observation time is invalid");
    }

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(
          hashtext('energy-provider-attempt-state'),
          hashtext(${input.attemptKey})
        )`,
      );

      const [selected] = await tx
        .select({ attempt: providerTransactionAttempts, providerName: providerDeliveries.providerName })
        .from(providerTransactionAttempts)
        .innerJoin(providerDeliveries, eq(providerDeliveries.id, providerTransactionAttempts.providerDeliveryId))
        .where(eq(providerTransactionAttempts.attemptKey, input.attemptKey))
        .limit(1)
        .for("update");

      if (selected === undefined) throw new Error("Provider transaction attempt is missing");
      if (selected.providerName !== input.providerName) throw new Error("Energy provider journal owner changed");

      const current = parseAttemptStatus(selected.attempt.status);
      if (!transitionAllowed(current, input.status)) throw new Error(`Invalid provider transaction attempt transition: ${current} -> ${input.status}`);

      const chainObservedAt =
        input.lastChainObservedAt ??
        selected.attempt.lastChainObservedAt;

      if (
        input.status === "expired" &&
        (
          input.lastChainStatus !== "absent" ||
          selected.attempt.expirationAt === null ||
          chainObservedAt === null ||
          chainObservedAt.getTime() <
            selected.attempt.expirationAt.getTime()
        )
      ) {
        throw new Error(
          "Provider transaction attempt cannot expire without solidified chain absence at or after expiration",
        );
      }

      const [updated] = await tx
        .update(providerTransactionAttempts)
        .set({
          status: input.status,
          lastBroadcastResult: input.lastBroadcastResult ?? selected.attempt.lastBroadcastResult,
          lastChainStatus: input.lastChainStatus ?? selected.attempt.lastChainStatus,
          lastChainObservedAt: chainObservedAt,
          updatedAt: new Date(),
        })
        .where(eq(providerTransactionAttempts.id, selected.attempt.id))
        .returning();

      if (updated === undefined) throw new Error("Provider transaction attempt state update returned no row");
      return toAttempt(updated);
    });
  }

  async listAttempts(input: {
    readonly idempotencyKey: string;
    readonly providerName: string;
  }): Promise<readonly ProviderTransactionAttemptEntry[]> {
    const rows = await this.db
      .select({ attempt: providerTransactionAttempts, providerName: providerDeliveries.providerName })
      .from(providerTransactionAttempts)
      .innerJoin(providerDeliveries, eq(providerDeliveries.id, providerTransactionAttempts.providerDeliveryId))
      .where(eq(providerDeliveries.idempotencyKey, input.idempotencyKey))
      .orderBy(asc(providerTransactionAttempts.attemptNumber));
    if (rows.some((row) => row.providerName !== input.providerName)) throw new Error("Energy provider journal owner changed");
    return rows.map((row) => toAttempt(row.attempt));
  }
}
