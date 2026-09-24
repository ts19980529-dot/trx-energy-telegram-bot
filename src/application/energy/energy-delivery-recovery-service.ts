import type { EnergyUsageRepository, EnergyUsageService } from "./energy-usage-service.js";

/** Resume persisted Energy deliveries through the provider bound to each order. */
export class EnergyDeliveryRecoveryService {
  private pendingCursor: string | undefined;

  constructor(
    private readonly pendingOrders: Pick<EnergyUsageRepository, "listPending">,
    private readonly energyUsage: Pick<EnergyUsageService, "execute" | "canResumeDelivery">,
    private readonly maxOrders = 50,
  ) {}

  async runOnce(): Promise<void> {
    let orders = await this.pendingOrders.listPending(this.maxOrders, this.pendingCursor);
    if (orders.length === 0 && this.pendingCursor !== undefined) {
      this.pendingCursor = undefined;
      orders = await this.pendingOrders.listPending(this.maxOrders);
    }
    for (const order of orders) {
      this.pendingCursor = order.idempotencyKey;
      // Dispatching orders remain bound to their original provider.
      if (!this.energyUsage.canResumeDelivery(order.providerName)) {
        continue;
      }
      try {
        await this.energyUsage.execute(order);
      } catch (error) {
        console.error(`Energy delivery reconciliation failed: type=${error instanceof Error ? error.name : "UnknownError"}`);
      }
    }
  }
}
