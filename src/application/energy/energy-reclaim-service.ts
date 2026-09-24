import type {
  EnergyReclaimAttemptJournal,
  ProviderReclaimAttemptEntry,
  TronReclaimSigner,
  TronReclaimTransport,
  TronSignedReclaim,
} from "../../adapters/energy/tron-own-pool-energy-provider.js";
import type { EnergyUsageRepository, EnergyUsageService } from "./energy-usage-service.js";

function expirationOf(transaction: Record<string, unknown>): Date {
  const raw = transaction.raw_data;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Reclaim transaction has no raw_data");
  }
  const value = (raw as Record<string, unknown>).expiration;
  const number = typeof value === "string" && /^[1-9][0-9]*$/.test(value)
    ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
    throw new Error("Reclaim transaction has invalid expiration");
  }
  return new Date(number);
}

function validateSigned(signed: TronSignedReclaim, expected?: string): TronSignedReclaim {
  if (!/^[0-9a-fA-F]{64}$/.test(signed.txid) ||
    (expected !== undefined && signed.txid.toLowerCase() !== expected.toLowerCase()) ||
    signed.transaction.txID !== signed.txid ||
    !Array.isArray(signed.transaction.signature) ||
    signed.transaction.signature.length === 0) {
    throw new Error("Reclaim signer returned a mismatched transaction");
  }
  return signed;
}

/** Reconcile durable reclaim attempts. All ambiguous outcomes retain the same signed txID. */
export class EnergyReclaimService {
  private pendingCursor: string | undefined;
  private reclaimCursor: string | undefined;

  constructor(
    private readonly journal: EnergyReclaimAttemptJournal,
    private readonly signer: TronReclaimSigner,
    private readonly transport: TronReclaimTransport,
    private readonly providerName = "tron-own-pool",
    private readonly maxSources = 50,
    private readonly pendingOrders?: Pick<EnergyUsageRepository, "listPending">,
    private readonly energyUsage?: Pick<EnergyUsageService, "execute" | "canResumeDelivery">,
  ) {}

  async runOnce(): Promise<void> {
    if (this.pendingOrders !== undefined && this.energyUsage !== undefined) {
      let orders = await this.pendingOrders.listPending(this.maxSources, this.pendingCursor);
      if (orders.length === 0 && this.pendingCursor !== undefined) {
        this.pendingCursor = undefined;
        orders = await this.pendingOrders.listPending(this.maxSources);
      }
      for (const order of orders) {
        this.pendingCursor = order.idempotencyKey;
        // Dispatching orders remain bound to their original provider.
        if (!this.energyUsage.canResumeDelivery(order.providerName)) {
          continue;
        }
        try {
          await this.energyUsage.execute(order);
        } catch (error) {
          console.error(`Energy delivery reconciliation failed: type=${error instanceof Error ? error.name : "UnknownError"}`);
        }
      }
    }
    let sources = await this.journal.listDueSources(this.maxSources, this.reclaimCursor);
    if (sources.length === 0 && this.reclaimCursor !== undefined) {
      this.reclaimCursor = undefined;
      sources = await this.journal.listDueSources(this.maxSources);
    }
    for (const sourceId of sources) {
      this.reclaimCursor = sourceId;
      try {
        await this.reconcile(sourceId);
      } catch (error) {
        // Do not print signed transaction material or signer responses.
        console.error(`Energy reclaim source failed: ${sourceId}; type=${error instanceof Error ? error.name : "UnknownError"}`);
      }
    }
  }

  private async reconcile(sourceId: string): Promise<void> {
    const attempt = await this.journal.getOrCreateCurrentAttempt({
      sourceProviderTransactionAttemptId: sourceId,
      providerName: this.providerName,
    });
    if (["completed", "failed", "expired"].includes(attempt.status)) return;

    let signed = await this.signer.findSignedByAttemptKey(attempt.attemptKey);
    if (attempt.txid !== null) {
      if (signed !== undefined) validateSigned(signed, attempt.txid);
      await this.observe(attempt, signed);
      return;
    }

    if (signed === undefined) {
      const binding = await this.journal.getSourceBinding(sourceId);
      const unsigned = await this.transport.buildEnergyReclaim({
        ownerAddress: binding.ownerAddress,
        recipientAddress: binding.receiverAddress,
        balanceSun: binding.balanceSun,
      });
      signed = validateSigned(await this.signer.sign({
        attemptKey: attempt.attemptKey,
        unsigned,
      }), unsigned.txid);
    } else {
      validateSigned(signed);
    }

    const claimed = await this.journal.claimTransaction({
      attemptKey: attempt.attemptKey,
      txid: signed.txid,
      expirationAt: expirationOf(signed.transaction),
    });
    await this.observe(claimed, signed);
  }

  private async observe(attempt: ProviderReclaimAttemptEntry, signed?: TronSignedReclaim): Promise<void> {
    if (attempt.txid === null || attempt.expirationAt === null) {
      throw new Error("Reclaim attempt lacks transaction identity");
    }
    const result = await this.transport.getReclaimTransactionObservation({
      txid: attempt.txid,
      expirationAt: attempt.expirationAt,
    });
    if (result.status === "completed" || result.status === "failed") {
      await this.journal.recordState({
        attemptKey: attempt.attemptKey,
        status: result.status,
        lastChainStatus: result.status,
      });
      return;
    }
    if (result.status === "absent") {
      await this.journal.recordState({
        attemptKey: attempt.attemptKey,
        status: "expired",
        lastChainStatus: "absent",
        lastChainObservedAt: result.solidifiedObservedAt,
      });
      return;
    }
    if (result.status === "processing") {
      await this.journal.recordState({
        attemptKey: attempt.attemptKey,
        status: "processing",
        lastChainStatus: "processing",
      });
      return;
    }
    const recovered = signed ?? await this.signer.findSignedByAttemptKey(attempt.attemptKey);
    if (recovered === undefined) return;
    validateSigned(recovered, attempt.txid);
    if (Date.now() >= attempt.expirationAt.getTime()) return;
    const broadcast = await this.transport.broadcastSignedTransaction(recovered.transaction);
    await this.journal.recordState({
      attemptKey: attempt.attemptKey,
      status: broadcast === "accepted" ? "accepted" : "unknown",
      lastBroadcastResult: broadcast,
    });
  }
}
