import { describe, expect, it } from "vitest";

import { AdminAccessService } from "../src/application/telegram/admin-access-service.js";
import { PackageSelectionService } from "../src/application/telegram/package-selection-service.js";
import type {
  EnergyPackageRepository,
  EnergyPackageSummary,
  TelegramUserAccessSnapshot,
  TelegramUserOnboardingInput,
  TelegramUserRepository,
  TelegramUserSnapshot,
} from "../src/application/telegram/ports.js";
import { TelegramStartService } from "../src/application/telegram/start-service.js";

class FakeUsers implements TelegramUserRepository {
  readonly inputs: TelegramUserOnboardingInput[] = [];

  constructor(
    private readonly onboardResult: TelegramUserSnapshot,
    private readonly accessResult?: TelegramUserAccessSnapshot,
  ) {}

  async onboard(
    input: TelegramUserOnboardingInput,
  ): Promise<TelegramUserSnapshot> {
    this.inputs.push(input);
    return this.onboardResult;
  }

  async getAccessByTelegramUserId() {
    return this.accessResult;
  }
}

class FakePackages implements EnergyPackageRepository {
  listCalls = 0;

  constructor(
    private readonly items: readonly EnergyPackageSummary[],
  ) {}

  async listEnabled(): Promise<readonly EnergyPackageSummary[]> {
    this.listCalls += 1;
    return this.items;
  }

  async findEnabledById(id: string) {
    return this.items.find((item) => item.id === id);
  }
}

const packageItem: EnergyPackageSummary = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  code: "demo",
  count: 3,
  priceUsdtMicros: 4_250_000n,
};

describe("TelegramStartService", () => {
  it("onboards strictly by numeric Telegram ID and treats username as metadata", async () => {
    const users = new FakeUsers({
      id: "user-id",
      status: "active",
    });
    const packages = new FakePackages([packageItem]);
    const service = new TelegramStartService(users, packages);

    const result = await service.execute({
      telegramUserId: 123456789n,
      username: "display_only",
    });

    expect(result).toEqual({
      kind: "ready",
      packages: [packageItem],
    });
    expect(users.inputs).toEqual([
      {
        telegramUserId: 123456789n,
        username: "display_only",
      },
    ]);
  });

  it("does not expose packages to a blocked user", async () => {
    const users = new FakeUsers({
      id: "user-id",
      status: "blocked",
    });
    const packages = new FakePackages([packageItem]);
    const service = new TelegramStartService(users, packages);

    await expect(
      service.execute({
        telegramUserId: 123n,
        username: null,
      }),
    ).resolves.toEqual({ kind: "blocked" });

    expect(packages.listCalls).toBe(0);
  });
});

describe("AdminAccessService", () => {
  it("grants SUPER_ADMIN only to the configured numeric ID after onboarding", async () => {
    const users = new FakeUsers(
      { id: "user-id", status: "active" },
      { status: "active" },
    );
    const service = new AdminAccessService(users, 123n);

    await expect(service.getRole(123n)).resolves.toBe("SUPER_ADMIN");
    await expect(service.getRole(456n)).resolves.toBeUndefined();
  });

  it("denies blocked users even when the numeric ID matches SUPER_ADMIN_ID", async () => {
    const users = new FakeUsers(
      { id: "user-id", status: "blocked" },
      { status: "blocked" },
    );
    const service = new AdminAccessService(users, 123n);

    await expect(service.getRole(123n)).resolves.toBeUndefined();
  });
});

describe("PackageSelectionService", () => {
  it("rechecks access when an old package button is clicked", async () => {
    const users = new FakeUsers(
      { id: "user-id", status: "blocked" },
      { status: "blocked" },
    );
    const packages = new FakePackages([packageItem]);
    const service = new PackageSelectionService(users, packages);

    await expect(
      service.select({
        telegramUserId: 123n,
        packageId: packageItem.id,
      }),
    ).resolves.toEqual({ kind: "denied" });
  });
});
