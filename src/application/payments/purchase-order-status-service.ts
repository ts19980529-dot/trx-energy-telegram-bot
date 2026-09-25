import type { PurchaseOrderState } from "../../core/orders/state-machine.js";
import type { PurchaseOrderPaymentSnapshot } from "../../core/payments/purchase-order-payment.js";

export interface PurchaseOrderStatusView {
  readonly id: string;
  readonly status: PurchaseOrderState;
  readonly payment: PurchaseOrderPaymentSnapshot;
  readonly availableCount: number;
  readonly updatedAt: Date;
}

export interface PurchaseOrderStatusRepository {
  findOwnedOrder(input: {
    readonly orderId: string;
    readonly telegramUserId: bigint;
  }): Promise<PurchaseOrderStatusView | undefined>;

  listOwnedRecent(input: {
    readonly telegramUserId: bigint;
    readonly limit: number;
  }): Promise<
    | { readonly kind: "denied" }
    | {
        readonly kind: "ready";
        readonly orders: readonly PurchaseOrderStatusView[];
      }
  >;
}

export type PurchaseOrderStatusResult =
  | {
      readonly kind: "found";
      readonly order: PurchaseOrderStatusView;
    }
  | {
      readonly kind: "not_found";
    };

export type PurchaseOrderListResult =
  | { readonly kind: "denied" }
  | {
      readonly kind: "ready";
      readonly orders: readonly PurchaseOrderStatusView[];
    };

export class PurchaseOrderStatusService {
  constructor(
    private readonly repository: PurchaseOrderStatusRepository,
  ) {}

  async listRecent(input: {
    readonly telegramUserId: bigint;
    readonly limit?: number;
  }): Promise<PurchaseOrderListResult> {
    const limit = input.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new Error("Purchase recent-order limit must be between 1 and 10");
    }

    return this.repository.listOwnedRecent({
      telegramUserId: input.telegramUserId,
      limit,
    });
  }

  async get(input: {
    readonly orderId: string;
    readonly telegramUserId: bigint;
  }): Promise<PurchaseOrderStatusResult> {
    if (
      input.orderId.trim().length === 0 ||
      input.telegramUserId <= 0n
    ) {
      return { kind: "not_found" };
    }

    const order = await this.repository.findOwnedOrder(input);

    return order === undefined
      ? { kind: "not_found" }
      : { kind: "found", order };
  }
}
