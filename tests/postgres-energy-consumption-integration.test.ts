import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresEnergyUsageRepository } from "../src/adapters/database/postgres-energy-usage-repository.js";
import {
  createPostgresResource,
  type PostgresResource,
} from "../src/adapters/database/postgres.js";
import { PostgresTelegramUserRepository } from "../src/adapters/database/postgres-telegram-repositories.js";
import { NodeTronAddressCodec } from "../src/adapters/tron/node-tron-address-codec.js";
import { EnergyUsageService } from "../src/application/energy/energy-usage-service.js";
import type {
  EnergyDeliveryRequest,
  EnergyDeliveryResult,
  EnergyOrderStatus,
  EnergyProvider,
} from "../src/core/providers/energy-provider.js";
import {
  balanceLedger,
  energyOptions,
  packageBalances,
} from "../src/db/schema.js";
import { bootstrapCatalogIfNeeded } from "../src/runtime/catalog-bootstrap.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL === undefined ? describe.skip : describe;
const RECIPIENT = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

class FakeEnergyProvider implements EnergyProvider {
  readonly name = "fake-energy";
  createCalls = 0;
  findCalls = 0;
  statusCalls = 0;
  private lastIdempotencyKey: string | undefined;

  constructor(
    private readonly mode: "completed" | "failed" | "ambiguous_processing",
  ) {}

  async createDelivery(
    request: EnergyDeliveryRequest,
  ): Promise<EnergyDeliveryResult> {
    this.createCalls += 1;

    if (this.mode === "ambiguous_processing") {
      throw new Error("simulated provider timeout");
    }

    return {
      providerOrderId: `provider:${request.internalOrderId}`,
      idempotencyKey: request.idempotencyKey,
      status: this.mode,
    };
  }

  async getDeliveryStatus(
    providerOrderId: string,
  ): Promise<EnergyOrderStatus> {
    this.statusCalls += 1;
    return {
      providerOrderId,
      idempotencyKey: this.lastIdempotencyKey ?? "missing",
      status: "completed",
    };
  }

  async findDeliveryByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<EnergyOrderStatus | undefined> {
    this.findCalls += 1;
    this.lastIdempotencyKey = idempotencyKey;

    if (this.mode !== "ambiguous_processing") {
      return undefined;
    }

    return {
      providerOrderId: "provider:recovered",
      idempotencyKey,
      status: "processing",
    };
  }
}

describePostgres("PostgreSQL Energy consumption integration", () => {
  let resource: PostgresResource;
  let users: PostgresTelegramUserRepository;
  let energy: PostgresEnergyUsageRepository;

  beforeAll(async () => {
    resource = createPostgresResource(TEST_DATABASE_URL ?? "");
    await resource.ping();
    await migrate(resource.db, { migrationsFolder: "./drizzle" });
    await resource.assertSchemaReady();
    await bootstrapCatalogIfNeeded(resource.db);

    users = new PostgresTelegramUserRepository(resource.db);
    energy = new PostgresEnergyUsageRepository(resource.db);
  });

  afterAll(async () => {
    if (resource !== undefined) {
      await resource.close();
    }
  });

  async function customer(
    telegramUserId: bigint,
    availableCount: number,
  ): Promise<string> {
    const user = await users.onboard({
      telegramUserId,
      username: `energy_${telegramUserId.toString()}`,
    });

    await resource.db
      .update(packageBalances)
      .set({
        availableCount,
        reservedCount: 0,
        updatedAt: new Date(),
      })
      .where(eq(packageBalances.userId, user.id));

    return user.id;
  }

  it("reserves one count, completes delivery, and consumes the reservation exactly once", async () => {
    const telegramUserId = 9_200_000_000_001n;
    const userId = await customer(telegramUserId, 2);
    const provider = new FakeEnergyProvider("completed");
    const service = new EnergyUsageService(
      energy,
      provider,
      new NodeTronAddressCodec(),
    );

    const first = await service.execute({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:completed:1",
    });

    expect(first.kind).toBe("completed");
    if (first.kind !== "completed") {
      throw new Error("Expected completed Energy result");
    }

    expect(first.order.energyAmount).toBe(65_000n);
    expect(first.order.countCost).toBe(1);
    expect(first.order.availableCount).toBe(1);
    expect(first.order.reservedCount).toBe(0);
    expect(provider.createCalls).toBe(1);

    const replay = await service.execute({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:completed:1",
    });

    expect(replay.kind).toBe("completed");
    expect(provider.createCalls).toBe(1);

    const ledger = await resource.db
      .select({ reason: balanceLedger.reason })
      .from(balanceLedger)
      .where(eq(balanceLedger.userId, userId));

    expect(ledger.filter((row) => row.reason === "energy_reserve")).toHaveLength(1);
    expect(ledger.filter((row) => row.reason === "energy_consume")).toHaveLength(1);
    expect(ledger.filter((row) => row.reason === "energy_release")).toHaveLength(0);
  });

  it("releases the reserved count after a final provider failure", async () => {
    const telegramUserId = 9_200_000_000_002n;
    const userId = await customer(telegramUserId, 1);
    const provider = new FakeEnergyProvider("failed");
    const service = new EnergyUsageService(
      energy,
      provider,
      new NodeTronAddressCodec(),
    );

    const result = await service.execute({
      telegramUserId,
      optionCode: "energy_131k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:failed:1",
    });

    expect(result.kind).toBe("released");
    if (result.kind !== "released") {
      throw new Error("Expected released Energy result");
    }

    expect(result.order.energyAmount).toBe(131_000n);
    expect(result.order.availableCount).toBe(1);
    expect(result.order.reservedCount).toBe(0);

    const ledger = await resource.db
      .select({ reason: balanceLedger.reason })
      .from(balanceLedger)
      .where(eq(balanceLedger.userId, userId));

    expect(ledger.filter((row) => row.reason === "energy_reserve")).toHaveLength(1);
    expect(ledger.filter((row) => row.reason === "energy_release")).toHaveLength(1);
    expect(ledger.filter((row) => row.reason === "energy_consume")).toHaveLength(0);
  });

  it("queries by idempotency key after an ambiguous create and never creates a second provider order", async () => {
    const telegramUserId = 9_200_000_000_003n;
    await customer(telegramUserId, 1);
    const provider = new FakeEnergyProvider("ambiguous_processing");
    const service = new EnergyUsageService(
      energy,
      provider,
      new NodeTronAddressCodec(),
    );

    const created = await service.execute({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:ambiguous:1",
    });

    expect(created.kind).toBe("processing");
    if (created.kind !== "processing") {
      throw new Error("Expected processing Energy result");
    }

    expect(created.order.availableCount).toBe(0);
    expect(created.order.reservedCount).toBe(1);
    expect(provider.createCalls).toBe(1);
    expect(provider.findCalls).toBe(1);

    const refreshed = await service.getStatus({
      orderId: created.order.id,
      telegramUserId,
    });

    expect(refreshed.kind).toBe("completed");
    if (refreshed.kind !== "completed") {
      throw new Error("Expected completed Energy result after status refresh");
    }

    expect(refreshed.order.availableCount).toBe(0);
    expect(refreshed.order.reservedCount).toBe(0);
    expect(provider.createCalls).toBe(1);
    expect(provider.statusCalls).toBe(1);
  });

  it("serializes concurrent replays of the same idempotency key to one reservation and one provider create", async () => {
    const telegramUserId = 9_200_000_000_004n;
    await customer(telegramUserId, 2);
    const provider = new FakeEnergyProvider("completed");
    const service = new EnergyUsageService(
      energy,
      provider,
      new NodeTronAddressCodec(),
    );

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        service.execute({
          telegramUserId,
          optionCode: "energy_65k",
          recipientAddress: RECIPIENT,
          idempotencyKey: "energy:test:concurrent:1",
        }),
      ),
    );

    expect(results.every((result) => result.kind === "completed")).toBe(true);
    expect(provider.createCalls).toBe(1);

    const prepared = await energy.prepare(telegramUserId);
    expect(prepared).toMatchObject({
      kind: "ready",
      availableCount: 1,
      reservedCount: 0,
    });
  });

  it("replays an existing Energy order even if its option is later disabled", async () => {
    const telegramUserId = 9_200_000_000_005n;
    await customer(telegramUserId, 1);
    const provider = new FakeEnergyProvider("completed");
    const service = new EnergyUsageService(
      energy,
      provider,
      new NodeTronAddressCodec(),
    );

    const first = await service.execute({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:catalog-replay:1",
    });

    expect(first.kind).toBe("completed");
    expect(provider.createCalls).toBe(1);

    await resource.db
      .update(energyOptions)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(energyOptions.code, "energy_65k"));

    try {
      const replay = await service.execute({
        telegramUserId,
        optionCode: "energy_65k",
        recipientAddress: RECIPIENT,
        idempotencyKey: "energy:test:catalog-replay:1",
      });

      expect(replay.kind).toBe("completed");
      expect(provider.createCalls).toBe(1);
    } finally {
      await resource.db
        .update(energyOptions)
        .set({ enabled: true, updatedAt: new Date() })
        .where(eq(energyOptions.code, "energy_65k"));
    }
  });

  it("does not create a provider order when count balance is insufficient", async () => {
    const telegramUserId = 9_200_000_000_006n;
    await customer(telegramUserId, 0);
    const provider = new FakeEnergyProvider("completed");
    const service = new EnergyUsageService(
      energy,
      provider,
      new NodeTronAddressCodec(),
    );

    const result = await service.execute({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:insufficient:1",
    });

    expect(result).toEqual({
      kind: "insufficient_balance",
      availableCount: 0,
      requiredCount: 1,
    });
    expect(provider.createCalls).toBe(0);
  });
});
