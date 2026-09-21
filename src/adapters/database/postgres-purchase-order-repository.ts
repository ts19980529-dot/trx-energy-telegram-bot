import { and, eq } from "drizzle-orm";

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

  return (
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
    row.quotedAmountAtomic === payment.quotedAmountAtomic &&
    sameTimestamp(row.quoteExpiresAt, payment.quoteExpiresAt)
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
      const [inserted] = await tx
        .insert(packagePurchaseOrders)
        .values({
          userId: input.userId,
          packageId: input.packageId,
          idempotencyKey: input.idempotencyKey,
          packageCodeSnapshot:
            input.payment.packageCodeSnapshot,
          countSnapshot: input.payment.countSnapshot,
          priceUsdtMicrosSnapshot:
            input.payment.priceUsdtMicrosSnapshot,
          paymentAsset: input.payment.paymentAsset,
          paymentToAddressSnapshot:
            input.payment.paymentToAddressSnapshot,
          paymentTokenContractAddressSnapshot:
            input.payment.paymentTokenContractAddressSnapshot,
          requiredConfirmationsSnapshot:
            input.payment.requiredConfirmationsSnapshot,
          quotedAmountAtomic: input.payment.quotedAmountAtomic,
          quoteExpiresAt: input.payment.quoteExpiresAt,
          status: "created",
        })
        .onConflictDoNothing({
          target: packagePurchaseOrders.idempotencyKey,
        })
        .returning();

      if (inserted !== undefined) {
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
      }

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

      if (existing === undefined) {
        throw new Error(
          "Idempotency conflict produced no existing purchase order",
        );
      }

      if (!samePayload(existing, input)) {
        return { kind: "conflict" };
      }

      return {
        kind: "existing",
        order: toRecord(existing),
      };
    });
  }
}
