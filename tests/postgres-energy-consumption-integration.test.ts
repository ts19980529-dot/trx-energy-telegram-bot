import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresEnergyUsageRepository } from "../src/adapters/database/postgres-energy-usage-repository.js";
import { PostgresEnergyProviderJournal } from "../src/adapters/database/postgres-energy-provider-journal.js";
import { PostgresEnergyProviderAttemptJournal } from "../src/adapters/database/postgres-energy-provider-attempt-journal.js";
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

  it("claims a provider txid once and rejects transaction identity changes", async () => {
    const telegramUserId = 9_200_000_000_007n;
    await customer(telegramUserId, 1);

    const reservation = await energy.reserve({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:journal:1",
    });

    expect(reservation.kind).toBe("ready");
    if (reservation.kind !== "ready") {
      throw new Error("Expected ready Energy reservation");
    }

    const dispatch = await energy.startDispatch({
      orderId: reservation.order.id,
      providerName: "tron-own-pool",
    });

    expect(dispatch.created).toBe(true);
    expect(dispatch.order.delivery).not.toBeNull();

    const delivery = dispatch.order.delivery;
    if (delivery === null) {
      throw new Error("Expected provider delivery");
    }

    const journal = new PostgresEnergyProviderJournal(
      resource.db,
    );
    const txid = "a".repeat(64);
    const conflictingTxid = "b".repeat(64);

    expect(
      await journal.findByIdempotencyKey(
        delivery.idempotencyKey,
      ),
    ).toMatchObject({
      idempotencyKey: delivery.idempotencyKey,
      providerName: "tron-own-pool",
      providerOrderId: null,
      status: "pending",
    });

    await journal.claimProviderOrderId({
      idempotencyKey: delivery.idempotencyKey,
      providerName: "tron-own-pool",
      providerOrderId: txid,
    });

    await journal.claimProviderOrderId({
      idempotencyKey: delivery.idempotencyKey,
      providerName: "tron-own-pool",
      providerOrderId: txid,
    });

    expect(
      await journal.findByProviderOrderId({
        providerName: "tron-own-pool",
        providerOrderId: txid,
      }),
    ).toMatchObject({
      idempotencyKey: delivery.idempotencyKey,
      providerName: "tron-own-pool",
      providerOrderId: txid,
      status: "pending",
    });

    await expect(
      journal.claimProviderOrderId({
        idempotencyKey: delivery.idempotencyKey,
        providerName: "tron-own-pool",
        providerOrderId: conflictingTxid,
      }),
    ).rejects.toThrow(
      "Energy provider transaction identity changed",
    );
  });
  it("serializes provider transaction attempts and preserves expired txid history across replacement", async () => {
    const telegramUserId = 9_200_000_000_008n;
    await customer(telegramUserId, 1);
    const reservation = await energy.reserve({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:attempt-journal:1",
    });
    expect(reservation.kind).toBe("ready");
    if (reservation.kind !== "ready") throw new Error("Expected ready Energy reservation");
    const dispatch = await energy.startDispatch({ orderId: reservation.order.id, providerName: "tron-own-pool" });
    const delivery = dispatch.order.delivery;
    if (delivery === null) throw new Error("Expected provider delivery");

    const attempts = new PostgresEnergyProviderAttemptJournal(resource.db);
    const initial = await Promise.all(Array.from({ length: 6 }, () => attempts.getOrCreateCurrentAttempt({
      idempotencyKey: delivery.idempotencyKey,
      providerName: "tron-own-pool",
    })));
    expect(new Set(initial.map((attempt) => attempt.id)).size).toBe(1);
    const firstAttempt = initial[0];
    if (firstAttempt === undefined) throw new Error("Expected initial provider transaction attempt");
    expect(firstAttempt).toMatchObject({ attemptNumber: 1, attemptKey: `${delivery.idempotencyKey}:attempt:1`, txid: null, status: "created" });

    const firstTxid = "c".repeat(64);
    const firstExpiration = new Date(Date.now() - 5_000);
    const firstSigned = await attempts.claimAttemptTransaction({
      attemptKey: firstAttempt.attemptKey,
      providerName: "tron-own-pool",
      txid: firstTxid,
      expirationAt: firstExpiration,
    });
    expect(firstSigned.status).toBe("signed");
    await expect(attempts.claimAttemptTransaction({
      attemptKey: firstSigned.attemptKey,
      providerName: "tron-own-pool",
      txid: "d".repeat(64),
      expirationAt: firstExpiration,
    })).rejects.toThrow("Energy provider transaction attempt identity changed");
    await expect(attempts.recordAttemptState({
      attemptKey: firstSigned.attemptKey,
      providerName: "tron-own-pool",
      status: "expired",
      lastChainStatus: "unknown",
    })).rejects.toThrow("Provider transaction attempt cannot expire");
    await attempts.recordAttemptState({
      attemptKey: firstSigned.attemptKey,
      providerName: "tron-own-pool",
      status: "expired",
      lastBroadcastResult: "unknown",
      lastChainStatus: "absent",
    });

    const replacement = await Promise.all(Array.from({ length: 6 }, () => attempts.getOrCreateCurrentAttempt({
      idempotencyKey: delivery.idempotencyKey,
      providerName: "tron-own-pool",
    })));
    expect(new Set(replacement.map((attempt) => attempt.id)).size).toBe(1);
    const secondAttempt = replacement[0];
    if (secondAttempt === undefined) throw new Error("Expected replacement provider transaction attempt");
    expect(secondAttempt).toMatchObject({ attemptNumber: 2, attemptKey: `${delivery.idempotencyKey}:attempt:2`, txid: null, status: "created" });
    const secondTxid = "e".repeat(64);
    await attempts.claimAttemptTransaction({
      attemptKey: secondAttempt.attemptKey,
      providerName: "tron-own-pool",
      txid: secondTxid,
      expirationAt: new Date(Date.now() + 60_000),
    });
    const history = await attempts.listAttempts({ idempotencyKey: delivery.idempotencyKey, providerName: "tron-own-pool" });
    expect(history.map((attempt) => ({ attemptNumber: attempt.attemptNumber, txid: attempt.txid, status: attempt.status }))).toEqual([
      { attemptNumber: 1, txid: firstTxid, status: "expired" },
      { attemptNumber: 2, txid: secondTxid, status: "signed" },
    ]);
    expect(await new PostgresEnergyProviderJournal(resource.db).findByIdempotencyKey(delivery.idempotencyKey)).toMatchObject({ providerOrderId: secondTxid });
  });

});
