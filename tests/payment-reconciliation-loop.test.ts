import { describe, expect, it } from "vitest";

import {
  PaymentReconciliationLoop,
  type PaymentReconciliationRunner,
} from "../src/runtime/payment-reconciliation-loop.js";

describe("PaymentReconciliationLoop", () => {
  it("runs sequentially and stops cleanly when aborted", async () => {
    const controller = new AbortController();
    let active = 0;
    let maxActive = 0;
    let calls = 0;

    const runner: PaymentReconciliationRunner = {
      async runOnce() {
        active += 1;
        maxActive = Math.max(maxActive, active);
        calls += 1;
        active -= 1;

        if (calls === 2) {
          controller.abort();
        }
      },
    };

    const loop = new PaymentReconciliationLoop(
      runner,
      1,
      () => false,
      () => undefined,
    );

    await loop.run(controller.signal);

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it("retries only explicitly retryable source failures", async () => {
    const controller = new AbortController();
    const retryable = new Error("temporary");
    let calls = 0;
    const retried: unknown[] = [];

    const loop = new PaymentReconciliationLoop(
      {
        async runOnce() {
          calls += 1;

          if (calls === 1) {
            throw retryable;
          }

          controller.abort();
        },
      },
      1,
      (error) => error === retryable,
      (error) => retried.push(error),
    );

    await loop.run(controller.signal);

    expect(calls).toBe(2);
    expect(retried).toEqual([retryable]);
  });

  it("propagates non-retryable invariant failures", async () => {
    const failure = new Error("invariant");

    const loop = new PaymentReconciliationLoop(
      {
        async runOnce() {
          throw failure;
        },
      },
      1,
      () => false,
      () => undefined,
    );

    await expect(
      loop.run(new AbortController().signal),
    ).rejects.toBe(failure);
  });
});
