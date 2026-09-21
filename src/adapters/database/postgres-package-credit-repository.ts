import { and, eq, or, sql } from "drizzle-orm";

import { canTransitionPurchaseOrder } from "../../core/orders/state-machine.js";
import {
  balanceLedger,
  packageBalances,
  packagePurchaseOrders,
  paymentTransactions,
} from "../../db/schema.js";
import type { AppDatabase } from "./postgres.js";

type PurchaseOrderRow = typeof packagePurchaseOrders.$inferSelect;
type PaymentTransactionRow = typeof paymentTransactions.$inferSelect;
type BalanceLedgerRow = typeof balanceLedger.$inferSelect;

export type PackageCreditResult =
  | {
      readonly kind: "credited";
      readonly created: boolean;
      readonly purchaseOrderId: string;
      readonly paymentTransactionId: string;
      readonly ledgerId: string;
      readonly availableCount: number;
    }
  | {
      readonly kind: "order_not_found";
    }
  | {
      readonly kind: "not_ready";
      readonly orderStatus: string;
    }
  | {
      readonly kind: "conflict";
      readonly reason:
        | "persisted_order_invalid"
        | "confirmed_payment_missing"
        | "confirmed_payment_mismatch"
        | "balance_missing"
        | "credited_without_ledger"
        | "ledger_conflict"
        | "ledger_unique_conflict"
        | "order_transition_failed";
    };

function creditIdempotencyKey(orderId: string): string {
  return `purchase-credit:${orderId}`;
}

function ledgerMatches(input: {
  readonly row: BalanceLedgerRow;
  readonly order: PurchaseOrderRow;
  readonly payment: PaymentTransactionRow;
}): boolean {
  return (
    input.row.reason === "purchase_credit" &&
    input.row.userId === input.order.userId &&
    input.row.purchaseOrderId === input.order.id &&
    input.row.paymentTransactionId === input.payment.id &&
    input.row.energyConsumptionOrderId === null &&
    input.row.auditLogId === null &&
    input.row.idempotencyKey ===
      creditIdempotencyKey(input.order.id) &&
    input.row.availableDelta === input.order.countSnapshot &&
    input.row.reservedDelta === 0
  );
}

export class PostgresPackageCreditRepository {
  constructor(private readonly db: AppDatabase) {}

  creditPaidOrder(input: {
    readonly purchaseOrderId: string;
  }): Promise<PackageCreditResult> {
    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select()
        .from(packagePurchaseOrders)
        .where(
          eq(
            packagePurchaseOrders.id,
            input.purchaseOrderId,
          ),
        )
        .limit(1)
        .for("update");

      if (order === undefined) {
        return { kind: "order_not_found" };
      }

      if (
        !Number.isInteger(order.countSnapshot) ||
        order.countSnapshot <= 0
      ) {
        return {
          kind: "conflict",
          reason: "persisted_order_invalid",
        };
      }

      if (
        order.status !== "paid" &&
        order.status !== "credited"
      ) {
        return {
          kind: "not_ready",
          orderStatus: order.status,
        };
      }

      const confirmedPayments = await tx
        .select()
        .from(paymentTransactions)
        .where(
          and(
            eq(
              paymentTransactions.purchaseOrderId,
              order.id,
            ),
            eq(paymentTransactions.status, "confirmed"),
          ),
        )
        .for("update");

      if (confirmedPayments.length === 0) {
        return {
          kind: "conflict",
          reason: "confirmed_payment_missing",
        };
      }

      if (confirmedPayments.length !== 1) {
        return {
          kind: "conflict",
          reason: "confirmed_payment_mismatch",
        };
      }

      const payment = confirmedPayments[0]!;

      if (
        payment.purchaseOrderId !== order.id ||
        payment.status !== "confirmed"
      ) {
        return {
          kind: "conflict",
          reason: "confirmed_payment_mismatch",
        };
      }

      const [balance] = await tx
        .select()
        .from(packageBalances)
        .where(eq(packageBalances.userId, order.userId))
        .limit(1)
        .for("update");

      if (balance === undefined) {
        return {
          kind: "conflict",
          reason: "balance_missing",
        };
      }

      const existingCredits = await tx
        .select()
        .from(balanceLedger)
        .where(
          and(
            eq(balanceLedger.reason, "purchase_credit"),
            or(
              eq(balanceLedger.purchaseOrderId, order.id),
              eq(
                balanceLedger.paymentTransactionId,
                payment.id,
              ),
            ),
          ),
        )
        .for("update");

      if (existingCredits.length > 1) {
        return {
          kind: "conflict",
          reason: "ledger_conflict",
        };
      }

      const existingCredit = existingCredits[0];

      if (existingCredit !== undefined) {
        if (
          !ledgerMatches({
            row: existingCredit,
            order,
            payment,
          })
        ) {
          return {
            kind: "conflict",
            reason: "ledger_conflict",
          };
        }

        if (order.status !== "credited") {
          return {
            kind: "conflict",
            reason: "ledger_conflict",
          };
        }

        return {
          kind: "credited",
          created: false,
          purchaseOrderId: order.id,
          paymentTransactionId: payment.id,
          ledgerId: existingCredit.id,
          availableCount: balance.availableCount,
        };
      }

      if (order.status === "credited") {
        return {
          kind: "conflict",
          reason: "credited_without_ledger",
        };
      }

      if (!canTransitionPurchaseOrder("paid", "credited")) {
        return {
          kind: "conflict",
          reason: "order_transition_failed",
        };
      }

      const now = new Date();

      const [insertedLedger] = await tx
        .insert(balanceLedger)
        .values({
          userId: order.userId,
          purchaseOrderId: order.id,
          paymentTransactionId: payment.id,
          energyConsumptionOrderId: null,
          auditLogId: null,
          idempotencyKey: creditIdempotencyKey(order.id),
          reason: "purchase_credit",
          availableDelta: order.countSnapshot,
          reservedDelta: 0,
        })
        .onConflictDoNothing()
        .returning();

      if (insertedLedger === undefined) {
        return {
          kind: "conflict",
          reason: "ledger_unique_conflict",
        };
      }

      const [updatedBalance] = await tx
        .update(packageBalances)
        .set({
          availableCount: sql<number>`
            ${packageBalances.availableCount}
            + ${order.countSnapshot}
          `,
          updatedAt: now,
        })
        .where(eq(packageBalances.userId, order.userId))
        .returning({
          availableCount: packageBalances.availableCount,
        });

      if (updatedBalance === undefined) {
        throw new Error(
          "Locked package balance disappeared during purchase credit",
        );
      }

      const [creditedOrder] = await tx
        .update(packagePurchaseOrders)
        .set({
          status: "credited",
          updatedAt: now,
        })
        .where(
          and(
            eq(packagePurchaseOrders.id, order.id),
            eq(packagePurchaseOrders.status, "paid"),
          ),
        )
        .returning({
          status: packagePurchaseOrders.status,
        });

      if (
        creditedOrder === undefined ||
        creditedOrder.status !== "credited"
      ) {
        throw new Error(
          "Locked purchase order failed paid-to-credited transition",
        );
      }

      return {
        kind: "credited",
        created: true,
        purchaseOrderId: order.id,
        paymentTransactionId: payment.id,
        ledgerId: insertedLedger.id,
        availableCount: updatedBalance.availableCount,
      };
    });
  }
}
