import type {
  PaymentDetectionPage,
  PaymentDetectionRequest,
  PaymentDetector,
  PaymentObservation,
} from "../../core/payments/payment-observation.js";
import type { TronReadUnavailableReason } from "../../core/payments/tron-read-source.js";
import type {
  TronAddressCodec,
  TronEncodedAddress,
} from "../../core/payments/tron-evidence-normalization.js";
import type {
  TronGridCandidatePageResult,
  TronGridUsdtCandidateHttpTransport,
} from "./trongrid-candidate-http-transport.js";

const TXID_PATTERN = /^[0-9a-fA-F]{64}$/;
const BASE58_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const HEX41_PATTERN = /^41[0-9a-fA-F]{40}$/;
const HEX20_WITH_PREFIX_PATTERN = /^0x[0-9a-fA-F]{40}$/;
const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

export class TronGridCandidateAdapterError extends Error {
  constructor(readonly reason: TronReadUnavailableReason) {
    super(`TronGrid candidate adapter unavailable: ${reason}`);
    this.name = "TronGridCandidateAdapterError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function normalizeTxid(value: unknown): string | undefined {
  return typeof value === "string" && TXID_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

function encodedAddress(
  value: unknown,
): TronEncodedAddress | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  if (BASE58_PATTERN.test(value)) {
    return {
      encoding: "base58check",
      value,
    };
  }

  if (HEX41_PATTERN.test(value)) {
    return {
      encoding: "hex41",
      value: value.toLowerCase(),
    };
  }

  if (HEX20_WITH_PREFIX_PATTERN.test(value)) {
    return {
      encoding: "hex41",
      value: `41${value.slice(2).toLowerCase()}`,
    };
  }

  return undefined;
}

function normalizeAddress(
  codec: TronAddressCodec,
  value: unknown,
): string | undefined {
  const encoded = encodedAddress(value);

  if (encoded === undefined) {
    return undefined;
  }

  return codec.toBase58Check(encoded);
}

function parseUnsignedBigint(
  value: unknown,
  allowZero: boolean,
): bigint | undefined {
  let decimal: string;

  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    decimal = String(value);
  } else if (
    typeof value === "string" &&
    UNSIGNED_DECIMAL_PATTERN.test(value)
  ) {
    decimal = value;
  } else {
    return undefined;
  }

  const parsed = BigInt(decimal);

  if (allowZero ? parsed < 0n : parsed <= 0n) {
    return undefined;
  }

  return parsed;
}

function parseTimestamp(value: unknown): Date | undefined {
  const parsed = parseUnsignedBigint(value, true);

  if (
    parsed === undefined ||
    parsed > BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return undefined;
  }

  const timestamp = new Date(Number(parsed));

  return Number.isNaN(timestamp.getTime())
    ? undefined
    : timestamp;
}

function requireOk(
  result: TronGridCandidatePageResult,
): Record<string, unknown> {
  if (result.kind === "unavailable") {
    throw new TronGridCandidateAdapterError(result.reason);
  }

  return result.body;
}

function parseHistoryPage(
  body: Record<string, unknown>,
): {
  readonly transactionIds: readonly string[];
  readonly nextCursor?: string;
} {
  if (body.success !== undefined && body.success !== true) {
    throw new TronGridCandidateAdapterError("malformed_response");
  }

  if (!Array.isArray(body.data)) {
    throw new TronGridCandidateAdapterError("malformed_response");
  }

  const transactionIds: string[] = [];

  for (const item of body.data) {
    if (!isRecord(item)) {
      throw new TronGridCandidateAdapterError("malformed_response");
    }

    const transactionId = normalizeTxid(item.transaction_id);

    if (transactionId === undefined) {
      throw new TronGridCandidateAdapterError("malformed_response");
    }

    transactionIds.push(transactionId);
  }

  if (body.meta === undefined) {
    return { transactionIds };
  }

  if (!isRecord(body.meta)) {
    throw new TronGridCandidateAdapterError("malformed_response");
  }

  const fingerprint = body.meta.fingerprint;

  if (fingerprint === undefined) {
    return { transactionIds };
  }

  if (
    typeof fingerprint !== "string" ||
    fingerprint.trim().length === 0
  ) {
    throw new TronGridCandidateAdapterError("malformed_response");
  }

  return {
    transactionIds,
    nextCursor: fingerprint,
  };
}

function parseEventIndex(value: unknown): number | undefined {
  return Number.isInteger(value) && Number(value) >= 0
    ? Number(value)
    : undefined;
}

function parseMatchingEvents(input: {
  readonly body: Record<string, unknown>;
  readonly transactionId: string;
  readonly tokenContractAddress: string;
  readonly toAddress: string;
  readonly addressCodec: TronAddressCodec;
}): readonly PaymentObservation[] {
  if (
    input.body.success !== undefined &&
    input.body.success !== true
  ) {
    throw new TronGridCandidateAdapterError("malformed_response");
  }

  if (!Array.isArray(input.body.data)) {
    throw new TronGridCandidateAdapterError("malformed_response");
  }

  const observations: PaymentObservation[] = [];

  for (const item of input.body.data) {
    if (!isRecord(item)) {
      throw new TronGridCandidateAdapterError("malformed_response");
    }

    const transactionId = normalizeTxid(item.transaction_id);
    const eventIndex = parseEventIndex(item.event_index);

    if (
      transactionId === undefined ||
      eventIndex === undefined
    ) {
      throw new TronGridCandidateAdapterError("malformed_response");
    }

    if (transactionId !== input.transactionId) {
      throw new TronGridCandidateAdapterError("malformed_response");
    }

    if (item.event_name !== "Transfer") {
      continue;
    }

    const contractAddress = normalizeAddress(
      input.addressCodec,
      item.contract_address,
    );

    if (contractAddress === undefined) {
      throw new TronGridCandidateAdapterError("malformed_response");
    }

    if (contractAddress !== input.tokenContractAddress) {
      continue;
    }

    if (!isRecord(item.result)) {
      throw new TronGridCandidateAdapterError("malformed_response");
    }

    const fromAddress = normalizeAddress(
      input.addressCodec,
      item.result.from,
    );
    const toAddress = normalizeAddress(
      input.addressCodec,
      item.result.to,
    );
    const amountAtomic = parseUnsignedBigint(
      item.result.value,
      false,
    );

    if (
      fromAddress === undefined ||
      toAddress === undefined ||
      amountAtomic === undefined
    ) {
      throw new TronGridCandidateAdapterError("malformed_response");
    }

    if (toAddress !== input.toAddress) {
      continue;
    }

    const blockNumberRaw = item.block_number;
    const blockTimestampRaw = item.block_timestamp;
    const blockNumber =
      blockNumberRaw === undefined
        ? undefined
        : parseUnsignedBigint(blockNumberRaw, true);
    const blockTimestamp =
      blockTimestampRaw === undefined
        ? undefined
        : parseTimestamp(blockTimestampRaw);

    if (
      (blockNumberRaw !== undefined && blockNumber === undefined) ||
      (blockTimestampRaw !== undefined &&
        blockTimestamp === undefined)
    ) {
      throw new TronGridCandidateAdapterError("malformed_response");
    }

    observations.push({
      asset: "USDT",
      txid: transactionId,
      tokenContractAddress: contractAddress,
      eventIndex,
      fromAddress,
      toAddress,
      amountAtomic,
      confirmations: 0,
      solidified: false,
      evidenceSource: "indexer",
      executionStatus: "unknown",
      ...(blockNumber === undefined ? {} : { blockNumber }),
      ...(blockTimestamp === undefined
        ? {}
        : { blockTimestamp }),
    });
  }

  return observations;
}

function canonicalRequestAddress(
  codec: TronAddressCodec,
  value: string,
  field: string,
): string {
  const normalized = normalizeAddress(codec, value);

  if (normalized === undefined) {
    throw new Error(`${field} must be a valid TRON address`);
  }

  return normalized;
}

export class TronGridUsdtPaymentDetector
  implements PaymentDetector
{
  readonly name: string;

  constructor(
    private readonly transport: TronGridUsdtCandidateHttpTransport,
    private readonly addressCodec: TronAddressCodec,
  ) {
    this.name = `trongrid-usdt:${transport.name}`;
  }

  async findCandidates(
    request: PaymentDetectionRequest,
  ): Promise<PaymentDetectionPage> {
    if (request.asset !== "USDT") {
      return { observations: [] };
    }

    if (request.tokenContractAddress === null) {
      throw new Error(
        "USDT candidate detection requires tokenContractAddress",
      );
    }

    const toAddress = canonicalRequestAddress(
      this.addressCodec,
      request.toAddress,
      "toAddress",
    );
    const tokenContractAddress = canonicalRequestAddress(
      this.addressCodec,
      request.tokenContractAddress,
      "tokenContractAddress",
    );

    const history = parseHistoryPage(
      requireOk(
        await this.transport.listIncomingUsdtTransfers({
          toAddress,
          tokenContractAddress,
          ...(request.cursor === undefined
            ? {}
            : { cursor: request.cursor }),
        }),
      ),
    );

    const observations: PaymentObservation[] = [];
    const seenTransactions = new Set<string>();
    const seenIdentities = new Set<string>();

    for (const transactionId of history.transactionIds) {
      if (seenTransactions.has(transactionId)) {
        continue;
      }

      seenTransactions.add(transactionId);

      const eventObservations = parseMatchingEvents({
        body: requireOk(
          await this.transport.listTransactionEvents({
            transactionId,
          }),
        ),
        transactionId,
        tokenContractAddress,
        toAddress,
        addressCodec: this.addressCodec,
      });

      for (const observation of eventObservations) {
        const identity =
          `${observation.tokenContractAddress}:` +
          `${observation.txid}:${observation.eventIndex}`;

        if (seenIdentities.has(identity)) {
          continue;
        }

        seenIdentities.add(identity);
        observations.push(observation);
      }
    }

    return {
      observations,
      ...(history.nextCursor === undefined
        ? {}
        : { nextCursor: history.nextCursor }),
    };
  }
}
