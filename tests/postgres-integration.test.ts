import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PostgresPackageCreditRepository } from "../src/adapters/database/postgres-package-credit-repository.js";
import { PostgresPaymentLifecycleRepository } from "../src/adapters/database/postgres-payment-lifecycle-repository.js";
import { PostgresPurchaseOrderStatusRepository } from "../src/adapters/database/postgres-purchase-order-status-repository.js";
import { PostgresUsdtReconciliationOrderRepository } from "../src/adapters/database/postgres-usdt-payment-reconciliation-order-repository.js";
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
  balanceLedger,
  energyOptions,
  energyPackages,
  packageBalances,
  packagePurchaseOrders,
  paymentTransactions,
  users,
} from "../src/db/schema.js";
import {
  catalogEnergyOptions,
  catalogPackages,
} from "../src/config/catalog.js";
import { bootstrapCatalogIfNeeded } from "../src/runtime/catalog-bootstrap.js";

const EXPECTED_TEST_DATABASE = "trx_energy_phase1_test";
const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const describePostgres = TEST_DATABASE_URL === undefined ? describe.skip : describe;

describePostgres("PostgreSQL Telegram foundation integration", () => {
  let resource: PostgresResource;
  let userRepository: PostgresTelegramUserRepository;
  let packageRepository: PostgresEnergyPackageRepository;
  let purchaseOrderRepository: PostgresPurchaseOrderRepository;
  let purchaseOrderCustomerRepository: PostgresPurchaseOrderCustomerRepository;
  let paymentLifecycleRepository: PostgresPaymentLifecycleRepository;
  let purchaseOrderStatusRepository: PostgresPurchaseOrderStatusRepository;
  let packageCreditRepository: PostgresPackageCreditRepository;
  let paymentReconciliationOrderRepository: PostgresUsdtReconciliationOrderRepository;

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
    paymentLifecycleRepository =
      new PostgresPaymentLifecycleRepository(resource.db);
    purchaseOrderStatusRepository =
      new PostgresPurchaseOrderStatusRepository(resource.db);
    packageCreditRepository =
      new PostgresPackageCreditRepository(resource.db);
    paymentReconciliationOrderRepository =
      new PostgresUsdtReconciliationOrderRepository(resource.db);
  });

  afterAll(async () => {
    if (resource !== undefined) {
      await resource.close();
    }
  });

  it("bootstraps the client catalog exactly once without overwriting initialized data", async () => {
    await expect(
      bootstrapCatalogIfNeeded(resource.db),
    ).resolves.toBe("initialized");

    await expect(
      bootstrapCatalogIfNeeded(resource.db),
    ).resolves.toBe("already_initialized");

    const packages = await resource.db
      .select({
        code: energyPackages.code,
        count: energyPackages.count,
        priceUsdtMicros: energyPackages.priceUsdtMicros,
        enabled: energyPackages.enabled,
        sortOrder: energyPackages.sortOrder,
      })
      .from(energyPackages);

    expect(
      packages
        .filter((item) =>
          catalogPackages.some((expected) => expected.code === item.code),
        )
        .sort((left, right) => left.sortOrder - right.sortOrder),
    ).toEqual(
      catalogPackages.map((item) => ({
        code: item.code,
        count: item.count,
        priceUsdtMicros: item.priceUsdtMicros,
        enabled: item.enabled,
        sortOrder: item.sortOrder,
      })),
    );

    const options = await resource.db
      .select({
        code: energyOptions.code,
        energyAmount: energyOptions.energyAmount,
        countCost: energyOptions.countCost,
        enabled: energyOptions.enabled,
        sortOrder: energyOptions.sortOrder,
      })
      .from(energyOptions);

    expect(
      options.sort((left, right) => left.sortOrder - right.sortOrder),
    ).toEqual(
      catalogEnergyOptions.map((item) => ({
        code: item.code,
        energyAmount: item.energyAmount,
        countCost: item.countCost,
        enabled: item.enabled,
        sortOrder: item.sortOrder,
      })),
    );
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
  it("enforces one payment row per TXID for USDT and TRX", async () => {
    const sharedUsdtTxid = "a".repeat(64);
    const usdtContract = "TUSDT_PHASE2_CONTRACT";

    await resource.db.insert(paymentTransactions).values({
      txid: sharedUsdtTxid,
      asset: "USDT",
      tokenContractAddress: usdtContract,
      eventIndex: 0,
      fromAddress: "TUSDT_FROM_0",
      toAddress: "TUSDT_TO",
      amountAtomic: 17_000_000n,
    });

    await expect(
      resource.db.insert(paymentTransactions).values({
        txid: sharedUsdtTxid,
        asset: "USDT",
        tokenContractAddress: usdtContract,
        eventIndex: 1,
        fromAddress: "TUSDT_FROM_1",
        toAddress: "TUSDT_TO",
        amountAtomic: 34_000_000n,
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
        quoteExpiresAt: new Date("2026-09-22T02:15:00.000Z"),
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

    const replayed = await purchaseOrderRepository.createOrGet({
      ...input,
      payment: {
        ...input.payment,
        quoteExpiresAt: new Date("2026-09-22T02:20:00.000Z"),
      },
    });

    expect(replayed).toMatchObject({
      kind: "existing",
      order: {
        id: first.order.id,
      },
    });

    if (replayed.kind === "conflict") {
      throw new Error("Expected idempotent purchase-order replay");
    }

    expect(replayed.order.payment.quoteExpiresAt).toEqual(
      input.payment.quoteExpiresAt,
    );

    await expect(
      purchaseOrderCustomerRepository.findActiveUserIdByTelegramUserId(
        telegramUserId,
      ),
    ).resolves.toBe(user.id);
  });

  it("allocates lifetime-unique USDT amounts for concurrent same-route orders and never reuses an expired amount", async () => {
    const packageId = "23232323-2323-4232-8232-232323232323";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_attribution_package",
        count: 10,
        priceUsdtMicros: 17_000_000n,
        enabled: true,
        sortOrder: 35,
      })
      .onConflictDoNothing();

    const usersForOrders = await Promise.all(
      [21n, 22n, 23n].map((suffix) =>
        userRepository.onboard({
          telegramUserId:
            9_100_000_000_000n + suffix,
          username: `phase2_attribution_${suffix}`,
        }),
      ),
    );

    const basePayment = {
      packageCodeSnapshot: "phase2_attribution_package",
      countSnapshot: 10,
      priceUsdtMicrosSnapshot: 17_000_000n,
      paymentAsset: "USDT" as const,
      paymentToAddressSnapshot:
        "TTEST_ATTRIBUTION_DESTINATION",
      paymentTokenContractAddressSnapshot:
        "TTEST_USDT_CONTRACT",
      requiredConfirmationsSnapshot: 1,
      quotedAmountAtomic: 17_000_000n,
      quoteExpiresAt: null,
    };

    const firstTwo = await Promise.all(
      usersForOrders.slice(0, 2).map((user, index) =>
        purchaseOrderRepository.createOrGet({
          userId: user!.id,
          packageId,
          idempotencyKey:
            `phase2:attribution:${index}`,
          payment: basePayment,
          maxUsdtAttributionOffsetAtomic: 2n,
        }),
      ),
    );

    const createdFirstTwo = firstTwo.map((result) => {
      if (result.kind === "conflict") {
        throw new Error(
          "Unexpected attribution conflict while slots remain",
        );
      }

      expect(result.kind).toBe("created");
      return result.order;
    });

    const amounts = createdFirstTwo
      .map((order) => order.expectation.amountAtomic)
      .sort((left, right) => (left < right ? -1 : 1));

    expect(amounts).toEqual([
      17_000_000n,
      17_000_001n,
    ]);

    await resource.db
      .update(packagePurchaseOrders)
      .set({ status: "expired" })
      .where(
        eq(
          packagePurchaseOrders.id,
          createdFirstTwo[0]!.id,
        ),
      );

    const third = await purchaseOrderRepository.createOrGet({
      userId: usersForOrders[2]!.id,
      packageId,
      idempotencyKey: "phase2:attribution:2",
      payment: basePayment,
      maxUsdtAttributionOffsetAtomic: 2n,
    });

    expect(third).toMatchObject({ kind: "created" });

    if (third.kind !== "created") {
      throw new Error("Expected third attributed order");
    }

    expect(third.order.expectation.amountAtomic).toBe(
      17_000_002n,
    );

    const exhaustedUser = await userRepository.onboard({
      telegramUserId: 9_100_000_000_024n,
      username: "phase2_attribution_exhausted",
    });

    await expect(
      purchaseOrderRepository.createOrGet({
        userId: exhaustedUser.id,
        packageId,
        idempotencyKey: "phase2:attribution:exhausted",
        payment: basePayment,
        maxUsdtAttributionOffsetAtomic: 2n,
      }),
    ).resolves.toEqual({
      kind: "conflict",
      reason: "attribution_unavailable",
    });
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

  it("persists payment evidence monotonically and advances the order atomically", async () => {
    const user = await userRepository.onboard({
      telegramUserId: 9_100_000_000_009n,
      username: "phase2_payment_lifecycle",
    });
    const packageId = "55555555-5555-4555-8555-555555555555";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_payment_lifecycle_package",
        count: 10,
        priceUsdtMicros: 17_000_000n,
        enabled: true,
        sortOrder: 50,
      })
      .onConflictDoNothing();

    const created = await purchaseOrderRepository.createOrGet({
      userId: user.id,
      packageId,
      idempotencyKey: "phase2:payment:lifecycle",
      payment: {
        packageCodeSnapshot:
          "phase2_payment_lifecycle_package",
        countSnapshot: 10,
        priceUsdtMicrosSnapshot: 17_000_000n,
        paymentAsset: "USDT",
        paymentToAddressSnapshot:
          "TTEST_PAYMENT_DESTINATION",
        paymentTokenContractAddressSnapshot:
          "TTEST_USDT_CONTRACT",
        requiredConfirmationsSnapshot: 2,
        quotedAmountAtomic: 17_000_000n,
        quoteExpiresAt: null,
      },
    });

    if (created.kind === "conflict") {
      throw new Error("Unexpected order idempotency conflict");
    }

    const baseObservation = {
      asset: "USDT" as const,
      txid: "e".repeat(64),
      tokenContractAddress: "TTEST_USDT_CONTRACT",
      eventIndex: 0,
      fromAddress: "TTEST_PAYMENT_SENDER",
      toAddress: "TTEST_PAYMENT_DESTINATION",
      amountAtomic: 17_000_000n,
      blockNumber: 70_000_000n,
      blockTimestamp: new Date("2026-09-21T15:00:00.000Z"),
    };

    await expect(
      paymentLifecycleRepository.applyObservation({
        purchaseOrderId: created.order.id,
        observation: {
          ...baseObservation,
          confirmations: 0,
          solidified: false,
          evidenceSource: "fullnode",
          executionStatus: "success",
        },
      }),
    ).resolves.toMatchObject({
      kind: "applied",
      transactionStatus: "detected",
      orderStatus: "payment_detected",
    });

    await expect(
      paymentLifecycleRepository.applyObservation({
        purchaseOrderId: created.order.id,
        observation: {
          ...baseObservation,
          confirmations: 1,
          solidified: true,
          evidenceSource: "solidified_node",
          executionStatus: "success",
        },
      }),
    ).resolves.toMatchObject({
      kind: "applied",
      transactionStatus: "confirming",
      orderStatus: "confirming",
    });

    await expect(
      paymentLifecycleRepository.applyObservation({
        purchaseOrderId: created.order.id,
        observation: {
          ...baseObservation,
          confirmations: 0,
          solidified: false,
          evidenceSource: "fullnode",
          executionStatus: "success",
        },
      }),
    ).resolves.toMatchObject({
      kind: "applied",
      transactionStatus: "confirming",
      orderStatus: "confirming",
    });

    await expect(
      paymentLifecycleRepository.applyObservation({
        purchaseOrderId: created.order.id,
        observation: {
          ...baseObservation,
          confirmations: 2,
          solidified: true,
          evidenceSource: "solidified_node",
          executionStatus: "success",
        },
      }),
    ).resolves.toMatchObject({
      kind: "applied",
      transactionStatus: "confirmed",
      orderStatus: "paid",
    });

    const [paymentRow] = await resource.db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.txid, baseObservation.txid));

    expect(paymentRow).toMatchObject({
      purchaseOrderId: created.order.id,
      status: "confirmed",
      confirmations: 2,
      blockNumber: 70_000_000n,
    });
    expect(paymentRow?.confirmedAt).not.toBeNull();

    const [orderRow] = await resource.db
      .select({ status: packagePurchaseOrders.status })
      .from(packagePurchaseOrders)
      .where(eq(packagePurchaseOrders.id, created.order.id));

    expect(orderRow?.status).toBe("paid");

    const [balance] = await resource.db
      .select({
        availableCount: packageBalances.availableCount,
        reservedCount: packageBalances.reservedCount,
      })
      .from(packageBalances)
      .where(eq(packageBalances.userId, user.id));

    expect(balance).toEqual({
      availableCount: 0,
      reservedCount: 0,
    });
  });

  it("serializes concurrent confirmed evidence to one payment row without crediting balance", async () => {
    const user = await userRepository.onboard({
      telegramUserId: 9_100_000_000_010n,
      username: "phase2_payment_concurrent",
    });
    const packageId = "66666666-6666-4666-8666-666666666666";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_payment_concurrent_package",
        count: 20,
        priceUsdtMicros: 34_000_000n,
        enabled: true,
        sortOrder: 60,
      })
      .onConflictDoNothing();

    const created = await purchaseOrderRepository.createOrGet({
      userId: user.id,
      packageId,
      idempotencyKey: "phase2:payment:concurrent",
      payment: {
        packageCodeSnapshot:
          "phase2_payment_concurrent_package",
        countSnapshot: 20,
        priceUsdtMicrosSnapshot: 34_000_000n,
        paymentAsset: "USDT",
        paymentToAddressSnapshot:
          "TTEST_CONCURRENT_DESTINATION",
        paymentTokenContractAddressSnapshot:
          "TTEST_USDT_CONTRACT",
        requiredConfirmationsSnapshot: 1,
        quotedAmountAtomic: 34_000_000n,
        quoteExpiresAt: null,
      },
    });

    if (created.kind === "conflict") {
      throw new Error("Unexpected order idempotency conflict");
    }

    const observation = {
      asset: "USDT" as const,
      txid: "f".repeat(64),
      tokenContractAddress: "TTEST_USDT_CONTRACT",
      eventIndex: 1,
      fromAddress: "TTEST_CONCURRENT_SENDER",
      toAddress: "TTEST_CONCURRENT_DESTINATION",
      amountAtomic: 34_000_000n,
      confirmations: 1,
      solidified: true,
      evidenceSource: "solidified_node" as const,
      executionStatus: "success" as const,
      blockNumber: 70_000_100n,
      blockTimestamp: new Date("2026-09-21T15:01:00.000Z"),
    };

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        paymentLifecycleRepository.applyObservation({
          purchaseOrderId: created.order.id,
          observation,
        }),
      ),
    );

    expect(
      results.filter((result) => result.kind === "applied"),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) => result.kind === "terminal_noop",
      ),
    ).toHaveLength(5);

    const rows = await resource.db
      .select()
      .from(paymentTransactions)
      .where(eq(paymentTransactions.txid, observation.txid));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("confirmed");

    const [orderRow] = await resource.db
      .select({ status: packagePurchaseOrders.status })
      .from(packagePurchaseOrders)
      .where(eq(packagePurchaseOrders.id, created.order.id));

    expect(orderRow?.status).toBe("paid");

    const [balance] = await resource.db
      .select({ availableCount: packageBalances.availableCount })
      .from(packageBalances)
      .where(eq(packageBalances.userId, user.id));

    expect(balance?.availableCount).toBe(0);
  });

  it("keeps mismatched evidence out of the automatic payment lifecycle", async () => {
    const user = await userRepository.onboard({
      telegramUserId: 9_100_000_000_011n,
      username: "phase2_payment_mismatch",
    });
    const packageId = "77777777-7777-4777-8777-777777777777";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_payment_mismatch_package",
        count: 50,
        priceUsdtMicros: 85_000_000n,
        enabled: true,
        sortOrder: 70,
      })
      .onConflictDoNothing();

    const created = await purchaseOrderRepository.createOrGet({
      userId: user.id,
      packageId,
      idempotencyKey: "phase2:payment:mismatch",
      payment: {
        packageCodeSnapshot:
          "phase2_payment_mismatch_package",
        countSnapshot: 50,
        priceUsdtMicrosSnapshot: 85_000_000n,
        paymentAsset: "USDT",
        paymentToAddressSnapshot:
          "TTEST_MISMATCH_DESTINATION",
        paymentTokenContractAddressSnapshot:
          "TTEST_USDT_CONTRACT",
        requiredConfirmationsSnapshot: 1,
        quotedAmountAtomic: 85_000_000n,
        quoteExpiresAt: null,
      },
    });

    if (created.kind === "conflict") {
      throw new Error("Unexpected order idempotency conflict");
    }

    const txid = "1".repeat(64);

    await expect(
      paymentLifecycleRepository.applyObservation({
        purchaseOrderId: created.order.id,
        observation: {
          asset: "USDT",
          txid,
          tokenContractAddress: "TTEST_USDT_CONTRACT",
          eventIndex: 2,
          fromAddress: "TTEST_MISMATCH_SENDER",
          toAddress: "TTEST_MISMATCH_DESTINATION",
          amountAtomic: 84_999_999n,
          confirmations: 1,
          solidified: true,
          evidenceSource: "solidified_node",
          executionStatus: "success",
        },
      }),
    ).resolves.toEqual({
      kind: "ignored",
      reason: "reconciliation_mismatch",
    });

    const paymentRows = await resource.db
      .select({ id: paymentTransactions.id })
      .from(paymentTransactions)
      .where(eq(paymentTransactions.txid, txid));

    expect(paymentRows).toHaveLength(0);

    const [orderRow] = await resource.db
      .select({ status: packagePurchaseOrders.status })
      .from(packagePurchaseOrders)
      .where(eq(packagePurchaseOrders.id, created.order.id));

    expect(orderRow?.status).toBe("waiting_payment");
  });

  it("prevents one payment identity from being consumed by two purchase orders", async () => {
    const firstUser = await userRepository.onboard({
      telegramUserId: 9_100_000_000_012n,
      username: "phase2_payment_identity_first",
    });
    const secondUser = await userRepository.onboard({
      telegramUserId: 9_100_000_000_013n,
      username: "phase2_payment_identity_second",
    });
    const packageId = "88888888-8888-4888-8888-888888888888";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_payment_identity_package",
        count: 100,
        priceUsdtMicros: 170_000_000n,
        enabled: true,
        sortOrder: 80,
      })
      .onConflictDoNothing();

    const payment = {
      packageCodeSnapshot: "phase2_payment_identity_package",
      countSnapshot: 100,
      priceUsdtMicrosSnapshot: 170_000_000n,
      paymentAsset: "USDT" as const,
      paymentToAddressSnapshot:
        "TTEST_IDENTITY_DESTINATION",
      paymentTokenContractAddressSnapshot:
        "TTEST_USDT_CONTRACT",
      requiredConfirmationsSnapshot: 1,
      quotedAmountAtomic: 170_000_000n,
      quoteExpiresAt: null,
    };

    const firstOrder = await purchaseOrderRepository.createOrGet({
      userId: firstUser.id,
      packageId,
      idempotencyKey: "phase2:payment:identity:first",
      payment,
    });
    const secondOrder = await purchaseOrderRepository.createOrGet({
      userId: secondUser.id,
      packageId,
      idempotencyKey: "phase2:payment:identity:second",
      payment,
      maxUsdtAttributionOffsetAtomic: 10n,
    });

    if (
      firstOrder.kind === "conflict" ||
      secondOrder.kind === "conflict"
    ) {
      throw new Error("Unexpected order idempotency conflict");
    }

    const observation = {
      asset: "USDT" as const,
      txid: "2".repeat(64),
      tokenContractAddress: "TTEST_USDT_CONTRACT",
      eventIndex: 3,
      fromAddress: "TTEST_IDENTITY_SENDER",
      toAddress: "TTEST_IDENTITY_DESTINATION",
      amountAtomic: 170_000_000n,
      confirmations: 1,
      solidified: true,
      evidenceSource: "solidified_node" as const,
      executionStatus: "success" as const,
    };

    await expect(
      paymentLifecycleRepository.applyObservation({
        purchaseOrderId: firstOrder.order.id,
        observation,
      }),
    ).resolves.toMatchObject({
      kind: "applied",
      transactionStatus: "confirmed",
      orderStatus: "paid",
    });

    await expect(
      paymentLifecycleRepository.applyObservation({
        purchaseOrderId: secondOrder.order.id,
        observation: {
          ...observation,
          eventIndex: observation.eventIndex + 1,
        },
      }),
    ).resolves.toEqual({
      kind: "conflict",
      reason: "payment_identity_conflict",
    });

    const [secondOrderRow] = await resource.db
      .select({ status: packagePurchaseOrders.status })
      .from(packagePurchaseOrders)
      .where(eq(packagePurchaseOrders.id, secondOrder.order.id));

    expect(secondOrderRow?.status).toBe("waiting_payment");
  });

  it("fails closed when authoritative evidence contradicts a rejected terminal payment", async () => {
    const user = await userRepository.onboard({
      telegramUserId: 9_100_000_000_014n,
      username: "phase2_payment_terminal_conflict",
    });
    const packageId = "99999999-9999-4999-8999-999999999999";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_payment_terminal_package",
        count: 200,
        priceUsdtMicros: 340_000_000n,
        enabled: true,
        sortOrder: 90,
      })
      .onConflictDoNothing();

    const created = await purchaseOrderRepository.createOrGet({
      userId: user.id,
      packageId,
      idempotencyKey: "phase2:payment:terminal-conflict",
      payment: {
        packageCodeSnapshot:
          "phase2_payment_terminal_package",
        countSnapshot: 200,
        priceUsdtMicrosSnapshot: 340_000_000n,
        paymentAsset: "USDT",
        paymentToAddressSnapshot:
          "TTEST_TERMINAL_DESTINATION",
        paymentTokenContractAddressSnapshot:
          "TTEST_USDT_CONTRACT",
        requiredConfirmationsSnapshot: 1,
        quotedAmountAtomic: 340_000_000n,
        quoteExpiresAt: null,
      },
    });

    if (created.kind === "conflict") {
      throw new Error("Unexpected order idempotency conflict");
    }

    const base = {
      asset: "USDT" as const,
      txid: "3".repeat(64),
      tokenContractAddress: "TTEST_USDT_CONTRACT",
      eventIndex: 4,
      fromAddress: "TTEST_TERMINAL_SENDER",
      toAddress: "TTEST_TERMINAL_DESTINATION",
      amountAtomic: 340_000_000n,
      confirmations: 1,
      solidified: true,
      evidenceSource: "solidified_node" as const,
    };

    await expect(
      paymentLifecycleRepository.applyObservation({
        purchaseOrderId: created.order.id,
        observation: {
          ...base,
          executionStatus: "failed",
        },
      }),
    ).resolves.toMatchObject({
      kind: "applied",
      transactionStatus: "rejected",
      orderStatus: "failed",
    });

    await expect(
      paymentLifecycleRepository.applyObservation({
        purchaseOrderId: created.order.id,
        observation: {
          ...base,
          executionStatus: "success",
        },
      }),
    ).resolves.toEqual({
      kind: "conflict",
      reason: "transaction_terminal_conflict",
    });

    const [paymentRow] = await resource.db
      .select({ status: paymentTransactions.status })
      .from(paymentTransactions)
      .where(eq(paymentTransactions.txid, base.txid));

    expect(paymentRow?.status).toBe("rejected");

    const [orderRow] = await resource.db
      .select({ status: packagePurchaseOrders.status })
      .from(packagePurchaseOrders)
      .where(eq(packagePurchaseOrders.id, created.order.id));

    expect(orderRow?.status).toBe("failed");
  });

  it("credits a paid purchase exactly once and moves it to credited atomically", async () => {
    const user = await userRepository.onboard({
      telegramUserId: 9_100_000_000_015n,
      username: "phase2_purchase_credit",
    });
    const packageId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_purchase_credit_package",
        count: 10,
        priceUsdtMicros: 17_000_000n,
        enabled: true,
        sortOrder: 100,
      })
      .onConflictDoNothing();

    const created = await purchaseOrderRepository.createOrGet({
      userId: user.id,
      packageId,
      idempotencyKey: "phase2:credit:single",
      payment: {
        packageCodeSnapshot:
          "phase2_purchase_credit_package",
        countSnapshot: 10,
        priceUsdtMicrosSnapshot: 17_000_000n,
        paymentAsset: "USDT",
        paymentToAddressSnapshot:
          "TTEST_CREDIT_DESTINATION",
        paymentTokenContractAddressSnapshot:
          "TTEST_USDT_CONTRACT",
        requiredConfirmationsSnapshot: 1,
        quotedAmountAtomic: 17_000_000n,
        quoteExpiresAt: null,
      },
    });

    if (created.kind === "conflict") {
      throw new Error("Unexpected order idempotency conflict");
    }

    await expect(
      paymentLifecycleRepository.applyObservation({
        purchaseOrderId: created.order.id,
        observation: {
          asset: "USDT",
          txid: "4".repeat(64),
          tokenContractAddress: "TTEST_USDT_CONTRACT",
          eventIndex: 5,
          fromAddress: "TTEST_CREDIT_SENDER",
          toAddress: "TTEST_CREDIT_DESTINATION",
          amountAtomic: 17_000_000n,
          confirmations: 1,
          solidified: true,
          evidenceSource: "solidified_node",
          executionStatus: "success",
        },
      }),
    ).resolves.toMatchObject({
      kind: "applied",
      transactionStatus: "confirmed",
      orderStatus: "paid",
    });

    const result =
      await packageCreditRepository.creditPaidOrder({
        purchaseOrderId: created.order.id,
      });

    expect(result).toMatchObject({
      kind: "credited",
      created: true,
      availableCount: 10,
    });

    const [orderRow] = await resource.db
      .select({ status: packagePurchaseOrders.status })
      .from(packagePurchaseOrders)
      .where(eq(packagePurchaseOrders.id, created.order.id));

    expect(orderRow?.status).toBe("credited");

    const [balance] = await resource.db
      .select({
        availableCount: packageBalances.availableCount,
        reservedCount: packageBalances.reservedCount,
      })
      .from(packageBalances)
      .where(eq(packageBalances.userId, user.id));

    expect(balance).toEqual({
      availableCount: 10,
      reservedCount: 0,
    });

    const ledgerRows = await resource.db
      .select()
      .from(balanceLedger)
      .where(eq(balanceLedger.purchaseOrderId, created.order.id));

    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]).toMatchObject({
      userId: user.id,
      purchaseOrderId: created.order.id,
      paymentTransactionId:
        result.kind === "credited"
          ? result.paymentTransactionId
          : "",
      reason: "purchase_credit",
      availableDelta: 10,
      reservedDelta: 0,
    });
  });

  it("keeps concurrent package-credit retries exactly once", async () => {
    const user = await userRepository.onboard({
      telegramUserId: 9_100_000_000_016n,
      username: "phase2_purchase_credit_concurrent",
    });
    const packageId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_purchase_credit_concurrent_package",
        count: 20,
        priceUsdtMicros: 34_000_000n,
        enabled: true,
        sortOrder: 110,
      })
      .onConflictDoNothing();

    const created = await purchaseOrderRepository.createOrGet({
      userId: user.id,
      packageId,
      idempotencyKey: "phase2:credit:concurrent",
      payment: {
        packageCodeSnapshot:
          "phase2_purchase_credit_concurrent_package",
        countSnapshot: 20,
        priceUsdtMicrosSnapshot: 34_000_000n,
        paymentAsset: "USDT",
        paymentToAddressSnapshot:
          "TTEST_CREDIT_CONCURRENT_DESTINATION",
        paymentTokenContractAddressSnapshot:
          "TTEST_USDT_CONTRACT",
        requiredConfirmationsSnapshot: 1,
        quotedAmountAtomic: 34_000_000n,
        quoteExpiresAt: null,
      },
    });

    if (created.kind === "conflict") {
      throw new Error("Unexpected order idempotency conflict");
    }

    await paymentLifecycleRepository.applyObservation({
      purchaseOrderId: created.order.id,
      observation: {
        asset: "USDT",
        txid: "5".repeat(64),
        tokenContractAddress: "TTEST_USDT_CONTRACT",
        eventIndex: 6,
        fromAddress: "TTEST_CREDIT_CONCURRENT_SENDER",
        toAddress: "TTEST_CREDIT_CONCURRENT_DESTINATION",
        amountAtomic: 34_000_000n,
        confirmations: 1,
        solidified: true,
        evidenceSource: "solidified_node",
        executionStatus: "success",
      },
    });

    const results = await Promise.all(
      Array.from({ length: 6 }, () =>
        packageCreditRepository.creditPaidOrder({
          purchaseOrderId: created.order.id,
        }),
      ),
    );

    expect(
      results.filter(
        (result) =>
          result.kind === "credited" &&
          result.created,
      ),
    ).toHaveLength(1);
    expect(
      results.filter(
        (result) =>
          result.kind === "credited" &&
          !result.created,
      ),
    ).toHaveLength(5);

    const [balance] = await resource.db
      .select({ availableCount: packageBalances.availableCount })
      .from(packageBalances)
      .where(eq(packageBalances.userId, user.id));

    expect(balance?.availableCount).toBe(20);

    const ledgerRows = await resource.db
      .select({ id: balanceLedger.id })
      .from(balanceLedger)
      .where(eq(balanceLedger.purchaseOrderId, created.order.id));

    expect(ledgerRows).toHaveLength(1);
  });

  it("does not credit an order before confirmed payment reaches paid", async () => {
    const user = await userRepository.onboard({
      telegramUserId: 9_100_000_000_017n,
      username: "phase2_purchase_credit_not_ready",
    });
    const packageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_purchase_credit_not_ready_package",
        count: 50,
        priceUsdtMicros: 85_000_000n,
        enabled: true,
        sortOrder: 120,
      })
      .onConflictDoNothing();

    const created = await purchaseOrderRepository.createOrGet({
      userId: user.id,
      packageId,
      idempotencyKey: "phase2:credit:not-ready",
      payment: {
        packageCodeSnapshot:
          "phase2_purchase_credit_not_ready_package",
        countSnapshot: 50,
        priceUsdtMicrosSnapshot: 85_000_000n,
        paymentAsset: "USDT",
        paymentToAddressSnapshot:
          "TTEST_CREDIT_NOT_READY_DESTINATION",
        paymentTokenContractAddressSnapshot:
          "TTEST_USDT_CONTRACT",
        requiredConfirmationsSnapshot: 2,
        quotedAmountAtomic: 85_000_000n,
        quoteExpiresAt: null,
      },
    });

    if (created.kind === "conflict") {
      throw new Error("Unexpected order idempotency conflict");
    }

    await expect(
      packageCreditRepository.creditPaidOrder({
        purchaseOrderId: created.order.id,
      }),
    ).resolves.toEqual({
      kind: "not_ready",
      orderStatus: "waiting_payment",
    });

    const [balance] = await resource.db
      .select({ availableCount: packageBalances.availableCount })
      .from(packageBalances)
      .where(eq(packageBalances.userId, user.id));

    expect(balance?.availableCount).toBe(0);

    const ledgerRows = await resource.db
      .select({ id: balanceLedger.id })
      .from(balanceLedger)
      .where(eq(balanceLedger.purchaseOrderId, created.order.id));

    expect(ledgerRows).toHaveLength(0);
  });

  it("fails closed if a credited order has no matching purchase-credit ledger", async () => {
    const user = await userRepository.onboard({
      telegramUserId: 9_100_000_000_018n,
      username: "phase2_purchase_credit_corrupt",
    });
    const packageId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_purchase_credit_corrupt_package",
        count: 100,
        priceUsdtMicros: 170_000_000n,
        enabled: true,
        sortOrder: 130,
      })
      .onConflictDoNothing();

    const created = await purchaseOrderRepository.createOrGet({
      userId: user.id,
      packageId,
      idempotencyKey: "phase2:credit:corrupt",
      payment: {
        packageCodeSnapshot:
          "phase2_purchase_credit_corrupt_package",
        countSnapshot: 100,
        priceUsdtMicrosSnapshot: 170_000_000n,
        paymentAsset: "USDT",
        paymentToAddressSnapshot:
          "TTEST_CREDIT_CORRUPT_DESTINATION",
        paymentTokenContractAddressSnapshot:
          "TTEST_USDT_CONTRACT",
        requiredConfirmationsSnapshot: 1,
        quotedAmountAtomic: 170_000_000n,
        quoteExpiresAt: null,
      },
    });

    if (created.kind === "conflict") {
      throw new Error("Unexpected order idempotency conflict");
    }

    await paymentLifecycleRepository.applyObservation({
      purchaseOrderId: created.order.id,
      observation: {
        asset: "USDT",
        txid: "6".repeat(64),
        tokenContractAddress: "TTEST_USDT_CONTRACT",
        eventIndex: 7,
        fromAddress: "TTEST_CREDIT_CORRUPT_SENDER",
        toAddress: "TTEST_CREDIT_CORRUPT_DESTINATION",
        amountAtomic: 170_000_000n,
        confirmations: 1,
        solidified: true,
        evidenceSource: "solidified_node",
        executionStatus: "success",
      },
    });

    await resource.db
      .update(packagePurchaseOrders)
      .set({ status: "credited" })
      .where(eq(packagePurchaseOrders.id, created.order.id));

    await expect(
      packageCreditRepository.creditPaidOrder({
        purchaseOrderId: created.order.id,
      }),
    ).resolves.toEqual({
      kind: "conflict",
      reason: "credited_without_ledger",
    });

    const [balance] = await resource.db
      .select({ availableCount: packageBalances.availableCount })
      .from(packageBalances)
      .where(eq(packageBalances.userId, user.id));

    expect(balance?.availableCount).toBe(0);
  });

  it("does not mutate balance when purchase-credit idempotency key already belongs elsewhere", async () => {
    const targetUser = await userRepository.onboard({
      telegramUserId: 9_100_000_000_019n,
      username: "phase2_credit_idempotency_target",
    });
    const decoyUser = await userRepository.onboard({
      telegramUserId: 9_100_000_000_020n,
      username: "phase2_credit_idempotency_decoy",
    });
    const packageId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase2_credit_idempotency_package",
        count: 10,
        priceUsdtMicros: 17_000_000n,
        enabled: true,
        sortOrder: 140,
      })
      .onConflictDoNothing();

    const paymentSnapshot = {
      packageCodeSnapshot:
        "phase2_credit_idempotency_package",
      countSnapshot: 10,
      priceUsdtMicrosSnapshot: 17_000_000n,
      paymentAsset: "USDT" as const,
      paymentToAddressSnapshot:
        "TTEST_CREDIT_IDEMPOTENCY_DESTINATION",
      paymentTokenContractAddressSnapshot:
        "TTEST_USDT_CONTRACT",
      requiredConfirmationsSnapshot: 1,
      quotedAmountAtomic: 17_000_000n,
      quoteExpiresAt: null,
    };

    const targetOrder = await purchaseOrderRepository.createOrGet({
      userId: targetUser.id,
      packageId,
      idempotencyKey: "phase2:credit:idempotency:target",
      payment: paymentSnapshot,
      maxUsdtAttributionOffsetAtomic: 10n,
    });
    const decoyOrder = await purchaseOrderRepository.createOrGet({
      userId: decoyUser.id,
      packageId,
      idempotencyKey: "phase2:credit:idempotency:decoy",
      payment: paymentSnapshot,
      maxUsdtAttributionOffsetAtomic: 10n,
    });

    if (
      targetOrder.kind === "conflict" ||
      decoyOrder.kind === "conflict"
    ) {
      throw new Error("Unexpected order idempotency conflict");
    }

    await paymentLifecycleRepository.applyObservation({
      purchaseOrderId: targetOrder.order.id,
      observation: {
        asset: "USDT",
        txid: "7".repeat(64),
        tokenContractAddress: "TTEST_USDT_CONTRACT",
        eventIndex: 8,
        fromAddress: "TTEST_CREDIT_IDEMPOTENCY_TARGET_SENDER",
        toAddress: "TTEST_CREDIT_IDEMPOTENCY_DESTINATION",
        amountAtomic:
          targetOrder.order.expectation.amountAtomic,
        confirmations: 1,
        solidified: true,
        evidenceSource: "solidified_node",
        executionStatus: "success",
      },
    });

    const decoyPaymentResult =
      await paymentLifecycleRepository.applyObservation({
        purchaseOrderId: decoyOrder.order.id,
        observation: {
          asset: "USDT",
          txid: "8".repeat(64),
          tokenContractAddress: "TTEST_USDT_CONTRACT",
          eventIndex: 9,
          fromAddress:
            "TTEST_CREDIT_IDEMPOTENCY_DECOY_SENDER",
          toAddress: "TTEST_CREDIT_IDEMPOTENCY_DESTINATION",
          amountAtomic:
            decoyOrder.order.expectation.amountAtomic,
          confirmations: 1,
          solidified: true,
          evidenceSource: "solidified_node",
          executionStatus: "success",
        },
      });

    if (decoyPaymentResult.kind !== "applied") {
      throw new Error("Expected decoy payment to be applied");
    }

    await resource.db.insert(balanceLedger).values({
      userId: decoyUser.id,
      purchaseOrderId: decoyOrder.order.id,
      paymentTransactionId:
        decoyPaymentResult.paymentTransactionId,
      energyConsumptionOrderId: null,
      auditLogId: null,
      idempotencyKey:
        `purchase-credit:${targetOrder.order.id}`,
      reason: "purchase_credit",
      availableDelta: 10,
      reservedDelta: 0,
    });

    await expect(
      packageCreditRepository.creditPaidOrder({
        purchaseOrderId: targetOrder.order.id,
      }),
    ).resolves.toEqual({
      kind: "conflict",
      reason: "ledger_unique_conflict",
    });

    const [targetBalance] = await resource.db
      .select({
        availableCount: packageBalances.availableCount,
        reservedCount: packageBalances.reservedCount,
      })
      .from(packageBalances)
      .where(eq(packageBalances.userId, targetUser.id));

    expect(targetBalance).toEqual({
      availableCount: 0,
      reservedCount: 0,
    });

    const [targetOrderRow] = await resource.db
      .select({ status: packagePurchaseOrders.status })
      .from(packagePurchaseOrders)
      .where(
        eq(
          packagePurchaseOrders.id,
          targetOrder.order.id,
        ),
      );

    expect(targetOrderRow?.status).toBe("paid");

    const targetLedgerRows = await resource.db
      .select({ id: balanceLedger.id })
      .from(balanceLedger)
      .where(
        eq(
          balanceLedger.purchaseOrderId,
          targetOrder.order.id,
        ),
      );

    expect(targetLedgerRows).toHaveLength(0);
  });


  it("lists only active USDT purchase orders for payment reconciliation with exact frozen expectations", async () => {
    const user = await userRepository.onboard({
      telegramUserId: 9_100_000_000_021n,
      username: "phase3_reconciliation_order",
    });
    const packageId = "f1111111-1111-4111-8111-111111111111";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase3_reconciliation_package",
        count: 10,
        priceUsdtMicros: 17_000_000n,
        enabled: true,
        sortOrder: 150,
      })
      .onConflictDoNothing();

    const created = await purchaseOrderRepository.createOrGet({
      userId: user.id,
      packageId,
      idempotencyKey: "phase3:reconciliation:active",
      payment: {
        packageCodeSnapshot: "phase3_reconciliation_package",
        countSnapshot: 10,
        priceUsdtMicrosSnapshot: 17_000_000n,
        paymentAsset: "USDT",
        paymentToAddressSnapshot:
          "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        paymentTokenContractAddressSnapshot:
          "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        requiredConfirmationsSnapshot: 2,
        quotedAmountAtomic: 17_000_000n,
        quoteExpiresAt: null,
      },
      maxUsdtAttributionOffsetAtomic: 100n,
    });

    if (created.kind === "conflict") {
      throw new Error("Unexpected reconciliation order conflict");
    }

    const rows =
      await paymentReconciliationOrderRepository.listReconcilableUsdtOrders(
        1_000,
      );
    const row = rows.find((item) => item.id === created.order.id);

    expect(row).toMatchObject({
      id: created.order.id,
      status: "waiting_payment",
      expectation: {
        asset: "USDT",
        tokenContractAddress:
          "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        amountAtomic: created.order.expectation.amountAtomic,
        requiredConfirmations: 2,
      },
      quoteExpiresAt: null,
    });
    expect(row?.createdAt).toBeInstanceOf(Date);
  });


  it("returns purchase-order status only to the owning numeric Telegram user", async () => {
    const telegramUserId = 9_100_000_000_022n;
    const user = await userRepository.onboard({
      telegramUserId,
      username: "phase3_status_owner",
    });
    const packageId = "f2222222-2222-4222-8222-222222222222";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "phase3_status_package",
        count: 20,
        priceUsdtMicros: 34_000_000n,
        enabled: true,
        sortOrder: 160,
      })
      .onConflictDoNothing();

    const created = await purchaseOrderRepository.createOrGet({
      userId: user.id,
      packageId,
      idempotencyKey: "phase3:status:owned",
      payment: {
        packageCodeSnapshot: "phase3_status_package",
        countSnapshot: 20,
        priceUsdtMicrosSnapshot: 34_000_000n,
        paymentAsset: "USDT",
        paymentToAddressSnapshot:
          "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
        paymentTokenContractAddressSnapshot:
          "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        requiredConfirmationsSnapshot: 2,
        quotedAmountAtomic: 34_000_000n,
        quoteExpiresAt: null,
      },
      maxUsdtAttributionOffsetAtomic: 100n,
    });

    if (created.kind === "conflict") {
      throw new Error("Unexpected status order conflict");
    }

    await expect(
      purchaseOrderStatusRepository.findOwnedOrder({
        orderId: created.order.id,
        telegramUserId,
      }),
    ).resolves.toMatchObject({
      id: created.order.id,
      status: "waiting_payment",
      availableCount: 0,
      payment: {
        countSnapshot: 20,
        paymentAsset: "USDT",
        quotedAmountAtomic: created.order.expectation.amountAtomic,
      },
    });

    await expect(
      purchaseOrderStatusRepository.findOwnedOrder({
        orderId: created.order.id,
        telegramUserId: telegramUserId + 1n,
      }),
    ).resolves.toBeUndefined();
  });

  it("lists only recent purchase orders owned by the requesting active user", async () => {
    const ownerTelegramUserId = 9_100_000_000_060n;
    const otherTelegramUserId = 9_100_000_000_061n;
    const owner = await userRepository.onboard({
      telegramUserId: ownerTelegramUserId,
      username: "history_owner",
    });
    const other = await userRepository.onboard({
      telegramUserId: otherTelegramUserId,
      username: "history_other",
    });
    const packageId = "f3333333-3333-4333-8333-333333333333";

    await resource.db
      .insert(energyPackages)
      .values({
        id: packageId,
        code: "history_package",
        count: 10,
        priceUsdtMicros: 17_000_000n,
        enabled: true,
        sortOrder: 170,
      })
      .onConflictDoNothing();

    const create = async (
      userId: string,
      key: string,
      destination: string,
    ) =>
      purchaseOrderRepository.createOrGet({
        userId,
        packageId,
        idempotencyKey: key,
        payment: {
          packageCodeSnapshot: "history_package",
          countSnapshot: 10,
          priceUsdtMicrosSnapshot: 17_000_000n,
          paymentAsset: "USDT",
          paymentToAddressSnapshot: destination,
          paymentTokenContractAddressSnapshot:
            "TTEST_HISTORY_USDT_CONTRACT",
          requiredConfirmationsSnapshot: 2,
          quotedAmountAtomic: 17_000_000n,
          quoteExpiresAt: null,
        },
        maxUsdtAttributionOffsetAtomic: 100n,
      });

    const ownerOrder = await create(
      owner.id,
      "history:owner:1",
      "TTEST_HISTORY_OWNER",
    );
    const otherOrder = await create(
      other.id,
      "history:other:1",
      "TTEST_HISTORY_OTHER",
    );

    if (ownerOrder.kind === "conflict" || otherOrder.kind === "conflict") {
      throw new Error("Unexpected history order conflict");
    }

    const listed = await purchaseOrderStatusRepository.listOwnedRecent({
      telegramUserId: ownerTelegramUserId,
      limit: 5,
    });
    expect(listed.kind).toBe("ready");
    if (listed.kind !== "ready") {
      throw new Error("Expected owner purchase-order history");
    }

    expect(listed.orders.map((order) => order.id)).toContain(
      ownerOrder.order.id,
    );
    expect(listed.orders.map((order) => order.id)).not.toContain(
      otherOrder.order.id,
    );

    await resource.db
      .update(users)
      .set({ status: "blocked" })
      .where(eq(users.id, owner.id));

    await expect(
      purchaseOrderStatusRepository.listOwnedRecent({
        telegramUserId: ownerTelegramUserId,
        limit: 5,
      }),
    ).resolves.toEqual({ kind: "denied" });

    await expect(
      purchaseOrderStatusRepository.findOwnedOrder({
        orderId: ownerOrder.order.id,
        telegramUserId: ownerTelegramUserId,
      }),
    ).resolves.toBeUndefined();
  });

});
