import { describe, expect, it } from "vitest";

import {
  canTransitionEnergyConsumption,
  canTransitionPurchaseOrder,
} from "../src/core/orders/state-machine.js";

describe("purchase order state machine", () => {
  it("allows the normal confirmed-payment path", () => {
    expect(canTransitionPurchaseOrder("created", "waiting_payment")).toBe(true);
    expect(
      canTransitionPurchaseOrder("waiting_payment", "payment_detected"),
    ).toBe(true);
    expect(canTransitionPurchaseOrder("payment_detected", "confirming")).toBe(
      true,
    );
    expect(canTransitionPurchaseOrder("confirming", "paid")).toBe(true);
    expect(canTransitionPurchaseOrder("paid", "credited")).toBe(true);
  });

  it("does not allow bypassing payment confirmation", () => {
    expect(canTransitionPurchaseOrder("waiting_payment", "credited")).toBe(
      false,
    );
    expect(canTransitionPurchaseOrder("payment_detected", "credited")).toBe(
      false,
    );
  });

  it("keeps credited orders terminal", () => {
    expect(canTransitionPurchaseOrder("credited", "paid")).toBe(false);
  });
});

describe("energy consumption state machine", () => {
  it("requires reservation before dispatch", () => {
    expect(canTransitionEnergyConsumption("created", "reserved")).toBe(true);
    expect(canTransitionEnergyConsumption("created", "dispatching")).toBe(
      false,
    );
  });

  it("requires failed reserved consumption to release the reservation", () => {
    expect(
      canTransitionEnergyConsumption("dispatching", "delivery_failed"),
    ).toBe(true);
    expect(canTransitionEnergyConsumption("delivery_failed", "released")).toBe(
      true,
    );
  });

  it("keeps completed consumption terminal", () => {
    expect(canTransitionEnergyConsumption("completed", "released")).toBe(
      false,
    );
  });
});
