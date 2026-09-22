import type {
  PaymentAsset,
  PaymentExpectation,
} from "./payment-observation.js";

export interface PurchasePackageSnapshotInput {
  readonly packageCode: string;
  readonly count: number;
  readonly priceUsdtMicros: bigint;
}

export interface PurchasePaymentQuote {
  readonly asset: PaymentAsset;
  readonly toAddress: string;
  readonly tokenContractAddress: string | null;
  readonly amountAtomic: bigint;
  readonly requiredConfirmations: number;
  readonly expiresAt?: Date | null;
}

export interface PurchaseOrderPaymentSnapshot {
  readonly packageCodeSnapshot: string;
  readonly countSnapshot: number;
  readonly priceUsdtMicrosSnapshot: bigint;
  readonly paymentAttributionOffsetAtomic?: bigint;
  readonly paymentAsset: PaymentAsset;
  readonly paymentToAddressSnapshot: string;
  readonly paymentTokenContractAddressSnapshot: string | null;
  readonly requiredConfirmationsSnapshot: number;
  readonly quotedAmountAtomic: bigint;
  readonly quoteExpiresAt: Date | null;
}

export type PurchaseOrderPaymentInvalidReason =
  | "invalid_package_snapshot"
  | "invalid_quote"
  | "asset_contract_mismatch"
  | "invalid_attribution_offset"
  | "usdt_amount_mismatch";

export type PurchaseOrderPaymentContractResult =
  | {
      readonly kind: "ready";
      readonly snapshot: PurchaseOrderPaymentSnapshot;
      readonly expectation: PaymentExpectation;
    }
  | {
      readonly kind: "invalid";
      readonly reason: PurchaseOrderPaymentInvalidReason;
    };

function nonEmptyTrimmed(value: string): string | undefined {
  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function validExpiry(value: Date | null | undefined): Date | null | undefined {
  if (value === undefined || value === null) {
    return value ?? null;
  }

  if (Number.isNaN(value.getTime())) {
    return undefined;
  }

  return new Date(value.getTime());
}

function validatePersistedSnapshot(
  snapshot: PurchaseOrderPaymentSnapshot,
): PurchaseOrderPaymentInvalidReason | undefined {
  if (
    nonEmptyTrimmed(snapshot.packageCodeSnapshot) === undefined ||
    !Number.isInteger(snapshot.countSnapshot) ||
    snapshot.countSnapshot <= 0 ||
    snapshot.priceUsdtMicrosSnapshot <= 0n
  ) {
    return "invalid_package_snapshot";
  }

  const attributionOffset =
    snapshot.paymentAttributionOffsetAtomic ?? 0n;

  if (attributionOffset < 0n) {
    return "invalid_attribution_offset";
  }

  if (
    nonEmptyTrimmed(snapshot.paymentToAddressSnapshot) === undefined ||
    snapshot.quotedAmountAtomic <= 0n ||
    !Number.isInteger(snapshot.requiredConfirmationsSnapshot) ||
    snapshot.requiredConfirmationsSnapshot <= 0 ||
    (snapshot.quoteExpiresAt !== null &&
      Number.isNaN(snapshot.quoteExpiresAt.getTime()))
  ) {
    return "invalid_quote";
  }

  if (snapshot.paymentAsset === "TRX") {
    if (snapshot.paymentTokenContractAddressSnapshot !== null) {
      return "asset_contract_mismatch";
    }

    if (attributionOffset !== 0n) {
      return "invalid_attribution_offset";
    }

    return undefined;
  }

  if (
    snapshot.paymentTokenContractAddressSnapshot === null ||
    nonEmptyTrimmed(snapshot.paymentTokenContractAddressSnapshot) === undefined
  ) {
    return "asset_contract_mismatch";
  }

  if (
    snapshot.quotedAmountAtomic !==
    snapshot.priceUsdtMicrosSnapshot + attributionOffset
  ) {
    return "usdt_amount_mismatch";
  }

  return undefined;
}

export function paymentExpectationFromOrderSnapshot(
  snapshot: PurchaseOrderPaymentSnapshot,
): PaymentExpectation | undefined {
  if (validatePersistedSnapshot(snapshot) !== undefined) {
    return undefined;
  }

  return {
    asset: snapshot.paymentAsset,
    tokenContractAddress:
      snapshot.paymentTokenContractAddressSnapshot,
    toAddress: snapshot.paymentToAddressSnapshot,
    amountAtomic: snapshot.quotedAmountAtomic,
    requiredConfirmations:
      snapshot.requiredConfirmationsSnapshot,
  };
}

export function withUsdtPaymentAttributionOffset(
  snapshot: PurchaseOrderPaymentSnapshot,
  offsetAtomic: bigint,
): PurchaseOrderPaymentSnapshot | undefined {
  if (snapshot.paymentAsset !== "USDT" || offsetAtomic < 0n) {
    return undefined;
  }

  const attributed: PurchaseOrderPaymentSnapshot = {
    ...snapshot,
    paymentAttributionOffsetAtomic: offsetAtomic,
    quotedAmountAtomic:
      snapshot.priceUsdtMicrosSnapshot + offsetAtomic,
  };

  return validatePersistedSnapshot(attributed) === undefined
    ? attributed
    : undefined;
}

export function buildPurchaseOrderPaymentContract(input: {
  readonly package: PurchasePackageSnapshotInput;
  readonly quote: PurchasePaymentQuote;
  readonly attributionOffsetAtomic?: bigint;
}): PurchaseOrderPaymentContractResult {
  const packageCode = nonEmptyTrimmed(input.package.packageCode);

  if (
    packageCode === undefined ||
    !Number.isInteger(input.package.count) ||
    input.package.count <= 0 ||
    input.package.priceUsdtMicros <= 0n
  ) {
    return {
      kind: "invalid",
      reason: "invalid_package_snapshot",
    };
  }

  const toAddress = nonEmptyTrimmed(input.quote.toAddress);
  const expiresAt = validExpiry(input.quote.expiresAt);
  const attributionOffset = input.attributionOffsetAtomic ?? 0n;

  if (attributionOffset < 0n) {
    return {
      kind: "invalid",
      reason: "invalid_attribution_offset",
    };
  }

  if (
    toAddress === undefined ||
    input.quote.amountAtomic <= 0n ||
    !Number.isInteger(input.quote.requiredConfirmations) ||
    input.quote.requiredConfirmations <= 0 ||
    expiresAt === undefined
  ) {
    return {
      kind: "invalid",
      reason: "invalid_quote",
    };
  }

  let tokenContractAddress: string | null;

  if (input.quote.asset === "TRX") {
    if (attributionOffset !== 0n) {
      return {
        kind: "invalid",
        reason: "invalid_attribution_offset",
      };
    }

    if (input.quote.tokenContractAddress !== null) {
      return {
        kind: "invalid",
        reason: "asset_contract_mismatch",
      };
    }

    tokenContractAddress = null;
  } else {
    if (input.quote.tokenContractAddress === null) {
      return {
        kind: "invalid",
        reason: "asset_contract_mismatch",
      };
    }

    const token = nonEmptyTrimmed(input.quote.tokenContractAddress);

    if (token === undefined) {
      return {
        kind: "invalid",
        reason: "asset_contract_mismatch",
      };
    }

    if (input.quote.amountAtomic !== input.package.priceUsdtMicros) {
      return {
        kind: "invalid",
        reason: "usdt_amount_mismatch",
      };
    }

    tokenContractAddress = token;
  }

  const snapshot: PurchaseOrderPaymentSnapshot = {
    packageCodeSnapshot: packageCode,
    countSnapshot: input.package.count,
    priceUsdtMicrosSnapshot: input.package.priceUsdtMicros,
    paymentAttributionOffsetAtomic: attributionOffset,
    paymentAsset: input.quote.asset,
    paymentToAddressSnapshot: toAddress,
    paymentTokenContractAddressSnapshot: tokenContractAddress,
    requiredConfirmationsSnapshot:
      input.quote.requiredConfirmations,
    quotedAmountAtomic:
      input.quote.asset === "USDT"
        ? input.quote.amountAtomic + attributionOffset
        : input.quote.amountAtomic,
    quoteExpiresAt: expiresAt ?? null,
  };

  const expectation = paymentExpectationFromOrderSnapshot(snapshot);

  if (expectation === undefined) {
    return {
      kind: "invalid",
      reason: "invalid_quote",
    };
  }

  return {
    kind: "ready",
    snapshot,
    expectation,
  };
}
