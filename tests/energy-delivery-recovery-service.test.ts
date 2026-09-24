import { describe, expect, it, vi } from "vitest";

import { EnergyDeliveryRecoveryService } from "../src/application/energy/energy-delivery-recovery-service.js";

describe("durable Energy delivery recovery", () => {
  it("continues past failed orders and waits for the order's registered provider", async () => {
    const pending = ["a", "b", "c"].map((idempotencyKey) => ({
      telegramUserId: 1n, optionCode: "energy", recipientAddress: "recipient", idempotencyKey,
      providerName: idempotencyKey === "b" ? "previous-provider" : null,
    }));
    const listPending = vi.fn(async (limit: number, afterKey?: string) =>
      pending.filter((order) => afterKey === undefined || order.idempotencyKey > afterKey).slice(0, limit));
    const execute = vi.fn(async (_order: (typeof pending)[number]) => { throw new Error("temporary outage"); });
    let previousRegistered = false;
    const canResumeDelivery = (name: string | null) =>
      name === null || name === "tron-own-pool" ||
      (previousRegistered && name === "previous-provider");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new EnergyDeliveryRecoveryService(
        { listPending }, { execute, canResumeDelivery }, 1,
      );
      for (let i = 0; i < 4; i++) await service.runOnce();
      expect(execute.mock.calls.map(([order]) => order.idempotencyKey)).toEqual(["a", "c", "a"]);
      previousRegistered = true;
      await service.runOnce();
      expect(execute.mock.calls.map(([order]) => order.idempotencyKey)).toEqual(["a", "c", "a", "b"]);
    } finally {
      errors.mockRestore();
    }
  });
});
