import type { AdminRole } from "../../core/admin/roles.js";

export type UserStatus = "active" | "blocked";

export interface TelegramUserOnboardingInput {
  readonly telegramUserId: bigint;
  readonly username: string | null;
}

export interface TelegramUserSnapshot {
  readonly id: string;
  readonly status: UserStatus;
}

export interface TelegramUserAccessSnapshot {
  readonly status: UserStatus;
  readonly role?: AdminRole;
}

export interface TelegramUserRepository {
  onboard(input: TelegramUserOnboardingInput): Promise<TelegramUserSnapshot>;

  getAccessByTelegramUserId(
    telegramUserId: bigint,
  ): Promise<TelegramUserAccessSnapshot | undefined>;
}

export interface EnergyPackageSummary {
  readonly id: string;
  readonly code: string;
  readonly count: number;
  readonly priceUsdtMicros: bigint;
}

export interface EnergyPackageRepository {
  listEnabled(): Promise<readonly EnergyPackageSummary[]>;

  findEnabledById(id: string): Promise<EnergyPackageSummary | undefined>;
}
