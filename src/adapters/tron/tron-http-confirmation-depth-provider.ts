import type {
  TronConfirmationDepthOutcome,
  TronConfirmationDepthProvider,
  TronReadView,
} from "../../core/payments/tron-read-source.js";
import type { TronLatestBlockHttpTransport } from "./tron-http-transport.js";

const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_SAFE_INTEGER_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

function parseUnsignedDecimal(value: unknown): bigint | undefined {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return BigInt(value);
  }

  if (
    typeof value === "string" &&
    UNSIGNED_DECIMAL_PATTERN.test(value)
  ) {
    return BigInt(value);
  }

  return undefined;
}

function latestBlockNumber(
  body: Record<string, unknown>,
): bigint | undefined {
  const header = body.block_header;

  if (
    typeof header !== "object" ||
    header === null ||
    Array.isArray(header)
  ) {
    return undefined;
  }

  const rawData = (header as Record<string, unknown>).raw_data;

  if (
    typeof rawData !== "object" ||
    rawData === null ||
    Array.isArray(rawData)
  ) {
    return undefined;
  }

  return parseUnsignedDecimal(
    (rawData as Record<string, unknown>).number,
  );
}

export class HttpTronConfirmationDepthProvider
  implements TronConfirmationDepthProvider
{
  readonly name: string;

  constructor(
    private readonly transport: TronLatestBlockHttpTransport,
  ) {
    this.name = `http-tron-confirmation-depth:${transport.name}`;
  }

  async getConfirmationDepth(input: {
    readonly view: TronReadView;
    readonly transactionBlockNumber: string;
  }): Promise<TronConfirmationDepthOutcome> {
    const transactionHeight = parseUnsignedDecimal(
      input.transactionBlockNumber,
    );

    if (transactionHeight === undefined) {
      return {
        kind: "unavailable",
        reason: "malformed_response",
      };
    }

    let result;

    try {
      result = await this.transport.getLatestBlock({
        view: input.view,
      });
    } catch {
      return {
        kind: "unavailable",
        reason: "upstream_error",
      };
    }

    if (result.kind === "unavailable") {
      return result;
    }

    if (result.kind === "not_found") {
      return {
        kind: "unavailable",
        reason: "malformed_response",
      };
    }

    const latestHeight = latestBlockNumber(result.body);

    if (
      latestHeight === undefined ||
      latestHeight < transactionHeight
    ) {
      return {
        kind: "unavailable",
        reason: "malformed_response",
      };
    }

    const confirmations =
      latestHeight - transactionHeight + 1n;

    if (confirmations > MAX_SAFE_INTEGER_BIGINT) {
      return {
        kind: "unavailable",
        reason: "malformed_response",
      };
    }

    return {
      kind: "available",
      confirmations: Number(confirmations),
    };
  }
}
