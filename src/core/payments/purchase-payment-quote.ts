import type { PaymentAsset } from "./payment-observation.js";
import type {
  PurchasePackageSnapshotInput,
  PurchasePaymentQuote,
} from "./purchase-order-payment.js";

export interface PurchasePaymentQuoteRequest {
  readonly package: PurchasePackageSnapshotInput;
  readonly asset: PaymentAsset;
  readonly requestedAt: Date;
}

export type PurchasePaymentQuoteResult =
  | {
      readonly kind: "ready";
      readonly quote: PurchasePaymentQuote;
    }
  | {
      readonly kind: "unsupported_asset";
      readonly asset: PaymentAsset;
    }
  | {
      readonly kind: "invalid_request";
    }
  | {
      readonly kind: "unavailable";
    };

export interface PurchasePaymentQuoteProvider {
  readonly name: string;

  quote(
    request: PurchasePaymentQuoteRequest,
  ): Promise<PurchasePaymentQuoteResult>;
}
