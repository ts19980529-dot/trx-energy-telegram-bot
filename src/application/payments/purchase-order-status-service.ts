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
}

export type PurchaseOrderStatusResult =
  | {
      readonly kind: "found";
      readonly order: PurchaseOrderStatusView;
    }
  | {
      readonly kind: "not_found";
    };

export class PurchaseOrderStatusService {
  constructor(
    private readonly repository: PurchaseOrderStatusRepository,
  ) {}

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
