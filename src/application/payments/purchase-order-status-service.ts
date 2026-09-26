import type { PurchaseOrderState } from "../../core/orders/state-machine.js";
import type { PurchaseOrderPaymentSnapshot } from "../../core/payments/purchase-order-payment.js";

export interface PurchaseOrderStatusView {
  readonly id: string;
  readonly status: PurchaseOrderState;
  readonly payment: PurchaseOrderPaymentSnapshot;
  readonly availableCount: number;
  readonly updatedAt: Date;
}

export type PurchaseOrderPageDirection = "next" | "previous";

export interface PurchaseOrderStatusRepository {
  findOwnedOrder(input: {
    readonly orderId: string;
    readonly telegramUserId: bigint;
  }): Promise<PurchaseOrderStatusView | undefined>;

  listOwnedPage(input: {
    readonly telegramUserId: bigint;
    readonly limit: number;
    readonly cursorId?: string;
    readonly direction?: PurchaseOrderPageDirection;
  }): Promise<
    | { readonly kind: "denied" }
    | {
        readonly kind: "ready";
        readonly orders: readonly PurchaseOrderStatusView[];
        readonly previousCursor: string | null;
        readonly nextCursor: string | null;
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

export type PurchaseOrderPageResult =
  | { readonly kind: "denied" }
  | {
      readonly kind: "ready";
      readonly orders: readonly PurchaseOrderStatusView[];
      readonly previousCursor: string | null;
      readonly nextCursor: string | null;
    };

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class PurchaseOrderStatusService {
  constructor(
    private readonly repository: PurchaseOrderStatusRepository,
  ) {}

  async listPage(input: {
    readonly telegramUserId: bigint;
    readonly limit?: number;
    readonly cursorId?: string;
    readonly direction?: PurchaseOrderPageDirection;
  }): Promise<PurchaseOrderPageResult> {
    const limit = input.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new Error("Purchase order page size must be between 1 and 10");
    }

    if (
      input.cursorId !== undefined &&
      !UUID_PATTERN.test(input.cursorId)
    ) {
      throw new Error("Purchase order cursor is invalid");
    }

    if (
      input.direction !== undefined &&
      input.direction !== "next" &&
      input.direction !== "previous"
    ) {
      throw new Error("Purchase order page direction is invalid");
    }

    if (input.cursorId === undefined && input.direction !== undefined) {
      throw new Error("Purchase order page direction requires a cursor");
    }

    return this.repository.listOwnedPage({
      telegramUserId: input.telegramUserId,
      limit,
      ...(input.cursorId === undefined
        ? {}
        : { cursorId: input.cursorId }),
      ...(input.direction === undefined
        ? {}
        : { direction: input.direction }),
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
