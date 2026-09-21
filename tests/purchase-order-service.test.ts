import { describe, expect, it } from "vitest";

import { PurchaseOrderCreationService } from "../src/application/payments/purchase-order-service.js";
import type {
  PurchaseOrderCustomerRepository,
  PurchaseOrderPackageRepository,
  PurchaseOrderPersistenceInput,
  PurchaseOrderRepository,
} from "../src/application/payments/purchase-order-service.js";
import type {
  PurchasePaymentQuoteProvider,
  PurchasePaymentQuoteResult,
} from "../src/core/payments/purchase-payment-quote.js";
import { paymentExpectationFromOrderSnapshot } from "../src/core/payments/purchase-order-payment.js";

const packageItem = {
  id: "11111111-1111-4111-8111-111111111111",
  code: "energy-10",
  count: 10,
  priceUsdtMicros: 17_000_000n,
};

class FakeCustomerRepository
  implements PurchaseOrderCustomerRepository
{
  constructor(private readonly userId?: string) {}

  async findActiveUserIdByTelegramUserId(): Promise<
    string | undefined
  > {
    return this.userId;
  }
}

class FakePackageRepository
  implements PurchaseOrderPackageRepository
{
  constructor(
    private readonly item:
      | typeof packageItem
      | null = packageItem,
  ) {}

  async findEnabledById() {
    return this.item ?? undefined;
  }
}

class FakeQuoteProvider
  implements PurchasePaymentQuoteProvider
{
  readonly name = "fake-quote";

  constructor(
    private readonly result: PurchasePaymentQuoteResult,
  ) {}

  async quote(): Promise<PurchasePaymentQuoteResult> {
    return this.result;
  }
}

class FakeOrderRepository implements PurchaseOrderRepository {
  input?: PurchaseOrderPersistenceInput;

  constructor(
    private readonly mode: "created" | "existing" | "conflict" =
      "created",
  ) {}

  async createOrGet(input: PurchaseOrderPersistenceInput) {
    this.input = input;

    if (this.mode === "conflict") {
      return { kind: "conflict" as const };
    }

    const expectation =
      paymentExpectationFromOrderSnapshot(input.payment);

    if (expectation === undefined) {
      throw new Error("Invalid test payment snapshot");
    }

    return {
      kind: this.mode,
      order: {
        id: "22222222-2222-4222-8222-222222222222",
        userId: input.userId,
        packageId: input.packageId,
        idempotencyKey: input.idempotencyKey,
        status: "waiting_payment" as const,
        payment: input.payment,
        expectation,
      },
    };
  }
}

function readyQuote(): PurchasePaymentQuoteResult {
  return {
    kind: "ready",
    quote: {
      asset: "USDT",
      toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
      tokenContractAddress:
        "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      amountAtomic: 17_000_000n,
      requiredConfirmations: 2,
      expiresAt: null,
    },
  };
}

function service(options?: {
  denyUser?: boolean;
  packageAvailable?: boolean;
  quote?: PurchasePaymentQuoteResult;
  orderMode?: "created" | "existing" | "conflict";
}) {
  const orders = new FakeOrderRepository(
    options?.orderMode ?? "created",
  );
  const instance = new PurchaseOrderCreationService(
    new FakeCustomerRepository(
      options?.denyUser === true
        ? undefined
        : "33333333-3333-4333-8333-333333333333",
    ),
    new FakePackageRepository(
      options?.packageAvailable === false
        ? null
        : packageItem,
    ),
    new FakeQuoteProvider(options?.quote ?? readyQuote()),
    orders,
  );

  return { instance, orders };
}

const validInput = {
  telegramUserId: 42n,
  packageId: packageItem.id,
  asset: "USDT" as const,
  idempotencyKey: "telegram:callback-123",
  requestedAt: new Date("2026-09-21T14:00:00.000Z"),
};

describe("PurchaseOrderCreationService", () => {
  it("freezes a ready quote and persists one waiting-payment order", async () => {
    const { instance, orders } = service();

    await expect(instance.create(validInput)).resolves.toMatchObject({
      kind: "ready",
      created: true,
      order: {
        userId: "33333333-3333-4333-8333-333333333333",
        packageId: packageItem.id,
        idempotencyKey: "telegram:callback-123",
        status: "waiting_payment",
        payment: {
          packageCodeSnapshot: "energy-10",
          countSnapshot: 10,
          priceUsdtMicrosSnapshot: 17_000_000n,
          paymentAsset: "USDT",
          quotedAmountAtomic: 17_000_000n,
        },
        expectation: {
          asset: "USDT",
          amountAtomic: 17_000_000n,
        },
      },
    });

    expect(orders.input?.idempotencyKey).toBe(
      "telegram:callback-123",
    );
  });

  it("denies unknown or blocked customers before package or quote work", async () => {
    const { instance } = service({ denyUser: true });

    await expect(instance.create(validInput)).resolves.toEqual({
      kind: "denied",
    });
  });

  it("rejects disabled or missing packages", async () => {
    const { instance } = service({ packageAvailable: false });

    await expect(instance.create(validInput)).resolves.toEqual({
      kind: "package_unavailable",
    });
  });

  it("preserves unsupported-asset and quote-unavailable outcomes", async () => {
    const unsupported = service({
      quote: { kind: "unsupported_asset", asset: "TRX" },
    });

    await expect(
      unsupported.instance.create({
        ...validInput,
        asset: "TRX",
      }),
    ).resolves.toEqual({
      kind: "unsupported_asset",
      asset: "TRX",
    });

    const unavailable = service({
      quote: { kind: "unavailable" },
    });

    await expect(
      unavailable.instance.create(validInput),
    ).resolves.toEqual({
      kind: "quote_unavailable",
    });
  });

  it("rejects invalid request identity and already-expired quotes", async () => {
    const { instance } = service();

    await expect(
      instance.create({
        ...validInput,
        idempotencyKey: "   ",
      }),
    ).resolves.toEqual({ kind: "invalid_request" });

    const expired = service({
      quote: {
        kind: "ready",
        quote: {
          asset: "USDT",
          toAddress: "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL",
          tokenContractAddress:
            "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
          amountAtomic: 17_000_000n,
          requiredConfirmations: 2,
          expiresAt: new Date("2026-09-21T13:59:59.000Z"),
        },
      },
    });

    await expect(
      expired.instance.create(validInput),
    ).resolves.toEqual({ kind: "invalid_request" });
  });

  it("reports idempotency payload conflicts without creating another order", async () => {
    const { instance } = service({ orderMode: "conflict" });

    await expect(instance.create(validInput)).resolves.toEqual({
      kind: "idempotency_conflict",
    });
  });

  it("returns an existing order as an idempotent replay", async () => {
    const { instance } = service({ orderMode: "existing" });

    await expect(instance.create(validInput)).resolves.toMatchObject({
      kind: "ready",
      created: false,
      order: {
        idempotencyKey: "telegram:callback-123",
      },
    });
  });
});

