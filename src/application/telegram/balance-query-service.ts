export interface BalanceSummary {
  readonly availableCount: number;
  readonly reservedCount: number;
}

export interface BalanceQueryRepository {
  getByTelegramUserId(
    telegramUserId: bigint,
  ): Promise<
    | { readonly kind: "denied" }
    | { readonly kind: "ready"; readonly balance: BalanceSummary }
  >;
}

export class BalanceQueryService {
  constructor(private readonly repository: BalanceQueryRepository) {}

  get(telegramUserId: bigint) {
    if (telegramUserId <= 0n) {
      return Promise.resolve({ kind: "denied" as const });
    }

    return this.repository.getByTelegramUserId(telegramUserId);
  }
}
