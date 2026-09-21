import type {
  EnergyPackageRepository,
  EnergyPackageSummary,
  TelegramUserRepository,
} from "./ports.js";

export type PackageSelectionResult =
  | {
      readonly kind: "denied";
    }
  | {
      readonly kind: "unavailable";
    }
  | {
      readonly kind: "ready";
      readonly package: EnergyPackageSummary;
    };

export class PackageSelectionService {
  constructor(
    private readonly users: TelegramUserRepository,
    private readonly packages: EnergyPackageRepository,
  ) {}

  async select(input: {
    readonly telegramUserId: bigint;
    readonly packageId: string;
  }): Promise<PackageSelectionResult> {
    const access = await this.users.getAccessByTelegramUserId(
      input.telegramUserId,
    );

    if (access === undefined || access.status === "blocked") {
      return { kind: "denied" };
    }

    const item = await this.packages.findEnabledById(input.packageId);

    if (item === undefined) {
      return { kind: "unavailable" };
    }

    return {
      kind: "ready",
      package: item,
    };
  }
}
