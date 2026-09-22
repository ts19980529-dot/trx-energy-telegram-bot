import { and, asc, eq, inArray, lte } from "drizzle-orm";

import type {
  UsdtReconciliationOrderRepository,
  UsdtReconciliationOrder,
  UsdtReconciliationOrderStatus,
} from "../../application/payments/usdt-payment-reconciliation-service.js";
import {
  paymentExpectationFromOrderSnapshot,
  type PurchaseOrderPaymentSnapshot,
} from "../../core/payments/purchase-order-payment.js";
import { packagePurchaseOrders } from "../../db/schema.js";
import type { AppDatabase } from "./postgres.js";

const reconciliationStatuses = [
  "waiting_payment",
  "payment_detected",
  "confirming",
  "paid",
] as const satisfies readonly UsdtReconciliationOrderStatus[];

function isReconciliationStatus(
  value: string,
): value is UsdtReconciliationOrderStatus {
  return (reconciliationStatuses as readonly string[]).includes(value);
}

export class PostgresUsdtReconciliationOrderRepository
  implements UsdtReconciliationOrderRepository
{
  constructor(private readonly db: AppDatabase) {}

  async listReconcilableUsdtOrders(
    limit: number,
  ): Promise<readonly UsdtReconciliationOrder[]> {
    if (!Number.isSafeInteger(limit) || limit <= 0) {
      throw new Error("limit must be a positive safe integer");
    }

    const rows = await this.db
      .select({
        id: packagePurchaseOrders.id,
        status: packagePurchaseOrders.status,
        packageCodeSnapshot:
          packagePurchaseOrders.packageCodeSnapshot,
        countSnapshot: packagePurchaseOrders.countSnapshot,
        priceUsdtMicrosSnapshot:
          packagePurchaseOrders.priceUsdtMicrosSnapshot,
        paymentAttributionOffsetAtomic:
          packagePurchaseOrders.paymentAttributionOffsetAtomic,
        paymentAsset: packagePurchaseOrders.paymentAsset,
        paymentToAddressSnapshot:
          packagePurchaseOrders.paymentToAddressSnapshot,
        paymentTokenContractAddressSnapshot:
          packagePurchaseOrders.paymentTokenContractAddressSnapshot,
        requiredConfirmationsSnapshot:
          packagePurchaseOrders.requiredConfirmationsSnapshot,
        quotedAmountAtomic:
          packagePurchaseOrders.quotedAmountAtomic,
        quoteExpiresAt: packagePurchaseOrders.quoteExpiresAt,
        createdAt: packagePurchaseOrders.createdAt,
      })
      .from(packagePurchaseOrders)
      .where(
        and(
          eq(packagePurchaseOrders.paymentAsset, "USDT"),
          inArray(
            packagePurchaseOrders.status,
            [...reconciliationStatuses],
          ),
        ),
      )
      .orderBy(
        asc(packagePurchaseOrders.createdAt),
        asc(packagePurchaseOrders.id),
      )
      .limit(limit);

    return rows.map((row) => {
      if (
        row.paymentAsset !== "USDT" ||
        !isReconciliationStatus(row.status)
      ) {
        throw new Error(
          "Unexpected purchase order returned for USDT reconciliation",
        );
      }

      const payment: PurchaseOrderPaymentSnapshot = {
        packageCodeSnapshot: row.packageCodeSnapshot,
        countSnapshot: row.countSnapshot,
        priceUsdtMicrosSnapshot:
          row.priceUsdtMicrosSnapshot,
        paymentAttributionOffsetAtomic:
          row.paymentAttributionOffsetAtomic,
        paymentAsset: "USDT",
        paymentToAddressSnapshot:
          row.paymentToAddressSnapshot,
        paymentTokenContractAddressSnapshot:
          row.paymentTokenContractAddressSnapshot,
        requiredConfirmationsSnapshot:
          row.requiredConfirmationsSnapshot,
        quotedAmountAtomic: row.quotedAmountAtomic,
        quoteExpiresAt: row.quoteExpiresAt,
      };
      const expectation =
        paymentExpectationFromOrderSnapshot(payment);

      if (
        expectation === undefined ||
        expectation.asset !== "USDT" ||
        expectation.tokenContractAddress === null
      ) {
        throw new Error(
          "Persisted USDT reconciliation order violates payment invariants",
        );
      }

      return {
        id: row.id,
        status: row.status,
        expectation,
        createdAt: row.createdAt,
        quoteExpiresAt: row.quoteExpiresAt,
      };
    });
  }
  async expireWaitingUsdtOrder(input: {
    readonly purchaseOrderId: string;
    readonly expiredAt: Date;
  }): Promise<"expired" | "not_waiting" | "order_not_found"> {
    if (
      input.purchaseOrderId.trim().length === 0 ||
      Number.isNaN(input.expiredAt.getTime())
    ) {
      throw new Error("Invalid USDT purchase-order expiry request");
    }

    return this.db.transaction(async (tx) => {
      const [order] = await tx
        .select({
          status: packagePurchaseOrders.status,
          quoteExpiresAt: packagePurchaseOrders.quoteExpiresAt,
        })
        .from(packagePurchaseOrders)
        .where(eq(packagePurchaseOrders.id, input.purchaseOrderId))
        .limit(1)
        .for("update");

      if (order === undefined) {
        return "order_not_found";
      }

      if (
        order.status !== "waiting_payment" ||
        order.quoteExpiresAt === null ||
        order.quoteExpiresAt.getTime() > input.expiredAt.getTime()
      ) {
        return "not_waiting";
      }

      const [expired] = await tx
        .update(packagePurchaseOrders)
        .set({
          status: "expired",
          updatedAt: new Date(input.expiredAt.getTime()),
        })
        .where(
          and(
            eq(packagePurchaseOrders.id, input.purchaseOrderId),
            eq(packagePurchaseOrders.status, "waiting_payment"),
            lte(packagePurchaseOrders.quoteExpiresAt, input.expiredAt),
          ),
        )
        .returning({ status: packagePurchaseOrders.status });

      return expired?.status === "expired"
        ? "expired"
        : "not_waiting";
    });
  }

}
