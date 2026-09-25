import type {
  EnergyConsumptionSnapshot,
  EnergyUsageRepository,
} from "./energy-usage-service.js";

export type EnergyOrderListResult =
  | { readonly kind: "denied" }
  | {
      readonly kind: "ready";
      readonly orders: readonly EnergyConsumptionSnapshot[];
    };

export type EnergyOrderQueryResult =
  | { readonly kind: "found"; readonly order: EnergyConsumptionSnapshot }
  | { readonly kind: "not_found" };

export class EnergyOrderQueryService {
  constructor(
    private readonly repository: Pick<
      EnergyUsageRepository,
      "listOwned" | "getOwned"
    >,
  ) {}

  async listRecent(input: {
    readonly telegramUserId: bigint;
    readonly limit?: number;
  }): Promise<EnergyOrderListResult> {
    const limit = input.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new Error("Energy recent-order limit must be between 1 and 10");
    }

    if (this.repository.listOwned === undefined) {
      throw new Error("Energy recent-order repository capability is unavailable");
    }

    return this.repository.listOwned(input.telegramUserId, limit);
  }

  async get(input: {
    readonly orderId: string;
    readonly telegramUserId: bigint;
  }): Promise<EnergyOrderQueryResult> {
    if (input.orderId.trim().length === 0 || input.telegramUserId <= 0n) {
      return { kind: "not_found" };
    }

    const order = await this.repository.getOwned(input);
    return order === undefined
      ? { kind: "not_found" }
      : { kind: "found", order };
  }
}
