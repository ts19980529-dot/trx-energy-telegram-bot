import type {
  PurchasePaymentQuoteProvider,
  PurchasePaymentQuoteRequest,
  PurchasePaymentQuoteResult,
} from "../../core/payments/purchase-payment-quote.js";

export interface ConfiguredUsdtPurchaseQuoteConfig {
  readonly toAddress: string;
  readonly tokenContractAddress: string;
  readonly requiredConfirmations: number;
  readonly quoteTtlMs?: number | null;
}

function nonEmptyTrimmed(value: string, field: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty`);
  }

  return trimmed;
}

function validPackage(
  request: PurchasePaymentQuoteRequest,
): boolean {
  return (
    request.package.packageCode.trim().length > 0 &&
    Number.isInteger(request.package.count) &&
    request.package.count > 0 &&
    request.package.priceUsdtMicros > 0n &&
    !Number.isNaN(request.requestedAt.getTime())
  );
}

export class ConfiguredUsdtPurchaseQuoteProvider
  implements PurchasePaymentQuoteProvider
{
  readonly name = "configured-usdt";

  private readonly toAddress: string;
  private readonly tokenContractAddress: string;
  private readonly requiredConfirmations: number;
  private readonly quoteTtlMs: number | null;

  constructor(config: ConfiguredUsdtPurchaseQuoteConfig) {
    this.toAddress = nonEmptyTrimmed(
      config.toAddress,
      "toAddress",
    );
    this.tokenContractAddress = nonEmptyTrimmed(
      config.tokenContractAddress,
      "tokenContractAddress",
    );

    if (
      !Number.isInteger(config.requiredConfirmations) ||
      config.requiredConfirmations <= 0
    ) {
      throw new Error(
        "requiredConfirmations must be a positive integer",
      );
    }

    this.requiredConfirmations = config.requiredConfirmations;

    if (config.quoteTtlMs === undefined || config.quoteTtlMs === null) {
      this.quoteTtlMs = null;
    } else {
      if (
        !Number.isSafeInteger(config.quoteTtlMs) ||
        config.quoteTtlMs <= 0
      ) {
        throw new Error("quoteTtlMs must be a positive safe integer");
      }

      this.quoteTtlMs = config.quoteTtlMs;
    }
  }

  async quote(
    request: PurchasePaymentQuoteRequest,
  ): Promise<PurchasePaymentQuoteResult> {
    if (request.asset !== "USDT") {
      return {
        kind: "unsupported_asset",
        asset: request.asset,
      };
    }

    if (!validPackage(request)) {
      return { kind: "invalid_request" };
    }

    let expiresAt: Date | null = null;

    if (this.quoteTtlMs !== null) {
      const expirationMs =
        request.requestedAt.getTime() + this.quoteTtlMs;
      const candidate = new Date(expirationMs);

      if (Number.isNaN(candidate.getTime())) {
        return { kind: "invalid_request" };
      }

      expiresAt = candidate;
    }

    return {
      kind: "ready",
      quote: {
        asset: "USDT",
        toAddress: this.toAddress,
        tokenContractAddress: this.tokenContractAddress,
        amountAtomic: request.package.priceUsdtMicros,
        requiredConfirmations: this.requiredConfirmations,
        expiresAt,
      },
    };
  }
}
