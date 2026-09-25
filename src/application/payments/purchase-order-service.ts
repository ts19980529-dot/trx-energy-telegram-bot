import type {
  PaymentAsset,
  PaymentExpectation,
} from "../../core/payments/payment-observation.js";
import {
  buildPurchaseOrderPaymentContract,
  type PurchaseOrderPaymentSnapshot,
} from "../../core/payments/purchase-order-payment.js";
import type { PurchasePaymentQuoteProvider } from "../../core/payments/purchase-payment-quote.js";
import type { PurchaseOrderState } from "../../core/orders/state-machine.js";

export interface PurchaseOrderCustomerRepository {
  findActiveUserIdByTelegramUserId(
    telegramUserId: bigint,
  ): Promise<string | undefined>;
}

export interface PurchaseOrderPackageSnapshot {
  readonly id: string;
  readonly code: string;
  readonly count: number;
  readonly priceUsdtMicros: bigint;
}

export interface PurchaseOrderPackageRepository {
  findEnabledById(
    id: string,
  ): Promise<PurchaseOrderPackageSnapshot | undefined>;
}

export interface PurchaseOrderRecord {
  readonly id: string;
  readonly userId: string;
  readonly packageId: string;
  readonly idempotencyKey: string;
  readonly status: PurchaseOrderState;
  readonly payment: PurchaseOrderPaymentSnapshot;
  readonly expectation: PaymentExpectation;
}

export interface PurchaseOrderPersistenceInput {
  readonly userId: string;
  readonly packageId: string;
  readonly idempotencyKey: string;
  readonly payment: PurchaseOrderPaymentSnapshot;
  readonly maxUsdtAttributionOffsetAtomic?: bigint;
}

export type PurchaseOrderPersistenceResult =
  | {
      readonly kind: "created" | "existing";
      readonly order: PurchaseOrderRecord;
    }
  | {
      readonly kind: "conflict";
      readonly reason?: "attribution_unavailable";
    };

export interface PurchaseOrderRepository {
  createOrGet(
    input: PurchaseOrderPersistenceInput,
  ): Promise<PurchaseOrderPersistenceResult>;
}

export type PurchaseOrderCreationResult =
  | {
      readonly kind: "service_unavailable";
    }
  | {
      readonly kind: "ready";
      readonly created: boolean;
      readonly order: PurchaseOrderRecord;
    }
  | {
      readonly kind: "denied";
    }
  | {
      readonly kind: "package_unavailable";
    }
  | {
      readonly kind: "unsupported_asset";
      readonly asset: PaymentAsset;
    }
  | {
      readonly kind: "quote_unavailable";
    }
  | {
      readonly kind: "invalid_request";
    }
  | {
      readonly kind: "idempotency_conflict";
    }
  | {
      readonly kind: "payment_attribution_unavailable";
    };

export class PurchaseOrderCreationService {
  constructor(
    private readonly customers: PurchaseOrderCustomerRepository,
    private readonly packages: PurchaseOrderPackageRepository,
    private readonly quotes: PurchasePaymentQuoteProvider,
    private readonly orders: PurchaseOrderRepository,
    private readonly usdtAttributionMaxOffsetAtomic: bigint,
  ) {
    if (usdtAttributionMaxOffsetAtomic < 0n) {
      throw new Error(
        "USDT attribution max offset must be non-negative",
      );
    }
  }

  async create(input: {
    readonly telegramUserId: bigint;
    readonly packageId: string;
    readonly asset: PaymentAsset;
    readonly idempotencyKey: string;
    readonly requestedAt: Date;
  }): Promise<PurchaseOrderCreationResult> {
    const packageId = input.packageId.trim();
    const idempotencyKey = input.idempotencyKey.trim();

    if (
      input.telegramUserId <= 0n ||
      packageId.length === 0 ||
      idempotencyKey.length === 0 ||
      Number.isNaN(input.requestedAt.getTime())
    ) {
      return { kind: "invalid_request" };
    }

    const userId =
      await this.customers.findActiveUserIdByTelegramUserId(
        input.telegramUserId,
      );

    if (userId === undefined) {
      return { kind: "denied" };
    }

    const selected = await this.packages.findEnabledById(packageId);

    if (selected === undefined) {
      return { kind: "package_unavailable" };
    }

    const packageSnapshot = {
      packageCode: selected.code,
      count: selected.count,
      priceUsdtMicros: selected.priceUsdtMicros,
    };

    const quoteResult = await this.quotes.quote({
      package: packageSnapshot,
      asset: input.asset,
      requestedAt: new Date(input.requestedAt.getTime()),
    });

    if (quoteResult.kind === "unsupported_asset") {
      return quoteResult;
    }

    if (quoteResult.kind === "unavailable") {
      return { kind: "quote_unavailable" };
    }

    if (quoteResult.kind === "invalid_request") {
      return { kind: "invalid_request" };
    }

    const contract = buildPurchaseOrderPaymentContract({
      package: packageSnapshot,
      quote: quoteResult.quote,
    });

    if (contract.kind !== "ready") {
      return { kind: "invalid_request" };
    }

    if (
      contract.snapshot.quoteExpiresAt !== null &&
      contract.snapshot.quoteExpiresAt.getTime() <=
        input.requestedAt.getTime()
    ) {
      return { kind: "invalid_request" };
    }

    const persisted = await this.orders.createOrGet({
      userId,
      packageId: selected.id,
      idempotencyKey,
      payment: contract.snapshot,
      maxUsdtAttributionOffsetAtomic:
        this.usdtAttributionMaxOffsetAtomic,
    });

    if (persisted.kind === "conflict") {
      if (persisted.reason === "attribution_unavailable") {
        return { kind: "payment_attribution_unavailable" };
      }

      return { kind: "idempotency_conflict" };
    }

    return {
      kind: "ready",
      created: persisted.kind === "created",
      order: persisted.order,
    };
  }
}
