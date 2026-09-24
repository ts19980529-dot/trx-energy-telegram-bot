import type {
  EnergyUsageRepository,
  EnergyUsageService,
} from "./energy-usage-service.js";

export class EnergyPendingRecoveryService {
  private afterKey: string | undefined;

  constructor(
    private readonly repository: Pick<EnergyUsageRepository, "listPending">,
    private readonly usage: Pick<EnergyUsageService, "execute">,
    private readonly providerName: string,
    private readonly limit: number,
    private readonly onRecoveryError: (error: unknown) => void,
  ) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Energy recovery scan limit must be between 1 and 100");
    }
    if (providerName.trim().length === 0) {
      throw new Error("Energy recovery provider name is required");
    }
  }

  async runOnce(): Promise<void> {
    const pending = await this.repository.listPending(this.limit, this.afterKey);

    if (pending.length === 0) {
      this.afterKey = undefined;
      return;
    }

    for (const order of pending) {
      // The cursor is only a scheduling hint. The database holds the orders
      // and their idempotency keys, including across runtime restarts.
      this.afterKey = order.idempotencyKey;

      if (order.providerName !== null && order.providerName !== this.providerName) {
        continue;
      }

      try {
        await this.usage.execute({
          telegramUserId: order.telegramUserId,
          optionCode: order.optionCode,
          recipientAddress: order.recipientAddress,
          idempotencyKey: order.idempotencyKey,
        });
      } catch (error) {
        // One unavailable order must not prevent later orders from recovering.
        this.onRecoveryError(error);
      }
    }

    if (pending.length < this.limit) {
      this.afterKey = undefined;
    }
  }
}
