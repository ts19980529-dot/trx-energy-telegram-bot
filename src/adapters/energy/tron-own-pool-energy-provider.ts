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

  if (
    snapshot.totalEnergyLimit <= 0n ||
    snapshot.totalEnergyWeight <= 0n
  ) {
    throw new Error(
      "TRON Energy resource snapshot must be positive",
    );
  }

  const numerator =
    targetEnergy *
    SUN_PER_TRX *
    snapshot.totalEnergyWeight;
  const required =
    (numerator + snapshot.totalEnergyLimit - 1n) /
    snapshot.totalEnergyLimit;

  return required < SUN_PER_TRX
    ? SUN_PER_TRX
    : required;
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
  /**
   * The signer boundary must durably bind idempotencyKey to the signed
   * transaction before returning. Repeating the same key must return the
   * exact same transaction identity instead of signing a replacement.
   */
  sign(input: {
    readonly idempotencyKey: string;
    readonly unsigned: TronUnsignedDelegation;
  }): Promise<TronSignedDelegation>;

  /**
   * Recovers the exact previously signed transaction after a Bot Core
   * timeout/restart. This is required so a signed-but-not-yet-broadcast
   * transaction can be safely rebroadcast without creating a second txID.
   */
  findSignedByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<TronSignedDelegation | undefined>;
}

export interface TronDelegationTransport {
  getEnergyResourceSnapshot(
    ownerAddress: string,
  ): Promise<TronEnergyResourceSnapshot>;

  getCanDelegatedEnergySun(
    ownerAddress: string,
  ): Promise<bigint>;

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
  ): Promise<
    "processing" | "completed" | "failed" | "unknown"
  >;
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

function requireTxid(
  value: string,
  field: string,
): string {
  const normalized = value.trim().toLowerCase();

  if (!TXID_PATTERN.test(normalized)) {
    throw new Error(
      `${field} must be a 64-character hexadecimal txid`,
    );
  }

  return normalized;
}

function transactionTxid(
  transaction: Record<string, unknown>,
): string {
  if (typeof transaction.txID !== "string") {
    throw new Error(
      "Signed TRON transaction is missing txID",
    );
  }

  return requireTxid(
    transaction.txID,
    "signed transaction txID",
  );
}

function assertSignedTransaction(
  signed: TronSignedDelegation,
  expectedTxid?: string,
): TronSignedDelegation {
  const signedTxid = requireTxid(
    signed.txid,
    "signed txid",
  );
  const embeddedTxid = transactionTxid(
    signed.transaction,
  );

  if (signedTxid !== embeddedTxid) {
    throw new Error(
      "TRON signer returned inconsistent transaction identity",
    );
  }

  if (
    expectedTxid !== undefined &&
    signedTxid !== requireTxid(
      expectedTxid,
      "expected txid",
    )
  ) {
    throw new Error(
      "TRON signer changed transaction identity",
    );
  }

  if (
    !Array.isArray(signed.transaction.signature) ||
    signed.transaction.signature.length === 0 ||
    signed.transaction.signature.some(
      (value) =>
        typeof value !== "string" ||
        value.trim().length === 0,
    )
  ) {
    throw new Error(
      "TRON signer returned an unsigned transaction",
    );
  }

  return {
    txid: signedTxid,
    transaction: signed.transaction,
  };
}

function deliveryStatusFromOrderStatus(
  status: EnergyOrderStatus["status"],
): EnergyDeliveryResult["status"] {
  return status === "unknown"
    ? "processing"
    : status;
}

export class TronOwnPoolEnergyProvider
  implements EnergyProvider
{
  readonly name = "tron-own-pool";

  constructor(
    private readonly ownerAddress: string,
    private readonly transport: TronDelegationTransport,
    private readonly signer: TronDelegationSigner,
    private readonly journal: EnergyProviderJournal,
  ) {
    if (ownerAddress.trim().length === 0) {
      throw new Error(
        "ownerAddress must not be empty",
      );
    }
  }

  async createDelivery(
    request: EnergyDeliveryRequest,
  ): Promise<EnergyDeliveryResult> {
    const existing =
      await this.journal.findByIdempotencyKey(
        request.idempotencyKey,
      );

    if (
      existing !== undefined &&
      existing.providerName !== this.name
    ) {
      throw new Error(
        "Energy provider journal owner changed",
      );
    }

    if (existing?.status === "failed") {
      return {
        providerOrderId:
          existing.providerOrderId,
        idempotencyKey: request.idempotencyKey,
        status: "failed",
      };
    }

    if (existing?.providerOrderId !== null &&
        existing?.providerOrderId !== undefined) {
      const status = await this.getDeliveryStatus(
        existing.providerOrderId,
      );

      if (status.status !== "unknown") {
        return {
          providerOrderId:
            status.providerOrderId,
          idempotencyKey:
            status.idempotencyKey,
          status:
            deliveryStatusFromOrderStatus(
              status.status,
            ),
        };
      }

      const signed =
        await this.recoverSignedTransaction(
          request.idempotencyKey,
          existing.providerOrderId,
        );

      if (signed === undefined) {
        return {
          providerOrderId:
            existing.providerOrderId,
          idempotencyKey:
            request.idempotencyKey,
          status: "processing",
        };
      }

      return this.broadcastClaimedTransaction(
        request.idempotencyKey,
        signed,
      );
    }

    const previouslySigned =
      await this.recoverSignedTransaction(
        request.idempotencyKey,
      );

    if (previouslySigned !== undefined) {
      await this.journal.claimProviderOrderId({
        idempotencyKey:
          request.idempotencyKey,
        providerName: this.name,
        providerOrderId:
          previouslySigned.txid,
      });

      return this.broadcastClaimedTransaction(
        request.idempotencyKey,
        previouslySigned,
      );
    }

    const snapshot =
      await this.transport.getEnergyResourceSnapshot(
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
        idempotencyKey:
          request.idempotencyKey,
        status: "failed",
      };
    }

    const unsigned =
      await this.transport.buildEnergyDelegation({
        ownerAddress: this.ownerAddress,
        recipientAddress:
          request.recipientAddress,
        balanceSun,
      });
    const unsignedTxid = requireTxid(
      unsigned.txid,
      "unsigned txid",
    );

    const signed = assertSignedTransaction(
      await this.signer.sign({
        idempotencyKey:
          request.idempotencyKey,
        unsigned: {
          ...unsigned,
          txid: unsignedTxid,
        },
      }),
      unsignedTxid,
    );

    await this.journal.claimProviderOrderId({
      idempotencyKey:
        request.idempotencyKey,
      providerName: this.name,
      providerOrderId: signed.txid,
    });

    return this.broadcastClaimedTransaction(
      request.idempotencyKey,
      signed,
    );
  }

  async getDeliveryStatus(
    providerOrderId: string,
  ): Promise<EnergyOrderStatus> {
    const txid = requireTxid(
      providerOrderId,
      "providerOrderId",
    );
    const entry =
      await this.journal.findByProviderOrderId({
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
        idempotencyKey:
          entry.idempotencyKey,
        status: "failed",
      };
    }

    const status =
      await this.transport.getSolidifiedTransactionStatus(
        txid,
      );

    return {
      providerOrderId: txid,
      idempotencyKey:
        entry.idempotencyKey,
      status,
    };
  }

  async findDeliveryByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<EnergyOrderStatus | undefined> {
    const entry =
      await this.journal.findByIdempotencyKey(
        idempotencyKey,
      );

    if (
      entry === undefined ||
      entry.providerName !== this.name
    ) {
      return undefined;
    }

    if (entry.status === "failed") {
      return {
        providerOrderId:
          entry.providerOrderId,
        idempotencyKey:
          entry.idempotencyKey,
        status: "failed",
      };
    }

    if (entry.providerOrderId !== null) {
      const status =
        await this.getDeliveryStatus(
          entry.providerOrderId,
        );

      if (status.status !== "unknown") {
        return status;
      }

      const signed =
        await this.recoverSignedTransaction(
          idempotencyKey,
          entry.providerOrderId,
        );

      if (signed === undefined) {
        return {
          providerOrderId:
            entry.providerOrderId,
          idempotencyKey,
          status: "unknown",
        };
      }

      return this.rebroadcastForRecovery(
        idempotencyKey,
        signed,
      );
    }

    const signed =
      await this.recoverSignedTransaction(
        idempotencyKey,
      );

    if (signed === undefined) {
      return undefined;
    }

    await this.journal.claimProviderOrderId({
      idempotencyKey,
      providerName: this.name,
      providerOrderId: signed.txid,
    });

    return this.rebroadcastForRecovery(
      idempotencyKey,
      signed,
    );
  }

  private async recoverSignedTransaction(
    idempotencyKey: string,
    expectedTxid?: string,
  ): Promise<TronSignedDelegation | undefined> {
    const signed =
      await this.signer.findSignedByIdempotencyKey(
        idempotencyKey,
      );

    return signed === undefined
      ? undefined
      : assertSignedTransaction(
          signed,
          expectedTxid,
        );
  }

  private async broadcastClaimedTransaction(
    idempotencyKey: string,
    signed: TronSignedDelegation,
  ): Promise<EnergyDeliveryResult> {
    const broadcast =
      await this.transport.broadcastSignedTransaction(
        signed.transaction,
      );

    if (broadcast === "rejected") {
      return {
        providerOrderId: signed.txid,
        idempotencyKey,
        status: "failed",
      };
    }

    return {
      providerOrderId: signed.txid,
      idempotencyKey,
      status:
        broadcast === "accepted"
          ? "accepted"
          : "processing",
    };
  }

  private async rebroadcastForRecovery(
    idempotencyKey: string,
    signed: TronSignedDelegation,
  ): Promise<EnergyOrderStatus> {
    const result =
      await this.broadcastClaimedTransaction(
        idempotencyKey,
        signed,
      );

    return {
      providerOrderId:
        result.providerOrderId,
      idempotencyKey,
      status:
        result.status === "failed"
          ? "failed"
          : "processing",
    };
  }
}
