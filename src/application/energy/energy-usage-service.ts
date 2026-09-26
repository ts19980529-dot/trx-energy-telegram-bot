import type {
  EnergyOrderStatus,
  EnergyProvider,
  EnergyDeliveryResult,
} from "../../core/providers/energy-provider.js";
import type {
  EnergyConsumptionState,
} from "../../core/orders/state-machine.js";
import type {
  TronAddressCodec,
  TronEncodedAddress,
} from "../../core/payments/tron-evidence-normalization.js";

export interface EnergyOptionSummary {
  readonly id: string;
  readonly code: string;
  readonly energyAmount: bigint;
  readonly countCost: number;
}

export type ProviderDeliveryStatus =
  | "pending"
  | "accepted"
  | "processing"
  | "completed"
  | "failed"
  | "unknown";

export interface EnergyDeliverySnapshot {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly providerName: string;
  readonly providerOrderId: string | null;
  readonly status: ProviderDeliveryStatus;
}

export interface EnergyConsumptionSnapshot {
  readonly id: string;
  readonly userId: string;
  readonly optionCode: string;
  readonly recipientAddress: string;
  readonly energyAmount: bigint;
  readonly countCost: number;
  readonly status: EnergyConsumptionState;
  readonly availableCount: number;
  readonly reservedCount: number;
  readonly delivery: EnergyDeliverySnapshot | null;
}

export type EnergyPreparationResult =
  | { readonly kind: "denied" }
  | {
      readonly kind: "ready";
      readonly availableCount: number;
      readonly reservedCount: number;
      readonly options: readonly EnergyOptionSummary[];
    };

export type EnergyReservationResult =
  | { readonly kind: "denied" }
  | { readonly kind: "option_unavailable" }
  | {
      readonly kind: "insufficient_balance";
      readonly availableCount: number;
      readonly requiredCount: number;
    }
  | { readonly kind: "conflict" }
  | {
      readonly kind: "ready";
      readonly created: boolean;
      readonly order: EnergyConsumptionSnapshot;
    };

export interface EnergyUsageRepository {
  listPending(limit: number, afterKey?: string): Promise<readonly {
    telegramUserId: bigint;
    optionCode: string;
    recipientAddress: string;
    idempotencyKey: string;
    providerName: string | null;
  }[]>;
  prepare(telegramUserId: bigint): Promise<EnergyPreparationResult>;

  reserve(input: {
    readonly telegramUserId: bigint;
    readonly optionCode: string;
    readonly recipientAddress: string;
    readonly idempotencyKey: string;
  }): Promise<EnergyReservationResult>;

  startDispatch(input: {
    readonly orderId: string;
    readonly providerName: string;
  }): Promise<{
    readonly created: boolean;
    readonly order: EnergyConsumptionSnapshot;
  }>;

  applyDelivery(input: {
    readonly orderId: string;
    readonly providerName: string;
    readonly deliveryIdempotencyKey: string;
    readonly providerOrderId: string | null;
    readonly status: Exclude<ProviderDeliveryStatus, "pending">;
  }): Promise<EnergyConsumptionSnapshot>;

  getOwned(input: {
    readonly orderId: string;
    readonly telegramUserId: bigint;
  }): Promise<EnergyConsumptionSnapshot | undefined>;
}

export type PrepareEnergyUsageResult =
  | { readonly kind: "denied" }
  | { readonly kind: "invalid_address" }
  | {
      readonly kind: "ready";
      readonly recipientAddress: string;
      readonly availableCount: number;
      readonly reservedCount: number;
      readonly options: readonly EnergyOptionSummary[];
    };

export type ExecuteEnergyUsageResult =
  | { readonly kind: "denied" }
  | { readonly kind: "invalid_address" }
  | { readonly kind: "option_unavailable" }
  | {
      readonly kind: "insufficient_balance";
      readonly availableCount: number;
      readonly requiredCount: number;
    }
  | { readonly kind: "conflict" }
  | { readonly kind: "not_found" }
  | {
      readonly kind: "completed" | "processing" | "released";
      readonly order: EnergyConsumptionSnapshot;
    };

function canonicalTronAddress(
  codec: TronAddressCodec,
  value: string,
): string | undefined {
  const trimmed = value.trim();

  if (trimmed.length === 0) {
    return undefined;
  }

  const encoded: TronEncodedAddress = /^41[0-9a-fA-F]{40}$/.test(trimmed)
    ? { encoding: "hex41", value: trimmed }
    : { encoding: "base58check", value: trimmed };

  return codec.toBase58Check(encoded);
}

export class EnergyPreparationService {
  constructor(
    private readonly repository: Pick<EnergyUsageRepository, "prepare">,
    private readonly addressCodec: TronAddressCodec,
  ) {}

  async prepare(input: {
    readonly telegramUserId: bigint;
    readonly recipientAddress: string;
  }): Promise<PrepareEnergyUsageResult> {
    return this.preparation.prepare(input);
  }
}

function resultFromOrder(
  order: EnergyConsumptionSnapshot,
): ExecuteEnergyUsageResult {
  if (order.status === "completed") {
    return { kind: "completed", order };
  }

  if (order.status === "released" || order.status === "cancelled") {
    return { kind: "released", order };
  }

  return { kind: "processing", order };
}

function providerResultStatus(
  result: EnergyDeliveryResult | EnergyOrderStatus,
): Exclude<ProviderDeliveryStatus, "pending"> {
  return result.status;
}

export class EnergyUsageService {
  private readonly providers: ReadonlyMap<string, EnergyProvider>;
  private readonly preparation: EnergyPreparationService;
  // Transient same-process serialization only; durable idempotency remains in the repository/provider.
  private readonly activeOrders = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: EnergyUsageRepository,
    private readonly provider: EnergyProvider,
    addressCodec: TronAddressCodec,
    historicalProviders: readonly EnergyProvider[] = [],
  ) {
    this.preparation = new EnergyPreparationService(
      repository,
      addressCodec,
    );
    const registered = new Map<string, EnergyProvider>();
    for (const entry of [provider, ...historicalProviders]) {
      if (entry.name.trim().length === 0 || registered.has(entry.name)) {
        throw new Error("Energy providers must have distinct non-empty names");
      }
      registered.set(entry.name, entry);
    }
    this.providers = registered;
  }

  canResumeDelivery(providerName: string | null): boolean {
    return providerName === null || this.providers.has(providerName);
  }

  async prepare(input: {
    readonly telegramUserId: bigint;
    readonly recipientAddress: string;
  }): Promise<PrepareEnergyUsageResult> {
    const recipientAddress = canonicalTronAddress(
      this.addressCodec,
      input.recipientAddress,
    );

    if (recipientAddress === undefined) {
      return { kind: "invalid_address" };
    }

    const prepared = await this.repository.prepare(input.telegramUserId);

    if (prepared.kind === "denied") {
      return prepared;
    }

    return {
      kind: "ready",
      recipientAddress,
      availableCount: prepared.availableCount,
      reservedCount: prepared.reservedCount,
      options: prepared.options,
    };
  }

  async execute(input: {
    readonly telegramUserId: bigint;
    readonly optionCode: string;
    readonly recipientAddress: string;
    readonly idempotencyKey: string;
  }): Promise<ExecuteEnergyUsageResult> {
    const recipientAddress = canonicalTronAddress(
      this.addressCodec,
      input.recipientAddress,
    );

    if (recipientAddress === undefined) {
      return { kind: "invalid_address" };
    }

    const reservation = await this.repository.reserve({
      telegramUserId: input.telegramUserId,
      optionCode: input.optionCode,
      recipientAddress,
      idempotencyKey: input.idempotencyKey,
    });

    if (reservation.kind !== "ready") {
      return reservation;
    }

    if (
      reservation.order.status === "completed" ||
      reservation.order.status === "released" ||
      reservation.order.status === "cancelled" ||
      reservation.order.status === "delivery_failed"
    ) {
      return resultFromOrder(reservation.order);
    }

    return this.withOrderOperation(reservation.order.id, () =>
      this.dispatchReservedOrder(reservation.order));
  }

  private async dispatchReservedOrder(
    reservedOrder: EnergyConsumptionSnapshot,
  ): Promise<ExecuteEnergyUsageResult> {
    const provider = reservedOrder.delivery === null
      ? this.provider
      : this.providers.get(reservedOrder.delivery.providerName);
    if (provider === undefined) {
      return resultFromOrder(reservedOrder);
    }

    const dispatch = await this.repository.startDispatch({
      orderId: reservedOrder.id,
      providerName: provider.name,
    });

    if (dispatch.order.status !== "dispatching") {
      return resultFromOrder(dispatch.order);
    }

    const delivery = dispatch.order.delivery;

    if (delivery === null) {
      throw new Error("Dispatching Energy order is missing provider delivery");
    }

    if (!dispatch.created) {
      let recovered: EnergyDeliveryResult | EnergyOrderStatus | undefined;

      try {
        recovered = await this.continueExistingDelivery(
          dispatch.order,
          delivery,
          provider,
        );
      } catch {
        return resultFromOrder(dispatch.order);
      }

      if (recovered === undefined) {
        // Crash after durable reservation but before provider creation: resume
        // with the same provider key. The provider contract forbids a second order.
        const resumed = await provider.createDelivery({
          idempotencyKey: delivery.idempotencyKey,
          internalOrderId: dispatch.order.id,
          recipientAddress: dispatch.order.recipientAddress,
          energyAmount: dispatch.order.energyAmount,
        });
        return this.applyProviderResult(dispatch.order.id, delivery, resumed, provider);
      }

      return this.applyProviderResult(dispatch.order.id, delivery, recovered, provider);
    }

    let created: EnergyDeliveryResult;

    try {
      created = await provider.createDelivery({
        idempotencyKey: delivery.idempotencyKey,
        internalOrderId: dispatch.order.id,
        recipientAddress: dispatch.order.recipientAddress,
        energyAmount: dispatch.order.energyAmount,
      });
    } catch {
      let recovered: EnergyOrderStatus | undefined;

      try {
        recovered = await this.recoverExistingDelivery(delivery, provider);
      } catch {
        return resultFromOrder(dispatch.order);
      }

      if (recovered !== undefined) {
        return this.applyProviderResult(dispatch.order.id, delivery, recovered, provider);
      }

      return resultFromOrder(
        await this.repository.applyDelivery({
          orderId: dispatch.order.id,
          providerName: provider.name,
          deliveryIdempotencyKey: delivery.idempotencyKey,
          providerOrderId: delivery.providerOrderId,
          status: "unknown",
        }),
      );
    }

    return this.applyProviderResult(dispatch.order.id, delivery, created, provider);
  }

  async getStatus(input: {
    readonly orderId: string;
    readonly telegramUserId: bigint;
  }): Promise<ExecuteEnergyUsageResult> {
    return this.withOrderOperation(input.orderId, () => this.getStatusUnserialized(input));
  }

  private async getStatusUnserialized(input: {
    readonly orderId: string;
    readonly telegramUserId: bigint;
  }): Promise<ExecuteEnergyUsageResult> {
    const order = await this.repository.getOwned(input);

    if (order === undefined) {
      return { kind: "not_found" };
    }

    if (order.status !== "dispatching" || order.delivery === null) {
      return resultFromOrder(order);
    }

    const provider = this.providers.get(order.delivery.providerName);
    if (provider === undefined) {
      return resultFromOrder(order);
    }

    let recovered: EnergyDeliveryResult | EnergyOrderStatus | undefined;

    try {
      recovered = await this.continueExistingDelivery(
        order,
        order.delivery,
        provider,
      );
    } catch {
      return resultFromOrder(order);
    }

    if (recovered === undefined) {
      return resultFromOrder(order);
    }

    return this.applyProviderResult(order.id, order.delivery, recovered, provider);
  }

  private async withOrderOperation(
    orderId: string,
    run: () => Promise<ExecuteEnergyUsageResult>,
  ): Promise<ExecuteEnergyUsageResult> {
    const running = this.activeOrders.get(orderId);
    if (running !== undefined) {
      await running;
      return this.withOrderOperation(orderId, run);
    }

    let release!: () => void;
    const completed = new Promise<void>((resolve) => { release = resolve; });
    this.activeOrders.set(orderId, completed);
    try {
      return await run();
    } finally {
      this.activeOrders.delete(orderId);
      release();
    }
  }

  private async continueExistingDelivery(
    order: EnergyConsumptionSnapshot,
    delivery: EnergyDeliverySnapshot,
    provider: EnergyProvider,
  ): Promise<EnergyDeliveryResult | EnergyOrderStatus | undefined> {
    try {
      return await provider.createDelivery({
        idempotencyKey: delivery.idempotencyKey,
        internalOrderId: order.id,
        recipientAddress: order.recipientAddress,
        energyAmount: order.energyAmount,
      });
    } catch {
      return this.recoverExistingDelivery(delivery, provider);
    }
  }
  private async recoverExistingDelivery(
    delivery: EnergyDeliverySnapshot,
    provider: EnergyProvider,
  ): Promise<EnergyOrderStatus | undefined> {
    if (delivery.providerOrderId !== null) {
      return provider.getDeliveryStatus(delivery.providerOrderId);
    }

    return provider.findDeliveryByIdempotencyKey(
      delivery.idempotencyKey,
    );
  }

  private async applyProviderResult(
    orderId: string,
    delivery: EnergyDeliverySnapshot,
    result: EnergyDeliveryResult | EnergyOrderStatus,
    provider: EnergyProvider,
  ): Promise<ExecuteEnergyUsageResult> {
    if (result.idempotencyKey !== delivery.idempotencyKey) {
      throw new Error("Energy provider returned mismatched idempotency key");
    }

    const order = await this.repository.applyDelivery({
      orderId,
      providerName: provider.name,
      deliveryIdempotencyKey: delivery.idempotencyKey,
      providerOrderId: result.providerOrderId,
      status: providerResultStatus(result),
    });

    return resultFromOrder(order);
  }
}
