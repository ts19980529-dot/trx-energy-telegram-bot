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
   * Must be idempotent for the same idempotencyKey.
   * A retry with the same key must not create a second provider order.
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
