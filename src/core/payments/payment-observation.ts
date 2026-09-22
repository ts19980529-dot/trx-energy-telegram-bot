export const paymentAssets = ["TRX", "USDT"] as const;

export type PaymentAsset = (typeof paymentAssets)[number];

export type PaymentExecutionStatus = "unknown" | "success" | "failed";

export type PaymentEvidenceSource =
  | "fullnode"
  | "indexer"
  | "solidified_node"
  | "solidified_index";

export interface PaymentExpectation {
  readonly asset: PaymentAsset;
  readonly tokenContractAddress: string | null;
  readonly toAddress: string;
  readonly amountAtomic: bigint;
  readonly requiredConfirmations: number;
}

export type PaymentIdentity =
  | {
      readonly asset: "TRX";
      readonly txid: string;
      readonly tokenContractAddress: null;
      readonly eventIndex: null;
    }
  | {
      readonly asset: "USDT";
      readonly txid: string;
      readonly tokenContractAddress: string;
      readonly eventIndex: number;
    };

interface PaymentObservationBase {
  readonly fromAddress: string;
  readonly toAddress: string;
  readonly amountAtomic: bigint;
  readonly confirmations: number;
  readonly solidified: boolean;
  readonly evidenceSource: PaymentEvidenceSource;
  readonly executionStatus: PaymentExecutionStatus;
  readonly blockNumber?: bigint;
  readonly blockTimestamp?: Date;
}

export type PaymentObservation =
  | (PaymentObservationBase & {
      readonly asset: "TRX";
      readonly txid: string;
      readonly tokenContractAddress: null;
      readonly eventIndex: null;
    })
  | (PaymentObservationBase & {
      readonly asset: "USDT";
      readonly txid: string;
      readonly tokenContractAddress: string;
      readonly eventIndex: number;
    });

export interface PaymentDetectionRequest {
  readonly asset: PaymentAsset;
  readonly tokenContractAddress: string | null;
  readonly toAddress: string;
  readonly minTimestampMs?: number;
  readonly maxTimestampMs?: number;
  readonly cursor?: string;
}

export interface PaymentDetectionPage {
  readonly observations: readonly PaymentObservation[];
  readonly nextCursor?: string;
}

export interface PaymentDetector {
  readonly name: string;

  findCandidates(request: PaymentDetectionRequest): Promise<PaymentDetectionPage>;
}

export interface PaymentFinalityVerifier {
  readonly name: string;

  inspect(identity: PaymentIdentity): Promise<PaymentObservation | undefined>;
}

export type PaymentEvaluation =
  | {
      readonly kind: "invalid";
      readonly reason: "invalid_expectation" | "invalid_observation";
    }
  | {
      readonly kind: "mismatch";
      readonly reason:
        | "asset_mismatch"
        | "token_contract_mismatch"
        | "destination_mismatch"
        | "amount_mismatch";
    }
  | {
      readonly kind: "pending";
      readonly reason:
        | "not_solidified"
        | "non_authoritative_finality_source"
        | "execution_unknown"
        | "insufficient_confirmations";
    }
  | {
      readonly kind: "rejected";
      readonly reason: "execution_failed";
    }
  | {
      readonly kind: "confirmed";
    };

function isNonEmpty(value: string): boolean {
  return value.trim().length > 0;
}

function isAuthoritativeFinalitySource(source: PaymentEvidenceSource): boolean {
  return source === "solidified_node" || source === "solidified_index";
}

function isValidExpectation(expectation: PaymentExpectation): boolean {
  if (!isNonEmpty(expectation.toAddress) || expectation.amountAtomic <= 0n) {
    return false;
  }

  if (
    !Number.isInteger(expectation.requiredConfirmations) ||
    expectation.requiredConfirmations <= 0
  ) {
    return false;
  }

  if (expectation.asset === "TRX") {
    return expectation.tokenContractAddress === null;
  }

  return (
    expectation.tokenContractAddress !== null &&
    isNonEmpty(expectation.tokenContractAddress)
  );
}

function isValidObservation(observation: PaymentObservation): boolean {
  if (
    !isNonEmpty(observation.txid) ||
    !isNonEmpty(observation.fromAddress) ||
    !isNonEmpty(observation.toAddress) ||
    observation.amountAtomic <= 0n ||
    !Number.isInteger(observation.confirmations) ||
    observation.confirmations < 0
  ) {
    return false;
  }

  if (observation.asset === "TRX") {
    return (
      observation.tokenContractAddress === null &&
      observation.eventIndex === null
    );
  }

  return (
    isNonEmpty(observation.tokenContractAddress) &&
    Number.isInteger(observation.eventIndex) &&
    observation.eventIndex >= 0
  );
}

export function paymentIdentityOf(
  observation: PaymentObservation,
): PaymentIdentity {
  if (observation.asset === "TRX") {
    return {
      asset: "TRX",
      txid: observation.txid,
      tokenContractAddress: null,
      eventIndex: null,
    };
  }

  return {
    asset: "USDT",
    txid: observation.txid,
    tokenContractAddress: observation.tokenContractAddress,
    eventIndex: observation.eventIndex,
  };
}

export function evaluatePaymentObservation(
  expectation: PaymentExpectation,
  observation: PaymentObservation,
): PaymentEvaluation {
  if (!isValidExpectation(expectation)) {
    return { kind: "invalid", reason: "invalid_expectation" };
  }

  if (!isValidObservation(observation)) {
    return { kind: "invalid", reason: "invalid_observation" };
  }

  if (observation.asset !== expectation.asset) {
    return { kind: "mismatch", reason: "asset_mismatch" };
  }

  if (observation.tokenContractAddress !== expectation.tokenContractAddress) {
    return { kind: "mismatch", reason: "token_contract_mismatch" };
  }

  if (observation.toAddress !== expectation.toAddress) {
    return { kind: "mismatch", reason: "destination_mismatch" };
  }

  if (observation.amountAtomic !== expectation.amountAtomic) {
    return { kind: "mismatch", reason: "amount_mismatch" };
  }

  if (!observation.solidified) {
    return { kind: "pending", reason: "not_solidified" };
  }

  if (!isAuthoritativeFinalitySource(observation.evidenceSource)) {
    return {
      kind: "pending",
      reason: "non_authoritative_finality_source",
    };
  }

  if (observation.executionStatus === "failed") {
    return { kind: "rejected", reason: "execution_failed" };
  }

  if (observation.executionStatus === "unknown") {
    return { kind: "pending", reason: "execution_unknown" };
  }

  if (observation.confirmations < expectation.requiredConfirmations) {
    return { kind: "pending", reason: "insufficient_confirmations" };
  }

  return { kind: "confirmed" };
}
