import { and, asc, eq, gte, lte } from "drizzle-orm";

import type {
  PurchaseOrderCustomerRepository,
  PurchaseOrderPersistenceInput,
  PurchaseOrderPersistenceResult,
  PurchaseOrderRecord,
  PurchaseOrderRepository,
} from "../../application/payments/purchase-order-service.js";
import {
  canTransitionPurchaseOrder,
  purchaseOrderStates,
  type PurchaseOrderState,
} from "../../core/orders/state-machine.js";
import {
  paymentExpectationFromOrderSnapshot,
  withUsdtPaymentAttributionOffset,
  type PurchaseOrderPaymentSnapshot,
} from "../../core/payments/purchase-order-payment.js";
import {
  packagePurchaseOrders,
  users,
} from "../../db/schema.js";
import type { AppDatabase } from "./postgres.js";

type PurchaseOrderRow = typeof packagePurchaseOrders.$inferSelect;

function toStatus(value: string): PurchaseOrderState {
  if ((purchaseOrderStates as readonly string[]).includes(value)) {
    return value as PurchaseOrderState;
  }

  throw new Error("Unexpected purchase-order status returned by database");
}

function toPaymentSnapshot(
  row: PurchaseOrderRow,
): PurchaseOrderPaymentSnapshot {
  return {
    packageCodeSnapshot: row.packageCodeSnapshot,
    countSnapshot: row.countSnapshot,
    priceUsdtMicrosSnapshot: row.priceUsdtMicrosSnapshot,
    paymentAttributionOffsetAtomic:
      row.paymentAttributionOffsetAtomic,
    paymentAsset:
      row.paymentAsset === "TRX" ? "TRX" : "USDT",
    paymentToAddressSnapshot: row.paymentToAddressSnapshot,
    paymentTokenContractAddressSnapshot:
      row.paymentTokenContractAddressSnapshot,
    requiredConfirmationsSnapshot:
      row.requiredConfirmationsSnapshot,
    quotedAmountAtomic: row.quotedAmountAtomic,
    quoteExpiresAt: row.quoteExpiresAt,
  };
}

function toRecord(row: PurchaseOrderRow): PurchaseOrderRecord {
  if (row.paymentAsset !== "TRX" && row.paymentAsset !== "USDT") {
    throw new Error(
      "Unexpected purchase-order payment asset returned by database",
    );
  }

  const payment = toPaymentSnapshot(row);
  const expectation = paymentExpectationFromOrderSnapshot(payment);

  if (expectation === undefined) {
    throw new Error(
      "Persisted purchase-order payment snapshot violates invariants",
    );
  }

  return {
    id: row.id,
    userId: row.userId,
    packageId: row.packageId,
    idempotencyKey: row.idempotencyKey,
    status: toStatus(row.status),
    payment,
    expectation,
  };
}

function sameTimestamp(
  left: Date | null,
  right: Date | null,
): boolean {
  if (left === null || right === null) {
    return left === right;
  }

  return left.getTime() === right.getTime();
}

function samePayload(
  row: PurchaseOrderRow,
  input: PurchaseOrderPersistenceInput,
): boolean {
  const payment = input.payment;
  const commonMatches =
    row.userId === input.userId &&
    row.packageId === input.packageId &&
    row.idempotencyKey === input.idempotencyKey &&
    row.packageCodeSnapshot === payment.packageCodeSnapshot &&
    row.countSnapshot === payment.countSnapshot &&
    row.priceUsdtMicrosSnapshot ===
      payment.priceUsdtMicrosSnapshot &&
    row.paymentAsset === payment.paymentAsset &&
    row.paymentToAddressSnapshot ===
      payment.paymentToAddressSnapshot &&
    row.paymentTokenContractAddressSnapshot ===
      payment.paymentTokenContractAddressSnapshot &&
    row.requiredConfirmationsSnapshot ===
      payment.requiredConfirmationsSnapshot &&
    sameTimestamp(row.quoteExpiresAt, payment.quoteExpiresAt);

  if (!commonMatches) {
    return false;
  }

  if (payment.paymentAsset === "USDT") {
    return (
      (payment.paymentAttributionOffsetAtomic ?? 0n) === 0n &&
      payment.quotedAmountAtomic ===
        payment.priceUsdtMicrosSnapshot &&
      paymentExpectationFromOrderSnapshot(
        toPaymentSnapshot(row),
      ) !== undefined
    );
  }

  return (
    row.paymentAttributionOffsetAtomic === 0n &&
    (payment.paymentAttributionOffsetAtomic ?? 0n) === 0n &&
    row.quotedAmountAtomic === payment.quotedAmountAtomic
  );
}

export class PostgresPurchaseOrderCustomerRepository
  implements PurchaseOrderCustomerRepository
{
  constructor(private readonly db: AppDatabase) {}

  async findActiveUserIdByTelegramUserId(
    telegramUserId: bigint,
  ): Promise<string | undefined> {
    const [row] = await this.db
      .select({
        id: users.id,
        status: users.status,
      })
      .from(users)
      .where(eq(users.telegramUserId, telegramUserId))
      .limit(1);

    if (row === undefined || row.status !== "active") {
      return undefined;
    }

    return row.id;
  }
}

export class PostgresPurchaseOrderRepository
  implements PurchaseOrderRepository
{
  constructor(private readonly db: AppDatabase) {}

  createOrGet(
    input: PurchaseOrderPersistenceInput,
  ): Promise<PurchaseOrderPersistenceResult> {
    return this.db.transaction(async (tx) => {
      const findExisting = async () => {
        const [existing] = await tx
          .select()
          .from(packagePurchaseOrders)
          .where(
            eq(
              packagePurchaseOrders.idempotencyKey,
              input.idempotencyKey,
            ),
          )
          .limit(1);

        return existing;
      };

      const existingBeforeInsert = await findExisting();

      if (existingBeforeInsert !== undefined) {
        if (!samePayload(existingBeforeInsert, input)) {
          return { kind: "conflict" as const };
        }

        return {
          kind: "existing" as const,
          order: toRecord(existingBeforeInsert),
        };
      }

      if (
        paymentExpectationFromOrderSnapshot(input.payment) ===
        undefined
      ) {
        throw new Error(
          "Purchase-order persistence received an invalid payment snapshot",
        );
      }

      const insertCandidate = async (
        payment: PurchaseOrderPaymentSnapshot,
      ) => {
        const [inserted] = await tx
          .insert(packagePurchaseOrders)
          .values({
            userId: input.userId,
            packageId: input.packageId,
            idempotencyKey: input.idempotencyKey,
            packageCodeSnapshot:
              payment.packageCodeSnapshot,
            countSnapshot: payment.countSnapshot,
            priceUsdtMicrosSnapshot:
              payment.priceUsdtMicrosSnapshot,
            paymentAttributionOffsetAtomic:
              payment.paymentAttributionOffsetAtomic ?? 0n,
            paymentAsset: payment.paymentAsset,
            paymentToAddressSnapshot:
              payment.paymentToAddressSnapshot,
            paymentTokenContractAddressSnapshot:
              payment.paymentTokenContractAddressSnapshot,
            requiredConfirmationsSnapshot:
              payment.requiredConfirmationsSnapshot,
            quotedAmountAtomic: payment.quotedAmountAtomic,
            quoteExpiresAt: payment.quoteExpiresAt,
            status: "created",
          })
          .onConflictDoNothing()
          .returning();

        return inserted;
      };

      const activateInserted = async (
        inserted: PurchaseOrderRow,
      ): Promise<PurchaseOrderPersistenceResult> => {
        if (
          !canTransitionPurchaseOrder(
            "created",
            "waiting_payment",
          )
        ) {
          throw new Error(
            "Purchase-order state machine forbids initial transition",
          );
        }

        const [waiting] = await tx
          .update(packagePurchaseOrders)
          .set({
            status: "waiting_payment",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(packagePurchaseOrders.id, inserted.id),
              eq(packagePurchaseOrders.status, "created"),
            ),
          )
          .returning();

        if (waiting === undefined) {
          throw new Error(
            "Purchase order failed to enter waiting_payment",
          );
        }

        return {
          kind: "created",
          order: toRecord(waiting),
        };
      };

      if (input.payment.paymentAsset === "TRX") {
        const inserted = await insertCandidate(input.payment);

        if (inserted !== undefined) {
          return activateInserted(inserted);
        }

        const existing = await findExisting();

        if (existing === undefined) {
          throw new Error(
            "Purchase-order insert conflicted without an idempotent row",
          );
        }

        if (!samePayload(existing, input)) {
          return { kind: "conflict" };
        }

        return {
          kind: "existing",
          order: toRecord(existing),
        };
      }

      if (
        (input.payment.paymentAttributionOffsetAtomic ?? 0n) !== 0n ||
        input.payment.quotedAmountAtomic !==
          input.payment.priceUsdtMicrosSnapshot
      ) {
        throw new Error(
          "USDT persistence input must contain the canonical unattributed quote",
        );
      }

      const maxOffset =
        input.maxUsdtAttributionOffsetAtomic ?? 0n;

      if (maxOffset < 0n) {
        throw new Error(
          "USDT attribution max offset must be non-negative",
        );
      }

      const tokenContract =
        input.payment.paymentTokenContractAddressSnapshot;

      if (tokenContract === null) {
        throw new Error(
          "USDT persistence input requires a token contract",
        );
      }

      const baseAmount =
        input.payment.priceUsdtMicrosSnapshot;
      const maximumAmount = baseAmount + maxOffset;

      while (true) {
        const usedAmounts = await tx
          .select({
            amount: packagePurchaseOrders.quotedAmountAtomic,
          })
          .from(packagePurchaseOrders)
          .where(
            and(
              eq(packagePurchaseOrders.paymentAsset, "USDT"),
              eq(
                packagePurchaseOrders.paymentTokenContractAddressSnapshot,
                tokenContract,
              ),
              eq(
                packagePurchaseOrders.paymentToAddressSnapshot,
                input.payment.paymentToAddressSnapshot,
              ),
              gte(
                packagePurchaseOrders.quotedAmountAtomic,
                baseAmount,
              ),
              lte(
                packagePurchaseOrders.quotedAmountAtomic,
                maximumAmount,
              ),
            ),
          )
          .orderBy(
            asc(packagePurchaseOrders.quotedAmountAtomic),
          );

        let candidateAmount = baseAmount;

        for (const row of usedAmounts) {
          if (row.amount < candidateAmount) {
            continue;
          }

          if (row.amount === candidateAmount) {
            candidateAmount += 1n;
            continue;
          }

          break;
        }

        if (candidateAmount > maximumAmount) {
          return { kind: "attribution_unavailable" };
        }

        const attributed =
          withUsdtPaymentAttributionOffset(
            input.payment,
            candidateAmount - baseAmount,
          );

        if (attributed === undefined) {
          throw new Error(
            "Failed to build a valid attributed USDT payment snapshot",
          );
        }

        const inserted = await insertCandidate(attributed);

        if (inserted !== undefined) {
          return activateInserted(inserted);
        }

        const existing = await findExisting();

        if (existing !== undefined) {
          if (!samePayload(existing, input)) {
            return { kind: "conflict" };
          }

          return {
            kind: "existing",
            order: toRecord(existing),
          };
        }
      }
    });
  }
}
