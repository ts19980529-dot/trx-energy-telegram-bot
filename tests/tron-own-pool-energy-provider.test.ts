import { describe, expect, it } from "vitest";

import {
  requiredDelegationSun,
  TronOwnPoolEnergyProvider,
  type EnergyProviderAttemptJournal,
  type EnergyProviderJournal,
  type EnergyProviderJournalEntry,
  type ProviderTransactionAttemptEntry,
  type ProviderTransactionAttemptStatus,
  type TronTransactionObservation,
  type TronDelegationBinding,
  type TronDelegationSigner,
  type TronDelegationTransport,
  type TronEnergyResourceSnapshot,
  type TronSignedDelegation,
  type TronUnsignedDelegation,
} from "../src/adapters/energy/tron-own-pool-energy-provider.js";

const OWNER = "TJRabPrwbZy45sbavfcjinPJC18kjpRTv8";
const RECIPIENT = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const TXID = "a".repeat(64);
const OTHER_TXID = "b".repeat(64);

class MemoryJournal implements EnergyProviderJournal {
  private readonly byIdempotency = new Map<
    string,
    EnergyProviderJournalEntry
  >();

  constructor(
    idempotencyKey: string,
    providerName = "tron-own-pool",
  ) {
    this.byIdempotency.set(idempotencyKey, {
      idempotencyKey,
      providerName,
      providerOrderId: null,
      status: "pending",
    });
  }

  async findByIdempotencyKey(
    idempotencyKey: string,
  ): Promise<EnergyProviderJournalEntry | undefined> {
    return this.byIdempotency.get(idempotencyKey);
  }

  async findByProviderOrderId(input: {
    readonly providerName: string;
    readonly providerOrderId: string;
  }): Promise<EnergyProviderJournalEntry | undefined> {
    return [...this.byIdempotency.values()].find(
      (entry) =>
        entry.providerName === input.providerName &&
        entry.providerOrderId === input.providerOrderId,
    );
  }

  async claimProviderOrderId(input: {
    readonly idempotencyKey: string;
    readonly providerName: string;
    readonly providerOrderId: string;
  }): Promise<void> {
    const existing = this.byIdempotency.get(
      input.idempotencyKey,
    );

    if (existing === undefined) {
      throw new Error("missing journal row");
    }

    if (
      existing.providerName !== input.providerName ||
      (existing.providerOrderId !== null &&
        existing.providerOrderId !== input.providerOrderId)
    ) {
      throw new Error("journal identity conflict");
    }

    this.byIdempotency.set(input.idempotencyKey, {
      ...existing,
      providerOrderId: input.providerOrderId,
    });
  }
  projectProviderOrderId(
    idempotencyKey: string,
    providerOrderId: string,
  ): void {
    const existing = this.byIdempotency.get(idempotencyKey);
    if (existing === undefined) throw new Error("missing journal row");
    this.byIdempotency.set(idempotencyKey, { ...existing, providerOrderId });
  }
}

class MemoryAttemptJournal implements EnergyProviderAttemptJournal {
  private readonly attempts = new Map<string, ProviderTransactionAttemptEntry[]>();
  onBind: (() => void) | undefined;
  onClaim: (() => void) | undefined;

  constructor(private readonly deliveryJournal: MemoryJournal) {}

  async getOrCreateCurrentAttempt(input: {
    readonly idempotencyKey: string;
    readonly providerName: string;
  }): Promise<ProviderTransactionAttemptEntry> {
    const items = this.attempts.get(input.idempotencyKey) ?? [];
    const latest = items.at(-1);
    if (latest !== undefined && latest.status !== "expired") return latest;
    const attemptNumber = (latest?.attemptNumber ?? 0) + 1;
    const created: ProviderTransactionAttemptEntry = {
      id: `attempt-${attemptNumber}`,
      providerDeliveryId: "memory-delivery",
      attemptNumber,
      attemptKey: `${input.idempotencyKey}:attempt:${attemptNumber}`,
      txid: null,
      expirationAt: null,
      delegationBinding: null,
      status: "created",
      lastBroadcastResult: null,
      lastChainStatus: null,
      lastChainObservedAt: null,
    };
    this.attempts.set(input.idempotencyKey, [...items, created]);
    return created;
  }

  async bindDelegation(input: {
    readonly attemptKey: string;
    readonly providerName: string;
    readonly binding: TronDelegationBinding;
  }): Promise<ProviderTransactionAttemptEntry> {
    const located = this.locate(input.attemptKey);
    if (located.attempt.delegationBinding !== null) {
      if (
        located.attempt.delegationBinding.ownerAddress !== input.binding.ownerAddress ||
        located.attempt.delegationBinding.receiverAddress !== input.binding.receiverAddress ||
        located.attempt.delegationBinding.resource !== input.binding.resource ||
        located.attempt.delegationBinding.balanceSun !== input.binding.balanceSun
      ) throw new Error("binding changed");
      return located.attempt;
    }
    const updated: ProviderTransactionAttemptEntry = {
      ...located.attempt,
      delegationBinding: input.binding,
    };
    located.items[located.index] = updated;
    this.onBind?.();
    return updated;
  }

  async claimAttemptTransaction(input: {
    readonly attemptKey: string;
    readonly providerName: string;
    readonly txid: string;
    readonly expirationAt: Date;
  }): Promise<ProviderTransactionAttemptEntry> {
    const located = this.locate(input.attemptKey);
    if (located.attempt.txid !== null) {
      if (
        located.attempt.txid !== input.txid ||
        located.attempt.expirationAt?.getTime() !== input.expirationAt.getTime()
      ) throw new Error("attempt identity changed");
      return located.attempt;
    }
    if (located.attempt.status !== "created") throw new Error("attempt not created");
    if (located.attempt.delegationBinding === null) throw new Error("binding missing");
    const updated: ProviderTransactionAttemptEntry = {
      ...located.attempt,
      txid: input.txid,
      expirationAt: input.expirationAt,
      status: "signed",
    };
    located.items[located.index] = updated;
    this.deliveryJournal.projectProviderOrderId(located.idempotencyKey, input.txid);
    this.onClaim?.();
    return updated;
  }

  async recordAttemptState(input: {
    readonly attemptKey: string;
    readonly providerName: string;
    readonly status: ProviderTransactionAttemptStatus;
    readonly lastBroadcastResult?: "accepted" | "rejected" | "unknown";
    readonly lastChainStatus?: "absent" | "processing" | "completed" | "failed" | "unknown";
    readonly lastChainObservedAt?: Date;
  }): Promise<ProviderTransactionAttemptEntry> {
    const located = this.locate(input.attemptKey);
    const observedAt = input.lastChainObservedAt ?? located.attempt.lastChainObservedAt;
    if (
      input.status === "expired" &&
      (
        input.lastChainStatus !== "absent" ||
        located.attempt.expirationAt === null ||
        observedAt === null ||
        observedAt.getTime() < located.attempt.expirationAt.getTime()
      )
    ) throw new Error("attempt cannot expire");
    const updated: ProviderTransactionAttemptEntry = {
      ...located.attempt,
      status: input.status,
      lastBroadcastResult: input.lastBroadcastResult ?? located.attempt.lastBroadcastResult,
      lastChainStatus: input.lastChainStatus ?? located.attempt.lastChainStatus,
      lastChainObservedAt: observedAt,
    };
    located.items[located.index] = updated;
    return updated;
  }

  async listAttempts(input: {
    readonly idempotencyKey: string;
    readonly providerName: string;
  }): Promise<readonly ProviderTransactionAttemptEntry[]> {
    return this.attempts.get(input.idempotencyKey) ?? [];
  }

  private locate(attemptKey: string): {
    idempotencyKey: string;
    items: ProviderTransactionAttemptEntry[];
    index: number;
    attempt: ProviderTransactionAttemptEntry;
  } {
    for (const [idempotencyKey, items] of this.attempts) {
      const index = items.findIndex((item) => item.attemptKey === attemptKey);
      const attempt = items[index];
      if (index >= 0 && attempt !== undefined) return { idempotencyKey, items, index, attempt };
    }
    throw new Error("attempt missing");
  }
}
class FakeTransport implements TronDelegationTransport {
  snapshot: TronEnergyResourceSnapshot = {
    totalEnergyLimit: 180_000_000_000n,
    totalEnergyWeight: 50_000_000n,
  };
  maxDelegatable = 100_000_000n;
  broadcastResult: "accepted" | "rejected" | "unknown" = "accepted";
  solidifiedStatus: "processing" | "completed" | "failed" | "unknown" = "processing";
  readonly observations = new Map<string, TronTransactionObservation>();
  buildTxids: string[] = [TXID];
  buildExpirationsMs: number[] = [Date.now() + 60_000];
  buildCalls = 0;
  broadcastCalls = 0;
  statusCalls = 0;
  lastBalanceSun: bigint | undefined;
  readonly events: string[] = [];

  async getEnergyResourceSnapshot(): Promise<TronEnergyResourceSnapshot> { return this.snapshot; }
  async getCanDelegatedEnergySun(): Promise<bigint> { return this.maxDelegatable; }

  async buildEnergyDelegation(input: {
    readonly ownerAddress: string;
    readonly recipientAddress: string;
    readonly balanceSun: bigint;
  }): Promise<TronUnsignedDelegation> {
    const index = this.buildCalls;
    this.buildCalls += 1;
    this.lastBalanceSun = input.balanceSun;
    this.events.push("build");
    const txid = this.buildTxids[index] ?? this.buildTxids.at(-1) ?? TXID;
    const expiration = this.buildExpirationsMs[index] ?? this.buildExpirationsMs.at(-1) ?? Date.now() + 60_000;
    return {
      txid,
      transaction: {
        txID: txid,
        raw_data: {
          expiration,
          contract: [{
            type: "DelegateResourceContract",
            parameter: { value: {
              owner_address: input.ownerAddress,
              receiver_address: input.recipientAddress,
              balance: Number(input.balanceSun),
              resource: "ENERGY",
              lock: false,
            } },
          }],
        },
      },
    };
  }

  async broadcastSignedTransaction(
    transaction: Record<string, unknown>,
  ): Promise<"accepted" | "rejected" | "unknown"> {
    this.broadcastCalls += 1;
    this.events.push("broadcast");
    expect(typeof transaction.txID).toBe("string");
    return this.broadcastResult;
  }

  async getTransactionObservation(input: {
    readonly txid: string;
    readonly expirationAt: Date;
  }): Promise<TronTransactionObservation> {
    this.statusCalls += 1;
    return this.observations.get(input.txid) ?? { status: this.solidifiedStatus };
  }
}
class FakeSigner implements TronDelegationSigner {
  calls = 0;
  recoverCalls = 0;
  txid: string | undefined;
  readonly events: string[] = [];
  readonly signedKeys: string[] = [];
  private readonly signedByKey = new Map<string, TronSignedDelegation>();

  seed(
    key: string,
    txid = TXID,
    expiration = Date.now() + 60_000,
  ): void {
    const attemptKey = key.includes(":attempt:") ? key : `${key}:attempt:1`;
    this.signedByKey.set(attemptKey, {
      txid,
      transaction: {
        txID: txid,
        raw_data: {
          expiration,
          contract: [{
            type: "DelegateResourceContract",
            parameter: { value: {
              owner_address: OWNER,
              receiver_address: RECIPIENT,
              balance: 18_055_556,
              resource: "ENERGY",
              lock: false,
            } },
          }],
        },
        signature: ["test-signature"],
      },
    });
  }

  async sign(input: {
    readonly attemptKey: string;
    readonly unsigned: TronUnsignedDelegation;
  }): Promise<TronSignedDelegation> {
    this.calls += 1;
    this.events.push("sign");
    this.signedKeys.push(input.attemptKey);
    const existing = this.signedByKey.get(input.attemptKey);
    if (existing !== undefined) return existing;
    const txid = this.txid ?? input.unsigned.txid;
    const signed: TronSignedDelegation = {
      txid,
      transaction: {
        ...input.unsigned.transaction,
        txID: txid,
        signature: ["test-signature"],
      },
    };
    this.signedByKey.set(input.attemptKey, signed);
    return signed;
  }

  async findSignedByAttemptKey(
    attemptKey: string,
  ): Promise<TronSignedDelegation | undefined> {
    this.recoverCalls += 1;
    return this.signedByKey.get(attemptKey);
  }
}
function request(idempotencyKey: string) {
  return {
    idempotencyKey,
    internalOrderId:
      "11111111-1111-4111-8111-111111111111",
    recipientAddress: RECIPIENT,
    energyAmount: 65_000n,
  };
}

describe("TRON own-pool Energy provider", () => {
  it("inverts the java-tron V2 Energy formula with integer ceiling", () => {
    const snapshot = {
      totalEnergyLimit: 180_000_000_000n,
      totalEnergyWeight: 50_000_000n,
    };

    const balanceSun = requiredDelegationSun(
      65_000n,
      snapshot,
    );

    expect(balanceSun).toBe(18_055_556n);

    const delivered =
      (balanceSun * snapshot.totalEnergyLimit) /
      (1_000_000n * snapshot.totalEnergyWeight);
    const oneSunLess =
      ((balanceSun - 1n) * snapshot.totalEnergyLimit) /
      (1_000_000n * snapshot.totalEnergyWeight);

    expect(delivered).toBeGreaterThanOrEqual(65_000n);
    expect(oneSunLess).toBeLessThan(65_000n);
  });

  it("enforces TRON's one-TRX minimum delegation", () => {
    expect(
      requiredDelegationSun(65_000n, {
        totalEnergyLimit: 90_000_000_000n,
        totalEnergyWeight: 260_886n,
      }),
    ).toBe(1_000_000n);
  });

  it("fails preflight without signing or broadcasting when capacity is insufficient", async () => {
    const key = "energy-delivery:capacity";
    const journal = new MemoryJournal(key);
    const attempts = new MemoryAttemptJournal(journal);
    const transport = new FakeTransport();
    const signer = new FakeSigner();
    transport.maxDelegatable = 1_000_000n;

    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      transport,
      signer,
      journal,
      attempts,
    );

    const result = await provider.createDelivery(
      request(key),
    );

    expect(result).toEqual({
      providerOrderId: null,
      idempotencyKey: key,
      status: "failed",
    });
    expect(transport.buildCalls).toBe(0);
    expect(signer.calls).toBe(0);
    expect(transport.broadcastCalls).toBe(0);
  });

  it("persists the signed txid before broadcast", async () => {
    const key = "energy-delivery:ordered";
    const journal = new MemoryJournal(key);
    const attempts = new MemoryAttemptJournal(journal);
    const transport = new FakeTransport();
    const signer = new FakeSigner();

    attempts.onBind = () => {
      transport.events.push("bind");
    };
    attempts.onClaim = () => {
      transport.events.push("claim");
    };

    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      transport,
      signer,
      journal,
      attempts,
    );

    const result = await provider.createDelivery(
      request(key),
    );

    expect(result).toEqual({
      providerOrderId: TXID,
      idempotencyKey: key,
      status: "accepted",
    });
    expect(transport.events).toEqual([
      "build",
      "bind",
      "claim",
      "broadcast",
    ]);
    const [boundAttempt] = await attempts.listAttempts({
      idempotencyKey: key,
      providerName: "tron-own-pool",
    });
    expect(boundAttempt?.delegationBinding).toEqual({
      ownerAddress: OWNER,
      receiverAddress: RECIPIENT,
      resource: "ENERGY",
      balanceSun: 18_055_556n,
    });
    expect(transport.lastBalanceSun).toBe(18_055_556n);
  });

  it("fails closed if the signer changes transaction identity", async () => {
    const key = "energy-delivery:signer-mismatch";
    const journal = new MemoryJournal(key);
    const attempts = new MemoryAttemptJournal(journal);
    const transport = new FakeTransport();
    const signer = new FakeSigner();
    signer.txid = OTHER_TXID;

    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      transport,
      signer,
      journal,
      attempts,
    );

    await expect(
      provider.createDelivery(request(key)),
    ).rejects.toThrow(
      "TRON signer changed transaction identity",
    );

    expect(transport.broadcastCalls).toBe(0);
    expect(
      (await journal.findByIdempotencyKey(key))
        ?.providerOrderId,
    ).toBeNull();
  });

  it("recovers an ambiguous broadcast through the journaled txid", async () => {
    const key = "energy-delivery:ambiguous";
    const journal = new MemoryJournal(key);
    const attempts = new MemoryAttemptJournal(journal);
    const transport = new FakeTransport();
    const signer = new FakeSigner();
    transport.broadcastResult = "unknown";

    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      transport,
      signer,
      journal,
      attempts,
    );

    const created = await provider.createDelivery(
      request(key),
    );

    expect(created).toEqual({
      providerOrderId: TXID,
      idempotencyKey: key,
      status: "processing",
    });

    transport.solidifiedStatus = "completed";

    const recovered =
      await provider.findDeliveryByIdempotencyKey(key);

    expect(recovered).toEqual({
      providerOrderId: TXID,
      idempotencyKey: key,
      status: "completed",
    });
    expect(transport.statusCalls).toBe(1);
    expect(transport.broadcastCalls).toBe(1);
  });



  it("recovers the same signed transaction after a crash before journal claim", async () => {
    const key = "energy-delivery:crash-before-claim";
    const journal = new MemoryJournal(key);
    const attempts = new MemoryAttemptJournal(journal);
    const transport = new FakeTransport();
    const signer = new FakeSigner();
    signer.seed(key);

    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      transport,
      signer,
      journal,
      attempts,
    );

    const result = await provider.createDelivery(
      request(key),
    );

    expect(result).toEqual({
      providerOrderId: TXID,
      idempotencyKey: key,
      status: "accepted",
    });
    expect(transport.buildCalls).toBe(0);
    expect(signer.calls).toBe(0);
    expect(signer.recoverCalls).toBe(1);
    expect(transport.broadcastCalls).toBe(1);
    expect(
      (await journal.findByIdempotencyKey(key))
        ?.providerOrderId,
    ).toBe(TXID);
  });

  it("rebroadcasts the exact signed transaction after a crash between txid claim and broadcast", async () => {
    const key = "energy-delivery:crash-before-broadcast";
    const journal = new MemoryJournal(key);
    const attempts = new MemoryAttemptJournal(journal);
    const transport = new FakeTransport();
    const signer = new FakeSigner();
    signer.seed(key);
    const firstAttempt = await attempts.getOrCreateCurrentAttempt({
      idempotencyKey: key,
      providerName: "tron-own-pool",
    });
    await attempts.bindDelegation({
      attemptKey: firstAttempt.attemptKey,
      providerName: "tron-own-pool",
      binding: {
        ownerAddress: OWNER,
        receiverAddress: RECIPIENT,
        resource: "ENERGY",
        balanceSun: 18_055_556n,
      },
    });
    await attempts.claimAttemptTransaction({
      attemptKey: firstAttempt.attemptKey,
      providerName: "tron-own-pool",
      txid: TXID,
      expirationAt: new Date(Date.now() + 60_000),
    });
    transport.solidifiedStatus = "unknown";

    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      transport,
      signer,
      journal,
      attempts,
    );

    const result = await provider.createDelivery(
      request(key),
    );

    expect(result).toEqual({
      providerOrderId: TXID,
      idempotencyKey: key,
      status: "accepted",
    });
    expect(transport.statusCalls).toBe(1);
    expect(transport.buildCalls).toBe(0);
    expect(signer.calls).toBe(0);
    expect(signer.recoverCalls).toBe(1);
    expect(transport.broadcastCalls).toBe(1);
  });

  it("fails closed if durable signer recovery disagrees with the journaled txid", async () => {
    const key = "energy-delivery:recovery-mismatch";
    const journal = new MemoryJournal(key);
    const attempts = new MemoryAttemptJournal(journal);
    const transport = new FakeTransport();
    const signer = new FakeSigner();
    const firstAttempt = await attempts.getOrCreateCurrentAttempt({
      idempotencyKey: key,
      providerName: "tron-own-pool",
    });
    await attempts.bindDelegation({
      attemptKey: firstAttempt.attemptKey,
      providerName: "tron-own-pool",
      binding: {
        ownerAddress: OWNER,
        receiverAddress: RECIPIENT,
        resource: "ENERGY",
        balanceSun: 18_055_556n,
      },
    });
    await attempts.claimAttemptTransaction({
      attemptKey: firstAttempt.attemptKey,
      providerName: "tron-own-pool",
      txid: TXID,
      expirationAt: new Date(Date.now() + 60_000),
    });
    signer.seed(firstAttempt.attemptKey, OTHER_TXID);
    transport.solidifiedStatus = "unknown";

    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      transport,
      signer,
      journal,
      attempts,
    );

    await expect(
      provider.createDelivery(request(key)),
    ).rejects.toThrow(
      "TRON signer changed transaction identity",
    );

    expect(transport.buildCalls).toBe(0);
    expect(signer.calls).toBe(0);
    expect(transport.broadcastCalls).toBe(0);
  });

  it("rejects a journal row owned by another provider", async () => {
    const key = "energy-delivery:provider-conflict";
    const journal = new MemoryJournal(
      key,
      "other-provider",
    );
    const attempts = new MemoryAttemptJournal(journal);
    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      new FakeTransport(),
      new FakeSigner(),
      journal,
      attempts,
    );

    await expect(
      provider.createDelivery(request(key)),
    ).rejects.toThrow(
      "Energy provider journal owner changed",
    );
  });
  it("creates a replacement attempt only after solidified absence reaches the original expiration", async () => {
    const key = "energy-delivery:replacement";
    const journal = new MemoryJournal(key);
    const attempts = new MemoryAttemptJournal(journal);
    const transport = new FakeTransport();
    const signer = new FakeSigner();
    transport.buildTxids = [TXID, OTHER_TXID];
    transport.buildExpirationsMs = [1_000, 3_000];
    transport.broadcastResult = "unknown";

    const provider = new TronOwnPoolEnergyProvider(
      OWNER, transport, signer, journal, attempts,
    );

    const first = await provider.createDelivery(request(key));
    expect(first.status).toBe("processing");
    expect(transport.buildCalls).toBe(1);
    expect(signer.signedKeys).toEqual([`${key}:attempt:1`]);

    transport.observations.set(TXID, {
      status: "absent",
      solidifiedObservedAt: new Date(2_000),
    });
    transport.broadcastResult = "accepted";

    const replacement = await provider.createDelivery(request(key));
    expect(replacement).toEqual({
      providerOrderId: OTHER_TXID,
      idempotencyKey: key,
      status: "accepted",
    });
    expect(transport.buildCalls).toBe(2);
    expect(signer.signedKeys).toEqual([
      `${key}:attempt:1`,
      `${key}:attempt:2`,
    ]);

    const history = await attempts.listAttempts({
      idempotencyKey: key,
      providerName: "tron-own-pool",
    });
    expect(history.map((attempt) => ({
      attemptNumber: attempt.attemptNumber,
      txid: attempt.txid,
      status: attempt.status,
    }))).toEqual([
      { attemptNumber: 1, txid: TXID, status: "expired" },
      { attemptNumber: 2, txid: OTHER_TXID, status: "accepted" },
    ]);
    expect((await journal.findByIdempotencyKey(key))?.providerOrderId).toBe(OTHER_TXID);
  });

});
