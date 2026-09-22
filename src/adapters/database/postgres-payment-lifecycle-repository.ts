import { and, eq } from "drizzle-orm";

import {
  paymentTransactionLifecycleStates,
  planPaymentEvidenceLifecycle,
  type PaymentTransactionLifecycleState,
} from "../../core/payments/payment-evidence-lifecycle.js";
import {
  evaluatePaymentObservation,
  type PaymentObservation,
} from "../../core/payments/payment-observation.js";
import {
  paymentExpectationFromOrderSnapshot,
  type PurchaseOrderPaymentSnapshot,
} from "../../core/payments/purchase-order-payment.js";
import {
  purchaseOrderStates,
  type PurchaseOrderState,
} from "../../core/orders/state-machine.js";
import {
  packagePurchaseOrders,
  paymentTransactions,
} from "../../db/schema.js";
import type { AppDatabase } from "./postgres.js";

type PurchaseOrderRow = typeof packagePurchaseOrders.$inferSelect;
type PaymentTransactionRow = typeof paymentTransactions.$inferSelect;

export type PaymentLifecyclePersistenceResult =
  | {
      readonly kind: "applied";
      readonly paymentTransactionId: string;
      readonly transactionStatus: PaymentTransactionLifecycleState;
      readonly orderStatus: PurchaseOrderState;
    }
  | {
      readonly kind: "ignored";
      readonly reason:
        | "invalid_evidence"
        | "reconciliation_mismatch";
    }
  | {
      readonly kind: "terminal_noop";
      readonly orderStatus:
        | "paid"
        | "credited"
        | "expired"
        | "failed";
    }
  | {
      readonly kind: "order_not_found";
    }
  | {
      readonly kind: "conflict";
      readonly reason:
        | "invalid_order_state"
        | "transaction_terminal_conflict"
        | "order_terminal_conflict"
        | "persisted_order_invalid"
        | "persisted_payment_invalid"
        | "payment_identity_conflict"
        | "payment_evidence_conflict"
        | "database_unique_conflict";
    };

function purchaseOrderStatus(
  value: string,
): PurchaseOrderState | undefined {
  return (purchaseOrderStates as readonly string[]).includes(value)
    ? (value as PurchaseOrderState)
    : undefined;
}

function paymentTransactionStatus(
  value: string,
): PaymentTransactionLifecycleState | undefined {
  return (
    paymentTransactionLifecycleStates as readonly string[]
  ).includes(value)
    ? (value as PaymentTransactionLifecycleState)
    : undefined;
}

function paymentSnapshot(
  row: PurchaseOrderRow,
): PurchaseOrderPaymentSnapshot | undefined {
  if (row.paymentAsset !== "TRX" && row.paymentAsset !== "USDT") {
    return undefined;
  }

  return {
    packageCodeSnapshot: row.packageCodeSnapshot,
    countSnapshot: row.countSnapshot,
    priceUsdtMicrosSnapshot: row.priceUsdtMicrosSnapshot,
    paymentAttributionOffsetAtomic:
      row.paymentAttributionOffsetAtomic,
    paymentAsset: row.paymentAsset,
    paymentToAddressSnapshot: row.paymentToAddressSnapshot,
    paymentTokenContractAddressSnapshot:
      row.paymentTokenContractAddressSnapshot,
    requiredConfirmationsSnapshot:
      row.requiredConfirmationsSnapshot,
    quotedAmountAtomic: row.quotedAmountAtomic,
    quoteExpiresAt: row.quoteExpiresAt,
  };
}

function identityWhere(observation: PaymentObservation) {
  if (observation.asset === "TRX") {
    return and(
      eq(paymentTransactions.asset, "TRX"),
      eq(paymentTransactions.txid, observation.txid),
    );
  }

  return and(
    eq(paymentTransactions.asset, "USDT"),
    eq(
      paymentTransactions.tokenContractAddress,
      observation.tokenContractAddress,
    ),
    eq(paymentTransactions.txid, observation.txid),
    eq(paymentTransactions.eventIndex, observation.eventIndex),
  );
}

function sameOptionalBigint(
  stored: bigint | null,
  observed: bigint | undefined,
): boolean {
  return (
    observed === undefined ||
    stored === null ||
    stored === observed
  );
}

function sameOptionalTimestamp(
  stored: Date | null,
  observed: Date | undefined,
): boolean {
  return (
    observed === undefined ||
    stored === null ||
    stored.getTime() === observed.getTime()
  );
}

function sameEvidence(
  row: PaymentTransactionRow,
  observation: PaymentObservation,
): boolean {
  return (
    row.asset === observation.asset &&
    row.txid === observation.txid &&
    row.tokenContractAddress ===
      observation.tokenContractAddress &&
    row.eventIndex === observation.eventIndex &&
    row.fromAddress === observation.fromAddress &&
    row.toAddress === observation.toAddress &&
    row.amountAtomic === observation.amountAtomic &&
    sameOptionalBigint(
      row.blockNumber,
      observation.blockNumber,
    ) &&
    sameOptionalTimestamp(
      row.blockTimestamp,
      observation.blockTimestamp,
    )
  );
}

function validObservationMetadata(
  observation: PaymentObservation,
): boolean {
  return (
    (observation.blockNumber === undefined ||
      observation.blockNumber >= 0n) &&
    (observation.blockTimestamp === undefined ||
      !Number.isNaN(observation.blockTimestamp.getTime()))
  );
}

function mergedBlockNumber(
  row: PaymentTransactionRow,
  observation: PaymentObservation,
): bigint | null {
  return row.blockNumber ?? observation.blockNumber ?? null;
}

function mergedBlockTimestamp(
  row: PaymentTransactionRow,
  observation: PaymentObservation,
): Date | null {
  return row.blockTimestamp ?? observation.blockTimestamp ?? null;
}

export class PostgresPaymentLifecycleRepository {
  constructor(private readonly db: AppDatabase) {}

  applyObservation(input: {
    readonly purchaseOrderId: string;
    readonly observation: PaymentObservation;
  }): Promise<PaymentLifecyclePersistenceResult> {
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(packagePurchaseOrders)
        .where(eq(packagePurchaseOrders.id, input.purchaseOrderId))
        .limit(1)
        .for("update");

      if (order === undefined) {
        return { kind: "order_not_found" };
      }

      const orderStatus = purchaseOrderStatus(order.status);
      const snapshot = paymentSnapshot(order);
      const expectation =
        snapshot === undefined
          ? undefined
          : paymentExpectationFromOrderSnapshot(snapshot);

      if (orderStatus === undefined || expectation === undefined) {
        return {
          kind: "conflict",
          reason: "persisted_order_invalid",
        };
      }

      if (!validObservationMetadata(input.observation)) {
        return {
          kind: "ignored",
          reason: "invalid_evidence",
        };
      }

      let [payment] = await tx
        .select()
        .from(paymentTransactions)
        .where(identityWhere(input.observation))
        .limit(1)
        .for("update");

      const validateExisting = (
        row: PaymentTransactionRow,
      ): PaymentLifecyclePersistenceResult | undefined => {
        if (
          row.purchaseOrderId !== null &&
          row.purchaseOrderId !== order.id
        ) {
          return {
            kind: "conflict",
            reason: "payment_identity_conflict",
          };
        }

        if (!sameEvidence(row, input.observation)) {
          return {
            kind: "conflict",
            reason: "payment_evidence_conflict",
          };
        }

        if (paymentTransactionStatus(row.status) === undefined) {
          return {
            kind: "conflict",
            reason: "persisted_payment_invalid",
          };
        }

        return undefined;
      };

      if (payment !== undefined) {
        const existingConflict = validateExisting(payment);

        if (existingConflict !== undefined) {
          return existingConflict;
        }
      }

      const evaluation = evaluatePaymentObservation(
        expectation,
        input.observation,
      );

      const currentTransactionStatus =
        payment === undefined
          ? undefined
          : paymentTransactionStatus(payment.status);

      const plan = planPaymentEvidenceLifecycle({
        evaluation,
        orderState: orderStatus,
        ...(currentTransactionStatus === undefined
          ? {}
          : { currentTransactionStatus }),
      });

      if (plan.kind === "ignore") {
        return {
          kind: "ignored",
          reason: plan.reason,
        };
      }

      if (plan.kind === "terminal_noop") {
        return {
          kind: "terminal_noop",
          orderStatus: plan.orderState,
        };
      }

      if (plan.kind === "invalid_order_state") {
        return {
          kind: "conflict",
          reason: "invalid_order_state",
        };
      }

      if (plan.kind === "state_conflict") {
        return {
          kind: "conflict",
          reason: plan.reason,
        };
      }

      const now = new Date();

      if (payment === undefined) {
        const [inserted] = await tx
          .insert(paymentTransactions)
          .values({
            purchaseOrderId: order.id,
            txid: input.observation.txid,
            asset: input.observation.asset,
            tokenContractAddress:
              input.observation.tokenContractAddress,
            eventIndex: input.observation.eventIndex,
            fromAddress: input.observation.fromAddress,
            toAddress: input.observation.toAddress,
            amountAtomic: input.observation.amountAtomic,
            blockNumber:
              input.observation.blockNumber ?? null,
            blockTimestamp:
              input.observation.blockTimestamp ?? null,
            confirmations: input.observation.confirmations,
            status: plan.transactionStatus,
            confirmedAt:
              plan.transactionStatus === "confirmed"
                ? now
                : null,
            updatedAt: now,
          })
          .onConflictDoNothing()
          .returning();

        if (inserted !== undefined) {
          payment = inserted;
        } else {
          [payment] = await tx
            .select()
            .from(paymentTransactions)
            .where(identityWhere(input.observation))
            .limit(1)
            .for("update");

          if (payment === undefined) {
            return {
              kind: "conflict",
              reason: "database_unique_conflict",
            };
          }

          const concurrentConflict = validateExisting(payment);

          if (concurrentConflict !== undefined) {
            return concurrentConflict;
          }

          const concurrentStatus =
            paymentTransactionStatus(payment.status);

          if (concurrentStatus === undefined) {
            return {
              kind: "conflict",
              reason: "persisted_payment_invalid",
            };
          }

          const concurrentPlan = planPaymentEvidenceLifecycle({
            evaluation,
            orderState: orderStatus,
            currentTransactionStatus: concurrentStatus,
          });

          if (concurrentPlan.kind === "ignore") {
            return {
              kind: "ignored",
              reason: concurrentPlan.reason,
            };
          }

          if (concurrentPlan.kind === "terminal_noop") {
            return {
              kind: "terminal_noop",
              orderStatus: concurrentPlan.orderState,
            };
          }

          if (concurrentPlan.kind === "invalid_order_state") {
            return {
              kind: "conflict",
              reason: "invalid_order_state",
            };
          }

          if (concurrentPlan.kind === "state_conflict") {
            return {
              kind: "conflict",
              reason: concurrentPlan.reason,
            };
          }

          return this.applyLockedPlan({
            tx,
            order,
            orderStatus,
            payment,
            observation: input.observation,
            transactionStatus:
              concurrentPlan.transactionStatus,
            orderTransitions:
              concurrentPlan.orderTransitions,
            now,
          });
        }
      }

      return this.applyLockedPlan({
        tx,
        order,
        orderStatus,
        payment,
        observation: input.observation,
        transactionStatus: plan.transactionStatus,
        orderTransitions: plan.orderTransitions,
        now,
      });
    });
  }

  private async applyLockedPlan(input: {
    readonly tx: Parameters<
      Parameters<AppDatabase["transaction"]>[0]
    >[0];
    readonly order: PurchaseOrderRow;
    readonly orderStatus: PurchaseOrderState;
    readonly payment: PaymentTransactionRow;
    readonly observation: PaymentObservation;
    readonly transactionStatus: PaymentTransactionLifecycleState;
    readonly orderTransitions: readonly PurchaseOrderState[];
    readonly now: Date;
  }): Promise<PaymentLifecyclePersistenceResult> {
    const [updatedPayment] = await input.tx
      .update(paymentTransactions)
      .set({
        purchaseOrderId: input.order.id,
        blockNumber: mergedBlockNumber(
          input.payment,
          input.observation,
        ),
        blockTimestamp: mergedBlockTimestamp(
          input.payment,
          input.observation,
        ),
        confirmations: Math.max(
          input.payment.confirmations,
          input.observation.confirmations,
        ),
        status: input.transactionStatus,
        confirmedAt:
          input.transactionStatus === "confirmed"
            ? input.payment.confirmedAt ?? input.now
            : input.payment.confirmedAt,
        updatedAt: input.now,
      })
      .where(eq(paymentTransactions.id, input.payment.id))
      .returning({
        id: paymentTransactions.id,
        status: paymentTransactions.status,
      });

    if (updatedPayment === undefined) {
      throw new Error(
        "Locked payment transaction disappeared during update",
      );
    }

    let currentOrderStatus = input.orderStatus;

    for (const nextStatus of input.orderTransitions) {
      const [updatedOrder] = await input.tx
        .update(packagePurchaseOrders)
        .set({
          status: nextStatus,
          updatedAt: input.now,
        })
        .where(
          and(
            eq(packagePurchaseOrders.id, input.order.id),
            eq(
              packagePurchaseOrders.status,
              currentOrderStatus,
            ),
          ),
        )
        .returning({
          status: packagePurchaseOrders.status,
        });

      if (updatedOrder === undefined) {
        throw new Error(
          "Locked purchase order failed lifecycle transition",
        );
      }

      currentOrderStatus = nextStatus;
    }

    return {
      kind: "applied",
      paymentTransactionId: updatedPayment.id,
      transactionStatus: input.transactionStatus,
      orderStatus: currentOrderStatus,
    };
  }
}
