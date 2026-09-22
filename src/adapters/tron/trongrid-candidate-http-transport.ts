import type {
  TronReadUnavailableReason,
} from "../../core/payments/tron-read-source.js";

export interface TronGridCandidateHttpTransportConfig {
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly apiKey?: string;
  readonly pageSize?: number;
}

export type TronGridCandidatePageResult =
  | {
      readonly kind: "ok";
      readonly body: Record<string, unknown>;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: TronReadUnavailableReason;
    };

export interface TronGridUsdtCandidateHttpTransport {
  readonly name: string;

  listIncomingUsdtTransfers(input: {
    readonly toAddress: string;
    readonly tokenContractAddress: string;
    readonly minTimestampMs?: number;
    readonly maxTimestampMs?: number;
    readonly cursor?: string;
  }): Promise<TronGridCandidatePageResult>;

  listTransactionEvents(input: {
    readonly transactionId: string;
  }): Promise<TronGridCandidatePageResult>;
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

function normalizeBaseUrl(value: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error("baseUrl must be a valid URL");
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("baseUrl must use http or https");
  }

  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      "baseUrl must be an origin without credentials, path, query or hash",
    );
  }

  return url.origin;
}

function classifyForbidden(bodyText: string): TronReadUnavailableReason {
  return /rate|limit|frequency|quota/i.test(bodyText)
    ? "rate_limited"
    : "access_denied";
}

function unavailable(
  reason: TronReadUnavailableReason,
): TronGridCandidatePageResult {
  return { kind: "unavailable", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

const TXID_PATTERN = /^[0-9a-fA-F]{64}$/;

function nonEmpty(value: string, field: string): string {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    throw new Error(`${field} must not be empty`);
  }

  return trimmed;
}

function transactionId(value: string): string {
  const normalized = value.trim();

  if (!TXID_PATTERN.test(normalized)) {
    throw new Error(
      "transactionId must be a 64-character hexadecimal string",
    );
  }

  return normalized.toLowerCase();
}

export class NodeFetchTronGridUsdtCandidateHttpTransport
  implements TronGridUsdtCandidateHttpTransport
{
  readonly name = "node-fetch-trongrid-usdt-candidates";

  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;
  private readonly pageSize: number;

  constructor(
    config: TronGridCandidateHttpTransportConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);

    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }

    this.timeoutMs = config.timeoutMs;

    const pageSize = config.pageSize ?? 200;

    if (
      !Number.isInteger(pageSize) ||
      pageSize < 1 ||
      pageSize > 200
    ) {
      throw new Error("pageSize must be an integer between 1 and 200");
    }

    this.pageSize = pageSize;

    if (config.apiKey !== undefined) {
      const trimmed = config.apiKey.trim();

      if (trimmed.length === 0) {
        throw new Error("apiKey must not be empty when provided");
      }

      this.apiKey = trimmed;
    }
  }

  private async requestJson(url: URL): Promise<TronGridCandidatePageResult> {
    const headers: Record<string, string> = {
      accept: "application/json",
    };

    if (this.apiKey !== undefined) {
      headers["TRON-PRO-API-KEY"] = this.apiKey;
    }

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "TimeoutError" || error.name === "AbortError")
      ) {
        return unavailable("timeout");
      }

      return unavailable("upstream_error");
    }

    const bodyText = await response.text();

    if (response.status === 429) {
      return unavailable("rate_limited");
    }

    if (response.status === 401) {
      return unavailable("access_denied");
    }

    if (response.status === 403) {
      return unavailable(classifyForbidden(bodyText));
    }

    if (!response.ok) {
      return unavailable("upstream_error");
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(bodyText);
    } catch {
      return unavailable("malformed_response");
    }

    if (!isRecord(parsed)) {
      return unavailable("malformed_response");
    }

    return {
      kind: "ok",
      body: parsed,
    };
  }

  listIncomingUsdtTransfers(input: {
    readonly toAddress: string;
    readonly tokenContractAddress: string;
    readonly minTimestampMs?: number;
    readonly maxTimestampMs?: number;
    readonly cursor?: string;
  }): Promise<TronGridCandidatePageResult> {
    const toAddress = nonEmpty(input.toAddress, "toAddress");
    const tokenContractAddress = nonEmpty(
      input.tokenContractAddress,
      "tokenContractAddress",
    );

    const url = new URL(
      `/v1/accounts/${encodeURIComponent(toAddress)}/transactions/trc20`,
      this.baseUrl,
    );

    url.searchParams.set("only_confirmed", "true");
    url.searchParams.set("only_to", "true");
    url.searchParams.set("contract_address", tokenContractAddress);
    url.searchParams.set("limit", String(this.pageSize));
    url.searchParams.set("order_by", "block_timestamp,desc");

    const validateTimestamp = (
      value: number | undefined,
      field: string,
    ): number | undefined => {
      if (value === undefined) {
        return undefined;
      }

      if (!Number.isSafeInteger(value) || value < 0) {
        throw new Error(`${field} must be a non-negative safe integer`);
      }

      return value;
    };

    const minTimestampMs = validateTimestamp(
      input.minTimestampMs,
      "minTimestampMs",
    );
    const maxTimestampMs = validateTimestamp(
      input.maxTimestampMs,
      "maxTimestampMs",
    );

    if (
      minTimestampMs !== undefined &&
      maxTimestampMs !== undefined &&
      minTimestampMs > maxTimestampMs
    ) {
      throw new Error("minTimestampMs must not exceed maxTimestampMs");
    }

    if (minTimestampMs !== undefined) {
      url.searchParams.set("min_timestamp", String(minTimestampMs));
    }

    if (maxTimestampMs !== undefined) {
      url.searchParams.set("max_timestamp", String(maxTimestampMs));
    }

    if (input.cursor !== undefined) {
      url.searchParams.set(
        "fingerprint",
        nonEmpty(input.cursor, "cursor"),
      );
    }

    return this.requestJson(url);
  }

  listTransactionEvents(input: {
    readonly transactionId: string;
  }): Promise<TronGridCandidatePageResult> {
    const normalizedTransactionId = transactionId(input.transactionId);
    const url = new URL(
      `/v1/transactions/${normalizedTransactionId}/events`,
      this.baseUrl,
    );

    url.searchParams.set("only_confirmed", "true");

    return this.requestJson(url);
  }
}
