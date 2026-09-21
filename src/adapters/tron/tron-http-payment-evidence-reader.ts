import type {
  PaymentIdentity,
} from "../../core/payments/payment-observation.js";
import type {
  TronConfirmationDepthProvider,
  TronPaymentEvidenceReader,
  TronReadOutcome,
  TronReadUnavailableReason,
  TronReadView,
} from "../../core/payments/tron-read-source.js";
import type { TronReadHttpTransport } from "./tron-http-transport.js";
import { parseTronPaymentEvidence } from "./tron-payment-evidence-parser.js";

const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

function unavailable(reason: TronReadUnavailableReason): TronReadOutcome {
  return { kind: "unavailable", reason };
}

function parseBlockNumber(value: unknown): string | undefined {
  if (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  ) {
    return String(value);
  }

  if (
    typeof value === "string" &&
    UNSIGNED_DECIMAL_PATTERN.test(value)
  ) {
    return BigInt(value).toString();
  }

  return undefined;
}

export class HttpTronPaymentEvidenceReader
  implements TronPaymentEvidenceReader
{
  readonly name: string;

  constructor(
    private readonly transport: TronReadHttpTransport,
    private readonly confirmationDepthProvider: TronConfirmationDepthProvider,
  ) {
    this.name =
      `http-tron-evidence:${transport.name}:${confirmationDepthProvider.name}`;
  }

  async readPaymentEvidence(input: {
    readonly identity: PaymentIdentity;
    readonly view: TronReadView;
  }): Promise<TronReadOutcome> {
    let transactionResult;
    let transactionInfoResult;

    try {
      [transactionResult, transactionInfoResult] = await Promise.all([
        this.transport.postTransactionRead({
          view: input.view,
          operation: "transaction_body",
          txid: input.identity.txid,
        }),
        this.transport.postTransactionRead({
          view: input.view,
          operation: "transaction_info",
          txid: input.identity.txid,
        }),
      ]);
    } catch {
      return unavailable("malformed_response");
    }

    if (transactionResult.kind === "unavailable") {
      return unavailable(transactionResult.reason);
    }

    if (transactionInfoResult.kind === "unavailable") {
      return unavailable(transactionInfoResult.reason);
    }

    if (
      transactionResult.kind === "not_found" ||
      transactionInfoResult.kind === "not_found"
    ) {
      return { kind: "not_found" };
    }

    const transactionBlockNumber = parseBlockNumber(
      transactionInfoResult.body.blockNumber,
    );

    if (transactionBlockNumber === undefined) {
      return unavailable("malformed_response");
    }

    let depth;

    try {
      depth = await this.confirmationDepthProvider.getConfirmationDepth({
        view: input.view,
        transactionBlockNumber,
      });
    } catch {
      return unavailable("upstream_error");
    }

    if (depth.kind === "unavailable") {
      return unavailable(depth.reason);
    }

    if (
      !Number.isInteger(depth.confirmations) ||
      depth.confirmations < 0
    ) {
      return unavailable("malformed_response");
    }

    const parsed = parseTronPaymentEvidence({
      identity: input.identity,
      view: input.view,
      confirmations: depth.confirmations,
      transaction: transactionResult.body,
      transactionInfo: transactionInfoResult.body,
    });

    if (parsed.kind === "malformed") {
      return unavailable("malformed_response");
    }

    if (parsed.kind === "no_match") {
      return { kind: "not_found" };
    }

    return {
      kind: "found",
      evidence: parsed.evidence,
    };
  }
}
