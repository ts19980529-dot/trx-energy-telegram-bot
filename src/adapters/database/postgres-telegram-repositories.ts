import { and, asc, eq } from "drizzle-orm";

import type {
  EnergyPackageRepository,
  EnergyPackageSummary,
  TelegramUserAccessSnapshot,
  TelegramUserOnboardingInput,
  TelegramUserRepository,
  TelegramUserSnapshot,
  UserStatus,
} from "../../application/telegram/ports.js";
import { isAdminRole } from "../../core/admin/roles.js";
import {
  adminAccounts,
  energyPackages,
  packageBalances,
  users,
} from "../../db/schema.js";
import type { AppDatabase } from "./postgres.js";

function toUserStatus(value: string): UserStatus {
  if (value === "active" || value === "blocked") {
    return value;
  }

  throw new Error("Unexpected user status returned by database");
}

export class PostgresTelegramUserRepository
  implements TelegramUserRepository
{
  constructor(private readonly db: AppDatabase) {}

  onboard(
    input: TelegramUserOnboardingInput,
  ): Promise<TelegramUserSnapshot> {
    return this.db.transaction(async (tx) => {
      const [user] = await tx
        .insert(users)
        .values({
          telegramUserId: input.telegramUserId,
          username: input.username,
        })
        .onConflictDoUpdate({
          target: users.telegramUserId,
          set: {
            username: input.username,
            updatedAt: new Date(),
          },
        })
        .returning({
          id: users.id,
          status: users.status,
        });

      if (user === undefined) {
        throw new Error("Telegram user upsert returned no row");
      }

      await tx
        .insert(packageBalances)
        .values({ userId: user.id })
        .onConflictDoNothing({ target: packageBalances.userId });

      return {
        id: user.id,
        status: toUserStatus(user.status),
      };
    });
  }

  async getAccessByTelegramUserId(
    telegramUserId: bigint,
  ): Promise<TelegramUserAccessSnapshot | undefined> {
    const [row] = await this.db
      .select({
        status: users.status,
        role: adminAccounts.role,
      })
      .from(users)
      .leftJoin(adminAccounts, eq(adminAccounts.userId, users.id))
      .where(eq(users.telegramUserId, telegramUserId))
      .limit(1);

    if (row === undefined) {
      return undefined;
    }

    const status = toUserStatus(row.status);

    if (row.role === null) {
      return { status };
    }

    if (!isAdminRole(row.role)) {
      throw new Error("Unexpected admin role returned by database");
    }

    return {
      status,
      role: row.role,
    };
  }
}

export class PostgresEnergyPackageRepository
  implements EnergyPackageRepository
{
  constructor(private readonly db: AppDatabase) {}

  listEnabled(): Promise<EnergyPackageSummary[]> {
    return this.db
      .select({
        id: energyPackages.id,
        code: energyPackages.code,
        count: energyPackages.count,
        priceUsdtMicros: energyPackages.priceUsdtMicros,
      })
      .from(energyPackages)
      .where(eq(energyPackages.enabled, true))
      .orderBy(asc(energyPackages.sortOrder), asc(energyPackages.count));
  }

  async findEnabledById(
    id: string,
  ): Promise<EnergyPackageSummary | undefined> {
    const [row] = await this.db
      .select({
        id: energyPackages.id,
        code: energyPackages.code,
        count: energyPackages.count,
        priceUsdtMicros: energyPackages.priceUsdtMicros,
      })
      .from(energyPackages)
      .where(and(eq(energyPackages.id, id), eq(energyPackages.enabled, true)))
      .limit(1);

    return row;
  }
}
