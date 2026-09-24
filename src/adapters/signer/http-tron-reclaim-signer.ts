import type {
  TronReclaimSigner,
  TronSignedReclaim,
  TronUnsignedReclaim,
} from "../energy/tron-own-pool-energy-provider.js";

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeBaseUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("ENERGY_SIGNER_BASE_URL must use http or https");
  }
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      "ENERGY_SIGNER_BASE_URL must be an origin without credentials, path, query or hash",
    );
  }
  return url.origin;
}

function parseSignedReclaim(value: unknown): TronSignedReclaim {
  if (!isRecord(value)) throw new Error("Reclaim signer response is invalid");
  const txid = value.txid;
  const transaction = value.transaction;
  if (
    typeof txid !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(txid) ||
    !isRecord(transaction)
  ) {
    throw new Error("Reclaim signer response is invalid");
  }
  return { txid: txid.toLowerCase(), transaction };
}

export class HttpTronReclaimSigner implements TronReclaimSigner {
  private readonly baseUrl: string;
  private readonly authToken: string;
  private readonly timeoutMs: number;

  constructor(
    config: {
      readonly baseUrl: string;
      readonly authToken: string;
      readonly timeoutMs: number;
    },
    private readonly fetchImpl: FetchLike = fetch,
  ) {
    this.baseUrl = normalizeBaseUrl(config.baseUrl);
    this.authToken = config.authToken.trim();
    if (this.authToken === "") {
      throw new Error("TRON_SIGNER_AUTH_TOKEN must not be empty");
    }
    if (!Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) {
      throw new Error("ENERGY_SIGNER_HTTP_TIMEOUT_MS must be positive");
    }
    this.timeoutMs = config.timeoutMs;
  }

  async sign(input: {
    readonly attemptKey: string;
    readonly unsigned: TronUnsignedReclaim;
  }): Promise<TronSignedReclaim> {
    const response = await this.post("/v1/reclaim/sign", input);
    return parseSignedReclaim(response);
  }

  async findSignedByAttemptKey(
    attemptKey: string,
  ): Promise<TronSignedReclaim | undefined> {
    const response = await this.post(
      "/v1/reclaim/recover",
      { attemptKey },
      true,
    );
    return response === undefined
      ? undefined
      : parseSignedReclaim(response);
  }

  private async post(
    path: string,
    body: unknown,
    allowNotFound = false,
  ): Promise<unknown | undefined> {
    let response: Response;
    try {
      response = await this.fetchImpl(
        `${this.baseUrl}${path}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.authToken}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
    } catch {
      throw new Error("TRON reclaim signer is unavailable");
    }
    if (allowNotFound && response.status === 404) return undefined;
    if (!response.ok) {
      throw new Error(
        `TRON reclaim signer request failed (${response.status})`,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new Error("TRON reclaim signer response is invalid");
    }
  }
}
