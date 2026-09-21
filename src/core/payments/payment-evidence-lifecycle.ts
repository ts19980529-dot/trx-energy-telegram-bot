import {
  canTransitionPurchaseOrder,
  type PurchaseOrderState,
} from "../orders/state-machine.js";
import type { PaymentEvaluation } from "./payment-observation.js";

export const paymentTransactionLifecycleStates = [
  "detected",
  "confirming",
  "confirmed",
  "rejected",
] as const;

export type PaymentTransactionLifecycleState =
  (typeof paymentTransactionLifecycleStates)[number];

export type PaymentLifecyclePlan =
  | {
      readonly kind: "ignore";
      readonly reason:
        | "invalid_evidence"
        | "reconciliation_mismatch";
    }
  | {
      readonly kind: "terminal_noop";
      readonly orderState:
        | "paid"
        | "credited"
        | "expired"
        | "failed";
    }
  | {
      readonly kind: "invalid_order_state";
      readonly orderState: "created";
    }
  | {
      readonly kind: "state_conflict";
      readonly reason:
        | "transaction_terminal_conflict"
        | "order_terminal_conflict";
    }
  | {
      readonly kind: "apply";
      readonly transactionStatus: PaymentTransactionLifecycleState;
      readonly orderTransitions: readonly PurchaseOrderState[];
    };

interface LifecycleTarget {
  readonly transactionStatus: PaymentTransactionLifecycleState;
}

function targetForEvaluation(
  evaluation: PaymentEvaluation,
): LifecycleTarget | undefined {
  if (evaluation.kind === "pending") {
    if (
      evaluation.reason === "not_solidified" ||
      evaluation.reason === "non_authoritative_finality_source"
    ) {
      return {
        transactionStatus: "detected",
      };
    }

    return {
      transactionStatus: "confirming",
    };
  }

  if (evaluation.kind === "rejected") {
    return {
      transactionStatus: "rejected",
    };
  }

  if (evaluation.kind === "confirmed") {
    return {
      transactionStatus: "confirmed",
    };
  }

  return undefined;
}

function mergeTransactionStatus(
  current: PaymentTransactionLifecycleState | undefined,
  requested: PaymentTransactionLifecycleState,
):
  | {
      readonly kind: "ok";
      readonly status: PaymentTransactionLifecycleState;
    }
  | {
      readonly kind: "conflict";
    } {
  if (current === undefined || current === requested) {
    return {
      kind: "ok",
      status: requested,
    };
  }

  if (current === "detected") {
    return {
      kind: "ok",
      status: requested,
    };
  }

  if (current === "confirming") {
    return {
      kind: "ok",
      status:
        requested === "detected"
          ? "confirming"
          : requested,
    };
  }

  if (current === "confirmed") {
    if (requested === "rejected") {
      return { kind: "conflict" };
    }

    return {
      kind: "ok",
      status: "confirmed",
    };
  }

  if (requested === "confirmed") {
    return { kind: "conflict" };
  }

  return {
    kind: "ok",
    status: "rejected",
  };
}

function orderTargetForTransaction(
  status: PaymentTransactionLifecycleState,
):
  | "payment_detected"
  | "confirming"
  | "paid"
  | "failed" {
  if (status === "detected") {
    return "payment_detected";
  }

  if (status === "confirming") {
    return "confirming";
  }

  if (status === "confirmed") {
    return "paid";
  }

  return "failed";
}

function happyPathTransitions(
  current: "waiting_payment" | "payment_detected" | "confirming",
  target: "payment_detected" | "confirming" | "paid",
): readonly PurchaseOrderState[] | undefined {
  const path: readonly PurchaseOrderState[] = [
    "waiting_payment",
    "payment_detected",
    "confirming",
    "paid",
  ];

  const currentIndex = path.indexOf(current);
  const targetIndex = path.indexOf(target);

  if (currentIndex < 0 || targetIndex < 0) {
    return undefined;
  }

  if (targetIndex <= currentIndex) {
    return [];
  }

  const transitions = path.slice(currentIndex + 1, targetIndex + 1);

  let from: PurchaseOrderState = current;

  for (const to of transitions) {
    if (!canTransitionPurchaseOrder(from, to)) {
      return undefined;
    }

    from = to;
  }

  return transitions;
}

function rejectedTransitions(
  current: "waiting_payment" | "payment_detected" | "confirming",
): readonly PurchaseOrderState[] | undefined {
  if (current === "waiting_payment") {
    if (
      !canTransitionPurchaseOrder(
        "waiting_payment",
        "payment_detected",
      ) ||
      !canTransitionPurchaseOrder("payment_detected", "failed")
    ) {
      return undefined;
    }

    return ["payment_detected", "failed"];
  }

  if (!canTransitionPurchaseOrder(current, "failed")) {
    return undefined;
  }

  return ["failed"];
}

function terminalOrderPlan(
  orderState: "paid" | "credited" | "expired" | "failed",
  transactionStatus: PaymentTransactionLifecycleState,
): PaymentLifecyclePlan {
  if (orderState === "expired") {
    return {
      kind: "terminal_noop",
      orderState,
    };
  }

  if (
    (orderState === "paid" || orderState === "credited") &&
    transactionStatus === "rejected"
  ) {
    return {
      kind: "state_conflict",
      reason: "order_terminal_conflict",
    };
  }

  if (
    orderState === "failed" &&
    transactionStatus === "confirmed"
  ) {
    return {
      kind: "state_conflict",
      reason: "order_terminal_conflict",
    };
  }

  return {
    kind: "terminal_noop",
    orderState,
  };
}

export function planPaymentEvidenceLifecycle(input: {
  readonly evaluation: PaymentEvaluation;
  readonly orderState: PurchaseOrderState;
  readonly currentTransactionStatus?: PaymentTransactionLifecycleState;
}): PaymentLifecyclePlan {
  if (input.evaluation.kind === "invalid") {
    return {
      kind: "ignore",
      reason: "invalid_evidence",
    };
  }

  if (input.evaluation.kind === "mismatch") {
    return {
      kind: "ignore",
      reason: "reconciliation_mismatch",
    };
  }

  const target = targetForEvaluation(input.evaluation);

  if (target === undefined) {
    return {
      kind: "ignore",
      reason: "invalid_evidence",
    };
  }

  const merged = mergeTransactionStatus(
    input.currentTransactionStatus,
    target.transactionStatus,
  );

  if (merged.kind === "conflict") {
    return {
      kind: "state_conflict",
      reason: "transaction_terminal_conflict",
    };
  }

  if (input.orderState === "created") {
    return {
      kind: "invalid_order_state",
      orderState: "created",
    };
  }

  if (
    input.orderState === "paid" ||
    input.orderState === "credited" ||
    input.orderState === "expired" ||
    input.orderState === "failed"
  ) {
    return terminalOrderPlan(
      input.orderState,
      merged.status,
    );
  }

  const orderTarget = orderTargetForTransaction(merged.status);
  const orderTransitions =
    orderTarget === "failed"
      ? rejectedTransitions(input.orderState)
      : happyPathTransitions(
          input.orderState,
          orderTarget,
        );

  if (orderTransitions === undefined) {
    return {
      kind: "invalid_order_state",
      orderState: "created",
    };
  }

  return {
    kind: "apply",
    transactionStatus: merged.status,
    orderTransitions,
  };
}
