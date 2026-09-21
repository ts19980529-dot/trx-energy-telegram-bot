import type {
  PaymentEvidenceSource,
  PaymentExecutionStatus,
  PaymentObservation,
} from "./payment-observation.js";

export const tronAddressEncodings = ["base58check", "hex41"] as const;

export type TronAddressEncoding = (typeof tronAddressEncodings)[number];

export interface TronEncodedAddress {
  readonly encoding: TronAddressEncoding;
  readonly value: string;
}

export interface TronAddressCodec {
  readonly name: string;

  /**
   * Converts and checksum-validates a TRON address into canonical Base58Check.
   * Returns undefined when the input is malformed or has an invalid checksum.
   */
  toBase58Check(address: TronEncodedAddress): string | undefined;
}

interface RawTronEvidenceBase {
  readonly txid: string;
  readonly fromAddress: TronEncodedAddress;
  readonly toAddress: TronEncodedAddress;
  readonly amountAtomic: string;
  readonly confirmations: number;
  readonly evidenceSource: PaymentEvidenceSource;
  readonly executionStatus: PaymentExecutionStatus;
  readonly blockNumber?: string;
  readonly blockTimestampMs?: string;
}

export type RawTronPaymentEvidence =
  | (RawTronEvidenceBase & {
      readonly asset: "TRX";
      readonly tokenContractAddress: null;
      readonly eventIndex: null;
    })
  | (RawTronEvidenceBase & {
      readonly asset: "USDT";
      readonly tokenContractAddress: TronEncodedAddress;
      readonly eventIndex: number;
    });

const evidenceSources: readonly PaymentEvidenceSource[] = [
  "fullnode",
  "indexer",
  "solidified_node",
  "solidified_index",
];

const executionStatuses: readonly PaymentExecutionStatus[] = [
  "unknown",
  "success",
  "failed",
];

const CANONICAL_BASE58CHECK_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const TXID_PATTERN = /^[0-9a-fA-F]{64}$/;
const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_DATE_MS = 8_640_000_000_000_000n;

function isEvidenceSource(value: unknown): value is PaymentEvidenceSource {
  return evidenceSources.includes(value as PaymentEvidenceSource);
}

function isExecutionStatus(value: unknown): value is PaymentExecutionStatus {
  return executionStatuses.includes(value as PaymentExecutionStatus);
}

function normalizeTxid(value: unknown): string | undefined {
  if (typeof value !== "string" || !TXID_PATTERN.test(value)) {
    return undefined;
  }

  return value.toLowerCase();
}

function parseUnsignedDecimal(
  value: unknown,
  allowZero: boolean,
): bigint | undefined {
  if (typeof value !== "string" || !UNSIGNED_DECIMAL_PATTERN.test(value)) {
    return undefined;
  }

  const parsed = BigInt(value);

  if (allowZero ? parsed < 0n : parsed <= 0n) {
    return undefined;
  }

  return parsed;
}

function normalizeAddress(
  codec: TronAddressCodec,
  address: TronEncodedAddress,
): string | undefined {
  if (
    !tronAddressEncodings.includes(address.encoding) ||
    typeof address.value !== "string" ||
    address.value.length === 0
  ) {
    return undefined;
  }

  const normalized = codec.toBase58Check(address);

  if (
    normalized === undefined ||
    !CANONICAL_BASE58CHECK_PATTERN.test(normalized)
  ) {
    return undefined;
  }

  return normalized;
}

function normalizedTimestamp(
  value: string | undefined,
): Date | undefined | null {
  if (value === undefined) {
    return undefined;
  }

  const parsed = parseUnsignedDecimal(value, true);

  if (parsed === undefined || parsed > MAX_DATE_MS) {
    return null;
  }

  const numeric = Number(parsed);

  if (!Number.isSafeInteger(numeric)) {
    return null;
  }

  const timestamp = new Date(numeric);

  return Number.isNaN(timestamp.getTime()) ? null : timestamp;
}

function isAuthoritativeSource(source: PaymentEvidenceSource): boolean {
  return source === "solidified_node" || source === "solidified_index";
}

export function normalizeTronPaymentEvidence(
  raw: RawTronPaymentEvidence,
  addressCodec: TronAddressCodec,
): PaymentObservation | undefined {
  const txid = normalizeTxid(raw.txid);
  const fromAddress = normalizeAddress(addressCodec, raw.fromAddress);
  const toAddress = normalizeAddress(addressCodec, raw.toAddress);
  const amountAtomic = parseUnsignedDecimal(raw.amountAtomic, false);

  if (
    txid === undefined ||
    fromAddress === undefined ||
    toAddress === undefined ||
    amountAtomic === undefined ||
    !Number.isInteger(raw.confirmations) ||
    raw.confirmations < 0 ||
    !isEvidenceSource(raw.evidenceSource) ||
    !isExecutionStatus(raw.executionStatus)
  ) {
    return undefined;
  }

  const blockNumber =
    raw.blockNumber === undefined
      ? undefined
      : parseUnsignedDecimal(raw.blockNumber, true);

  if (raw.blockNumber !== undefined && blockNumber === undefined) {
    return undefined;
  }

  const blockTimestamp = normalizedTimestamp(raw.blockTimestampMs);

  if (blockTimestamp === null) {
    return undefined;
  }

  const common = {
    txid,
    fromAddress,
    toAddress,
    amountAtomic,
    confirmations: raw.confirmations,
    solidified: isAuthoritativeSource(raw.evidenceSource),
    evidenceSource: raw.evidenceSource,
    executionStatus: raw.executionStatus,
    ...(blockNumber === undefined ? {} : { blockNumber }),
    ...(blockTimestamp === undefined ? {} : { blockTimestamp }),
  };

  if (raw.asset === "TRX") {
    if (raw.tokenContractAddress !== null || raw.eventIndex !== null) {
      return undefined;
    }

    return {
      ...common,
      asset: "TRX",
      tokenContractAddress: null,
      eventIndex: null,
    };
  }

  if (
    raw.asset !== "USDT" ||
    !Number.isInteger(raw.eventIndex) ||
    raw.eventIndex < 0
  ) {
    return undefined;
  }

  const tokenContractAddress = normalizeAddress(
    addressCodec,
    raw.tokenContractAddress,
  );

  if (tokenContractAddress === undefined) {
    return undefined;
  }

  return {
    ...common,
    asset: "USDT",
    tokenContractAddress,
    eventIndex: raw.eventIndex,
  };
}
