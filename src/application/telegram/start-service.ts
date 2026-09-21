import type {
  EnergyPackageRepository,
  EnergyPackageSummary,
  TelegramUserRepository,
} from "./ports.js";

export type TelegramStartResult =
  | {
      readonly kind: "blocked";
    }
  | {
      readonly kind: "ready";
      readonly packages: readonly EnergyPackageSummary[];
    };

export class TelegramStartService {
  constructor(
    private readonly users: TelegramUserRepository,
    private readonly packages: EnergyPackageRepository,
  ) {}

  async execute(input: {
    readonly telegramUserId: bigint;
    readonly username: string | null;
  }): Promise<TelegramStartResult> {
    const user = await this.users.onboard(input);

    if (user.status === "blocked") {
      return { kind: "blocked" };
    }

    return {
      kind: "ready",
      packages: await this.packages.listEnabled(),
    };
  }
}
