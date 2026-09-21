import type {
  TronReadUnavailableReason,
  TronReadView,
} from "../../core/payments/tron-read-source.js";
import {
  resolveTronLatestBlockEndpoint,
  resolveTronReadEndpoint,
  type TronReadOperation,
} from "./tron-read-endpoints.js";

export interface TronHttpTransportConfig {
  readonly headBaseUrl: string;
  readonly solidifiedBaseUrl: string;
  readonly timeoutMs: number;
  readonly apiKey?: string;
}

export type TronHttpReadResult =
  | {
      readonly kind: "ok";
      readonly body: Record<string, unknown>;
    }
  | {
      readonly kind: "not_found";
    }
  | {
      readonly kind: "unavailable";
      readonly reason: TronReadUnavailableReason;
    };

export interface TronReadHttpTransport {
  readonly name: string;

  postTransactionRead(input: {
    readonly view: TronReadView;
    readonly operation: TronReadOperation;
    readonly txid: string;
  }): Promise<TronHttpReadResult>;
}

export interface TronLatestBlockHttpTransport {
  readonly name: string;

  getLatestBlock(input: {
    readonly view: TronReadView;
  }): Promise<TronHttpReadResult>;
}

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const TXID_PATTERN = /^[0-9a-fA-F]{64}$/;

function normalizeBaseUrl(value: string, field: string): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${field} must use http or https`);
  }

  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      `${field} must be an origin without credentials, path, query or hash`,
    );
  }

  return url.origin;
}

function classifyForbidden(bodyText: string): TronReadUnavailableReason {
  return /rate|limit|frequency|quota/i.test(bodyText)
    ? "rate_limited"
    : "access_denied";
}

function unavailable(reason: TronReadUnavailableReason): TronHttpReadResult {
  return { kind: "unavailable", reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

export class NodeFetchTronReadHttpTransport
  implements TronReadHttpTransport, TronLatestBlockHttpTransport
{
  readonly name = "node-fetch-tron-read";

  private readonly headBaseUrl: string;
  private readonly solidifiedBaseUrl: string;
  private readonly timeoutMs: number;
  private readonly apiKey?: string;

  constructor(
    config: TronHttpTransportConfig,
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.headBaseUrl = normalizeBaseUrl(
      config.headBaseUrl,
      "headBaseUrl",
    );
    this.solidifiedBaseUrl = normalizeBaseUrl(
      config.solidifiedBaseUrl,
      "solidifiedBaseUrl",
    );

    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error("timeoutMs must be a positive integer");
    }

    this.timeoutMs = config.timeoutMs;

    if (config.apiKey !== undefined) {
      const trimmed = config.apiKey.trim();

      if (trimmed.length === 0) {
        throw new Error("apiKey must not be empty when provided");
      }

      this.apiKey = trimmed;
    }
  }

  private baseUrlFor(view: TronReadView): string {
    return view === "solidified"
      ? this.solidifiedBaseUrl
      : this.headBaseUrl;
  }

  private async requestJson(
    url: string,
    init: Omit<RequestInit, "headers" | "signal">,
  ): Promise<TronHttpReadResult> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (this.apiKey !== undefined) {
      headers["TRON-PRO-API-KEY"] = this.apiKey;
    }

    let response: Response;

    try {
      response = await this.fetchImpl(url, {
        ...init,
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

    if ("Error" in parsed) {
      return unavailable("upstream_error");
    }

    if (Object.keys(parsed).length === 0) {
      return { kind: "not_found" };
    }

    return {
      kind: "ok",
      body: parsed,
    };
  }

  async postTransactionRead(input: {
    readonly view: TronReadView;
    readonly operation: TronReadOperation;
    readonly txid: string;
  }): Promise<TronHttpReadResult> {
    if (!TXID_PATTERN.test(input.txid)) {
      throw new Error("txid must be a 64-character hexadecimal string");
    }

    const endpoint = resolveTronReadEndpoint(input.view, input.operation);

    return this.requestJson(
      `${this.baseUrlFor(input.view)}${endpoint}`,
      {
        method: "POST",
        body: JSON.stringify({ value: input.txid.toLowerCase() }),
      },
    );
  }

  async getLatestBlock(input: {
    readonly view: TronReadView;
  }): Promise<TronHttpReadResult> {
    const endpoint = resolveTronLatestBlockEndpoint(input.view);

    return this.requestJson(
      `${this.baseUrlFor(input.view)}${endpoint}`,
      input.view === "solidified"
        ? { method: "GET" }
        : { method: "POST" },
    );
  }
}
