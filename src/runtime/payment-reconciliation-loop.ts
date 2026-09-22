export interface PaymentReconciliationRunner {
  runOnce(scanStartedAt?: Date): Promise<unknown>;
}

export type PaymentReconciliationRetryPolicy = (
  error: unknown,
) => boolean;

function waitForNextCycle(
  intervalMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, intervalMs);

    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class PaymentReconciliationLoop {
  constructor(
    private readonly runner: PaymentReconciliationRunner,
    private readonly intervalMs: number,
    private readonly isRetryable: PaymentReconciliationRetryPolicy,
    private readonly onRetryableError: (error: unknown) => void,
  ) {
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) {
      throw new Error("intervalMs must be a positive safe integer");
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.runner.runOnce(new Date());
      } catch (error) {
        if (!this.isRetryable(error)) {
          throw error;
        }

        this.onRetryableError(error);
      }

      await waitForNextCycle(this.intervalMs, signal);
    }
  }
}
