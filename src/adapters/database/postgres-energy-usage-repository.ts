import { randomUUID } from "node:crypto";

import { and, asc, eq, inArray, sql } from "drizzle-orm";

import type {
  EnergyConsumptionSnapshot,
  EnergyDeliverySnapshot,
  EnergyPreparationResult,
  EnergyReservationResult,
  EnergyUsageRepository,
  ProviderDeliveryStatus,
} from "../../application/energy/energy-usage-service.js";
import { canTransitionEnergyConsumption } from "../../core/orders/state-machine.js";
import {
  balanceLedger,
  energyConsumptionOrders,
  energyOptions,
  packageBalances,
  providerDeliveries,
  users,
} from "../../db/schema.js";
import type { AppDatabase } from "./postgres.js";

type EnergyOrderRow = typeof energyConsumptionOrders.$inferSelect;
type ProviderDeliveryRow = typeof providerDeliveries.$inferSelect;
type BalanceRow = typeof packageBalances.$inferSelect;

function reserveLedgerKey(orderId: string): string {
  return `energy-reserve:${orderId}`;
}

function consumeLedgerKey(orderId: string): string {
  return `energy-consume:${orderId}`;
}

function releaseLedgerKey(orderId: string): string {
  return `energy-release:${orderId}`;
}

function deliveryKey(orderId: string): string {
  return `energy-delivery:${orderId}`;
}

function toDeliverySnapshot(
  row: ProviderDeliveryRow | undefined,
): EnergyDeliverySnapshot | null {
  if (row === undefined) {
    return null;
  }

  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    providerName: row.providerName,
    providerOrderId: row.providerOrderId,
    status: row.status as ProviderDeliveryStatus,
  };
}

function toOrderSnapshot(input: {
  readonly order: EnergyOrderRow;
  readonly balance: BalanceRow;
  readonly delivery?: ProviderDeliveryRow | undefined;
}): EnergyConsumptionSnapshot {
  return {
    id: input.order.id,
    userId: input.order.userId,
    optionCode: input.order.optionCodeSnapshot,
    recipientAddress: input.order.recipientAddress,
    energyAmount: input.order.energyAmount,
    countCost: input.order.countCost,
    status: input.order.status as EnergyConsumptionSnapshot["status"],
    availableCount: input.balance.availableCount,
    reservedCount: input.balance.reservedCount,
    delivery: toDeliverySnapshot(input.delivery),
  };
}

function mergeProviderDeliveryStatus(
  current: ProviderDeliveryStatus,
  incoming: Exclude<ProviderDeliveryStatus, "pending" | "completed" | "failed">,
): Exclude<ProviderDeliveryStatus, "completed" | "failed"> {
  if (current === "completed" || current === "failed") {
    throw new Error("Terminal provider delivery cannot regress");
  }

  if (current === "processing") {
    return "processing";
  }

  if (current === "accepted" && incoming === "unknown") {
    return "accepted";
  }

  return incoming;
}

function reservationMatches(input: {
  readonly order: EnergyOrderRow;
  readonly userId: string;
  readonly optionCode: string;
  readonly recipientAddress: string;
}): boolean {
  return (
    input.order.userId === input.userId &&
    input.order.optionCodeSnapshot === input.optionCode &&
    input.order.recipientAddress === input.recipientAddress
  );
}

export class PostgresEnergyUsageRepository implements EnergyUsageRepository {
  constructor(private readonly db: AppDatabase) {}

  async listPending(limit: number): Promise<readonly {
    telegramUserId: bigint;
    optionCode: string;
    recipientAddress: string;
    idempotencyKey: string;
  }[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Energy pending scan limit must be between 1 and 100");
    }
    const rows = await this.db.select({
      telegramUserId: users.telegramUserId,
      optionCode: energyConsumptionOrders.optionCodeSnapshot,
      recipientAddress: energyConsumptionOrders.recipientAddress,
      idempotencyKey: energyConsumptionOrders.idempotencyKey,
    }).from(energyConsumptionOrders)
      .innerJoin(users, eq(users.id, energyConsumptionOrders.userId))
      .where(inArray(energyConsumptionOrders.status, ["reserved", "dispatching"]))
      .orderBy(asc(energyConsumptionOrders.updatedAt))
      .limit(limit);
    return rows;
  }

  async prepare(telegramUserId: bigint): Promise<EnergyPreparationResult> {
    const [user] = await this.db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId))
      .limit(1);

    if (user === undefined || user.status === "blocked") {
      return { kind: "denied" };
    }

    const [balance] = await this.db
      .select()
      .from(packageBalances)
      .where(eq(packageBalances.userId, user.id))
      .limit(1);

    if (balance === undefined) {
      throw new Error("Active Energy customer is missing package balance");
    }

    const options = await this.db
      .select({
        id: energyOptions.id,
        code: energyOptions.code,
        energyAmount: energyOptions.energyAmount,
        countCost: energyOptions.countCost,
      })
      .from(energyOptions)
      .where(eq(energyOptions.enabled, true))
      .orderBy(asc(energyOptions.sortOrder), asc(energyOptions.energyAmount));

    return {
      kind: "ready",
      availableCount: balance.availableCount,
      reservedCount: balance.reservedCount,
      options,
    };
  }

  reserve(input: {
    readonly telegramUserId: bigint;
    readonly optionCode: string;
    readonly recipientAddress: string;
    readonly idempotencyKey: string;
  }): Promise<EnergyReservationResult> {
    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(
          hashtext('energy-reservation'),
          hashtext(${input.idempotencyKey})
        )`,
      );

      const [existing] = await tx
        .select()
        .from(energyConsumptionOrders)
        .where(eq(energyConsumptionOrders.idempotencyKey, input.idempotencyKey))
        .limit(1)
        .for("update");

      if (existing !== undefined) {
        const [user] = await tx
          .select({ id: users.id, status: users.status })
          .from(users)
          .where(eq(users.telegramUserId, input.telegramUserId))
          .limit(1)
          .for("update");

        if (user === undefined || user.status === "blocked") {
          return { kind: "denied" };
        }

        if (
          !reservationMatches({
            order: existing,
            userId: user.id,
            optionCode: input.optionCode,
            recipientAddress: input.recipientAddress,
          })
        ) {
          return { kind: "conflict" };
        }

        const [balance] = await tx
          .select()
          .from(packageBalances)
          .where(eq(packageBalances.userId, user.id))
          .limit(1)
          .for("update");

        if (balance === undefined) {
          throw new Error("Active Energy customer is missing package balance");
        }

        const [delivery] = await tx
          .select()
          .from(providerDeliveries)
          .where(
            eq(providerDeliveries.energyConsumptionOrderId, existing.id),
          )
          .limit(1);

        return {
          kind: "ready",
          created: false,
          order: toOrderSnapshot({ order: existing, balance, delivery }),
        };
      }

      const [user] = await tx
        .select({ id: users.id, status: users.status })
        .from(users)
        .where(eq(users.telegramUserId, input.telegramUserId))
        .limit(1)
        .for("update");

      if (user === undefined || user.status === "blocked") {
        return { kind: "denied" };
      }

      const [balance] = await tx
        .select()
        .from(packageBalances)
        .where(eq(packageBalances.userId, user.id))
        .limit(1)
        .for("update");

      if (balance === undefined) {
        throw new Error("Active Energy customer is missing package balance");
      }

      const [option] = await tx
        .select()
        .from(energyOptions)
        .where(
          and(
            eq(energyOptions.code, input.optionCode),
            eq(energyOptions.enabled, true),
          ),
        )
        .limit(1);

      if (option === undefined) {
        return { kind: "option_unavailable" };
      }

      if (balance.availableCount < option.countCost) {
        return {
          kind: "insufficient_balance",
          availableCount: balance.availableCount,
          requiredCount: option.countCost,
        };
      }

      const now = new Date();
      const [updatedBalance] = await tx
        .update(packageBalances)
        .set({
          availableCount: sql<number>`${packageBalances.availableCount} - ${option.countCost}`,
          reservedCount: sql<number>`${packageBalances.reservedCount} + ${option.countCost}`,
          updatedAt: now,
        })
        .where(
          and(
            eq(packageBalances.userId, user.id),
            sql`${packageBalances.availableCount} >= ${option.countCost}`,
          ),
        )
        .returning();

      if (updatedBalance === undefined) {
        return {
          kind: "insufficient_balance",
          availableCount: balance.availableCount,
          requiredCount: option.countCost,
        };
      }

      const orderId = randomUUID();
      const [created] = await tx
        .insert(energyConsumptionOrders)
        .values({
          id: orderId,
          userId: user.id,
          energyOptionId: option.id,
          idempotencyKey: input.idempotencyKey,
          optionCodeSnapshot: option.code,
          recipientAddress: input.recipientAddress,
          energyAmount: option.energyAmount,
          countCost: option.countCost,
          status: "created",
        })
        .returning();

      if (created === undefined) {
        throw new Error("Energy consumption order insert returned no row");
      }

      await tx.insert(balanceLedger).values({
        userId: user.id,
        energyConsumptionOrderId: orderId,
        idempotencyKey: reserveLedgerKey(orderId),
        reason: "energy_reserve",
        availableDelta: -option.countCost,
        reservedDelta: option.countCost,
      });

      if (!canTransitionEnergyConsumption("created", "reserved")) {
        throw new Error("Energy created-to-reserved transition is disabled");
      }

      const [reserved] = await tx
        .update(energyConsumptionOrders)
        .set({ status: "reserved", updatedAt: now })
        .where(
          and(
            eq(energyConsumptionOrders.id, orderId),
            eq(energyConsumptionOrders.status, "created"),
          ),
        )
        .returning();

      if (reserved === undefined) {
        throw new Error("Energy order failed created-to-reserved transition");
      }

      return {
        kind: "ready",
        created: true,
        order: toOrderSnapshot({ order: reserved, balance: updatedBalance }),
      };
    });
  }

  startDispatch(input: {
    readonly orderId: string;
    readonly providerName: string;
  }): Promise<{
    readonly created: boolean;
    readonly order: EnergyConsumptionSnapshot;
  }> {
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(energyConsumptionOrders)
        .where(eq(energyConsumptionOrders.id, input.orderId))
        .limit(1)
        .for("update");

      if (order === undefined) {
        throw new Error("Energy order disappeared before dispatch");
      }

      const [balance] = await tx
        .select()
        .from(packageBalances)
        .where(eq(packageBalances.userId, order.userId))
        .limit(1)
        .for("update");

      if (balance === undefined) {
        throw new Error("Energy order customer balance is missing");
      }

      const [existingDelivery] = await tx
        .select()
        .from(providerDeliveries)
        .where(eq(providerDeliveries.energyConsumptionOrderId, order.id))
        .limit(1)
        .for("update");

      if (order.status !== "reserved") {
        if (existingDelivery === undefined) {
          throw new Error("Non-reserved Energy order is missing provider delivery");
        }

        if (existingDelivery.providerName !== input.providerName) {
          throw new Error("Energy provider changed for an existing order");
        }

        return {
          created: false,
          order: toOrderSnapshot({
            order,
            balance,
            delivery: existingDelivery,
          }),
        };
      }

      if (existingDelivery !== undefined) {
        throw new Error("Reserved Energy order already has provider delivery");
      }

      if (!canTransitionEnergyConsumption("reserved", "dispatching")) {
        throw new Error("Energy reserved-to-dispatching transition is disabled");
      }

      const [delivery] = await tx
        .insert(providerDeliveries)
        .values({
          energyConsumptionOrderId: order.id,
          idempotencyKey: deliveryKey(order.id),
          providerName: input.providerName,
          status: "pending",
        })
        .returning();

      if (delivery === undefined) {
        throw new Error("Provider delivery insert returned no row");
      }

      const [dispatching] = await tx
        .update(energyConsumptionOrders)
        .set({ status: "dispatching", updatedAt: new Date() })
        .where(
          and(
            eq(energyConsumptionOrders.id, order.id),
            eq(energyConsumptionOrders.status, "reserved"),
          ),
        )
        .returning();

      if (dispatching === undefined) {
        throw new Error("Energy order failed reserved-to-dispatching transition");
      }

      return {
        created: true,
        order: toOrderSnapshot({
          order: dispatching,
          balance,
          delivery,
        }),
      };
    });
  }

  applyDelivery(input: {
    readonly orderId: string;
    readonly providerName: string;
    readonly deliveryIdempotencyKey: string;
    readonly providerOrderId: string | null;
    readonly status: Exclude<ProviderDeliveryStatus, "pending">;
  }): Promise<EnergyConsumptionSnapshot> {
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(energyConsumptionOrders)
        .where(eq(energyConsumptionOrders.id, input.orderId))
        .limit(1)
        .for("update");

      if (order === undefined) {
        throw new Error("Energy order disappeared while applying delivery");
      }

      const [delivery] = await tx
        .select()
        .from(providerDeliveries)
        .where(eq(providerDeliveries.energyConsumptionOrderId, order.id))
        .limit(1)
        .for("update");

      if (
        delivery === undefined ||
        delivery.providerName !== input.providerName ||
        delivery.idempotencyKey !== input.deliveryIdempotencyKey
      ) {
        throw new Error("Energy provider delivery identity mismatch");
      }

      if (
        delivery.providerOrderId !== null &&
        input.providerOrderId !== null &&
        delivery.providerOrderId !== input.providerOrderId
      ) {
        throw new Error("Energy provider order identity changed");
      }

      const providerOrderId = delivery.providerOrderId ?? input.providerOrderId;

      const [balance] = await tx
        .select()
        .from(packageBalances)
        .where(eq(packageBalances.userId, order.userId))
        .limit(1)
        .for("update");

      if (balance === undefined) {
        throw new Error("Energy order customer balance is missing");
      }

      if (input.status === "completed") {
        if (order.status === "completed") {
          return toOrderSnapshot({ order, balance, delivery });
        }

        if (order.status !== "dispatching") {
          throw new Error("Completed provider result conflicts with Energy order state");
        }

        if (!canTransitionEnergyConsumption("dispatching", "completed")) {
          throw new Error("Energy dispatching-to-completed transition is disabled");
        }

        const [updatedBalance] = await tx
          .update(packageBalances)
          .set({
            reservedCount: sql<number>`${packageBalances.reservedCount} - ${order.countCost}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(packageBalances.userId, order.userId),
              sql`${packageBalances.reservedCount} >= ${order.countCost}`,
            ),
          )
          .returning();

        if (updatedBalance === undefined) {
          throw new Error("Reserved Energy count is missing during consume");
        }

        await tx.insert(balanceLedger).values({
          userId: order.userId,
          energyConsumptionOrderId: order.id,
          idempotencyKey: consumeLedgerKey(order.id),
          reason: "energy_consume",
          availableDelta: 0,
          reservedDelta: -order.countCost,
        });

        const [updatedDelivery] = await tx
          .update(providerDeliveries)
          .set({
            providerOrderId,
            status: "completed",
            updatedAt: new Date(),
          })
          .where(eq(providerDeliveries.id, delivery.id))
          .returning();

        const [completed] = await tx
          .update(energyConsumptionOrders)
          .set({ status: "completed", updatedAt: new Date() })
          .where(
            and(
              eq(energyConsumptionOrders.id, order.id),
              eq(energyConsumptionOrders.status, "dispatching"),
            ),
          )
          .returning();

        if (updatedDelivery === undefined || completed === undefined) {
          throw new Error("Energy completion persistence failed");
        }

        return toOrderSnapshot({
          order: completed,
          balance: updatedBalance,
          delivery: updatedDelivery,
        });
      }

      if (input.status === "failed") {
        if (order.status === "released") {
          return toOrderSnapshot({ order, balance, delivery });
        }

        if (order.status !== "dispatching" && order.status !== "delivery_failed") {
          throw new Error("Failed provider result conflicts with Energy order state");
        }

        const [updatedDelivery] = await tx
          .update(providerDeliveries)
          .set({
            providerOrderId,
            status: "failed",
            updatedAt: new Date(),
          })
          .where(eq(providerDeliveries.id, delivery.id))
          .returning();

        let failedOrder = order;
        if (order.status === "dispatching") {
          if (!canTransitionEnergyConsumption("dispatching", "delivery_failed")) {
            throw new Error("Energy dispatching-to-failed transition is disabled");
          }

          const [failed] = await tx
            .update(energyConsumptionOrders)
            .set({ status: "delivery_failed", updatedAt: new Date() })
            .where(
              and(
                eq(energyConsumptionOrders.id, order.id),
                eq(energyConsumptionOrders.status, "dispatching"),
              ),
            )
            .returning();

          if (failed === undefined) {
            throw new Error("Energy delivery_failed transition failed");
          }
          failedOrder = failed;
        }

        if (!canTransitionEnergyConsumption("delivery_failed", "released")) {
          throw new Error("Energy failed-to-released transition is disabled");
        }

        const [updatedBalance] = await tx
          .update(packageBalances)
          .set({
            availableCount: sql<number>`${packageBalances.availableCount} + ${failedOrder.countCost}`,
            reservedCount: sql<number>`${packageBalances.reservedCount} - ${failedOrder.countCost}`,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(packageBalances.userId, failedOrder.userId),
              sql`${packageBalances.reservedCount} >= ${failedOrder.countCost}`,
            ),
          )
          .returning();

        if (updatedBalance === undefined) {
          throw new Error("Reserved Energy count is missing during release");
        }

        await tx.insert(balanceLedger).values({
          userId: failedOrder.userId,
          energyConsumptionOrderId: failedOrder.id,
          idempotencyKey: releaseLedgerKey(failedOrder.id),
          reason: "energy_release",
          availableDelta: failedOrder.countCost,
          reservedDelta: -failedOrder.countCost,
        });

        const [released] = await tx
          .update(energyConsumptionOrders)
          .set({ status: "released", updatedAt: new Date() })
          .where(
            and(
              eq(energyConsumptionOrders.id, failedOrder.id),
              eq(energyConsumptionOrders.status, "delivery_failed"),
            ),
          )
          .returning();

        if (updatedDelivery === undefined || released === undefined) {
          throw new Error("Energy release persistence failed");
        }

        return toOrderSnapshot({
          order: released,
          balance: updatedBalance,
          delivery: updatedDelivery,
        });
      }

      if (order.status !== "dispatching") {
        return toOrderSnapshot({ order, balance, delivery });
      }

      const nextStatus = mergeProviderDeliveryStatus(
        delivery.status as ProviderDeliveryStatus,
        input.status,
      );

      const [updatedDelivery] = await tx
        .update(providerDeliveries)
        .set({
          providerOrderId,
          status: nextStatus,
          updatedAt: new Date(),
        })
        .where(eq(providerDeliveries.id, delivery.id))
        .returning();

      if (updatedDelivery === undefined) {
        throw new Error("Provider delivery status update returned no row");
      }

      return toOrderSnapshot({
        order,
        balance,
        delivery: updatedDelivery,
      });
    });
  }

  getOwned(input: {
    readonly orderId: string;
    readonly telegramUserId: bigint;
  }): Promise<EnergyConsumptionSnapshot | undefined> {
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select({
          order: energyConsumptionOrders,
        })
        .from(energyConsumptionOrders)
        .innerJoin(users, eq(users.id, energyConsumptionOrders.userId))
        .where(
          and(
            eq(energyConsumptionOrders.id, input.orderId),
            eq(users.telegramUserId, input.telegramUserId),
          ),
        )
        .limit(1);

      if (order === undefined) {
        return undefined;
      }

      const [balance] = await tx
        .select()
        .from(packageBalances)
        .where(eq(packageBalances.userId, order.order.userId))
        .limit(1);

      if (balance === undefined) {
        throw new Error("Energy order customer balance is missing");
      }

      const [delivery] = await tx
        .select()
        .from(providerDeliveries)
        .where(
          eq(providerDeliveries.energyConsumptionOrderId, order.order.id),
        )
        .limit(1);

      return toOrderSnapshot({ order: order.order, balance, delivery });
    });
  }
}
