export type EnergyOrderId = string;

export interface EnergyDeliveryRequest {
  readonly idempotencyKey: string;
  readonly internalOrderId: EnergyOrderId;
  readonly recipientAddress: string;
  readonly energyAmount: bigint;
}

export interface EnergyDeliveryResult {
  readonly providerOrderId: string | null;
  readonly idempotencyKey: string;
  readonly status: "accepted" | "processing" | "completed" | "failed";
}

export interface EnergyOrderStatus {
  readonly providerOrderId: string | null;
  readonly idempotencyKey: string;
  readonly status: "processing" | "completed" | "failed" | "unknown";
}

export interface EnergyProvider {
  readonly name: string;

  /**
   * Must be idempotent for the same business-delivery idempotencyKey.
   * A retry must never overlap active external attempts. A replacement
   * chain transaction is allowed only after the provider has proven the
   * previous attempt expired and was absent from the finalized chain.
   */
  createDelivery(request: EnergyDeliveryRequest): Promise<EnergyDeliveryResult>;

  getDeliveryStatus(providerOrderId: string): Promise<EnergyOrderStatus>;

  /**
   * Recovery path for ambiguous createDelivery outcomes such as timeouts.
   * Callers must query this before deciding whether a create may be retried.
   */
  findDeliveryByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<EnergyOrderStatus | undefined>;
}
