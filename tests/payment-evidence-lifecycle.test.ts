import { describe, expect, it } from "vitest";

import { planPaymentEvidenceLifecycle } from "../src/core/payments/payment-evidence-lifecycle.js";
import type { PaymentEvaluation } from "../src/core/payments/payment-observation.js";

describe("payment evidence lifecycle", () => {
  it.each([
    {
      evaluation: {
        kind: "invalid",
        reason: "invalid_observation",
      } as const,
      expected: {
        kind: "ignore",
        reason: "invalid_evidence",
      },
    },
    {
      evaluation: {
        kind: "mismatch",
        reason: "amount_mismatch",
      } as const,
      expected: {
        kind: "ignore",
        reason: "reconciliation_mismatch",
      },
    },
  ])(
    "does not mutate order lifecycle for invalid or reconciliation evidence",
    ({ evaluation, expected }) => {
      expect(
        planPaymentEvidenceLifecycle({
          evaluation,
          orderState: "waiting_payment",
        }),
      ).toEqual(expected);
    },
  );

  it.each([
    "not_solidified",
    "non_authoritative_finality_source",
  ] as const)(
    "keeps early pending evidence at detected for %s",
    (reason) => {
      expect(
        planPaymentEvidenceLifecycle({
          evaluation: { kind: "pending", reason },
          orderState: "waiting_payment",
        }),
      ).toEqual({
        kind: "apply",
        transactionStatus: "detected",
        orderTransitions: ["payment_detected"],
      });
    },
  );

  it.each([
    "execution_unknown",
    "insufficient_confirmations",
  ] as const)(
    "moves authoritative pending evidence to confirming for %s",
    (reason) => {
      expect(
        planPaymentEvidenceLifecycle({
          evaluation: { kind: "pending", reason },
          orderState: "waiting_payment",
        }),
      ).toEqual({
        kind: "apply",
        transactionStatus: "confirming",
        orderTransitions: [
          "payment_detected",
          "confirming",
        ],
      });
    },
  );

  it("walks every legal state when a first authoritative observation is already confirmed", () => {
    expect(
      planPaymentEvidenceLifecycle({
        evaluation: { kind: "confirmed" },
        orderState: "waiting_payment",
      }),
    ).toEqual({
      kind: "apply",
      transactionStatus: "confirmed",
      orderTransitions: [
        "payment_detected",
        "confirming",
        "paid",
      ],
    });
  });

  it("continues from payment_detected without replaying completed transitions", () => {
    expect(
      planPaymentEvidenceLifecycle({
        evaluation: { kind: "confirmed" },
        orderState: "payment_detected",
        currentTransactionStatus: "detected",
      }),
    ).toEqual({
      kind: "apply",
      transactionStatus: "confirmed",
      orderTransitions: ["confirming", "paid"],
    });
  });

  it("does not downgrade confirming transaction/order on weaker repeated evidence", () => {
    expect(
      planPaymentEvidenceLifecycle({
        evaluation: {
          kind: "pending",
          reason: "not_solidified",
        },
        orderState: "confirming",
        currentTransactionStatus: "confirming",
      }),
    ).toEqual({
      kind: "apply",
      transactionStatus: "confirming",
      orderTransitions: [],
    });
  });

  it("uses an already-confirmed transaction to finish a lagging active order without downgrading", () => {
    expect(
      planPaymentEvidenceLifecycle({
        evaluation: {
          kind: "pending",
          reason: "not_solidified",
        },
        orderState: "confirming",
        currentTransactionStatus: "confirmed",
      }),
    ).toEqual({
      kind: "apply",
      transactionStatus: "confirmed",
      orderTransitions: ["paid"],
    });
  });

  it("uses an already-rejected transaction to finish a lagging active order without downgrading", () => {
    expect(
      planPaymentEvidenceLifecycle({
        evaluation: {
          kind: "pending",
          reason: "not_solidified",
        },
        orderState: "payment_detected",
        currentTransactionStatus: "rejected",
      }),
    ).toEqual({
      kind: "apply",
      transactionStatus: "rejected",
      orderTransitions: ["failed"],
    });
  });

  it("moves an authoritative execution failure through detected to failed", () => {
    expect(
      planPaymentEvidenceLifecycle({
        evaluation: {
          kind: "rejected",
          reason: "execution_failed",
        },
        orderState: "waiting_payment",
      }),
    ).toEqual({
      kind: "apply",
      transactionStatus: "rejected",
      orderTransitions: ["payment_detected", "failed"],
    });
  });

  it("moves a confirming order directly to failed only for authoritative rejection", () => {
    expect(
      planPaymentEvidenceLifecycle({
        evaluation: {
          kind: "rejected",
          reason: "execution_failed",
        },
        orderState: "confirming",
        currentTransactionStatus: "confirming",
      }),
    ).toEqual({
      kind: "apply",
      transactionStatus: "rejected",
      orderTransitions: ["failed"],
    });
  });

  it.each([
    "paid",
    "credited",
  ] as const)(
    "keeps terminal order state %s unchanged on repeated success evidence",
    (orderState) => {
      expect(
        planPaymentEvidenceLifecycle({
          evaluation: { kind: "confirmed" },
          orderState,
          currentTransactionStatus: "confirmed",
        }),
      ).toEqual({
        kind: "terminal_noop",
        orderState,
      });
    },
  );

  it("keeps an expired order terminal on late matching evidence", () => {
    expect(
      planPaymentEvidenceLifecycle({
        evaluation: { kind: "confirmed" },
        orderState: "expired",
      }),
    ).toEqual({
      kind: "terminal_noop",
      orderState: "expired",
    });
  });

  it("keeps a failed order unchanged on repeated rejected evidence", () => {
    expect(
      planPaymentEvidenceLifecycle({
        evaluation: {
          kind: "rejected",
          reason: "execution_failed",
        },
        orderState: "failed",
        currentTransactionStatus: "rejected",
      }),
    ).toEqual({
      kind: "terminal_noop",
      orderState: "failed",
    });
  });

  it("fails closed on confirmed-versus-rejected transaction terminal conflicts", () => {
    expect(
      planPaymentEvidenceLifecycle({
        evaluation: {
          kind: "rejected",
          reason: "execution_failed",
        },
        orderState: "paid",
        currentTransactionStatus: "confirmed",
      }),
    ).toEqual({
      kind: "state_conflict",
      reason: "transaction_terminal_conflict",
    });

    expect(
      planPaymentEvidenceLifecycle({
        evaluation: { kind: "confirmed" },
        orderState: "failed",
        currentTransactionStatus: "rejected",
      }),
    ).toEqual({
      kind: "state_conflict",
      reason: "transaction_terminal_conflict",
    });
  });

  it("fails closed when terminal order state contradicts effective transaction state", () => {
    expect(
      planPaymentEvidenceLifecycle({
        evaluation: {
          kind: "rejected",
          reason: "execution_failed",
        },
        orderState: "paid",
      }),
    ).toEqual({
      kind: "state_conflict",
      reason: "order_terminal_conflict",
    });

    expect(
      planPaymentEvidenceLifecycle({
        evaluation: { kind: "confirmed" },
        orderState: "failed",
      }),
    ).toEqual({
      kind: "state_conflict",
      reason: "order_terminal_conflict",
    });
  });

  it("fails closed if an externally visible order is still in created", () => {
    expect(
      planPaymentEvidenceLifecycle({
        evaluation: {
          kind: "pending",
          reason: "not_solidified",
        },
        orderState: "created",
      }),
    ).toEqual({
      kind: "invalid_order_state",
      orderState: "created",
    });
  });

  it("uses only the existing purchase-order state machine transitions", () => {
    const evaluations: PaymentEvaluation[] = [
      { kind: "pending", reason: "not_solidified" },
      { kind: "pending", reason: "execution_unknown" },
      { kind: "rejected", reason: "execution_failed" },
      { kind: "confirmed" },
    ];

    for (const evaluation of evaluations) {
      const plan = planPaymentEvidenceLifecycle({
        evaluation,
        orderState: "payment_detected",
        currentTransactionStatus: "detected",
      });

      expect(plan.kind).toBe("apply");

      if (plan.kind === "apply") {
        expect(plan.orderTransitions).not.toContain("created");
        expect(plan.orderTransitions).not.toContain(
          "waiting_payment",
        );
      }
    }
  });
});
