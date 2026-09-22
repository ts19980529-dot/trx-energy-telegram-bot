import type { PurchaseOrderState } from "../../core/orders/state-machine.js";
import {
  paymentIdentityOf,
  type PaymentDetector,
  type PaymentExpectation,
  type PaymentFinalityVerifier,
  type PaymentObservation,
} from "../../core/payments/payment-observation.js";

export type UsdtReconciliationOrderStatus =
  | "waiting_payment"
  | "payment_detected"
  | "confirming"
  | "paid";

export interface UsdtReconciliationOrder {
  readonly id: string;
  readonly status: UsdtReconciliationOrderStatus;
  readonly expectation: PaymentExpectation;
  readonly createdAt: Date;
  readonly quoteExpiresAt: Date | null;
}

export interface UsdtReconciliationOrderRepository {
  listReconcilableUsdtOrders(
    limit: number,
  ): Promise<readonly UsdtReconciliationOrder[]>;

  expireWaitingUsdtOrder(input: {
    readonly purchaseOrderId: string;
    readonly expiredAt: Date;
  }): Promise<"expired" | "not_waiting" | "order_not_found">;
}

export type PaymentLifecycleWriteResult =
  | {
      readonly kind: "applied";
      readonly orderStatus: PurchaseOrderState;
    }
  | {
      readonly kind: "ignored";
      readonly reason: string;
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
      readonly reason: string;
    };

export interface PaymentLifecycleWriter {
  applyObservation(input: {
    readonly purchaseOrderId: string;
    readonly observation: PaymentObservation;
  }): Promise<PaymentLifecycleWriteResult>;
}

export type PackageCreditWriteResult =
  | {
      readonly kind: "credited";
      readonly created: boolean;
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
      readonly reason: string;
    };

export interface PackageCreditWriter {
  creditPaidOrder(input: {
    readonly purchaseOrderId: string;
  }): Promise<PackageCreditWriteResult>;
}

export interface UsdtPaymentReconciliationResult {
  readonly ordersInspected: number;
  readonly namespacesScanned: number;
  readonly pagesScanned: number;
  readonly candidatesMatched: number;
  readonly finalityChecks: number;
  readonly creditsCreated: number;
}

export class UsdtPaymentReconciliationError extends Error {
  constructor(readonly reason: string) {
    super(`USDT payment reconciliation failed: ${reason}`);
    this.name = "UsdtPaymentReconciliationError";
  }
}

function validDate(value: Date): boolean {
  return !Number.isNaN(value.getTime());
}

function namespaceKey(expectation: PaymentExpectation): string {
  return JSON.stringify([
    expectation.tokenContractAddress,
    expectation.toAddress,
  ]);
}

function ensureUsdtOrder(order: UsdtReconciliationOrder): void {
  if (
    order.id.trim().length === 0 ||
    !validDate(order.createdAt) ||
    order.expectation.asset !== "USDT" ||
    order.expectation.tokenContractAddress === null ||
    order.expectation.tokenContractAddress.trim().length === 0 ||
    order.expectation.toAddress.trim().length === 0 ||
    order.expectation.amountAtomic <= 0n ||
    !Number.isInteger(order.expectation.requiredConfirmations) ||
    order.expectation.requiredConfirmations <= 0
  ) {
    throw new UsdtPaymentReconciliationError(
      "invalid_reconciliation_order",
    );
  }

  if (
    order.quoteExpiresAt === null ||
    !validDate(order.quoteExpiresAt) ||
    order.quoteExpiresAt.getTime() <= order.createdAt.getTime()
  ) {
    throw new UsdtPaymentReconciliationError(
      "quote_expiry_missing_or_invalid",
    );
  }
}

function candidateWithinOrderWindow(
  order: UsdtReconciliationOrder,
  observation: PaymentObservation,
  scanStartedAt: Date,
): boolean {
  if (
    observation.blockTimestamp === undefined ||
    !validDate(observation.blockTimestamp)
  ) {
    throw new UsdtPaymentReconciliationError(
      "candidate_block_timestamp_missing",
    );
  }

  if (order.quoteExpiresAt === null) {
    throw new UsdtPaymentReconciliationError(
      "quote_expiry_missing_or_invalid",
    );
  }

  const upperBoundMs = Math.min(
    scanStartedAt.getTime(),
    order.quoteExpiresAt.getTime(),
  );

  return (
    observation.blockTimestamp.getTime() >= order.createdAt.getTime() &&
    observation.blockTimestamp.getTime() <= upperBoundMs
  );
}

export class UsdtPaymentReconciliationService {
  constructor(
    private readonly orders: UsdtReconciliationOrderRepository,
    private readonly detector: PaymentDetector,
    private readonly finality: PaymentFinalityVerifier,
    private readonly lifecycle: PaymentLifecycleWriter,
    private readonly credits: PackageCreditWriter,
    private readonly maxOrdersPerRun: number,
    private readonly maxPagesPerNamespace: number,
  ) {
    if (
      !Number.isSafeInteger(maxOrdersPerRun) ||
      maxOrdersPerRun <= 0
    ) {
      throw new Error("maxOrdersPerRun must be a positive safe integer");
    }

    if (
      !Number.isSafeInteger(maxPagesPerNamespace) ||
      maxPagesPerNamespace <= 0
    ) {
      throw new Error(
        "maxPagesPerNamespace must be a positive safe integer",
      );
    }
  }

  async runOnce(
    scanStartedAt = new Date(),
  ): Promise<UsdtPaymentReconciliationResult> {
    if (!validDate(scanStartedAt)) {
      throw new UsdtPaymentReconciliationError("invalid_scan_time");
    }

    const listed = await this.orders.listReconcilableUsdtOrders(
      this.maxOrdersPerRun + 1,
    );

    if (listed.length > this.maxOrdersPerRun) {
      throw new UsdtPaymentReconciliationError(
        "reconciliation_order_capacity_exceeded",
      );
    }

    const orders = [...listed];

    for (const order of orders) {
      ensureUsdtOrder(order);
    }

    let creditsCreated = 0;

    for (const order of orders) {
      if (order.status !== "paid") {
        continue;
      }

      creditsCreated += await this.creditOrThrow(order.id);
    }

    let pagesScanned = 0;
    let candidatesMatched = 0;
    let finalityChecks = 0;
    let namespacesScanned = 0;

    const scanOrders = async (
      group: readonly UsdtReconciliationOrder[],
      maxTimestampMs: number,
    ): Promise<ReadonlySet<string>> => {
      const first = group[0];

      if (first === undefined) {
        return new Set<string>();
      }

      namespacesScanned += 1;

      const tokenContractAddress =
        first.expectation.tokenContractAddress;

      if (tokenContractAddress === null) {
        throw new UsdtPaymentReconciliationError(
          "missing_usdt_token_contract",
        );
      }

      const amountToOrder = new Map<string, UsdtReconciliationOrder>();
      let minTimestampMs = first.createdAt.getTime();

      for (const order of group) {
        if (
          order.expectation.tokenContractAddress !== tokenContractAddress ||
          order.expectation.toAddress !== first.expectation.toAddress
        ) {
          throw new UsdtPaymentReconciliationError(
            "namespace_group_mismatch",
          );
        }

        minTimestampMs = Math.min(
          minTimestampMs,
          order.createdAt.getTime(),
        );

        const amountKey = order.expectation.amountAtomic.toString();

        if (amountToOrder.has(amountKey)) {
          throw new UsdtPaymentReconciliationError(
            "duplicate_active_settlement_amount",
          );
        }

        amountToOrder.set(amountKey, order);
      }

      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      const matchedOrderIds = new Set<string>();

      for (
        let pageIndex = 0;
        pageIndex < this.maxPagesPerNamespace;
        pageIndex += 1
      ) {
        const page = await this.detector.findCandidates({
          asset: "USDT",
          tokenContractAddress,
          toAddress: first.expectation.toAddress,
          minTimestampMs,
          maxTimestampMs,
          ...(cursor === undefined ? {} : { cursor }),
        });

        pagesScanned += 1;

        for (const observation of page.observations) {
          if (
            observation.asset !== "USDT" ||
            observation.tokenContractAddress !== tokenContractAddress ||
            observation.toAddress !== first.expectation.toAddress
          ) {
            continue;
          }

          const order = amountToOrder.get(
            observation.amountAtomic.toString(),
          );

          if (order === undefined) {
            continue;
          }

          if (
            !candidateWithinOrderWindow(
              order,
              observation,
              scanStartedAt,
            )
          ) {
            continue;
          }

          candidatesMatched += 1;
          matchedOrderIds.add(order.id);

          const candidateState = await this.applyOrThrow(
            order.id,
            observation,
          );

          if (candidateState === "paid") {
            creditsCreated += await this.creditOrThrow(order.id);
            continue;
          }

          if (
            candidateState === "credited" ||
            candidateState === "expired" ||
            candidateState === "failed"
          ) {
            continue;
          }

          finalityChecks += 1;
          const authoritative = await this.finality.inspect(
            paymentIdentityOf(observation),
          );

          if (authoritative === undefined) {
            continue;
          }

          const finalState = await this.applyOrThrow(
            order.id,
            authoritative,
          );

          if (finalState === "paid") {
            creditsCreated += await this.creditOrThrow(order.id);
          }
        }

        if (page.nextCursor === undefined) {
          cursor = undefined;
          break;
        }

        if (
          page.nextCursor.trim().length === 0 ||
          seenCursors.has(page.nextCursor)
        ) {
          throw new UsdtPaymentReconciliationError(
            "invalid_pagination_cursor",
          );
        }

        seenCursors.add(page.nextCursor);
        cursor = page.nextCursor;
      }

      if (cursor !== undefined) {
        throw new UsdtPaymentReconciliationError(
          "scan_page_capacity_exceeded",
        );
      }

      return matchedOrderIds;
    };

    const overdueWaitingOrders = orders.filter(
      (order) =>
        order.status === "waiting_payment" &&
        order.quoteExpiresAt !== null &&
        order.quoteExpiresAt.getTime() <= scanStartedAt.getTime(),
    );
    const overdueOrderIds = new Set(
      overdueWaitingOrders.map((order) => order.id),
    );

    for (const order of overdueWaitingOrders) {
      if (order.quoteExpiresAt === null) {
        throw new UsdtPaymentReconciliationError(
          "quote_expiry_missing_or_invalid",
        );
      }

      const matched = await scanOrders(
        [order],
        order.quoteExpiresAt.getTime(),
      );

      if (matched.has(order.id)) {
        continue;
      }

      const expired = await this.orders.expireWaitingUsdtOrder({
        purchaseOrderId: order.id,
        expiredAt: scanStartedAt,
      });

      if (expired === "order_not_found") {
        throw new UsdtPaymentReconciliationError(
          "expiry_order_not_found",
        );
      }
    }

    const activeOrders = orders.filter(
      (order) =>
        order.status !== "paid" &&
        !overdueOrderIds.has(order.id),
    );
    const groups = new Map<string, UsdtReconciliationOrder[]>();

    for (const order of activeOrders) {
      const key = namespaceKey(order.expectation);
      const group = groups.get(key) ?? [];
      group.push(order);
      groups.set(key, group);
    }

    for (const group of groups.values()) {
      const upperBounds = group.map((order) => {
        if (order.quoteExpiresAt === null) {
          throw new UsdtPaymentReconciliationError(
            "quote_expiry_missing_or_invalid",
          );
        }

        return Math.min(
          scanStartedAt.getTime(),
          order.quoteExpiresAt.getTime(),
        );
      });
      const maxTimestampMs = Math.max(...upperBounds);

      await scanOrders(group, maxTimestampMs);
    }

    return {
      ordersInspected: orders.length,
      namespacesScanned,
      pagesScanned,
      candidatesMatched,
      finalityChecks,
      creditsCreated,
    };
  }

  private async applyOrThrow(
    purchaseOrderId: string,
    observation: PaymentObservation,
  ): Promise<PurchaseOrderState> {
    const result = await this.lifecycle.applyObservation({
      purchaseOrderId,
      observation,
    });

    if (
      result.kind === "applied" ||
      result.kind === "terminal_noop"
    ) {
      return result.orderStatus;
    }

    if (result.kind === "ignored") {
      throw new UsdtPaymentReconciliationError(
        `lifecycle_ignored:${result.reason}`,
      );
    }

    if (result.kind === "order_not_found") {
      throw new UsdtPaymentReconciliationError(
        "lifecycle_order_not_found",
      );
    }

    throw new UsdtPaymentReconciliationError(
      `lifecycle_conflict:${result.reason}`,
    );
  }

  private async creditOrThrow(
    purchaseOrderId: string,
  ): Promise<number> {
    const result = await this.credits.creditPaidOrder({
      purchaseOrderId,
    });

    if (result.kind === "credited") {
      return result.created ? 1 : 0;
    }

    if (result.kind === "not_ready") {
      throw new UsdtPaymentReconciliationError(
        `credit_not_ready:${result.orderStatus}`,
      );
    }

    if (result.kind === "order_not_found") {
      throw new UsdtPaymentReconciliationError(
        "credit_order_not_found",
      );
    }

    throw new UsdtPaymentReconciliationError(
      `credit_conflict:${result.reason}`,
    );
  }
}
