import type { TronReadView } from "../../core/payments/tron-read-source.js";

export const tronReadOperations = [
  "transaction_body",
  "transaction_info",
] as const;

export type TronReadOperation = (typeof tronReadOperations)[number];

export type TronReadEndpoint =
  | "/wallet/gettransactionbyid"
  | "/wallet/gettransactioninfobyid"
  | "/walletsolidity/gettransactionbyid"
  | "/walletsolidity/gettransactioninfobyid";

export function resolveTronReadEndpoint(
  view: TronReadView,
  operation: TronReadOperation,
): TronReadEndpoint {
  if (view === "head") {
    return operation === "transaction_body"
      ? "/wallet/gettransactionbyid"
      : "/wallet/gettransactioninfobyid";
  }

  return operation === "transaction_body"
    ? "/walletsolidity/gettransactionbyid"
    : "/walletsolidity/gettransactioninfobyid";
}
