import { describe, expect, it } from "vitest";

import { EnergyPendingRecoveryService } from "../src/application/energy/energy-pending-recovery-service.js";

describe("Energy pending delivery recovery", () => {
  it("advances past failed and foreign-provider orders while preserving the original keys", async () => {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const rows = [
      { telegramUserId: 42n, optionCode: "energy_65k", recipientAddress: "recipient-a", idempotencyKey: "a", providerName: null },
      { telegramUserId: 42n, optionCode: "energy_65k", recipientAddress: "recipient-b", idempotencyKey: "b", providerName: "previous-provider" },
      { telegramUserId: 43n, optionCode: "energy_131k", recipientAddress: "recipient-c", idempotencyKey: "c", providerName: "active-provider" },
    ];

    const recovery = new EnergyPendingRecoveryService(
      {
        async listPending(limit, afterKey) {
          return rows.filter((row) => afterKey === undefined || row.idempotencyKey > afterKey).slice(0, limit);
        },
      },
      {
        async execute(input) {
          calls.push(input.idempotencyKey);
          if (input.idempotencyKey === "a") {
            throw new Error("temporary provider error");
          }
          return { kind: "denied" };
        },
      },
      "active-provider",
      2,
      (error) => errors.push(error),
    );

    await recovery.runOnce();
    await recovery.runOnce();

    expect(calls).toEqual(["a", "c"]);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe("temporary provider error");

    await recovery.runOnce();
    expect(calls).toEqual(["a", "c", "a"]);
  });
});
