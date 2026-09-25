import { and, desc, eq } from "drizzle-orm";

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

interface PurchaseOrderStatusRow {
  readonly id: string;
  readonly status: string;
  readonly packageCodeSnapshot: string;
  readonly countSnapshot: number;
  readonly priceUsdtMicrosSnapshot: bigint;
  readonly paymentAttributionOffsetAtomic: bigint;
  readonly paymentAsset: string;
  readonly paymentToAddressSnapshot: string;
  readonly paymentTokenContractAddressSnapshot: string | null;
  readonly requiredConfirmationsSnapshot: number;
  readonly quotedAmountAtomic: bigint;
  readonly quoteExpiresAt: Date | null;
  readonly availableCount: number;
  readonly updatedAt: Date;
}

function toStatusView(
  row: PurchaseOrderStatusRow,
): PurchaseOrderStatusView {
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
          eq(users.status, "active"),
        ),
      )
      .limit(1);

    return row === undefined ? undefined : toStatusView(row);
  }

  async listOwnedRecent(input: {
    readonly telegramUserId: bigint;
    readonly limit: number;
  }): Promise<
    | { readonly kind: "denied" }
    | {
        readonly kind: "ready";
        readonly orders: readonly PurchaseOrderStatusView[];
      }
  > {
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > 10
    ) {
      throw new Error(
        "Purchase owned-order limit must be between 1 and 10",
      );
    }

    const [user] = await this.db
      .select({ id: users.id, status: users.status })
      .from(users)
      .where(eq(users.telegramUserId, input.telegramUserId))
      .limit(1);

    if (user === undefined || user.status === "blocked") {
      return { kind: "denied" };
    }

    const [balance] = await this.db
      .select({ availableCount: packageBalances.availableCount })
      .from(packageBalances)
      .where(eq(packageBalances.userId, user.id))
      .limit(1);

    if (balance === undefined) {
      throw new Error(
        "Purchase-order customer balance is missing",
      );
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
        updatedAt: packagePurchaseOrders.updatedAt,
      })
      .from(packagePurchaseOrders)
      .where(eq(packagePurchaseOrders.userId, user.id))
      .orderBy(
        desc(packagePurchaseOrders.createdAt),
        desc(packagePurchaseOrders.id),
      )
      .limit(input.limit);

    return {
      kind: "ready",
      orders: rows.map((row) =>
        toStatusView({
          ...row,
          availableCount: balance.availableCount,
        }),
      ),
    };
  }
}
