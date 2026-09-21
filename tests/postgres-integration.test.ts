import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PostgresPurchaseOrderCustomerRepository,
  PostgresPurchaseOrderRepository,
} from "../src/adapters/database/postgres-purchase-order-repository.js";
import {
  PostgresEnergyPackageRepository,
  PostgresTelegramUserRepository,
} from "../src/adapters/database/postgres-telegram-repositories.js";
import {
  createPostgresResource,
  type PostgresResource,
} from "../src/adapters/database/postgres.js";
import { AdminAccessService } from "../src/application/telegram/admin-access-service.js";
import {
  adminAccounts,
  energyPackages,
  packageBalances,
  packagePurchaseOrders,
  paymentTransactions,
  users,
} from "../src/db/schema.js";

const EXPECTED_TEST_DATABASE = "trx_energy_phase1_test";
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL === undefined ? describe.skip : describe;

describePostgres("PostgreSQL Telegram foundation integration", () => {
  let resource: PostgresResource;
  let userRepository: PostgresTelegramUserRepository;
  let packageRepository: PostgresEnergyPackageRepository;
  let purchaseOrderRepository: PostgresPurchaseOrderRepository;
  let purchaseOrderCustomerRepository: PostgresPurchaseOrderCustomerRepository;

  beforeAll(async () => {
    resource = createPostgresResource(TEST_DATABASE_URL ?? "");
    await resource.ping();

    const database = await resource.db.execute(
      sql<{ databaseName: string }>`select current_database() as "databaseName"`,
    );

    expect(database.rows[0]?.databaseName).toBe(EXPECTED_TEST_DATABASE);

    await migrate(resource.db, { migrationsFolder: "./drizzle" });
    await resource.assertSchemaReady();

    userRepository = new PostgresTelegramUserRepository(resource.db);
    packageRepository = new PostgresEnergyPackageRepository(resource.db);
    purchaseOrderRepository = new PostgresPurchaseOrderRepository(resource.db);
    purchaseOrderCustomerRepository =
      new PostgresPurchaseOrderCustomerRepository(resource.db);
  });

  afterAll(async () => {
    if (resource !== undefined) {
      await resource.close();
    }
  });

  it("applies migrations and keeps concurrent /start onboarding idempotent", async () => {
    const telegramUserId = 9_100_000_000_001n;

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) =>
        userRepository.onboard({
          telegramUserId,
          username: `phase1_concurrent_${index}`,
        }),
      ),
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);

    const storedUsers = await resource.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId));

    expect(storedUsers).toHaveLength(1);

    const balances = await resource.db
      .select({
        userId: packageBalances.userId,
        availableCount: packageBalances.availableCount,
        reservedCount: packageBalances.reservedCount,
      })
      .from(packageBalances)
      .where(eq(packageBalances.userId, storedUsers[0]!.id));

    expect(balances).toEqual([
      {
        userId: storedUsers[0]!.id,
        availableCount: 0,
        reservedCount: 0,
      },
    ]);
  });

  it("enforces blocked-user access before configured SUPER_ADMIN authority", async () => {
    const telegramUserId = 9_100_000_000_002n;
    const user = await userRepository.onboard({
      telegramUserId,
      username: "phase1_super_admin",
    });
    const adminAccess = new AdminAccessService(userRepository, telegramUserId);

    await expect(adminAccess.getRole(telegramUserId)).resolves.toBe(
      "SUPER_ADMIN",
    );

    await resource.db
      .update(users)
      .set({ status: "blocked" })
      .where(eq(users.id, user.id));

    await expect(adminAccess.getRole(telegramUserId)).resolves.toBeUndefined();
  });

  it("reads database admin roles by numeric Telegram ID", async () => {
    const telegramUserId = 9_100_000_000_003n;
    const user = await userRepository.onboard({
      telegramUserId,
      username: "phase1_admin",
    });

    await resource.db
      .insert(adminAccounts)
      .values({
        userId: user.id,
        role: "ADMIN",
      })
      .onConflictDoUpdate({
        target: adminAccounts.userId,
        set: {
          role: "ADMIN",
          updatedAt: new Date(),
        },
      });

    await expect(
      userRepository.getAccessByTelegramUserId(telegramUserId),
    ).resolves.toEqual({
      status: "active",
      role: "ADMIN",
    });
  });

  it("returns enabled packages only and rejects disabled historical selections", async () => {
    const enabledId = "11111111-1111-4111-8111-111111111111";
    const disabledId = "22222222-2222-4222-8222-222222222222";

    await resource.db
      .insert(energyPackages)
      .values([
        {
          id: enabledId,
          code: "phase1_enabled",
          count: 10,
          priceUsdtMicros: 17_000_000n,
          enabled: true,
          sortOrder: 10,
        },
        {
          id: disabledId,
          code: "phase1_disabled",
          count: 20,
          priceUsdtMicros: 34_000_000n,
          enabled: false,
          sortOrder: 20,
        },
      ])
      .onConflictDoNothing();

    const enabled = await packageRepository.listEnabled();

    expect(enabled.some((item) => item.id === enabledId)).toBe(true);
    expect(enabled.some((item) => item.id === disabledId)).toBe(false);
    await expect(packageRepository.findEnabledById(enabledId)).resolves.toMatchObject({
      id: enabledId,
      count: 10,
      priceUsdtMicros: 17_000_000n,
    });
    await expect(
      packageRepository.findEnabledById(disabledId),
    ).resolves.toBeUndefined();
  });

  it("rolls back onboarding-shaped writes when a database constraint fails", async () => {
    const telegramUserId = 9_100_000_000_004n;

    await expect(
      resource.db.transaction(async (tx) => {
        const [created] = await tx
          .insert(users)
          .values({
            telegramUserId,
            username: "phase1_rollback",
          })
          .returning({ id: users.id });

        if (created === undefined) {
          throw new Error("Failed to create rollback test user");
        }

        await tx.insert(packageBalances).values({
          userId: created.id,
          availableCount: -1,
        });
      }),
    ).rejects.toBeTruthy();

    const rows = await resource.db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId));

    expect(rows).toHaveLength(0);
  });

  it("enforces real PostgreSQL unique and check constraints", async () => {
    const telegramUserId = 9_100_000_000_005n;

    const [created] = await resource.db
      .insert(users)
      .values({
        telegramUserId,
        username: "phase1_constraint",
      })
      .returning({ id: users.id });

    expect(created).toBeDefined();

    await expect(
      resource.db.insert(users).values({
        telegramUserId,
        username: "phase1_duplicate",
      }),
    ).rejects.toBeTruthy();

    await expect(
      resource.db
        .update(users)
        .set({ status: "invalid" })
        .where(eq(users.telegramUserId, telegramUserId)),
    ).rejects.toBeTruthy();
  });
  it("uses event-level identity for TRC-20 and tx-level identity for TRX", async () => {
    const sharedUsdtTxid = "a".repeat(64);
    const usdtContract = "TUSDT_PHASE2_CONTRACT";

    await resource.db.insert(paymentTransactions).values([
      {
        txid: sharedUsdtTxid,
        asset: "USDT",
        tokenContractAddress: usdtContract,
        eventIndex: 0,
        fromAddress: "TUSDT_FROM_0",
        toAddress: "TUSDT_TO",
        amountAtomic: 17_000_000n,
      },
      {
        txid: sharedUsdtTxid,
        asset: "USDT",
        tokenContractAddress: usdtContract,
        eventIndex: 1,
        fromAddress: "TUSDT_FROM_1",
        toAddress: "TUSDT_TO",
        amountAtomic: 34_000_000n,
      },
    ]);

    const sameTransactionEvents = await resource.db
      .select({ eventIndex: paymentTransactions.eventIndex })
      .from(paymentTransactions)
      .where(eq(paymentTransactions.txid, sharedUsdtTxid));

    expect(sameTransactionEvents.map((row) => row.eventIndex).sort()).toEqual([
      0,
      1,
    ]);

    await expect(
      resource.db.insert(paymentTransactions).values({
        txid: sharedUsdtTxid,
        asset: "USDT",
        tokenContractAddress: usdtContract,
        eventIndex: 0,
        fromAddress: "TUSDT_DUPLICATE",
        toAddress: "TUSDT_TO",
        amountAtomic: 17_000_000n,
      }),
    ).rejects.toBeTruthy();

    await expect(
      resource.db.insert(paymentTransactions).values({
        txid: "c".repeat(64),
        asset: "USDT",
        tokenContractAddress: usdtContract,
        fromAddress: "TUSDT_NO_EVENT",
        toAddress: "TUSDT_TO",
        amountAtomic: 17_000_000n,
      }),
    ).rejects.toBeTruthy();

    const trxTxid = "b".repeat(64);

    await resource.db.insert(paymentTransactions).values({
      txid: trxTxid,
      asset: "TRX",
      tokenContractAddress: null,
      eventIndex: null,
      fromAddress: "TTRX_FROM",
      toAddress: "TTRX_TO",
      amountAtomic: 1_000_000n,
    });

    await expect(
      resource.db.insert(paymentTransactions).values({
        txid: trxTxid,
        asset: "TRX",
        tokenContractAddress: null,
        eventIndex: null,
        fromAddress: "TTRX_DUPLICATE",
        toAddress: "TTRX_TO",
        amountAtomic: 1_000_000n,
      }),
    ).rejects.toBeTruthy();

    await expect(
      resource.db.insert(paymentTransactions).values({
        txid: "d".repeat(64),
        asset: "TRX",
        tokenContractAddress: null,
        eventIndex: 0,
        fromAddress: "TTRX_EVENT_INDEX",
        toAddress: "TTRX_TO",
        amountAtomic: 1_000_000n,
      }),
    ).rejects.toBeTruthy();
  });

  it("creates purchase orders transactionally and keeps concurrent retries idempotent", async () => {
    const telegramUserId = 9_100_000_000_006n;
    const user = await userRepository.onboard({
      telegramUserId,
      username: "phase2_purchase_order",
    });
    const packageId = "33333333-3333-4333-8333-333333333333";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_order_package",
        count: 10,
        priceUsdtMicros: 17_000_000n,
        enabled: true,
        sortOrder: 30,
      })
      .onConflictDoNothing();

    const input = {
      userId: user.id,
      packageId,
      idempotencyKey: "phase2:purchase:concurrent",
      payment: {
        packageCodeSnapshot: "phase2_order_package",
        countSnapshot: 10,
        priceUsdtMicrosSnapshot: 17_000_000n,
        paymentAsset: "USDT" as const,
        paymentToAddressSnapshot:
          "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        paymentTokenContractAddressSnapshot:
          "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        requiredConfirmationsSnapshot: 2,
        quotedAmountAtomic: 17_000_000n,
        quoteExpiresAt: null,
      },
    };

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        purchaseOrderRepository.createOrGet(input),
      ),
    );

    const ready = results.filter(
      (result) => result.kind !== "conflict",
    );

    expect(ready).toHaveLength(6);
    expect(
      new Set(
        ready.map((result) => result.order.id),
      ).size,
    ).toBe(1);
    expect(
      results.filter((result) => result.kind === "created"),
    ).toHaveLength(1);

    const rows = await resource.db
      .select()
      .from(packagePurchaseOrders)
      .where(
        eq(
          packagePurchaseOrders.idempotencyKey,
          input.idempotencyKey,
        ),
      );

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("waiting_payment");

    const first = ready[0];

    if (first === undefined) {
      throw new Error("Expected persisted purchase order");
    }

    expect(first.order.expectation).toEqual({
      asset: "USDT",
      tokenContractAddress:
        "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
      amountAtomic: 17_000_000n,
      requiredConfirmations: 2,
    });

    await expect(
      purchaseOrderCustomerRepository.findActiveUserIdByTelegramUserId(
        telegramUserId,
      ),
    ).resolves.toBe(user.id);
  });

  it("detects idempotency-key reuse with a different immutable payload", async () => {
    const firstUser = await userRepository.onboard({
      telegramUserId: 9_100_000_000_007n,
      username: "phase2_idempotency_first",
    });
    const secondUser = await userRepository.onboard({
      telegramUserId: 9_100_000_000_008n,
      username: "phase2_idempotency_second",
    });
    const packageId = "44444444-4444-4444-8444-444444444444";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_conflict_package",
        count: 20,
        priceUsdtMicros: 34_000_000n,
        enabled: true,
        sortOrder: 40,
      })
      .onConflictDoNothing();

    const payment = {
      packageCodeSnapshot: "phase2_conflict_package",
      countSnapshot: 20,
      priceUsdtMicrosSnapshot: 34_000_000n,
      paymentAsset: "USDT" as const,
      paymentToAddressSnapshot:
        "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
      paymentTokenContractAddressSnapshot:
        "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      requiredConfirmationsSnapshot: 2,
      quotedAmountAtomic: 34_000_000n,
      quoteExpiresAt: null,
    };

    await expect(
      purchaseOrderRepository.createOrGet({
        userId: firstUser.id,
        packageId,
        idempotencyKey: "phase2:purchase:conflict",
        payment,
      }),
    ).resolves.toMatchObject({ kind: "created" });

    await expect(
      purchaseOrderRepository.createOrGet({
        userId: secondUser.id,
        packageId,
        idempotencyKey: "phase2:purchase:conflict",
        payment,
      }),
    ).resolves.toEqual({ kind: "conflict" });

    const rows = await resource.db
      .select({ userId: packagePurchaseOrders.userId })
      .from(packagePurchaseOrders)
      .where(
        eq(
          packagePurchaseOrders.idempotencyKey,
          "phase2:purchase:conflict",
        ),
      );

    expect(rows).toEqual([{ userId: firstUser.id }]);
  });

});
