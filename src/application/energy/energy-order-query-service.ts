import type { EnergyConsumptionSnapshot } from "./energy-usage-service.js";

export type EnergyOrderPageDirection = "next" | "previous";

export type EnergyOrderPageResult =
  | { readonly kind: "denied" }
  | {
      readonly kind: "ready";
      readonly orders: readonly EnergyConsumptionSnapshot[];
      readonly previousCursor: string | null;
      readonly nextCursor: string | null;
    };

export type EnergyOrderQueryResult =
  | { readonly kind: "found"; readonly order: EnergyConsumptionSnapshot }
  | { readonly kind: "not_found" };

export interface EnergyOrderQueryRepository {
  listOwnedPage(input: {
    readonly telegramUserId: bigint;
    readonly limit: number;
    readonly cursorId?: string;
    readonly direction?: EnergyOrderPageDirection;
  }): Promise<EnergyOrderPageResult>;

  getOwned(input: {
    readonly orderId: string;
    readonly telegramUserId: bigint;
  }): Promise<EnergyConsumptionSnapshot | undefined>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class EnergyOrderQueryService {
  constructor(private readonly repository: EnergyOrderQueryRepository) {}

  async listPage(input: {
    readonly telegramUserId: bigint;
    readonly limit?: number;
    readonly cursorId?: string;
    readonly direction?: EnergyOrderPageDirection;
  }): Promise<EnergyOrderPageResult> {
    const limit = input.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) {
      throw new Error("Energy order page size must be between 1 and 10");
    }

    if (
      input.cursorId !== undefined &&
      !UUID_PATTERN.test(input.cursorId)
    ) {
      throw new Error("Energy order cursor is invalid");
    }

    if (
      input.direction !== undefined &&
      input.direction !== "next" &&
      input.direction !== "previous"
    ) {
      throw new Error("Energy order page direction is invalid");
    }

    if (input.cursorId === undefined && input.direction !== undefined) {
      throw new Error("Energy order page direction requires a cursor");
    }

    if (input.cursorId !== undefined && input.direction === undefined) {
      throw new Error("Energy order page cursor requires a direction");
    }
    return this.repository.listOwnedPage({
      telegramUserId: input.telegramUserId,
      limit,
      ...(input.cursorId === undefined
        ? {}
        : { cursorId: input.cursorId }),
      ...(input.direction === undefined
        ? {}
        : { direction: input.direction }),
    });
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
