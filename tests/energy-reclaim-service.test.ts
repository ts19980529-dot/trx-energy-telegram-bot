import { describe, expect, it, vi } from "vitest";

import { EnergyReclaimService } from "../src/application/energy/energy-reclaim-service.js";
import type {
  EnergyReclaimAttemptJournal,
  ProviderReclaimAttemptEntry,
  TronReclaimSigner,
  TronReclaimTransport,
  TronSignedReclaim,
} from "../src/adapters/energy/tron-own-pool-energy-provider.js";

const txid = "a".repeat(64);
const expirationAt = new Date(Date.now() + 60_000);
const signed: TronSignedReclaim = {
  txid,
  transaction: {
    txID: txid,
    raw_data: { expiration: expirationAt.getTime() },
    signature: ["signed"],
  },
};

function harness(initial: "created" | "signed") {
  let row: ProviderReclaimAttemptEntry = {
    id: "reclaim-1",
    sourceProviderTransactionAttemptId: "source-1",
    attemptNumber: 1,
    attemptKey: "source-1:reclaim:1",
    txid: initial === "signed" ? txid : null,
    expirationAt: initial === "signed" ? expirationAt : null,
    status: initial,
    lastBroadcastResult: null,
    lastChainStatus: null,
    lastChainObservedAt: null,
  };
  let persistedSigned: TronSignedReclaim | undefined = initial === "signed" ? signed : undefined;
  const journal: EnergyReclaimAttemptJournal = {
    listDueSources: async () => row.status === "completed" ? [] : ["source-1"],
    getSourceBinding: async () => ({
      ownerAddress: "owner", receiverAddress: "receiver", resource: "ENERGY", balanceSun: 1_000_000n,
    }),
    getOrCreateCurrentAttempt: async () => row,
    listAttempts: async () => [row],
    claimTransaction: async (input) => {
      if (persistedSigned === undefined || input.txid !== persistedSigned.txid) {
        throw new Error("Unsigned transaction cannot be claimed");
      }
      row = { ...row, txid: input.txid, expirationAt: input.expirationAt, status: "signed" };
      return row;
    },
    recordState: async (input) => {
      row = { ...row, status: input.status, lastChainStatus: input.lastChainStatus ?? null };
      return row;
    },
  };
  const sign = vi.fn(async () => {
    persistedSigned = signed;
    return signed;
  });
  const signer: TronReclaimSigner = {
    sign,
    findSignedByAttemptKey: async () => persistedSigned,
  };
  const broadcast = vi.fn(async () => "accepted" as const);
  let observation: "unknown" | "completed" = "unknown";
  const transport: TronReclaimTransport = {
    buildEnergyReclaim: async () => ({ txid, transaction: signed.transaction }),
    broadcastSignedTransaction: broadcast,
    getReclaimTransactionObservation: async () => ({ status: observation }),
  };
  return {
    service: new EnergyReclaimService(journal, signer, transport),
    journal, signer, transport,
    sign, broadcast, setObservation: (value: "unknown" | "completed") => { observation = value; },
    getStatus: () => row.status,
  };
}

describe("durable Energy reclaim execution", () => {
  it("recovers the same signed transaction after restart, then records finality", async () => {
    const h = harness("created");
    await h.service.runOnce();
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledTimes(1);
    expect(h.getStatus()).toBe("accepted");

    await h.service.runOnce();
    expect(h.sign).toHaveBeenCalledTimes(1);
    expect(h.broadcast).toHaveBeenCalledTimes(2);

    h.setObservation("completed");
    await h.service.runOnce();
    expect(h.getStatus()).toBe("completed");
    await h.service.runOnce();
    expect(h.broadcast).toHaveBeenCalledTimes(2);
  });

  it("does not sign a replacement when a prior signed attempt exists", async () => {
    const h = harness("signed");
    await h.service.runOnce();
    expect(h.sign).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledTimes(1);
  });

  it("visits later pending deliveries and reclaim sources even if the first batch keeps failing", async () => {
    const h = harness("signed");
    const pending = ["a", "b", "c"].map((idempotencyKey) => ({
      telegramUserId: 1n, optionCode: "energy", recipientAddress: "recipient", idempotencyKey,
      providerName: idempotencyKey === "b" ? "previous-provider" : null,
    }));
    const listPending = vi.fn(async (limit: number, afterKey?: string) =>
      pending.filter((order) => afterKey === undefined || order.idempotencyKey > afterKey).slice(0, limit));
    const execute = vi.fn(async (_order: (typeof pending)[number]) => { throw new Error("temporary outage"); });
    let previousRegistered = false;
    const canResumeDelivery = (name: string | null) =>
      name === null || name === "tron-own-pool" ||
      (previousRegistered && name === "previous-provider");
    const listDueSources = vi.fn(async (limit: number, afterId?: string) =>
      ["a", "b", "c"].filter((id) => afterId === undefined || id > afterId).slice(0, limit));
    const getOrCreateCurrentAttempt = vi.fn(async (_input: {
      readonly sourceProviderTransactionAttemptId: string;
      readonly providerName: string;
    }) => { throw new Error("temporary outage"); });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const service = new EnergyReclaimService(
        { ...h.journal, listDueSources, getOrCreateCurrentAttempt },
        h.signer, h.transport, "tron-own-pool", 1,
        { listPending }, { execute, canResumeDelivery },
      );
      for (let i = 0; i < 4; i++) await service.runOnce();
      expect(execute.mock.calls.map(([order]) => order.idempotencyKey)).toEqual(["a", "c", "a"]);
      previousRegistered = true;
      await service.runOnce();
      expect(execute.mock.calls.map(([order]) => order.idempotencyKey)).toEqual(["a", "c", "a", "b"]);
      expect(getOrCreateCurrentAttempt.mock.calls.slice(0, 4).map(([input]) => input.sourceProviderTransactionAttemptId))
        .toEqual(["a", "b", "c", "a"]);
    } finally {
      errors.mockRestore();
    }
  });
});
