import type {
  EnergyDeliveryRequest,
  EnergyDeliveryResult,
  EnergyOrderStatus,
  EnergyProvider,
} from "../../core/providers/energy-provider.js";

const SUN_PER_TRX = 1_000_000n;
const TXID_PATTERN = /^[0-9a-fA-F]{64}$/;

export interface TronEnergyResourceSnapshot {
  readonly totalEnergyLimit: bigint;
  readonly totalEnergyWeight: bigint;
}

export function requiredDelegationSun(
  targetEnergy: bigint,
  snapshot: TronEnergyResourceSnapshot,
): bigint {
  if (targetEnergy <= 0n) {
    throw new Error("targetEnergy must be positive");
  }

  if (snapshot.totalEnergyLimit <= 0n || snapshot.totalEnergyWeight <= 0n) {
    throw new Error("TRON Energy resource snapshot must be positive");
  }

  const numerator =
    targetEnergy * SUN_PER_TRX * snapshot.totalEnergyWeight;
  const required =
    (numerator + snapshot.totalEnergyLimit - 1n) /
    snapshot.totalEnergyLimit;

  return required < SUN_PER_TRX ? SUN_PER_TRX : required;
}

export interface TronUnsignedDelegation {
  readonly txid: string;
  readonly transaction: Record<string, unknown>;
}

export interface TronSignedDelegation {
  readonly txid: string;
  readonly transaction: Record<string, unknown>;
}

export interface TronDelegationSigner {
  sign(input: {
    readonly idempotencyKey: string;
    readonly unsigned: TronUnsignedDelegation;
  }): Promise<TronSignedDelegation>;
}

export interface TronDelegationTransport {
  getEnergyResourceSnapshot(
    ownerAddress: string,
  ): Promise<TronEnergyResourceSnapshot>;

  getCanDelegatedEnergySun(ownerAddress: string): Promise<bigint>;

  buildEnergyDelegation(input: {
    readonly ownerAddress: string;
    readonly recipientAddress: string;
    readonly balanceSun: bigint;
  }): Promise<TronUnsignedDelegation>;

  broadcastSignedTransaction(
    transaction: Record<string, unknown>,
  ): Promise<"accepted" | "rejected" | "unknown">;

  getSolidifiedTransactionStatus(
    txid: string,
  ): Promise<"processing" | "completed" | "failed" | "unknown">;
}

export interface EnergyProviderJournalEntry {
  readonly idempotencyKey: string;
  readonly providerName: string;
  readonly providerOrderId: string | null;
  readonly status:
    | "pending"
    | "accepted"
    | "processing"
    | "completed"
    | "failed"
    | "unknown";
}

export interface EnergyProviderJournal {
  findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<EnergyProviderJournalEntry | undefined>;

  findByProviderOrderId(input: {
    readonly providerName: string;
    readonly providerOrderId: string;
  }): Promise<EnergyProviderJournalEntry | undefined>;

  claimProviderOrderId(input: {
    readonly idempotencyKey: string;
    readonly providerName: string;
    readonly providerOrderId: string;
  }): Promise<void>;
}

function requireTxid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();

  if (!TXID_PATTERN.test(normalized)) {
    throw new Error(
      `${field} must be a 64-character hexadecimal txid`,
    );
  }

  return normalized;
}

export class TronOwnPoolEnergyProvider implements EnergyProvider {
  readonly name = "tron-own-pool";

  constructor(
    private readonly ownerAddress: string,
    private readonly transport: TronDelegationTransport,
    private readonly signer: TronDelegationSigner,
    private readonly journal: EnergyProviderJournal,
  ) {
    if (ownerAddress.trim().length === 0) {
      throw new Error("ownerAddress must not be empty");
    }
  }

  async createDelivery(
    request: EnergyDeliveryRequest,
  ): Promise<EnergyDeliveryResult> {
    const existing = await this.journal.findByIdempotencyKey(
      request.idempotencyKey,
    );

    if (existing !== undefined && existing.providerName !== this.name) {
      throw new Error("Energy provider journal owner changed");
    }

    if (existing?.providerOrderId !== null &&
        existing?.providerOrderId !== undefined) {
      const recovered = await this.getDeliveryStatus(
        existing.providerOrderId,
      );

      return {
        providerOrderId: recovered.providerOrderId,
        idempotencyKey: recovered.idempotencyKey,
        status:
          recovered.status === "unknown"
            ? "processing"
            : recovered.status,
      };
    }

    if (existing?.status === "failed") {
      return {
        providerOrderId: null,
        idempotencyKey: request.idempotencyKey,
        status: "failed",
      };
    }

    const snapshot = await this.transport.getEnergyResourceSnapshot(
      this.ownerAddress,
    );
    const balanceSun = requiredDelegationSun(
      request.energyAmount,
      snapshot,
    );
    const maxDelegatable =
      await this.transport.getCanDelegatedEnergySun(
        this.ownerAddress,
      );

    if (maxDelegatable < balanceSun) {
      return {
        providerOrderId: null,
        idempotencyKey: request.idempotencyKey,
        status: "failed",
      };
    }

    const unsigned = await this.transport.buildEnergyDelegation({
      ownerAddress: this.ownerAddress,
      recipientAddress: request.recipientAddress,
      balanceSun,
    });
    const unsignedTxid = requireTxid(
      unsigned.txid,
      "unsigned txid",
    );

    const signed = await this.signer.sign({
      idempotencyKey: request.idempotencyKey,
      unsigned: {
        ...unsigned,
        txid: unsignedTxid,
      },
    });
    const signedTxid = requireTxid(
      signed.txid,
      "signed txid",
    );

    if (signedTxid !== unsignedTxid) {
      throw new Error("TRON signer changed transaction identity");
    }

    await this.journal.claimProviderOrderId({
      idempotencyKey: request.idempotencyKey,
      providerName: this.name,
      providerOrderId: signedTxid,
    });

    const broadcast =
      await this.transport.broadcastSignedTransaction(
        signed.transaction,
      );

    if (broadcast === "rejected") {
      return {
        providerOrderId: signedTxid,
        idempotencyKey: request.idempotencyKey,
        status: "failed",
      };
    }

    return {
      providerOrderId: signedTxid,
      idempotencyKey: request.idempotencyKey,
      status:
        broadcast === "accepted"
          ? "accepted"
          : "processing",
    };
  }

  async getDeliveryStatus(
    providerOrderId: string,
  ): Promise<EnergyOrderStatus> {
    const txid = requireTxid(
      providerOrderId,
      "providerOrderId",
    );
    const entry = await this.journal.findByProviderOrderId({
      providerName: this.name,
      providerOrderId: txid,
    });

    if (entry === undefined) {
      throw new Error(
        "TRON Energy provider order is not journaled",
      );
    }

    if (entry.status === "failed") {
      return {
        providerOrderId: txid,
        idempotencyKey: entry.idempotencyKey,
        status: "failed",
      };
    }

    const status =
      await this.transport.getSolidifiedTransactionStatus(
        txid,
      );

    return {
      providerOrderId: txid,
      idempotencyKey: entry.idempotencyKey,
      status,
    };
  }

  async findDeliveryByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<EnergyOrderStatus | undefined> {
    const entry = await this.journal.findByIdempotencyKey(
      idempotencyKey,
    );

    if (
      entry === undefined ||
      entry.providerName !== this.name
    ) {
      return undefined;
    }

    if (entry.providerOrderId === null) {
      return entry.status === "failed"
        ? {
            providerOrderId: null,
            idempotencyKey: entry.idempotencyKey,
            status: "failed",
          }
        : undefined;
    }

    return this.getDeliveryStatus(
      entry.providerOrderId,
    );
  }
}
