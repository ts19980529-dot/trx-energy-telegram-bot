export const purchaseOrderStates = [
  "created",
  "waiting_payment",
  "payment_detected",
  "confirming",
  "paid",
  "credited",
  "expired",
  "failed",
] as const;

export type PurchaseOrderState = (typeof purchaseOrderStates)[number];

const purchaseTransitions: Record<
  PurchaseOrderState,
  readonly PurchaseOrderState[]
> = {
  created: ["waiting_payment"],
  waiting_payment: ["payment_detected", "expired"],
  payment_detected: ["confirming", "failed"],
  confirming: ["paid", "failed"],
  paid: ["credited"],
  credited: [],
  expired: [],
  failed: [],
};

export function canTransitionPurchaseOrder(
  from: PurchaseOrderState,
  to: PurchaseOrderState,
): boolean {
  return purchaseTransitions[from].includes(to);
}

export const energyConsumptionStates = [
  "created",
  "reserved",
  "dispatching",
  "completed",
  "delivery_failed",
  "released",
  "cancelled",
] as const;

export type EnergyConsumptionState =
  (typeof energyConsumptionStates)[number];

const energyConsumptionTransitions: Record<
  EnergyConsumptionState,
  readonly EnergyConsumptionState[]
> = {
  created: ["reserved", "cancelled"],
  reserved: ["dispatching", "released"],
  dispatching: ["completed", "delivery_failed"],
  completed: [],
  delivery_failed: ["released"],
  released: [],
  cancelled: [],
};

export function canTransitionEnergyConsumption(
  from: EnergyConsumptionState,
  to: EnergyConsumptionState,
): boolean {
  return energyConsumptionTransitions[from].includes(to);
}
