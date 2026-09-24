import { TronWeb } from "tronweb";

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

export interface TronDelegationBinding {
  readonly ownerAddress: string;
  readonly receiverAddress: string;
  readonly resource: "ENERGY";
  readonly balanceSun: bigint;
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
   * The signer boundary must durably bind attemptKey to the signed
   * transaction before returning. Repeating the same attemptKey must return
   * the exact same transaction identity instead of signing a replacement.
   */
  sign(input: {
    readonly attemptKey: string;
    readonly unsigned: TronUnsignedDelegation;
  }): Promise<TronSignedDelegation>;

  /**
   * Recovers the exact transaction durably bound to one attemptKey after a
   * Bot Core timeout/restart. A replacement attempt uses a different key and
   * can only be created after the prior attempt is proven expired and absent.
   */
  findSignedByAttemptKey(
    attemptKey: string,
  ): Promise<TronSignedDelegation | undefined>;
}

export interface TronUnsignedReclaim {
  readonly txid: string;
  readonly transaction: Record<string, unknown>;
}

export interface TronSignedReclaim {
  readonly txid: string;
  readonly transaction: Record<string, unknown>;
}

export interface TronReclaimSigner {
  sign(input: {
    readonly attemptKey: string;
    readonly unsigned: TronUnsignedReclaim;
  }): Promise<TronSignedReclaim>;

  findSignedByAttemptKey(
    attemptKey: string,
  ): Promise<TronSignedReclaim | undefined>;
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

  getTransactionObservation(input: {
    readonly txid: string;
    readonly expirationAt: Date;
  }): Promise<TronTransactionObservation>;
}

export interface TronReclaimTransport {
  buildEnergyReclaim(input: {
    readonly ownerAddress: string;
    readonly recipientAddress: string;
    readonly balanceSun: bigint;
  }): Promise<TronUnsignedReclaim>;

  broadcastSignedTransaction(
    transaction: Record<string, unknown>,
  ): Promise<"accepted" | "rejected" | "unknown">;

  getReclaimTransactionObservation(input: {
    readonly txid: string;
    readonly expirationAt: Date;
  }): Promise<TronTransactionObservation>;
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
export type ProviderTransactionAttemptStatus =
  | "created"
  | "signed"
  | "accepted"
  | "processing"
  | "completed"
  | "failed"
  | "expired"
  | "unknown";

export type ProviderBroadcastResult =
  | "accepted"
  | "rejected"
  | "unknown";

export type ProviderChainStatus =
  | "absent"
  | "processing"
  | "completed"
  | "failed"
  | "unknown";

export type TronTransactionObservation =
  | { readonly status: "processing" | "completed" | "failed" | "unknown" }
  | {
      readonly status: "absent";
      readonly solidifiedObservedAt: Date;
    };

export interface ProviderTransactionAttemptEntry {
  readonly id: string;
  readonly providerDeliveryId: string;
  readonly attemptNumber: number;
  readonly attemptKey: string;
  readonly txid: string | null;
  readonly expirationAt: Date | null;
  readonly delegationBinding: TronDelegationBinding | null;
  readonly status: ProviderTransactionAttemptStatus;
  readonly lastBroadcastResult: ProviderBroadcastResult | null;
  readonly lastChainStatus: ProviderChainStatus | null;
  readonly lastChainObservedAt: Date | null;
}

export interface EnergyProviderAttemptJournal {
  getOrCreateCurrentAttempt(input: {
    readonly idempotencyKey: string;
    readonly providerName: string;
  }): Promise<ProviderTransactionAttemptEntry>;

  bindDelegation(input: {
    readonly attemptKey: string;
    readonly providerName: string;
    readonly binding: TronDelegationBinding;
  }): Promise<ProviderTransactionAttemptEntry>;

  claimAttemptTransaction(input: {
    readonly attemptKey: string;
    readonly providerName: string;
    readonly txid: string;
    readonly expirationAt: Date;
  }): Promise<ProviderTransactionAttemptEntry>;

  recordAttemptState(input: {
    readonly attemptKey: string;
    readonly providerName: string;
    readonly status: ProviderTransactionAttemptStatus;
    readonly lastBroadcastResult?: ProviderBroadcastResult;
    readonly lastChainStatus?: ProviderChainStatus;
    readonly lastChainObservedAt?: Date;
  }): Promise<ProviderTransactionAttemptEntry>;

  listAttempts(input: {
    readonly idempotencyKey: string;
    readonly providerName: string;
  }): Promise<readonly ProviderTransactionAttemptEntry[]>;
}


export type ProviderReclaimAttemptStatus =
  | "created"
  | "signed"
  | "accepted"
  | "processing"
  | "completed"
  | "failed"
  | "expired"
  | "unknown";

export interface ProviderReclaimAttemptEntry {
  readonly id: string;
  readonly sourceProviderTransactionAttemptId: string;
  readonly attemptNumber: number;
  readonly attemptKey: string;
  readonly txid: string | null;
  readonly expirationAt: Date | null;
  readonly status: ProviderReclaimAttemptStatus;
  readonly lastBroadcastResult: ProviderBroadcastResult | null;
  readonly lastChainStatus: ProviderChainStatus | null;
  readonly lastChainObservedAt: Date | null;
}

export interface EnergyReclaimAttemptJournal {
  getOrCreateCurrentAttempt(input: {
    readonly sourceProviderTransactionAttemptId: string;
    readonly providerName: string;
  }): Promise<ProviderReclaimAttemptEntry>;

  listAttempts(input: {
    readonly sourceProviderTransactionAttemptId: string;
    readonly providerName: string;
  }): Promise<readonly ProviderReclaimAttemptEntry[]>;
}

const TRON_HEX_ADDRESS_PATTERN = /^41[0-9a-fA-F]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function canonicalBase58Address(value: string, field: string): string {
  const trimmed = value.trim();
  try {
    const hex = TRON_HEX_ADDRESS_PATTERN.test(trimmed)
      ? trimmed
      : TronWeb.address.toHex(trimmed);
    const base58 = TronWeb.address.fromHex(hex);
    if (typeof base58 !== "string" || base58.trim() === "") throw new Error("invalid");
    return base58;
  } catch {
    throw new Error(`${field} must be a valid TRON address`);
  }
}

function delegationBindingFromTransaction(
  transaction: Record<string, unknown>,
): TronDelegationBinding {
  const rawData = transaction.raw_data;
  if (!isRecord(rawData) || !Array.isArray(rawData.contract)) {
    throw new Error("TRON delegation transaction raw_data is malformed");
  }
  if (rawData.contract.length !== 1 || !isRecord(rawData.contract[0])) {
    throw new Error("TRON delegation transaction must contain exactly one contract");
  }
  const contract = rawData.contract[0];
  if (contract.type !== "DelegateResourceContract") {
    throw new Error("TRON delegation transaction contract type mismatch");
  }
  const parameter = contract.parameter;
  if (!isRecord(parameter) || !isRecord(parameter.value)) {
    throw new Error("TRON DelegateResource parameter is malformed");
  }
  const value = parameter.value;
  if (value.resource !== "ENERGY") throw new Error("TRON delegation transaction must use ENERGY");
  if (value.lock === true) throw new Error("TRON delegation transaction must be unlocked");
  if (value.lock_period !== undefined && value.lock_period !== 0 && value.lock_period !== "0") {
    throw new Error("TRON delegation transaction lock period is not allowed");
  }
  const balance = value.balance;
  if (typeof balance !== "number" || !Number.isSafeInteger(balance) || balance < Number(SUN_PER_TRX)) {
    throw new Error("TRON delegation balance is invalid");
  }
  return {
    ownerAddress: canonicalBase58Address(
      requireNonEmptyString(value.owner_address, "DelegateResource owner_address"),
      "DelegateResource owner_address",
    ),
    receiverAddress: canonicalBase58Address(
      requireNonEmptyString(value.receiver_address, "DelegateResource receiver_address"),
      "DelegateResource receiver_address",
    ),
    resource: "ENERGY",
    balanceSun: BigInt(balance),
  };
}

function assertBindingMatchesExpected(
  binding: TronDelegationBinding,
  expected: {
    readonly ownerAddress: string;
    readonly receiverAddress: string;
    readonly balanceSun?: bigint;
  },
): void {
  if (binding.ownerAddress !== canonicalBase58Address(expected.ownerAddress, "expected owner address")) {
    throw new Error("TRON delegation owner address mismatch");
  }
  if (binding.receiverAddress !== canonicalBase58Address(expected.receiverAddress, "expected receiver address")) {
    throw new Error("TRON delegation receiver address mismatch");
  }
  if (expected.balanceSun !== undefined && binding.balanceSun !== expected.balanceSun) {
    throw new Error("TRON delegation balance mismatch");
  }
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

function transactionExpirationAt(
  transaction: Record<string, unknown>,
): Date {
  const rawData = transaction.raw_data;
  if (typeof rawData !== "object" || rawData === null || Array.isArray(rawData)) {
    throw new Error("TRON transaction is missing raw_data");
  }

  const value = (rawData as Record<string, unknown>).expiration;
  let milliseconds: number;

  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    milliseconds = value;
  } else if (typeof value === "string" && /^[1-9][0-9]*$/.test(value)) {
    const parsed = BigInt(value);
    if (parsed > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("TRON transaction expiration is outside the safe integer range");
    }
    milliseconds = Number(parsed);
  } else {
    throw new Error("TRON transaction expiration is missing or malformed");
  }

  const result = new Date(milliseconds);
  if (Number.isNaN(result.getTime())) {
    throw new Error("TRON transaction expiration is invalid");
  }
  return result;
}

function asOrderStatus(
  result: EnergyDeliveryResult,
): EnergyOrderStatus {
  return {
    providerOrderId: result.providerOrderId,
    idempotencyKey: result.idempotencyKey,
    status: result.status === "accepted" ? "processing" : result.status,
  };
}

export class TronOwnPoolEnergyProvider implements EnergyProvider {
  readonly name = "tron-own-pool";

  constructor(
    private readonly ownerAddress: string,
    private readonly transport: TronDelegationTransport,
    private readonly signer: TronDelegationSigner,
    private readonly journal: EnergyProviderJournal,
    private readonly attemptJournal: EnergyProviderAttemptJournal,
  ) {
    if (ownerAddress.trim().length === 0) {
      throw new Error("ownerAddress must not be empty");
    }
  }

  async createDelivery(
    request: EnergyDeliveryRequest,
  ): Promise<EnergyDeliveryResult> {
    const existing = await this.journal.findByIdempotencyKey(request.idempotencyKey);
    if (existing === undefined) {
      throw new Error("Energy provider journal row is missing");
    }
    if (existing.providerName !== this.name) {
      throw new Error("Energy provider journal owner changed");
    }
    if (existing.status === "failed") {
      return {
        providerOrderId: existing.providerOrderId,
        idempotencyKey: request.idempotencyKey,
        status: "failed",
      };
    }

    const attempt = await this.attemptJournal.getOrCreateCurrentAttempt({
      idempotencyKey: request.idempotencyKey,
      providerName: this.name,
    });
    return this.advanceAttempt(request, attempt, true);
  }

  async getDeliveryStatus(
    providerOrderId: string,
  ): Promise<EnergyOrderStatus> {
    const txid = requireTxid(providerOrderId, "providerOrderId");
    const entry = await this.journal.findByProviderOrderId({
      providerName: this.name,
      providerOrderId: txid,
    });
    if (entry === undefined) {
      throw new Error("TRON Energy provider order is not journaled");
    }

    const attempts = await this.attemptJournal.listAttempts({
      idempotencyKey: entry.idempotencyKey,
      providerName: this.name,
    });
    const attempt = attempts.find((candidate) => candidate.txid === txid);
    if (attempt === undefined) {
      throw new Error("TRON Energy provider transaction attempt is not journaled");
    }

    return asOrderStatus(
      await this.reconcileAttempt(entry.idempotencyKey, attempt),
    );
  }

  async findDeliveryByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<EnergyOrderStatus | undefined> {
    const entry = await this.journal.findByIdempotencyKey(idempotencyKey);
    if (entry === undefined || entry.providerName !== this.name) return undefined;
    if (entry.status === "failed") {
      return {
        providerOrderId: entry.providerOrderId,
        idempotencyKey,
        status: "failed",
      };
    }

    const attempts = await this.attemptJournal.listAttempts({
      idempotencyKey,
      providerName: this.name,
    });
    const attempt = attempts.at(-1);
    if (attempt === undefined) return undefined;

    if (attempt.status === "created") {
      const recovered = await this.recoverSignedTransaction(attempt.attemptKey);
      if (recovered === undefined) return undefined;
      if (attempt.delegationBinding === null) {
        throw new Error("TRON provider attempt is missing delegation binding");
      }
      const recoveredBinding = delegationBindingFromTransaction(recovered.transaction);
      assertBindingMatchesExpected(recoveredBinding, {
        ownerAddress: attempt.delegationBinding.ownerAddress,
        receiverAddress: attempt.delegationBinding.receiverAddress,
        balanceSun: attempt.delegationBinding.balanceSun,
      });
      const expirationAt = transactionExpirationAt(recovered.transaction);
      const claimed = await this.attemptJournal.claimAttemptTransaction({
        attemptKey: attempt.attemptKey,
        providerName: this.name,
        txid: recovered.txid,
        expirationAt,
      });
      return asOrderStatus(
        await this.broadcastAttempt(idempotencyKey, claimed, recovered),
      );
    }

    if (attempt.status === "expired") return undefined;
    return asOrderStatus(await this.reconcileAttempt(idempotencyKey, attempt));
  }

  private async advanceAttempt(
    request: EnergyDeliveryRequest,
    attempt: ProviderTransactionAttemptEntry,
    allowReplacement: boolean,
  ): Promise<EnergyDeliveryResult> {
    if (attempt.status === "completed" || attempt.status === "failed") {
      return {
        providerOrderId: attempt.txid,
        idempotencyKey: request.idempotencyKey,
        status: attempt.status,
      };
    }

    if (attempt.status === "created") {
      return this.startAttempt(request, attempt);
    }

    if (attempt.status === "expired") {
      const next = await this.attemptJournal.getOrCreateCurrentAttempt({
        idempotencyKey: request.idempotencyKey,
        providerName: this.name,
      });
      return this.advanceAttempt(request, next, false);
    }

    const reconciled = await this.reconcileAttempt(request.idempotencyKey, attempt);
    const refreshed = (await this.attemptJournal.listAttempts({
      idempotencyKey: request.idempotencyKey,
      providerName: this.name,
    })).at(-1);

    if (
      allowReplacement &&
      refreshed !== undefined &&
      refreshed.status === "expired"
    ) {
      const next = await this.attemptJournal.getOrCreateCurrentAttempt({
        idempotencyKey: request.idempotencyKey,
        providerName: this.name,
      });
      if (next.id !== refreshed.id) {
        return this.advanceAttempt(request, next, false);
      }
    }

    return reconciled;
  }

  private async startAttempt(
    request: EnergyDeliveryRequest,
    attempt: ProviderTransactionAttemptEntry,
  ): Promise<EnergyDeliveryResult> {
    const recovered = await this.recoverSignedTransaction(attempt.attemptKey);
    if (recovered !== undefined) {
      const recoveredBinding = delegationBindingFromTransaction(recovered.transaction);
      assertBindingMatchesExpected(recoveredBinding, {
        ownerAddress: this.ownerAddress,
        receiverAddress: request.recipientAddress,
      });
      const boundAttempt = await this.attemptJournal.bindDelegation({
        attemptKey: attempt.attemptKey,
        providerName: this.name,
        binding: recoveredBinding,
      });
      if (boundAttempt.delegationBinding === null) {
        throw new Error("TRON provider attempt delegation binding was not persisted");
      }
      const expirationAt = transactionExpirationAt(recovered.transaction);
      const claimed = await this.attemptJournal.claimAttemptTransaction({
        attemptKey: attempt.attemptKey,
        providerName: this.name,
        txid: recovered.txid,
        expirationAt,
      });
      return this.broadcastAttempt(request.idempotencyKey, claimed, recovered);
    }

    let balanceSun = attempt.delegationBinding?.balanceSun;
    if (attempt.delegationBinding !== null) {
      assertBindingMatchesExpected(attempt.delegationBinding, {
        ownerAddress: this.ownerAddress,
        receiverAddress: request.recipientAddress,
      });
    } else {
      const snapshot = await this.transport.getEnergyResourceSnapshot(this.ownerAddress);
      balanceSun = requiredDelegationSun(request.energyAmount, snapshot);
    }
    if (balanceSun === undefined) throw new Error("TRON delegation balance is unavailable");

    const maxDelegatable = await this.transport.getCanDelegatedEnergySun(this.ownerAddress);
    if (maxDelegatable < balanceSun) {
      await this.attemptJournal.recordAttemptState({
        attemptKey: attempt.attemptKey,
        providerName: this.name,
        status: "failed",
      });
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
    const unsignedBinding = delegationBindingFromTransaction(unsigned.transaction);
    assertBindingMatchesExpected(unsignedBinding, {
      ownerAddress: this.ownerAddress,
      receiverAddress: request.recipientAddress,
      balanceSun,
    });
    await this.attemptJournal.bindDelegation({
      attemptKey: attempt.attemptKey,
      providerName: this.name,
      binding: unsignedBinding,
    });

    const unsignedTxid = requireTxid(unsigned.txid, "unsigned txid");
    const expirationAt = transactionExpirationAt(unsigned.transaction);
    const signed = assertSignedTransaction(
      await this.signer.sign({
        attemptKey: attempt.attemptKey,
        unsigned: { ...unsigned, txid: unsignedTxid },
      }),
      unsignedTxid,
    );
    if (transactionExpirationAt(signed.transaction).getTime() !== expirationAt.getTime()) {
      throw new Error("TRON signer changed transaction expiration");
    }

    const claimed = await this.attemptJournal.claimAttemptTransaction({
      attemptKey: attempt.attemptKey,
      providerName: this.name,
      txid: signed.txid,
      expirationAt,
    });
    return this.broadcastAttempt(request.idempotencyKey, claimed, signed);
  }

  private async reconcileAttempt(
    idempotencyKey: string,
    attempt: ProviderTransactionAttemptEntry,
  ): Promise<EnergyDeliveryResult> {
    if (attempt.status === "completed" || attempt.status === "failed") {
      return { providerOrderId: attempt.txid, idempotencyKey, status: attempt.status };
    }
    if (attempt.txid === null || attempt.expirationAt === null) {
      throw new Error("Active TRON provider attempt is missing transaction identity");
    }

    const observation = await this.transport.getTransactionObservation({
      txid: attempt.txid,
      expirationAt: attempt.expirationAt,
    });

    if (observation.status === "completed" || observation.status === "failed") {
      await this.attemptJournal.recordAttemptState({
        attemptKey: attempt.attemptKey,
        providerName: this.name,
        status: observation.status,
        lastChainStatus: observation.status,
      });
      return { providerOrderId: attempt.txid, idempotencyKey, status: observation.status };
    }

    if (observation.status === "processing") {
      await this.attemptJournal.recordAttemptState({
        attemptKey: attempt.attemptKey,
        providerName: this.name,
        status: "processing",
        lastChainStatus: "processing",
      });
      return { providerOrderId: attempt.txid, idempotencyKey, status: "processing" };
    }

    if (observation.status === "absent") {
      await this.attemptJournal.recordAttemptState({
        attemptKey: attempt.attemptKey,
        providerName: this.name,
        status: "expired",
        lastChainStatus: "absent",
        lastChainObservedAt: observation.solidifiedObservedAt,
      });
      return { providerOrderId: attempt.txid, idempotencyKey, status: "processing" };
    }

    await this.attemptJournal.recordAttemptState({
      attemptKey: attempt.attemptKey,
      providerName: this.name,
      status: "unknown",
      lastChainStatus: "unknown",
    });
    const signed = await this.recoverSignedTransaction(attempt.attemptKey, attempt.txid);
    if (signed === undefined) {
      return { providerOrderId: attempt.txid, idempotencyKey, status: "processing" };
    }
    return this.broadcastAttempt(idempotencyKey, attempt, signed);
  }

  private async recoverSignedTransaction(
    attemptKey: string,
    expectedTxid?: string,
  ): Promise<TronSignedDelegation | undefined> {
    const signed = await this.signer.findSignedByAttemptKey(attemptKey);
    return signed === undefined ? undefined : assertSignedTransaction(signed, expectedTxid);
  }

  private async broadcastAttempt(
    idempotencyKey: string,
    attempt: ProviderTransactionAttemptEntry,
    signed: TronSignedDelegation,
  ): Promise<EnergyDeliveryResult> {
    const broadcast = await this.transport.broadcastSignedTransaction(signed.transaction);
    if (broadcast === "rejected") {
      await this.attemptJournal.recordAttemptState({
        attemptKey: attempt.attemptKey,
        providerName: this.name,
        status: "failed",
        lastBroadcastResult: "rejected",
      });
      return { providerOrderId: signed.txid, idempotencyKey, status: "failed" };
    }

    const nextStatus =
      broadcast === "accepted"
        ? attempt.status === "processing" ? "processing" : "accepted"
        : "unknown";
    await this.attemptJournal.recordAttemptState({
      attemptKey: attempt.attemptKey,
      providerName: this.name,
      status: nextStatus,
      lastBroadcastResult: broadcast,
    });
    return {
      providerOrderId: signed.txid,
      idempotencyKey,
      status: broadcast === "accepted" ? "accepted" : "processing",
    };
  }
}
