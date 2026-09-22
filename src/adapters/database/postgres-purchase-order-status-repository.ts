import { and, eq } from "drizzle-orm";

import type {
  PurchaseOrderStatusRepository,
  PurchaseOrderStatusView,
} from "../../application/payments/purchase-order-status-service.js";
import {
  purchaseOrderStates,
  type PurchaseOrderState,
} from "../../core/orders/state-machine.js";
import {
  paymentExpectationFromOrderSnapshot,
  type PurchaseOrderPaymentSnapshot,
} from "../../core/payments/purchase-order-payment.js";
import {
  packageBalances,
  packagePurchaseOrders,
  users,
} from "../../db/schema.js";
import type { AppDatabase } from "./postgres.js";

function parseStatus(value: string): PurchaseOrderState {
  if ((purchaseOrderStates as readonly string[]).includes(value)) {
    return value as PurchaseOrderState;
  }

  throw new Error(
    "Unexpected purchase-order status returned for Telegram status lookup",
  );
}

export class PostgresPurchaseOrderStatusRepository
  implements PurchaseOrderStatusRepository
{
  constructor(private readonly db: AppDatabase) {}

  async findOwnedOrder(input: {
    readonly orderId: string;
    readonly telegramUserId: bigint;
  }): Promise<PurchaseOrderStatusView | undefined> {
    const [row] = await this.db
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
        availableCount: packageBalances.availableCount,
        updatedAt: packagePurchaseOrders.updatedAt,
      })
      .from(packagePurchaseOrders)
      .innerJoin(
        users,
        eq(packagePurchaseOrders.userId, users.id),
      )
      .innerJoin(
        packageBalances,
        eq(packageBalances.userId, users.id),
      )
      .where(
        and(
          eq(packagePurchaseOrders.id, input.orderId),
          eq(users.telegramUserId, input.telegramUserId),
        ),
      )
      .limit(1);

    if (row === undefined) {
      return undefined;
    }

    if (
      row.paymentAsset !== "USDT" &&
      row.paymentAsset !== "TRX"
    ) {
      throw new Error(
        "Persisted purchase-order payment asset is invalid",
      );
    }

    const payment: PurchaseOrderPaymentSnapshot = {
      packageCodeSnapshot: row.packageCodeSnapshot,
      countSnapshot: row.countSnapshot,
      priceUsdtMicrosSnapshot: row.priceUsdtMicrosSnapshot,
      paymentAttributionOffsetAtomic:
        row.paymentAttributionOffsetAtomic,
      paymentAsset: row.paymentAsset,
      paymentToAddressSnapshot:
        row.paymentToAddressSnapshot,
      paymentTokenContractAddressSnapshot:
        row.paymentTokenContractAddressSnapshot,
      requiredConfirmationsSnapshot:
        row.requiredConfirmationsSnapshot,
      quotedAmountAtomic: row.quotedAmountAtomic,
      quoteExpiresAt: row.quoteExpiresAt,
    };

    if (paymentExpectationFromOrderSnapshot(payment) === undefined) {
      throw new Error(
        "Persisted purchase-order payment snapshot violates invariants",
      );
    }

    return {
      id: row.id,
      status: parseStatus(row.status),
      payment,
      availableCount: row.availableCount,
      updatedAt: row.updatedAt,
    };
  }
}
