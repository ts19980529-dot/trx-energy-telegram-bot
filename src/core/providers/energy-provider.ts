export type EnergyOrderId = string;

export interface EnergyDeliveryRequest {
  readonly idempotencyKey: string;
  readonly internalOrderId: EnergyOrderId;
  readonly recipientAddress: string;
  readonly energyAmount: bigint;
}

export interface EnergyDeliveryResult {
  readonly providerOrderId: string;
  readonly status: "accepted" | "processing" | "completed" | "failed";
}

export interface EnergyOrderStatus {
  readonly providerOrderId: string;
  readonly status: "processing" | "completed" | "failed" | "unknown";
}

export interface EnergyProvider {
  readonly name: string;

  createDelivery(request: EnergyDeliveryRequest): Promise<EnergyDeliveryResult>;

  getDeliveryStatus(providerOrderId: string): Promise<EnergyOrderStatus>;
}
