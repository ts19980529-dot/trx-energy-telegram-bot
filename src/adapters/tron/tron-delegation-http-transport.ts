import type {
  TronDelegationTransport,
  TronEnergyResourceSnapshot,
  TronUnsignedDelegation,
} from "../energy/tron-own-pool-energy-provider.js";
import type { TronHttpTransportConfig } from "./tron-http-transport.js";

type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

const TXID_PATTERN = /^[0-9a-fA-F]{64}$/;
const UNSIGNED_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const MAX_SAFE_INTEGER_BIGINT = BigInt(
  Number.MAX_SAFE_INTEGER,
);

function normalizeBaseUrl(
  value: string,
  field: string,
): string {
  let url: URL;

  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be a valid URL`);
  }

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    throw new Error(
      `${field} must use http or https`,
    );
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

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value)
  );
}

function parseUnsignedBigint(
  value: unknown,
): bigint | undefined {
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

function parseTxid(
  value: unknown,
): string | undefined {
  return typeof value === "string" &&
    TXID_PATTERN.test(value)
    ? value.toLowerCase()
    : undefined;
}
function solidifiedBlockTimestamp(
  block: Record<string, unknown>,
): number | undefined {
  const header = block.block_header;
  if (!isRecord(header)) return undefined;
  const rawData = header.raw_data;
  if (!isRecord(rawData)) return undefined;
  const value = rawData.timestamp;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return value;
  }
  if (typeof value === "string" && UNSIGNED_DECIMAL_PATTERN.test(value)) {
    const parsed = BigInt(value);
    if (parsed > 0n && parsed <= MAX_SAFE_INTEGER_BIGINT) return Number(parsed);
  }
  return undefined;
}

function contractExecutionStatus(
  transaction: Record<string, unknown>,
): "success" | "failed" | "unknown" {
  const ret = transaction.ret;

  if (
    !Array.isArray(ret) ||
    ret.length === 0 ||
    !isRecord(ret[0]) ||
    typeof ret[0].contractRet !== "string"
  ) {
    return "unknown";
  }

  return ret[0].contractRet === "SUCCESS"
    ? "success"
    : "failed";
}

function receiptExecutionStatus(
  transactionInfo: Record<string, unknown>,
): "success" | "failed" | "unknown" {
  const receipt = transactionInfo.receipt;

  if (
    !isRecord(receipt) ||
    typeof receipt.result !== "string"
  ) {
    return "unknown";
  }

  return receipt.result === "SUCCESS"
    ? "success"
    : "failed";
}

function isDelegateResourceTransaction(
  transaction: Record<string, unknown>,
): boolean {
  const rawData = transaction.raw_data;

  if (
    !isRecord(rawData) ||
    !Array.isArray(rawData.contract) ||
    rawData.contract.length !== 1 ||
    !isRecord(rawData.contract[0])
  ) {
    return false;
  }

  return (
    rawData.contract[0].type ===
    "DelegateResourceContract"
  );
}

export class NodeFetchTronDelegationTransport
  implements TronDelegationTransport
{
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

    if (
      !Number.isInteger(config.timeoutMs) ||
      config.timeoutMs <= 0
    ) {
      throw new Error(
        "timeoutMs must be a positive integer",
      );
    }

    this.timeoutMs = config.timeoutMs;

    if (config.apiKey !== undefined) {
      const trimmed = config.apiKey.trim();

      if (trimmed.length === 0) {
        throw new Error(
          "apiKey must not be empty when provided",
        );
      }

      this.apiKey = trimmed;
    }
  }

  private async postJson(
    baseUrl: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<
    | { readonly kind: "ok"; readonly body: Record<string, unknown> }
    | { readonly kind: "not_found" }
    | { readonly kind: "unavailable" }
  > {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };

    if (this.apiKey !== undefined) {
      headers["TRON-PRO-API-KEY"] = this.apiKey;
    }

    let response: Response;

    try {
      response = await this.fetchImpl(
        `${baseUrl}${path}`,
        {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(
            this.timeoutMs,
          ),
        },
      );
    } catch {
      return { kind: "unavailable" };
    }

    if (!response.ok) {
      return { kind: "unavailable" };
    }

    let parsed: unknown;

    try {
      parsed = JSON.parse(
        await response.text(),
      );
    } catch {
      return { kind: "unavailable" };
    }

    if (!isRecord(parsed)) {
      return { kind: "unavailable" };
    }

    if ("Error" in parsed) {
      return { kind: "unavailable" };
    }

    if (Object.keys(parsed).length === 0) {
      return { kind: "not_found" };
    }

    return {
      kind: "ok",
      body: parsed,
    };
  }

  private async getJson(
    baseUrl: string,
    path: string,
  ): Promise<
    | { readonly kind: "ok"; readonly body: Record<string, unknown> }
    | { readonly kind: "not_found" }
    | { readonly kind: "unavailable" }
  > {
    const headers: Record<string, string> = {};
    if (this.apiKey !== undefined) headers["TRON-PRO-API-KEY"] = this.apiKey;

    let response: Response;
    try {
      response = await this.fetchImpl(`${baseUrl}${path}`, {
        method: "GET",
        headers,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch {
      return { kind: "unavailable" };
    }

    if (!response.ok) return { kind: "unavailable" };

    let parsed: unknown;
    try {
      parsed = JSON.parse(await response.text());
    } catch {
      return { kind: "unavailable" };
    }

    if (!isRecord(parsed) || "Error" in parsed) return { kind: "unavailable" };
    if (Object.keys(parsed).length === 0) return { kind: "not_found" };
    return { kind: "ok", body: parsed };
  }
  async getEnergyResourceSnapshot(
    ownerAddress: string,
  ): Promise<TronEnergyResourceSnapshot> {
    const result = await this.postJson(
      this.headBaseUrl,
      "/wallet/getaccountresource",
      {
        address: ownerAddress,
        visible: true,
      },
    );

    if (result.kind !== "ok") {
      throw new Error(
        "TRON Energy resource snapshot is unavailable",
      );
    }

    const totalEnergyLimit =
      parseUnsignedBigint(
        result.body.TotalEnergyLimit,
      );
    const totalEnergyWeight =
      parseUnsignedBigint(
        result.body.TotalEnergyWeight,
      );

    if (
      totalEnergyLimit === undefined ||
      totalEnergyLimit <= 0n ||
      totalEnergyWeight === undefined ||
      totalEnergyWeight <= 0n
    ) {
      throw new Error(
        "TRON Energy resource snapshot is malformed",
      );
    }

    return {
      totalEnergyLimit,
      totalEnergyWeight,
    };
  }

  async getCanDelegatedEnergySun(
    ownerAddress: string,
  ): Promise<bigint> {
    const result = await this.postJson(
      this.headBaseUrl,
      "/wallet/getcandelegatedmaxsize",
      {
        owner_address: ownerAddress,
        type: 1,
        visible: true,
      },
    );

    if (result.kind !== "ok") {
      throw new Error(
        "TRON delegatable Energy capacity is unavailable",
      );
    }

    const maxSize = parseUnsignedBigint(
      result.body.max_size,
    );

    if (maxSize === undefined) {
      throw new Error(
        "TRON delegatable Energy capacity is malformed",
      );
    }

    return maxSize;
  }

  async buildEnergyDelegation(input: {
    readonly ownerAddress: string;
    readonly recipientAddress: string;
    readonly balanceSun: bigint;
  }): Promise<TronUnsignedDelegation> {
    if (
      input.balanceSun <= 0n ||
      input.balanceSun > MAX_SAFE_INTEGER_BIGINT
    ) {
      throw new Error(
        "TRON delegation balance is outside the safe JSON integer range",
      );
    }

    const result = await this.postJson(
      this.headBaseUrl,
      "/wallet/delegateresource",
      {
        owner_address: input.ownerAddress,
        receiver_address: input.recipientAddress,
        balance: Number(input.balanceSun),
        resource: "ENERGY",
        lock: false,
        visible: true,
      },
    );

    if (result.kind !== "ok") {
      throw new Error(
        "TRON DelegateResource transaction build failed",
      );
    }

    const txid = parseTxid(
      result.body.txID ?? result.body.txid,
    );

    if (txid === undefined) {
      throw new Error(
        "TRON DelegateResource response is missing txID",
      );
    }

    if (!isRecord(result.body.raw_data)) {
      throw new Error(
        "TRON DelegateResource response is missing raw_data",
      );
    }

    return {
      txid,
      transaction: result.body,
    };
  }

  async broadcastSignedTransaction(
    transaction: Record<string, unknown>,
  ): Promise<"accepted" | "rejected" | "unknown"> {
    const result = await this.postJson(
      this.headBaseUrl,
      "/wallet/broadcasttransaction",
      transaction,
    );

    if (result.kind !== "ok") {
      return "unknown";
    }

    if (result.body.result === true) {
      return "accepted";
    }

    if (
      result.body.code ===
      "DUP_TRANSACTION_ERROR"
    ) {
      return "accepted";
    }

    return "unknown";
  }

  async getTransactionObservation(input: {
    readonly txid: string;
    readonly expirationAt: Date;
  }): Promise<
    | { readonly status: "processing" | "completed" | "failed" | "unknown" }
    | { readonly status: "absent"; readonly solidifiedObservedAt: Date }
  > {
    const normalized = parseTxid(input.txid);
    if (normalized === undefined) throw new Error("txid must be a 64-character hexadecimal string");
    if (Number.isNaN(input.expirationAt.getTime())) {
      throw new Error("transaction expiration must be a valid Date");
    }

    const [solidifiedTransaction, solidifiedInfo] = await Promise.all([
      this.postJson(
        this.solidifiedBaseUrl,
        "/walletsolidity/gettransactionbyid",
        { value: normalized },
      ),
      this.postJson(
        this.solidifiedBaseUrl,
        "/walletsolidity/gettransactioninfobyid",
        { value: normalized },
      ),
    ]);

    if (solidifiedTransaction.kind === "ok") {
      const returnedTxid = parseTxid(solidifiedTransaction.body.txID);
      if (
        returnedTxid !== normalized ||
        !isDelegateResourceTransaction(solidifiedTransaction.body)
      ) {
        return { status: "unknown" };
      }

      const receiptStatus =
        solidifiedInfo.kind === "ok"
          ? receiptExecutionStatus(solidifiedInfo.body)
          : "unknown";
      const bodyStatus = contractExecutionStatus(solidifiedTransaction.body);

      if (receiptStatus === "failed" || bodyStatus === "failed") {
        return { status: "failed" };
      }
      if (receiptStatus === "success" || bodyStatus === "success") {
        return { status: "completed" };
      }
      return { status: "processing" };
    }

    const headTransaction = await this.postJson(
      this.headBaseUrl,
      "/wallet/gettransactionbyid",
      { value: normalized },
    );

    if (headTransaction.kind === "ok") {
      const returnedTxid = parseTxid(headTransaction.body.txID);
      return returnedTxid === normalized && isDelegateResourceTransaction(headTransaction.body)
        ? { status: "processing" }
        : { status: "unknown" };
    }

    if (
      solidifiedTransaction.kind !== "not_found" ||
      headTransaction.kind !== "not_found"
    ) {
      return { status: "unknown" };
    }

    const solidifiedBlock = await this.getJson(
      this.solidifiedBaseUrl,
      "/walletsolidity/getnowblock",
    );
    if (solidifiedBlock.kind !== "ok") return { status: "unknown" };

    const observedTimestamp = solidifiedBlockTimestamp(solidifiedBlock.body);
    if (
      observedTimestamp === undefined ||
      observedTimestamp < input.expirationAt.getTime()
    ) {
      return { status: "unknown" };
    }

    return {
      status: "absent",
      solidifiedObservedAt: new Date(observedTimestamp),
    };
  }
}
