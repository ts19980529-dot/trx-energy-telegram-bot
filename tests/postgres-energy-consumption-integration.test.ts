import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TronWeb, utils } from "tronweb";

import { PostgresEnergyUsageRepository } from "../src/adapters/database/postgres-energy-usage-repository.js";
import { PostgresEnergyProviderJournal } from "../src/adapters/database/postgres-energy-provider-journal.js";
import { PostgresEnergyProviderAttemptJournal } from "../src/adapters/database/postgres-energy-provider-attempt-journal.js";
import { PostgresEnergyReclaimAttemptJournal } from "../src/adapters/database/postgres-energy-reclaim-attempt-journal.js";
import {
  createPostgresResource,
  type PostgresResource,
} from "../src/adapters/database/postgres.js";
import { PostgresTelegramUserRepository } from "../src/adapters/database/postgres-telegram-repositories.js";
import { PostgresTronDelegationSigner } from "../src/adapters/signer/postgres-tron-delegation-signer.js";
import { PostgresTronReclaimSigner } from "../src/adapters/signer/postgres-tron-reclaim-signer.js";
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
  providerTransactionAttempts,
} from "../src/db/schema.js";
import { bootstrapCatalogIfNeeded } from "../src/runtime/catalog-bootstrap.js";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL === undefined ? describe.skip : describe;
const RECIPIENT = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const SIGNER_PRIVATE_KEY = "1".repeat(64);
const SIGNER_OWNER = TronWeb.address.fromPrivateKey(
  SIGNER_PRIVATE_KEY,
);
if (typeof SIGNER_OWNER !== "string") {
  throw new Error("Test signer private key is invalid");
}

function unsignedDelegation(
  now: number,
  balance = 1_000_000,
  receiverAddress = RECIPIENT,
) {
  const base = {
    visible: true,
    raw_data: {
      contract: [
        {
          parameter: {
            value: {
              owner_address: SIGNER_OWNER,
              receiver_address: receiverAddress,
              balance,
              resource: "ENERGY",
              lock: false,
            },
            type_url:
              "type.googleapis.com/protocol.DelegateResourceContract",
          },
          type: "DelegateResourceContract",
        },
      ],
      ref_block_bytes: "0001",
      ref_block_hash: "0000000000000000",
      expiration: now + 60_000,
      timestamp: now,
    },
  };
  const protobuf = utils.transaction.txJsonToPb(base);
  const rawDataHex =
    utils.transaction.txPbToRawDataHex(protobuf);
  const txid = String(
    utils.transaction.txPbToTxID(protobuf),
  )
    .replace(/^0x/, "")
    .toLowerCase();

  return {
    txid,
    transaction: {
      ...base,
      txID: txid,
      raw_data_hex: rawDataHex,
    },
  };
}


function unsignedReclaim(
  now: number,
  balance = 1_000_000,
  receiverAddress = RECIPIENT,
) {
  const base = {
    visible: true,
    raw_data: {
      contract: [
        {
          parameter: {
            value: {
              owner_address: SIGNER_OWNER,
              receiver_address: receiverAddress,
              balance,
              resource: "ENERGY",
            },
            type_url:
              "type.googleapis.com/protocol.UnDelegateResourceContract",
          },
          type: "UnDelegateResourceContract",
        },
      ],
      ref_block_bytes: "0001",
      ref_block_hash: "0000000000000000",
      expiration: now + 60_000,
      timestamp: now,
    },
  };
  const protobuf = utils.transaction.txJsonToPb(base);
  const rawDataHex =
    utils.transaction.txPbToRawDataHex(protobuf);
  const txid = String(
    utils.transaction.txPbToTxID(protobuf),
  )
    .replace(/^0x/, "")
    .toLowerCase();

  return {
    txid,
    transaction: {
      ...base,
      txID: txid,
      raw_data_hex: rawDataHex,
    },
  };
}

class FakeEnergyProvider implements EnergyProvider {
  createCalls = 0;
  findCalls = 0;
  statusCalls = 0;
  private lastIdempotencyKey: string | undefined;

  constructor(
    private readonly mode: "completed" | "failed" | "ambiguous_processing",
    readonly name = "fake-energy",
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
    await resource.assertSignerSchemaReady();
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

  it("scans reserved and dispatching orders with their persisted provider owner", async () => {
    const telegramUserId = 9_200_000_000_020n;
    await customer(telegramUserId, 1);
    const key = "energy:test:pending-scan:1";
    const reservation = await energy.reserve({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: key,
    });
    expect(reservation.kind).toBe("ready");
    if (reservation.kind !== "ready") {
      throw new Error("Expected reserved Energy order");
    }

    const reserved = (await energy.listPending(100)).find(
      (row) => row.idempotencyKey === key,
    );
    expect(reserved).toMatchObject({ telegramUserId, providerName: null });

    await energy.startDispatch({
      orderId: reservation.order.id,
      providerName: "recorded-provider",
    });

    const dispatching = (await energy.listPending(100)).find(
      (row) => row.idempotencyKey === key,
    );
    expect(dispatching).toMatchObject({
      telegramUserId,
      providerName: "recorded-provider",
    });
  });

  it("pages only Energy orders owned by the requesting Telegram user", async () => {
    const ownerTelegramUserId = 9_200_000_000_021n;
    const otherTelegramUserId = 9_200_000_000_022n;
    const ownerUserId = await customer(ownerTelegramUserId, 3);
    const otherUserId = await customer(otherTelegramUserId, 1);

    const ownerFirst = await energy.reserve({
      telegramUserId: ownerTelegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:owned-list:owner:1",
    });
    const ownerSecond = await energy.reserve({
      telegramUserId: ownerTelegramUserId,
      optionCode: "energy_131k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:owned-list:owner:2",
    });
    const other = await energy.reserve({
      telegramUserId: otherTelegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:owned-list:other:1",
    });

    if (
      ownerFirst.kind !== "ready" ||
      ownerSecond.kind !== "ready" ||
      other.kind !== "ready"
    ) {
      throw new Error("Expected owned-list Energy reservations");
    }

    const first = await energy.listOwnedPage({
      telegramUserId: ownerTelegramUserId,
      limit: 1,
    });
    expect(first.kind).toBe("ready");
    if (first.kind !== "ready") {
      throw new Error("Expected owner first Energy page");
    }
    expect(first.orders).toHaveLength(1);
    expect(first.previousCursor).toBeNull();
    expect(first.nextCursor).not.toBeNull();

    const second = await energy.listOwnedPage({
      telegramUserId: ownerTelegramUserId,
      limit: 1,
      cursorId: first.nextCursor!,
      direction: "next",
    });
    expect(second.kind).toBe("ready");
    if (second.kind !== "ready") {
      throw new Error("Expected owner second Energy page");
    }
    expect(second.orders).toHaveLength(1);
    expect(second.previousCursor).not.toBeNull();

    expect(
      new Set([
        first.orders[0]!.id,
        second.orders[0]!.id,
      ]),
    ).toEqual(
      new Set([ownerFirst.order.id, ownerSecond.order.id]),
    );
    expect(
      [...first.orders, ...second.orders].every(
        (order) => order.userId === ownerUserId,
      ),
    ).toBe(true);
    expect(
      [...first.orders, ...second.orders].some(
        (order) => order.userId === otherUserId,
      ),
    ).toBe(false);

    const back = await energy.listOwnedPage({
      telegramUserId: ownerTelegramUserId,
      limit: 1,
      cursorId: second.previousCursor!,
      direction: "previous",
    });
    expect(back.kind).toBe("ready");
    if (back.kind !== "ready") {
      throw new Error("Expected owner previous Energy page");
    }
    expect(back.orders.map((order) => order.id)).toEqual(
      first.orders.map((order) => order.id),
    );

    await expect(
      energy.listOwnedPage({
        telegramUserId: 9_200_000_009_999n,
        limit: 5,
      }),
    ).resolves.toEqual({ kind: "denied" });
  });

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
    expect(provider.createCalls).toBe(2);
    expect(provider.statusCalls).toBe(1);
  });

  it("keeps historical deliveries on their original provider after the active provider changes", async () => {
    const telegramUserId = 9_200_000_000_021n;
    await customer(telegramUserId, 2);
    const previousProvider = new FakeEnergyProvider("ambiguous_processing", "previous-provider");
    const currentProvider = new FakeEnergyProvider("completed", "current-provider");
    const codec = new NodeTronAddressCodec();
    const original = new EnergyUsageService(energy, previousProvider, codec);
    const historicalKey = "energy:test:provider-switch:old";

    const pending = await original.execute({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: historicalKey,
    });
    expect(pending.kind).toBe("processing");
    if (pending.kind !== "processing") {
      throw new Error("Expected pending historical Energy order");
    }

    const withoutOriginal = new EnergyUsageService(energy, currentProvider, codec);
    expect(withoutOriginal.canResumeDelivery("previous-provider")).toBe(false);
    expect(withoutOriginal.canResumeDelivery(null)).toBe(true);
    expect((await withoutOriginal.getStatus({
      orderId: pending.order.id,
      telegramUserId,
    })).kind).toBe("processing");
    expect((await withoutOriginal.execute({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: historicalKey,
    })).kind).toBe("processing");
    expect(currentProvider.createCalls).toBe(0);

    const switched = new EnergyUsageService(
      energy, currentProvider, codec, [previousProvider],
    );
    expect(switched.canResumeDelivery("previous-provider")).toBe(true);
    expect((await switched.getStatus({
      orderId: pending.order.id,
      telegramUserId,
    })).kind).toBe("completed");
    expect(previousProvider.createCalls).toBe(2);
    expect(currentProvider.createCalls).toBe(0);

    expect((await switched.execute({
      telegramUserId,
      optionCode: "energy_131k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:provider-switch:new",
    })).kind).toBe("completed");
    expect(currentProvider.createCalls).toBe(1);
  });

  it("serializes concurrent replays and status reads while a provider call is in flight", async () => {
    const telegramUserId = 9_200_000_000_004n;
    await customer(telegramUserId, 2);
    const provider = new FakeEnergyProvider("completed");
    const service = new EnergyUsageService(
      energy,
      provider,
      new NodeTronAddressCodec(),
    );
    const input = {
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:concurrent:1",
    };
    const originalCreate = provider.createDelivery.bind(provider);
    let notifyStarted!: () => void;
    let unblock!: () => void;
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    const blocked = new Promise<void>((resolve) => { unblock = resolve; });
    let entered = 0;
    provider.createDelivery = async (request) => {
      entered += 1;
      notifyStarted();
      await blocked;
      return originalCreate(request);
    };

    const first = service.execute(input);
    await started;
    const replays = Array.from({ length: 5 }, () => service.execute(input));
    const reservation = await energy.reserve(input);
    if (reservation.kind !== "ready") throw new Error("Expected reserved Energy order");
    const status = service.getStatus({ orderId: reservation.order.id, telegramUserId });
    await new Promise((resolve) => setTimeout(resolve, 60));
    const concurrentCalls = entered;
    unblock();
    const results = await Promise.all([first, ...replays, status]);
    expect(concurrentCalls).toBe(1);
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
    await attempts.bindDelegation({
      attemptKey: firstAttempt.attemptKey,
      providerName: "tron-own-pool",
      binding: {
        ownerAddress: SIGNER_OWNER,
        receiverAddress: RECIPIENT,
        resource: "ENERGY",
        balanceSun: 1_000_000n,
      },
    });
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
      lastChainObservedAt: new Date(),
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
    await attempts.bindDelegation({
      attemptKey: secondAttempt.attemptKey,
      providerName: "tron-own-pool",
      binding: {
        ownerAddress: SIGNER_OWNER,
        receiverAddress: RECIPIENT,
        resource: "ENERGY",
        balanceSun: 1_000_000n,
      },
    });
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

    const acceptedAtFloor = Date.now();
    await attempts.recordAttemptState({
      attemptKey: secondAttempt.attemptKey,
      providerName: "tron-own-pool",
      status: "accepted",
      lastBroadcastResult: "accepted",
    });
    await attempts.recordAttemptState({
      attemptKey: secondAttempt.attemptKey,
      providerName: "tron-own-pool",
      status: "completed",
      lastChainStatus: "completed",
    });

    const [reclaimTiming] = await resource.db
      .select({
        broadcastAcceptedAt: providerTransactionAttempts.broadcastAcceptedAt,
        finalizedAt: providerTransactionAttempts.finalizedAt,
        reclaimEligibleAt: providerTransactionAttempts.reclaimEligibleAt,
      })
      .from(providerTransactionAttempts)
      .where(eq(providerTransactionAttempts.id, secondAttempt.id))
      .limit(1);

    expect(reclaimTiming?.broadcastAcceptedAt?.getTime()).toBeGreaterThanOrEqual(
      acceptedAtFloor,
    );
    expect(reclaimTiming?.finalizedAt).not.toBeNull();
    expect(reclaimTiming?.reclaimEligibleAt).not.toBeNull();

    const broadcastAcceptedAt = reclaimTiming?.broadcastAcceptedAt;
    const finalizedAt = reclaimTiming?.finalizedAt;
    const reclaimEligibleAt = reclaimTiming?.reclaimEligibleAt;
    if (
      broadcastAcceptedAt === null ||
      broadcastAcceptedAt === undefined ||
      finalizedAt === null ||
      finalizedAt === undefined ||
      reclaimEligibleAt === null ||
      reclaimEligibleAt === undefined
    ) {
      throw new Error("Expected complete reclaim timing");
    }

    expect(reclaimEligibleAt.getTime()).toBeGreaterThanOrEqual(
      broadcastAcceptedAt.getTime() + 60 * 60 * 1000,
    );
    expect(reclaimEligibleAt.getTime()).toBeGreaterThanOrEqual(
      finalizedAt.getTime(),
    );
  });


  it("durably binds one safe unsigned delegation to one signer attempt across concurrency and restart", async () => {
    const telegramUserId = 9_200_000_000_009n;
    await customer(telegramUserId, 1);

    const reservation = await energy.reserve({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:signer-journal:1",
    });
    expect(reservation.kind).toBe("ready");
    if (reservation.kind !== "ready") {
      throw new Error("Expected ready Energy reservation");
    }

    const dispatch = await energy.startDispatch({
      orderId: reservation.order.id,
      providerName: "tron-own-pool",
    });
    const delivery = dispatch.order.delivery;
    if (delivery === null) {
      throw new Error("Expected provider delivery");
    }

    const attempts = new PostgresEnergyProviderAttemptJournal(
      resource.db,
    );
    const attempt = await attempts.getOrCreateCurrentAttempt({
      idempotencyKey: delivery.idempotencyKey,
      providerName: "tron-own-pool",
    });

    const now = Date.now();
    const unsigned = unsignedDelegation(now);
    await attempts.bindDelegation({
      attemptKey: attempt.attemptKey,
      providerName: "tron-own-pool",
      binding: {
        ownerAddress: SIGNER_OWNER,
        receiverAddress: RECIPIENT,
        resource: "ENERGY",
        balanceSun: 1_000_000n,
      },
    });
    const signer = new PostgresTronDelegationSigner(
      resource.db,
      SIGNER_OWNER,
      SIGNER_PRIVATE_KEY,
      () => now,
    );

    const signed = await Promise.all(
      Array.from({ length: 6 }, () =>
        signer.sign({
          attemptKey: attempt.attemptKey,
          unsigned,
        }),
      ),
    );

    expect(new Set(signed.map((item) => item.txid))).toEqual(
      new Set([unsigned.txid]),
    );
    expect(
      new Set(
        signed.map((item) =>
          JSON.stringify(item.transaction.signature),
        ),
      ).size,
    ).toBe(1);

    const [stored] = await resource.db
      .select({
        signerUnsignedTxid:
          providerTransactionAttempts.signerUnsignedTxid,
        signerUnsignedDigest:
          providerTransactionAttempts.signerUnsignedDigest,
        signedTransaction:
          providerTransactionAttempts.signedTransaction,
        signedAt: providerTransactionAttempts.signedAt,
      })
      .from(providerTransactionAttempts)
      .where(eq(providerTransactionAttempts.id, attempt.id))
      .limit(1);

    expect(stored?.signerUnsignedTxid).toBe(unsigned.txid);
    expect(stored?.signerUnsignedDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(stored?.signedTransaction).toMatchObject({
      txID: unsigned.txid,
    });
    expect(stored?.signedAt).toBeInstanceOf(Date);

    const restartedSigner = new PostgresTronDelegationSigner(
      resource.db,
      SIGNER_OWNER,
      SIGNER_PRIVATE_KEY,
      () => now + 1_000,
    );
    await expect(
      restartedSigner.findSignedByAttemptKey(attempt.attemptKey),
    ).resolves.toEqual(signed[0]);

    const tampered = structuredClone(unsigned);
    const rawData = tampered.transaction.raw_data as {
      contract: Array<{
        parameter: { value: { balance: number } };
      }>;
    };
    rawData.contract[0]!.parameter.value.balance = 2_000_000;

    await expect(
      signer.sign({
        attemptKey: attempt.attemptKey,
        unsigned: tampered,
      }),
    ).rejects.toThrow(/raw_data/);

    const differentUnsigned = unsignedDelegation(
      now + 1,
      2_000_000,
    );
    await expect(
      signer.sign({
        attemptKey: attempt.attemptKey,
        unsigned: differentUnsigned,
      }),
    ).rejects.toThrow("Signer bound delegation balance mismatch");

    await attempts.claimAttemptTransaction({
      attemptKey: attempt.attemptKey,
      providerName: "tron-own-pool",
      txid: unsigned.txid,
      expirationAt: new Date(now + 60_000),
    });
  });


  it("fails closed when the signer receiver differs from the durable delegation binding", async () => {
    const telegramUserId = 9_200_000_000_010n;
    await customer(telegramUserId, 1);

    const reservation = await energy.reserve({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:signer-binding:1",
    });
    if (reservation.kind !== "ready") throw new Error("Expected ready Energy reservation");

    const dispatch = await energy.startDispatch({
      orderId: reservation.order.id,
      providerName: "tron-own-pool",
    });
    const delivery = dispatch.order.delivery;
    if (delivery === null) throw new Error("Expected provider delivery");

    const attempts = new PostgresEnergyProviderAttemptJournal(resource.db);
    const attempt = await attempts.getOrCreateCurrentAttempt({
      idempotencyKey: delivery.idempotencyKey,
      providerName: "tron-own-pool",
    });
    await attempts.bindDelegation({
      attemptKey: attempt.attemptKey,
      providerName: "tron-own-pool",
      binding: {
        ownerAddress: SIGNER_OWNER,
        receiverAddress: RECIPIENT,
        resource: "ENERGY",
        balanceSun: 1_000_000n,
      },
    });

    const now = Date.now();
    const signer = new PostgresTronDelegationSigner(
      resource.db,
      SIGNER_OWNER,
      SIGNER_PRIVATE_KEY,
      () => now,
    );
    const mismatched = unsignedDelegation(now, 1_000_000, SIGNER_OWNER);

    await expect(
      signer.sign({
        attemptKey: attempt.attemptKey,
        unsigned: mismatched,
      }),
    ).rejects.toThrow("Signer bound receiver address mismatch");
  });

  it("creates exactly one reclaim attempt only after the completed delegation is eligible", async () => {
    const telegramUserId = 9_200_000_000_011n;
    await customer(telegramUserId, 1);

    const reservation = await energy.reserve({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:reclaim-attempt:1",
    });
    if (reservation.kind !== "ready") throw new Error("Expected ready Energy reservation");

    const dispatch = await energy.startDispatch({
      orderId: reservation.order.id,
      providerName: "tron-own-pool",
    });
    const delivery = dispatch.order.delivery;
    if (delivery === null) throw new Error("Expected provider delivery");

    const attempts = new PostgresEnergyProviderAttemptJournal(resource.db);
    const attempt = await attempts.getOrCreateCurrentAttempt({
      idempotencyKey: delivery.idempotencyKey,
      providerName: "tron-own-pool",
    });
    await attempts.bindDelegation({
      attemptKey: attempt.attemptKey,
      providerName: "tron-own-pool",
      binding: {
        ownerAddress: SIGNER_OWNER,
        receiverAddress: RECIPIENT,
        resource: "ENERGY",
        balanceSun: 1_000_000n,
      },
    });
    await attempts.claimAttemptTransaction({
      attemptKey: attempt.attemptKey,
      providerName: "tron-own-pool",
      txid: "f".repeat(64),
      expirationAt: new Date(Date.now() + 60_000),
    });
    await attempts.recordAttemptState({
      attemptKey: attempt.attemptKey,
      providerName: "tron-own-pool",
      status: "accepted",
      lastBroadcastResult: "accepted",
    });
    const completed = await attempts.recordAttemptState({
      attemptKey: attempt.attemptKey,
      providerName: "tron-own-pool",
      status: "completed",
      lastChainStatus: "completed",
    });
    if (completed.delegationBinding === null) throw new Error("Expected delegation binding");

    const beforeEligible = new PostgresEnergyReclaimAttemptJournal(resource.db, () => Date.now());
    expect(await beforeEligible.listDueSources(50)).not.toContain(completed.id);
    await expect(
      beforeEligible.getOrCreateCurrentAttempt({
        sourceProviderTransactionAttemptId: completed.id,
        providerName: "tron-own-pool",
      }),
    ).rejects.toThrow("Energy reclaim is not yet eligible");

    const future = new PostgresEnergyReclaimAttemptJournal(
      resource.db,
      () => Date.now() + 2 * 60 * 60 * 1000,
    );
    expect(await future.listDueSources(50)).toContain(completed.id);
    expect(await future.getSourceBinding(completed.id)).toMatchObject({
      ownerAddress: SIGNER_OWNER,
      receiverAddress: RECIPIENT,
      resource: "ENERGY",
      balanceSun: 1_000_000n,
    });
    const reclaimAttempts = await Promise.all(
      Array.from({ length: 6 }, () =>
        future.getOrCreateCurrentAttempt({
          sourceProviderTransactionAttemptId: completed.id,
          providerName: "tron-own-pool",
        }),
      ),
    );
    expect(new Set(reclaimAttempts.map((item) => item.id)).size).toBe(1);
    expect(reclaimAttempts[0]).toMatchObject({
      sourceProviderTransactionAttemptId: completed.id,
      attemptNumber: 1,
      attemptKey: `${completed.attemptKey}:reclaim:1`,
      txid: null,
      status: "created",
    });
  });


  it("durably signs only the exact eligible UnDelegateResource binding", async () => {
    const telegramUserId = 9_200_000_000_012n;
    await customer(telegramUserId, 1);

    const reservation = await energy.reserve({
      telegramUserId,
      optionCode: "energy_65k",
      recipientAddress: RECIPIENT,
      idempotencyKey: "energy:test:reclaim-signer:1",
    });
    if (reservation.kind !== "ready") throw new Error("Expected ready Energy reservation");

    const dispatch = await energy.startDispatch({
      orderId: reservation.order.id,
      providerName: "tron-own-pool",
    });
    const delivery = dispatch.order.delivery;
    if (delivery === null) throw new Error("Expected provider delivery");

    const attempts = new PostgresEnergyProviderAttemptJournal(resource.db);
    const source = await attempts.getOrCreateCurrentAttempt({
      idempotencyKey: delivery.idempotencyKey,
      providerName: "tron-own-pool",
    });
    await attempts.bindDelegation({
      attemptKey: source.attemptKey,
      providerName: "tron-own-pool",
      binding: {
        ownerAddress: SIGNER_OWNER,
        receiverAddress: RECIPIENT,
        resource: "ENERGY",
        balanceSun: 1_000_000n,
      },
    });
    await attempts.claimAttemptTransaction({
      attemptKey: source.attemptKey,
      providerName: "tron-own-pool",
      txid: "7".repeat(64),
      expirationAt: new Date(Date.now() + 60_000),
    });
    await attempts.recordAttemptState({
      attemptKey: source.attemptKey,
      providerName: "tron-own-pool",
      status: "accepted",
      lastBroadcastResult: "accepted",
    });
    const completed = await attempts.recordAttemptState({
      attemptKey: source.attemptKey,
      providerName: "tron-own-pool",
      status: "completed",
      lastChainStatus: "completed",
    });

    const signerNow = Date.now() + 2 * 60 * 60 * 1000;
    const reclaimJournal = new PostgresEnergyReclaimAttemptJournal(
      resource.db,
      () => signerNow,
    );
    const reclaimAttempt = await reclaimJournal.getOrCreateCurrentAttempt({
      sourceProviderTransactionAttemptId: completed.id,
      providerName: "tron-own-pool",
    });

    const unsigned = unsignedReclaim(signerNow);
    const signer = new PostgresTronReclaimSigner(
      resource.db,
      SIGNER_OWNER,
      SIGNER_PRIVATE_KEY,
      () => signerNow,
    );

    const signed = await Promise.all(
      Array.from({ length: 6 }, () =>
        signer.sign({
          attemptKey: reclaimAttempt.attemptKey,
          unsigned,
        }),
      ),
    );
    expect(new Set(signed.map((item) => item.txid))).toEqual(
      new Set([unsigned.txid]),
    );
    expect(
      new Set(
        signed.map((item) =>
          JSON.stringify(item.transaction.signature),
        ),
      ).size,
    ).toBe(1);

    const restarted = new PostgresTronReclaimSigner(
      resource.db,
      SIGNER_OWNER,
      SIGNER_PRIVATE_KEY,
      () => signerNow + 1_000,
    );
    await expect(
      restarted.findSignedByAttemptKey(reclaimAttempt.attemptKey),
    ).resolves.toEqual(signed[0]);

    const signedExpiration = (signed[0]?.transaction.raw_data as { expiration: number }).expiration;
    const claimed = await reclaimJournal.claimTransaction({
      attemptKey: reclaimAttempt.attemptKey,
      txid: signed[0]!.txid,
      expirationAt: new Date(signedExpiration),
    });
    expect(claimed.status).toBe("signed");
    await expect(reclaimJournal.claimTransaction({
      attemptKey: reclaimAttempt.attemptKey,
      txid: "a".repeat(64),
      expirationAt: new Date(signedExpiration),
    })).rejects.toThrow("Reclaim transaction identity changed");
    await reclaimJournal.recordState({
      attemptKey: reclaimAttempt.attemptKey,
      status: "accepted",
      lastBroadcastResult: "accepted",
    });
    await reclaimJournal.recordState({
      attemptKey: reclaimAttempt.attemptKey,
      status: "completed",
      lastChainStatus: "completed",
    });
    expect(await reclaimJournal.listDueSources(50)).not.toContain(completed.id);

    await expect(
      signer.sign({
        attemptKey: reclaimAttempt.attemptKey,
        unsigned: unsignedReclaim(signerNow + 1, 2_000_000),
      }),
    ).rejects.toThrow("Reclaim signer bound balance mismatch");
  });

});
