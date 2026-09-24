import {
  and,
  eq,
  isNull,
  or,
} from "drizzle-orm";

import type {
  EnergyProviderJournal,
  EnergyProviderJournalEntry,
} from "../energy/tron-own-pool-energy-provider.js";
import type { AppDatabase } from "./postgres.js";
import { providerDeliveries } from "../../db/schema.js";

type JournalStatus = EnergyProviderJournalEntry["status"];

function parseStatus(value: string): JournalStatus {
  switch (value) {
    case "pending":
    case "accepted":
    case "processing":
    case "completed":
    case "failed":
    case "unknown":
      return value;
    default:
      throw new Error(
        `Unsupported provider delivery status: ${value}`,
      );
  }
}

function toEntry(row: {
  readonly idempotencyKey: string;
  readonly providerName: string;
  readonly providerOrderId: string | null;
  readonly status: string;
}): EnergyProviderJournalEntry {
  return {
    idempotencyKey: row.idempotencyKey,
    providerName: row.providerName,
    providerOrderId: row.providerOrderId,
    status: parseStatus(row.status),
  };
}

export class PostgresEnergyProviderJournal
  implements EnergyProviderJournal
{
  constructor(private readonly db: AppDatabase) {}

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<EnergyProviderJournalEntry | undefined> {
    const [row] = await this.db
      .select({
        idempotencyKey: providerDeliveries.idempotencyKey,
        providerName: providerDeliveries.providerName,
        providerOrderId: providerDeliveries.providerOrderId,
        status: providerDeliveries.status,
      })
      .from(providerDeliveries)
      .where(
        eq(
          providerDeliveries.idempotencyKey,
          idempotencyKey,
        ),
      )
      .limit(1);

    return row === undefined ? undefined : toEntry(row);
  }

  async findByProviderOrderId(input: {
    readonly providerName: string;
    readonly providerOrderId: string;
  }): Promise<EnergyProviderJournalEntry | undefined> {
    const [row] = await this.db
      .select({
        idempotencyKey: providerDeliveries.idempotencyKey,
        providerName: providerDeliveries.providerName,
        providerOrderId: providerDeliveries.providerOrderId,
        status: providerDeliveries.status,
      })
      .from(providerDeliveries)
      .where(
        and(
          eq(
            providerDeliveries.providerName,
            input.providerName,
          ),
          eq(
            providerDeliveries.providerOrderId,
            input.providerOrderId,
          ),
        ),
      )
      .limit(1);

    return row === undefined ? undefined : toEntry(row);
  }

  async claimProviderOrderId(input: {
    readonly idempotencyKey: string;
    readonly providerName: string;
    readonly providerOrderId: string;
  }): Promise<void> {
    const [updated] = await this.db
      .update(providerDeliveries)
      .set({
        providerOrderId: input.providerOrderId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(
            providerDeliveries.idempotencyKey,
            input.idempotencyKey,
          ),
          eq(
            providerDeliveries.providerName,
            input.providerName,
          ),
          or(
            isNull(providerDeliveries.providerOrderId),
            eq(
              providerDeliveries.providerOrderId,
              input.providerOrderId,
            ),
          ),
        ),
      )
      .returning({
        providerOrderId:
          providerDeliveries.providerOrderId,
      });

    if (updated !== undefined) {
      return;
    }

    const existing = await this.findByIdempotencyKey(
      input.idempotencyKey,
    );

    if (existing === undefined) {
      throw new Error(
        "Energy provider journal row is missing",
      );
    }

    if (existing.providerName !== input.providerName) {
      throw new Error(
        "Energy provider journal owner changed",
      );
    }

    throw new Error(
      "Energy provider transaction identity changed",
    );
  }
}
