import type { PaymentIdentity } from "./payment-observation.js";
import type { RawTronPaymentEvidence } from "./tron-evidence-normalization.js";

export const tronReadViews = ["head", "solidified"] as const;

export type TronReadView = (typeof tronReadViews)[number];

export const tronReadUnavailableReasons = [
  "timeout",
  "rate_limited",
  "access_denied",
  "upstream_error",
  "malformed_response",
] as const;

export type TronReadUnavailableReason =
  (typeof tronReadUnavailableReasons)[number];

export type TronReadOutcome =
  | {
      readonly kind: "found";
      readonly evidence: RawTronPaymentEvidence;
    }
  | {
      readonly kind: "not_found";
    }
  | {
      readonly kind: "unavailable";
      readonly reason: TronReadUnavailableReason;
    };

export interface TronPaymentEvidenceReader {
  readonly name: string;

  readPaymentEvidence(input: {
    readonly identity: PaymentIdentity;
    readonly view: TronReadView;
  }): Promise<TronReadOutcome>;
}
