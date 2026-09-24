import { describe, expect, it } from "vitest";

import {
  requiredDelegationSun,
  TronOwnPoolEnergyProvider,
  type EnergyProviderJournal,
  type EnergyProviderJournalEntry,
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
}

class FakeTransport implements TronDelegationTransport {
  snapshot: TronEnergyResourceSnapshot = {
    totalEnergyLimit: 180_000_000_000n,
    totalEnergyWeight: 50_000_000n,
  };
  maxDelegatable = 100_000_000n;
  broadcastResult: "accepted" | "rejected" | "unknown" =
    "accepted";
  solidifiedStatus:
    | "processing"
    | "completed"
    | "failed"
    | "unknown" = "processing";
  buildCalls = 0;
  broadcastCalls = 0;
  statusCalls = 0;
  lastBalanceSun: bigint | undefined;
  readonly events: string[] = [];

  async getEnergyResourceSnapshot(): Promise<TronEnergyResourceSnapshot> {
    return this.snapshot;
  }

  async getCanDelegatedEnergySun(): Promise<bigint> {
    return this.maxDelegatable;
  }

  async buildEnergyDelegation(input: {
    readonly ownerAddress: string;
    readonly recipientAddress: string;
    readonly balanceSun: bigint;
  }): Promise<TronUnsignedDelegation> {
    this.buildCalls += 1;
    this.lastBalanceSun = input.balanceSun;
    this.events.push("build");

    return {
      txid: TXID,
      transaction: {
        txID: TXID,
        owner_address: input.ownerAddress,
        receiver_address: input.recipientAddress,
      },
    };
  }

  async broadcastSignedTransaction(
    transaction: Record<string, unknown>,
  ): Promise<"accepted" | "rejected" | "unknown"> {
    this.broadcastCalls += 1;
    this.events.push("broadcast");
    expect(transaction.txID).toBe(TXID);
    return this.broadcastResult;
  }

  async getSolidifiedTransactionStatus(): Promise<
    "processing" | "completed" | "failed" | "unknown"
  > {
    this.statusCalls += 1;
    return this.solidifiedStatus;
  }
}

class FakeSigner implements TronDelegationSigner {
  calls = 0;
  txid = TXID;
  readonly events: string[] = [];

  async sign(input: {
    readonly idempotencyKey: string;
    readonly unsigned: TronUnsignedDelegation;
  }): Promise<TronSignedDelegation> {
    this.calls += 1;
    this.events.push("sign");

    return {
      txid: this.txid,
      transaction: {
        ...input.unsigned.transaction,
        txID: this.txid,
        signature: ["test-signature"],
      },
    };
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
    const transport = new FakeTransport();
    const signer = new FakeSigner();
    transport.maxDelegatable = 1_000_000n;

    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      transport,
      signer,
      journal,
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
    const transport = new FakeTransport();
    const signer = new FakeSigner();

    const originalClaim =
      journal.claimProviderOrderId.bind(journal);
    journal.claimProviderOrderId = async (input) => {
      transport.events.push("claim");
      await originalClaim(input);
    };

    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      transport,
      signer,
      journal,
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
      "claim",
      "broadcast",
    ]);
    expect(transport.lastBalanceSun).toBe(18_055_556n);
  });

  it("fails closed if the signer changes transaction identity", async () => {
    const key = "energy-delivery:signer-mismatch";
    const journal = new MemoryJournal(key);
    const transport = new FakeTransport();
    const signer = new FakeSigner();
    signer.txid = OTHER_TXID;

    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      transport,
      signer,
      journal,
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
    const transport = new FakeTransport();
    const signer = new FakeSigner();
    transport.broadcastResult = "unknown";

    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      transport,
      signer,
      journal,
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

  it("rejects a journal row owned by another provider", async () => {
    const key = "energy-delivery:provider-conflict";
    const journal = new MemoryJournal(
      key,
      "other-provider",
    );
    const provider = new TronOwnPoolEnergyProvider(
      OWNER,
      new FakeTransport(),
      new FakeSigner(),
      journal,
    );

    await expect(
      provider.createDelivery(request(key)),
    ).rejects.toThrow(
      "Energy provider journal owner changed",
    );
  });
});
