import { describe, expect, it } from "vitest";

import {
  UsdtPaymentReconciliationError,
  UsdtPaymentReconciliationService,
  type PackageCreditWriter,
  type PaymentLifecycleWriter,
  type UsdtReconciliationOrderRepository,
  type UsdtReconciliationOrder,
} from "../src/application/payments/usdt-payment-reconciliation-service.js";
import type {
  PaymentDetectionPage,
  PaymentDetectionRequest,
  PaymentDetector,
  PaymentFinalityVerifier,
  PaymentIdentity,
  PaymentObservation,
} from "../src/core/payments/payment-observation.js";

const TOKEN = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const DESTINATION = "TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL";
const SENDER = "TYMwi6h3p1cQJw2j9WJcKjV7SqDWrLJY3U";

function order(
  overrides: Partial<UsdtReconciliationOrder> = {},
): UsdtReconciliationOrder {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    status: "waiting_payment",
    expectation: {
      asset: "USDT",
      tokenContractAddress: TOKEN,
      toAddress: DESTINATION,
      amountAtomic: 17_000_137n,
      requiredConfirmations: 2,
    },
    createdAt: new Date("2026-09-22T02:00:00.000Z"),
    quoteExpiresAt: new Date("2026-09-22T02:30:00.000Z"),
    ...overrides,
  };
}

function candidate(
  overrides: Partial<Extract<PaymentObservation, { asset: "USDT" }>> = {},
): Extract<PaymentObservation, { asset: "USDT" }> {
  return {
    asset: "USDT",
    txid: "a".repeat(64),
    tokenContractAddress: TOKEN,
    eventIndex: 7,
    fromAddress: SENDER,
    toAddress: DESTINATION,
    amountAtomic: 17_000_137n,
    confirmations: 0,
    solidified: false,
    evidenceSource: "indexer",
    executionStatus: "unknown",
    blockNumber: 70_000_000n,
    blockTimestamp: new Date("2026-09-22T02:05:00.000Z"),
    ...overrides,
  };
}

class FakeOrders implements UsdtReconciliationOrderRepository {
  readonly expiredOrderIds: string[] = [];

  constructor(
    private readonly rows: readonly UsdtReconciliationOrder[],
  ) {}

  async listReconcilableUsdtOrders(): Promise<
    readonly UsdtReconciliationOrder[]
  > {
    return this.rows;
  }

  async expireWaitingUsdtOrder(input: {
    readonly purchaseOrderId: string;
    readonly expiredAt: Date;
  }): Promise<"expired" | "not_waiting" | "order_not_found"> {
    const row = this.rows.find(
      (candidate) => candidate.id === input.purchaseOrderId,
    );

    if (row === undefined) {
      return "order_not_found";
    }

    if (
      row.status !== "waiting_payment" ||
      row.quoteExpiresAt === null ||
      row.quoteExpiresAt.getTime() > input.expiredAt.getTime()
    ) {
      return "not_waiting";
    }

    this.expiredOrderIds.push(row.id);
    return "expired";
  }
}

class FakeDetector implements PaymentDetector {
  readonly name = "fake-detector";
  readonly requests: PaymentDetectionRequest[] = [];

  constructor(
    private readonly pages: readonly PaymentDetectionPage[],
  ) {}

  async findCandidates(
    request: PaymentDetectionRequest,
  ): Promise<PaymentDetectionPage> {
    this.requests.push(request);
    return this.pages[this.requests.length - 1] ?? {
      observations: [],
    };
  }
}

class FakeFinality implements PaymentFinalityVerifier {
  readonly name = "fake-finality";
  readonly identities: PaymentIdentity[] = [];

  constructor(
    private readonly observation?: PaymentObservation,
  ) {}

  async inspect(
    identity: PaymentIdentity,
  ): Promise<PaymentObservation | undefined> {
    this.identities.push(identity);
    return this.observation;
  }
}

class FakeLifecycle implements PaymentLifecycleWriter {
  readonly observations: Array<{
    purchaseOrderId: string;
    observation: PaymentObservation;
  }> = [];

  async applyObservation(input: {
    readonly purchaseOrderId: string;
    readonly observation: PaymentObservation;
  }) {
    this.observations.push(input);

    if (input.observation.solidified) {
      return {
        kind: "applied" as const,
        orderStatus: "paid" as const,
      };
    }

    return {
      kind: "applied" as const,
      orderStatus: "payment_detected" as const,
    };
  }
}

class FakeCredits implements PackageCreditWriter {
  readonly orderIds: string[] = [];

  async creditPaidOrder(input: {
    readonly purchaseOrderId: string;
  }) {
    this.orderIds.push(input.purchaseOrderId);
    return {
      kind: "credited" as const,
      created: true,
    };
  }
}

function service(input?: {
  rows?: readonly UsdtReconciliationOrder[];
  pages?: readonly PaymentDetectionPage[];
  finality?: PaymentObservation;
  maxOrders?: number;
  maxPages?: number;
}) {
  const detector = new FakeDetector(input?.pages ?? []);
  const finality = new FakeFinality(input?.finality);
  const lifecycle = new FakeLifecycle();
  const credits = new FakeCredits();
  const orders = new FakeOrders(input?.rows ?? [order()]);
  const instance = new UsdtPaymentReconciliationService(
    orders,
    detector,
    finality,
    lifecycle,
    credits,
    input?.maxOrders ?? 100,
    input?.maxPages ?? 10,
  );

  return {
    instance,
    detector,
    finality,
    lifecycle,
    credits,
    orders,
  };
}

describe("UsdtPaymentReconciliationService", () => {
  it("discovers, persists, finalizes and credits one exact attributed payment", async () => {
    const indexed = candidate();
    const solidified = candidate({
      confirmations: 3,
      solidified: true,
      evidenceSource: "solidified_node",
      executionStatus: "success",
    });
    const {
      instance,
      detector,
      finality,
      lifecycle,
      credits,
    } = service({
      pages: [{ observations: [indexed] }],
      finality: solidified,
    });

    await expect(
      instance.runOnce(new Date("2026-09-22T02:10:00.000Z")),
    ).resolves.toEqual({
      ordersInspected: 1,
      namespacesScanned: 1,
      pagesScanned: 1,
      candidatesMatched: 1,
      finalityChecks: 1,
      creditsCreated: 1,
    });

    expect(detector.requests).toEqual([
      {
        asset: "USDT",
        tokenContractAddress: TOKEN,
        toAddress: DESTINATION,
        minTimestampMs: Date.parse("2026-09-22T02:00:00.000Z"),
        maxTimestampMs: Date.parse("2026-09-22T02:10:00.000Z"),
      },
    ]);
    expect(finality.identities).toEqual([
      {
        asset: "USDT",
        txid: "a".repeat(64),
        tokenContractAddress: TOKEN,
        eventIndex: 7,
      },
    ]);
    expect(lifecycle.observations).toHaveLength(2);
    expect(credits.orderIds).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
  });

  it("retries exactly-once credit for an already-paid order without scanning", async () => {
    const { instance, detector, credits } = service({
      rows: [order({ status: "paid" })],
    });

    await expect(instance.runOnce()).resolves.toMatchObject({
      ordersInspected: 1,
      namespacesScanned: 0,
      pagesScanned: 0,
      creditsCreated: 1,
    });

    expect(detector.requests).toHaveLength(0);
    expect(credits.orderIds).toHaveLength(1);
  });

  it("preserves a fixed time window while following pagination", async () => {
    const { instance, detector } = service({
      pages: [
        {
          observations: [],
          nextCursor: "page-2",
        },
        {
          observations: [],
        },
      ],
    });

    await instance.runOnce(
      new Date("2026-09-22T02:10:00.000Z"),
    );

    expect(detector.requests).toHaveLength(2);
    expect(detector.requests[0]).toMatchObject({
      minTimestampMs: Date.parse("2026-09-22T02:00:00.000Z"),
      maxTimestampMs: Date.parse("2026-09-22T02:10:00.000Z"),
    });
    expect(detector.requests[1]).toMatchObject({
      minTimestampMs: Date.parse("2026-09-22T02:00:00.000Z"),
      maxTimestampMs: Date.parse("2026-09-22T02:10:00.000Z"),
      cursor: "page-2",
    });
  });

  it("fails closed instead of silently truncating pagination", async () => {
    const { instance } = service({
      pages: [
        {
          observations: [],
          nextCursor: "page-2",
        },
      ],
      maxPages: 1,
    });

    await expect(instance.runOnce()).rejects.toEqual(
      new UsdtPaymentReconciliationError(
        "scan_page_capacity_exceeded",
      ),
    );
  });

  it("rejects historical exact-amount transfers from before the order existed", async () => {
    const { instance, lifecycle } = service({
      pages: [
        {
          observations: [
            candidate({
              blockTimestamp: new Date(
                "2026-09-22T01:59:59.000Z",
              ),
            }),
          ],
        },
      ],
    });

    await expect(instance.runOnce()).resolves.toMatchObject({
      candidatesMatched: 0,
      finalityChecks: 0,
    });
    expect(lifecycle.observations).toHaveLength(0);
  });

  it("expires an overdue waiting order only after scanning through its payment deadline", async () => {
    const expiring = order({
      quoteExpiresAt: new Date("2026-09-22T02:15:00.000Z"),
    });
    const { instance, detector, orders } = service({
      rows: [expiring],
      pages: [{ observations: [] }],
    });

    await expect(
      instance.runOnce(new Date("2026-09-22T02:20:00.000Z")),
    ).resolves.toMatchObject({
      ordersInspected: 1,
      namespacesScanned: 1,
      pagesScanned: 1,
      candidatesMatched: 0,
    });

    expect(detector.requests).toEqual([
      {
        asset: "USDT",
        tokenContractAddress: TOKEN,
        toAddress: DESTINATION,
        minTimestampMs: Date.parse("2026-09-22T02:00:00.000Z"),
        maxTimestampMs: Date.parse("2026-09-22T02:15:00.000Z"),
      },
    ]);
    expect(orders.expiredOrderIds).toEqual([expiring.id]);
  });

  it("keeps a payment made before the deadline eligible even when finality is still pending after expiry", async () => {
    const expiring = order({
      quoteExpiresAt: new Date("2026-09-22T02:15:00.000Z"),
    });
    const timely = candidate({
      blockTimestamp: new Date("2026-09-22T02:14:00.000Z"),
    });
    const {
      instance,
      lifecycle,
      finality,
      orders,
    } = service({
      rows: [expiring],
      pages: [{ observations: [timely] }],
    });

    await expect(
      instance.runOnce(new Date("2026-09-22T02:20:00.000Z")),
    ).resolves.toMatchObject({
      candidatesMatched: 1,
      finalityChecks: 1,
      creditsCreated: 0,
    });

    expect(lifecycle.observations).toHaveLength(1);
    expect(finality.identities).toHaveLength(1);
    expect(orders.expiredOrderIds).toHaveLength(0);
  });

  it("does not accept a transfer whose block timestamp is after the order deadline", async () => {
    const expiring = order({
      quoteExpiresAt: new Date("2026-09-22T02:15:00.000Z"),
    });
    const late = candidate({
      blockTimestamp: new Date("2026-09-22T02:15:01.000Z"),
    });
    const { instance, lifecycle, orders } = service({
      rows: [expiring],
      pages: [{ observations: [late] }],
    });

    await expect(
      instance.runOnce(new Date("2026-09-22T02:20:00.000Z")),
    ).resolves.toMatchObject({
      candidatesMatched: 0,
      finalityChecks: 0,
    });

    expect(lifecycle.observations).toHaveLength(0);
    expect(orders.expiredOrderIds).toEqual([expiring.id]);
  });

  it("fails closed when a reconcilable order has no bounded expiry", async () => {
    const { instance } = service({
      rows: [order({ quoteExpiresAt: null })],
    });

    await expect(
      instance.runOnce(new Date("2026-09-22T02:10:00.000Z")),
    ).rejects.toEqual(
      new UsdtPaymentReconciliationError(
        "quote_expiry_missing_or_invalid",
      ),
    );
  });

  it("fails closed when the active-order or page capacity is exceeded", async () => {
    const tooMany = service({
      rows: [
        order(),
        order({
          id: "22222222-2222-4222-8222-222222222222",
          expectation: {
            ...order().expectation,
            amountAtomic: 17_000_138n,
          },
        }),
      ],
      maxOrders: 1,
    });

    await expect(tooMany.instance.runOnce()).rejects.toEqual(
      new UsdtPaymentReconciliationError(
        "reconciliation_order_capacity_exceeded",
      ),
    );
  });
});
