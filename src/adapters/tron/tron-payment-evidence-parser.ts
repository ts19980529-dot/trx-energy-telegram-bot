import type {
  PaymentIdentity,
} from "../../core/payments/payment-observation.js";
import type { TronReadView } from "../../core/payments/tron-read-source.js";
import type {
  RawTronPaymentEvidence,
  TronEncodedAddress,
} from "../../core/payments/tron-evidence-normalization.js";

export type TronPaymentEvidenceParseResult =
  | {
      readonly kind: "evidence";
      readonly evidence: RawTronPaymentEvidence;
    }
  | {
      readonly kind: "no_match";
    }
  | {
      readonly kind: "malformed";
    };

export interface TronPaymentEvidenceParseInput {
  readonly identity: PaymentIdentity;
  readonly view: TronReadView;
  readonly confirmations: number;
  readonly transaction: Record<string, unknown>;
  readonly transactionInfo: Record<string, unknown>;
}

const TXID_PATTERN = /^[0-9a-fA-F]{64}$/;
const HEX41_PATTERN = /^41[0-9a-fA-F]{40}$/;
const BASE58_PATTERN = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;
const HEX20_PATTERN = /^[0-9a-fA-F]{40}$/;
const HEX32_PATTERN = /^[0-9a-fA-F]{64}$/;
const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const TRANSFER_EVENT_TOPIC =
  "ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeTxid(value: unknown): string | undefined {
  return typeof value === "string" && TXID_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}

function parseAddress(value: unknown): TronEncodedAddress | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  if (HEX41_PATTERN.test(value)) {
    return { encoding: "hex41", value: value.toLowerCase() };
  }

  if (BASE58_PATTERN.test(value)) {
    return { encoding: "base58check", value };
  }

  return undefined;
}

function parseUnsignedInteger(
  value: unknown,
  allowZero: boolean,
): string | undefined {
  let decimal: string;

  if (typeof value === "string") {
    if (!UNSIGNED_DECIMAL_PATTERN.test(value)) {
      return undefined;
    }

    decimal = value;
  } else if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    decimal = String(value);
  } else {
    return undefined;
  }

  const parsed = BigInt(decimal);

  if (allowZero ? parsed < 0n : parsed <= 0n) {
    return undefined;
  }

  return parsed.toString();
}

function parseBlockMetadata(
  transactionInfo: Record<string, unknown>,
):
  | {
      readonly blockNumber?: string;
      readonly blockTimestampMs?: string;
    }
  | undefined {
  const blockNumberRaw = transactionInfo.blockNumber;
  const blockTimestampRaw = transactionInfo.blockTimeStamp;

  const blockNumber =
    blockNumberRaw === undefined
      ? undefined
      : parseUnsignedInteger(blockNumberRaw, true);
  const blockTimestampMs =
    blockTimestampRaw === undefined
      ? undefined
      : parseUnsignedInteger(blockTimestampRaw, true);

  if (
    (blockNumberRaw !== undefined && blockNumber === undefined) ||
    (blockTimestampRaw !== undefined && blockTimestampMs === undefined)
  ) {
    return undefined;
  }

  return {
    ...(blockNumber === undefined ? {} : { blockNumber }),
    ...(blockTimestampMs === undefined ? {} : { blockTimestampMs }),
  };
}

function parseContractRet(
  transaction: Record<string, unknown>,
): "success" | "failed" | "unknown" {
  const ret = transaction.ret;

  if (!Array.isArray(ret) || ret.length === 0 || !isRecord(ret[0])) {
    return "unknown";
  }

  const contractRet = ret[0].contractRet;

  if (typeof contractRet !== "string") {
    return "unknown";
  }

  return contractRet === "SUCCESS" ? "success" : "failed";
}

function parseReceiptResult(
  transactionInfo: Record<string, unknown>,
): "success" | "failed" | "unknown" {
  const receipt = transactionInfo.receipt;

  if (!isRecord(receipt) || typeof receipt.result !== "string") {
    return "unknown";
  }

  return receipt.result === "SUCCESS" ? "success" : "failed";
}

function getOnlyContract(
  transaction: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const rawData = transaction.raw_data;

  if (!isRecord(rawData) || !Array.isArray(rawData.contract)) {
    return undefined;
  }

  if (rawData.contract.length !== 1 || !isRecord(rawData.contract[0])) {
    return undefined;
  }

  return rawData.contract[0];
}

function getContractValue(
  contract: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const parameter = contract.parameter;

  if (!isRecord(parameter) || !isRecord(parameter.value)) {
    return undefined;
  }

  return parameter.value;
}

function parseReceiptIdentity(
  transactionInfo: Record<string, unknown>,
): string | undefined {
  return normalizeTxid(transactionInfo.id);
}

function evidenceSourceForView(
  view: TronReadView,
): "fullnode" | "solidified_node" {
  return view === "solidified" ? "solidified_node" : "fullnode";
}

function parseTrxEvidence(
  input: TronPaymentEvidenceParseInput,
  txid: string,
  contract: Record<string, unknown>,
  metadata: {
    readonly blockNumber?: string;
    readonly blockTimestampMs?: string;
  },
): TronPaymentEvidenceParseResult {
  if (contract.type !== "TransferContract") {
    return { kind: "no_match" };
  }

  const value = getContractValue(contract);

  if (value === undefined) {
    return { kind: "malformed" };
  }

  const fromAddress = parseAddress(value.owner_address);
  const toAddress = parseAddress(value.to_address);
  const amountAtomic = parseUnsignedInteger(value.amount, false);

  if (
    fromAddress === undefined ||
    toAddress === undefined ||
    amountAtomic === undefined
  ) {
    return { kind: "malformed" };
  }

  const receiptStatus = parseReceiptResult(input.transactionInfo);
  const bodyStatus = parseContractRet(input.transaction);
  const executionStatus =
    receiptStatus !== "unknown" ? receiptStatus : bodyStatus;

  return {
    kind: "evidence",
    evidence: {
      asset: "TRX",
      txid,
      tokenContractAddress: null,
      eventIndex: null,
      fromAddress,
      toAddress,
      amountAtomic,
      confirmations: input.confirmations,
      evidenceSource: evidenceSourceForView(input.view),
      executionStatus,
      ...metadata,
    },
  };
}

function eventAddress(value: unknown): TronEncodedAddress | undefined {
  if (typeof value !== "string" || !HEX20_PATTERN.test(value)) {
    return undefined;
  }

  return {
    encoding: "hex41",
    value: `41${value.toLowerCase()}`,
  };
}

function indexedAddress(value: unknown): TronEncodedAddress | undefined {
  if (typeof value !== "string" || !HEX32_PATTERN.test(value)) {
    return undefined;
  }

  return {
    encoding: "hex41",
    value: `41${value.slice(-40).toLowerCase()}`,
  };
}

function uint256Decimal(value: unknown): string | undefined {
  if (typeof value !== "string" || !HEX32_PATTERN.test(value)) {
    return undefined;
  }

  const parsed = BigInt(`0x${value}`);

  return parsed > 0n ? parsed.toString() : undefined;
}

function parseTrc20Evidence(
  input: TronPaymentEvidenceParseInput & {
    readonly identity: Extract<PaymentIdentity, { asset: "USDT" }>;
  },
  txid: string,
  contract: Record<string, unknown>,
  metadata: {
    readonly blockNumber?: string;
    readonly blockTimestampMs?: string;
  },
): TronPaymentEvidenceParseResult {
  if (contract.type !== "TriggerSmartContract") {
    return { kind: "no_match" };
  }

  if (parseReceiptResult(input.transactionInfo) !== "success") {
    return { kind: "no_match" };
  }

  const logs = input.transactionInfo.log;

  if (!Array.isArray(logs)) {
    return { kind: "malformed" };
  }

  const event = logs[input.identity.eventIndex];

  if (event === undefined) {
    return { kind: "no_match" };
  }

  if (!isRecord(event)) {
    return { kind: "malformed" };
  }

  const topics = event.topics;

  if (!Array.isArray(topics) || topics.length < 3) {
    return { kind: "malformed" };
  }

  if (
    typeof topics[0] !== "string" ||
    topics[0].toLowerCase() !== TRANSFER_EVENT_TOPIC
  ) {
    return { kind: "no_match" };
  }

  const tokenContractAddress = eventAddress(event.address);
  const fromAddress = indexedAddress(topics[1]);
  const toAddress = indexedAddress(topics[2]);
  const amountAtomic = uint256Decimal(event.data);

  if (
    tokenContractAddress === undefined ||
    fromAddress === undefined ||
    toAddress === undefined ||
    amountAtomic === undefined
  ) {
    return { kind: "malformed" };
  }

  return {
    kind: "evidence",
    evidence: {
      asset: "USDT",
      txid,
      tokenContractAddress,
      eventIndex: input.identity.eventIndex,
      fromAddress,
      toAddress,
      amountAtomic,
      confirmations: input.confirmations,
      evidenceSource: evidenceSourceForView(input.view),
      executionStatus: "success",
      ...metadata,
    },
  };
}

export function parseTronPaymentEvidence(
  input: TronPaymentEvidenceParseInput,
): TronPaymentEvidenceParseResult {
  if (!Number.isInteger(input.confirmations) || input.confirmations < 0) {
    return { kind: "malformed" };
  }

  const expectedTxid = input.identity.txid.toLowerCase();

  if (!TXID_PATTERN.test(expectedTxid)) {
    return { kind: "malformed" };
  }

  const txid = normalizeTxid(input.transaction.txID);
  const receiptTxid = parseReceiptIdentity(input.transactionInfo);

  if (
    txid === undefined ||
    receiptTxid === undefined ||
    txid !== expectedTxid ||
    receiptTxid !== expectedTxid
  ) {
    return { kind: "malformed" };
  }

  const contract = getOnlyContract(input.transaction);
  const metadata = parseBlockMetadata(input.transactionInfo);

  if (contract === undefined || metadata === undefined) {
    return { kind: "malformed" };
  }

  if (input.identity.asset === "TRX") {
    return parseTrxEvidence(input, txid, contract, metadata);
  }

  return parseTrc20Evidence(
    {
      ...input,
      identity: input.identity,
    },
    txid,
    contract,
    metadata,
  );
}
