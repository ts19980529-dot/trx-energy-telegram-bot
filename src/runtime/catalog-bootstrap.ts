import { sql } from "drizzle-orm";

import {
  catalogEnergyOptions,
  catalogPackages,
} from "../config/catalog.js";
import {
  energyOptions,
  energyPackages,
} from "../db/schema.js";
import type { AppDatabase } from "../adapters/database/postgres.js";

export type CatalogBootstrapResult =
  | "initialized"
  | "already_initialized";

export async function bootstrapCatalogIfNeeded(
  db: AppDatabase,
): Promise<CatalogBootstrapResult> {
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select pg_advisory_xact_lock(
        hashtext('trx-energy-telegram-bot'),
        hashtext('catalog-bootstrap')
      )`,
    );

    const [packageCountRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(energyPackages);
    const [optionCountRow] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(energyOptions);

    const packageCount = packageCountRow?.count ?? 0;
    const optionCount = optionCountRow?.count ?? 0;

    if (packageCount === 0 && optionCount === 0) {
      await tx.insert(energyPackages).values(
        catalogPackages.map((item) => ({
          code: item.code,
          count: item.count,
          priceUsdtMicros: item.priceUsdtMicros,
          enabled: item.enabled,
          sortOrder: item.sortOrder,
        })),
      );

      await tx.insert(energyOptions).values(
        catalogEnergyOptions.map((item) => ({
          code: item.code,
          energyAmount: item.energyAmount,
          countCost: item.countCost,
          enabled: item.enabled,
          sortOrder: item.sortOrder,
        })),
      );

      return "initialized";
    }

    if (packageCount === 0 || optionCount === 0) {
      throw new Error(
        "Catalog bootstrap detected partial initialization",
      );
    }

    return "already_initialized";
  });
}
