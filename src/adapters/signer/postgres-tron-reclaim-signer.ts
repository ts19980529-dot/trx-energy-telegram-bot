import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { TronWeb, utils } from "tronweb";

import {
  providerDeliveries,
  providerReclaimAttempts,
  providerTransactionAttempts,
} from "../../db/schema.js";
import type { AppDatabase } from "../database/postgres.js";
import type {
  TronReclaimSigner,
  TronSignedReclaim,
  TronUnsignedReclaim,
} from "../energy/tron-own-pool-energy-provider.js";

const TXID_PATTERN = /^[0-9a-f]{64}$/;
const HEX_41_ADDRESS_PATTERN = /^41[0-9a-f]{40}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeTxid(value: string, field: string): string {
  const normalized = value.trim().toLowerCase();
  if (!TXID_PATTERN.test(normalized)) {
    throw new Error(`${field} must be a 64-character hexadecimal txid`);
  }
  return normalized;
}

function canonicalAddress(value: string, field: string): string {
  const trimmed = value.trim();
  if (HEX_41_ADDRESS_PATTERN.test(trimmed.toLowerCase())) {
    return trimmed.toLowerCase();
  }
  try {
    const hex = TronWeb.address.toHex(trimmed).toLowerCase();
    if (!HEX_41_ADDRESS_PATTERN.test(hex)) throw new Error("invalid");
    return hex;
  } catch {
    throw new Error(`${field} must be a valid TRON address`);
  }
}

function safePositiveInteger(value: unknown, field: string): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value <= 0
  ) {
    throw new Error(`${field} must be a positive safe integer`);
  }
  return value;
}

function stableJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new Error("Reclaim signer transaction contains a non-finite number");
      }
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map((item) => stableJson(item)).join(",")}]`;
      }
      if (!isRecord(value)) {
        throw new Error("Reclaim signer transaction contains a non-JSON value");
      }
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
        .join(",")}}`;
    default:
      throw new Error("Reclaim signer transaction contains a non-JSON value");
  }
}

function transactionDigest(transaction: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(transaction)).digest("hex");
}

function cloneTransaction(
  transaction: Record<string, unknown>,
): Record<string, unknown> {
  return JSON.parse(JSON.stringify(transaction)) as Record<string, unknown>;
}

interface ValidatedUnsignedReclaim {
  readonly txid: string;
  readonly digest: string;
  readonly ownerAddressHex: string;
  readonly receiverAddressHex: string;
  readonly balanceSun: bigint;
}

function validateUnsignedReclaim(
  unsigned: TronUnsignedReclaim,
  ownerAddressHex: string,
  now: () => number,
): ValidatedUnsignedReclaim {
  const txid = normalizeTxid(unsigned.txid, "unsigned reclaim txid");
  const transaction = unsigned.transaction;
  const embeddedTxid = normalizeTxid(
    requireString(transaction.txID, "transaction.txID"),
    "transaction.txID",
  );
  if (embeddedTxid !== txid) {
    throw new Error("Reclaim signer transaction identity mismatch");
  }
  if (
    "signature" in transaction &&
    Array.isArray(transaction.signature) &&
    transaction.signature.length > 0
  ) {
    throw new Error("Reclaim signer refuses an already-signed transaction");
  }

  let transactionValid = false;
  try {
    transactionValid = utils.transaction.txCheck(transaction);
  } catch {
    transactionValid = false;
  }
  if (!transactionValid) {
    throw new Error(
      "Reclaim signer transaction raw_data, raw_data_hex and txID are inconsistent",
    );
  }

  const rawData = transaction.raw_data;
  if (!isRecord(rawData) || !Array.isArray(rawData.contract)) {
    throw new Error("Reclaim signer transaction raw_data is malformed");
  }
  if (rawData.contract.length !== 1 || !isRecord(rawData.contract[0])) {
    throw new Error("Reclaim signer requires exactly one TRON contract");
  }
  const contract = rawData.contract[0];
  if (contract.type !== "UnDelegateResourceContract") {
    throw new Error("Reclaim signer only accepts UnDelegateResourceContract");
  }
  const parameter = contract.parameter;
  if (!isRecord(parameter) || !isRecord(parameter.value)) {
    throw new Error("Reclaim signer UnDelegateResource parameter is malformed");
  }
  const value = parameter.value;
  if (value.resource !== "ENERGY") {
    throw new Error("Reclaim signer only accepts ENERGY");
  }

  const ownerAddress = canonicalAddress(
    requireString(value.owner_address, "UnDelegateResource owner_address"),
    "UnDelegateResource owner_address",
  );
  if (ownerAddress !== ownerAddressHex) {
    throw new Error("Reclaim signer owner address mismatch");
  }
  const receiverAddress = canonicalAddress(
    requireString(value.receiver_address, "UnDelegateResource receiver_address"),
    "UnDelegateResource receiver_address",
  );
  const balance = safePositiveInteger(
    value.balance,
    "UnDelegateResource balance",
  );

  const expiration = safePositiveInteger(
    rawData.expiration,
    "transaction expiration",
  );
  if (expiration <= now()) {
    throw new Error("Reclaim signer refuses an expired transaction");
  }

  return {
    txid,
    digest: transactionDigest(transaction),
    ownerAddressHex: ownerAddress,
    receiverAddressHex: receiverAddress,
    balanceSun: BigInt(balance),
  };
}

function signedReclaim(
  txid: string,
  value: unknown,
): TronSignedReclaim {
  if (!isRecord(value)) {
    throw new Error("Stored reclaim signer transaction is malformed");
  }
  const embeddedTxid = normalizeTxid(
    requireString(value.txID, "signed reclaim transaction txID"),
    "signed reclaim transaction txID",
  );
  if (embeddedTxid !== txid) {
    throw new Error("Stored reclaim signer transaction identity mismatch");
  }
  if (
    !Array.isArray(value.signature) ||
    value.signature.length === 0 ||
    value.signature.some(
      (signature) =>
        typeof signature !== "string" ||
        !/^[0-9a-fA-F]{130}$/.test(signature),
    )
  ) {
    throw new Error("Stored reclaim signer transaction signature is malformed");
  }
  return { txid, transaction: value };
}

export class PostgresTronReclaimSigner implements TronReclaimSigner {
  private readonly ownerAddressHex: string;
  private readonly privateKey: string;

  constructor(
    private readonly db: AppDatabase,
    ownerAddress: string,
    privateKey: string,
    private readonly now: () => number = Date.now,
  ) {
    this.ownerAddressHex = canonicalAddress(
      ownerAddress,
      "reclaim signer owner address",
    );

    const normalizedPrivateKey = privateKey.trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(normalizedPrivateKey)) {
      throw new Error("TRON reclaim signer private key is invalid");
    }
    this.privateKey = normalizedPrivateKey;

    const derivedAddress = TronWeb.address.fromPrivateKey(this.privateKey);
    if (
      typeof derivedAddress !== "string" ||
      canonicalAddress(derivedAddress, "derived reclaim signer address") !==
        this.ownerAddressHex
    ) {
      throw new Error(
        "TRON reclaim signer private key does not match owner address",
      );
    }
  }

  async sign(input: {
    readonly attemptKey: string;
    readonly unsigned: TronUnsignedReclaim;
  }): Promise<TronSignedReclaim> {
    const attemptKey = requireString(input.attemptKey, "attemptKey");
    const validated = validateUnsignedReclaim(
      input.unsigned,
      this.ownerAddressHex,
      this.now,
    );

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(
          hashtext('tron-energy-reclaim-signer'),
          hashtext(${attemptKey})
        )`,
      );

      const [selected] = await tx
        .select({
          reclaim: providerReclaimAttempts,
          source: providerTransactionAttempts,
          providerName: providerDeliveries.providerName,
        })
        .from(providerReclaimAttempts)
        .innerJoin(
          providerTransactionAttempts,
          eq(
            providerTransactionAttempts.id,
            providerReclaimAttempts.sourceProviderTransactionAttemptId,
          ),
        )
        .innerJoin(
          providerDeliveries,
          eq(
            providerDeliveries.id,
            providerTransactionAttempts.providerDeliveryId,
          ),
        )
        .where(eq(providerReclaimAttempts.attemptKey, attemptKey))
        .limit(1)
        .for("update");

      if (selected === undefined) {
        throw new Error("Reclaim signer attempt is not registered");
      }
      if (selected.providerName !== "tron-own-pool") {
        throw new Error("Reclaim signer provider is not allowed");
      }
      if (
        selected.source.status !== "completed" ||
        selected.source.finalizedAt === null ||
        selected.source.reclaimEligibleAt === null ||
        selected.source.reclaimEligibleAt.getTime() > this.now()
      ) {
        throw new Error("Reclaim signer source is not eligible");
      }
      if (
        selected.source.delegatedOwnerAddress === null ||
        selected.source.delegatedReceiverAddress === null ||
        selected.source.delegatedResource !== "ENERGY" ||
        selected.source.delegatedBalanceSun === null
      ) {
        throw new Error("Reclaim signer source binding is incomplete");
      }
      if (
        canonicalAddress(
          selected.source.delegatedOwnerAddress,
          "bound reclaim owner address",
        ) !== validated.ownerAddressHex
      ) {
        throw new Error("Reclaim signer bound owner mismatch");
      }
      if (
        canonicalAddress(
          selected.source.delegatedReceiverAddress,
          "bound reclaim receiver address",
        ) !== validated.receiverAddressHex
      ) {
        throw new Error("Reclaim signer bound receiver mismatch");
      }
      if (selected.source.delegatedBalanceSun !== validated.balanceSun) {
        throw new Error("Reclaim signer bound balance mismatch");
      }

      const existingTxid = selected.reclaim.signerUnsignedTxid;
      const existingDigest = selected.reclaim.signerUnsignedDigest;
      const existingSigned = selected.reclaim.signedTransaction;
      const existingSignedAt = selected.reclaim.signedAt;
      const hasAnyExisting =
        existingTxid !== null ||
        existingDigest !== null ||
        existingSigned !== null ||
        existingSignedAt !== null;

      if (hasAnyExisting) {
        if (
          existingTxid === null ||
          existingDigest === null ||
          existingSigned === null ||
          existingSignedAt === null
        ) {
          throw new Error("Reclaim signer persistence is incomplete");
        }
        if (
          normalizeTxid(existingTxid, "stored reclaim signer txid") !==
            validated.txid ||
          existingDigest !== validated.digest
        ) {
          throw new Error("Reclaim signer attempt identity changed");
        }
        return signedReclaim(validated.txid, existingSigned);
      }

      if (selected.reclaim.status !== "created") {
        throw new Error("Reclaim signer attempt is no longer signable");
      }

      const transaction = cloneTransaction(input.unsigned.transaction);
      const signed = utils.crypto.signTransaction(
        this.privateKey,
        transaction,
      ) as unknown;
      const result = signedReclaim(validated.txid, signed);
      const timestamp = new Date(this.now());

      const [updated] = await tx
        .update(providerReclaimAttempts)
        .set({
          signerUnsignedTxid: validated.txid,
          signerUnsignedDigest: validated.digest,
          signedTransaction: result.transaction,
          signedAt: timestamp,
          updatedAt: timestamp,
        })
        .where(eq(providerReclaimAttempts.id, selected.reclaim.id))
        .returning({ id: providerReclaimAttempts.id });

      if (updated === undefined) {
        throw new Error("Reclaim signer persistence failed");
      }
      return result;
    });
  }

  async findSignedByAttemptKey(
    attemptKey: string,
  ): Promise<TronSignedReclaim | undefined> {
    const normalizedKey = requireString(attemptKey, "attemptKey");
    const [selected] = await this.db
      .select({
        providerName: providerDeliveries.providerName,
        signerUnsignedTxid: providerReclaimAttempts.signerUnsignedTxid,
        signerUnsignedDigest: providerReclaimAttempts.signerUnsignedDigest,
        signedTransaction: providerReclaimAttempts.signedTransaction,
        signedAt: providerReclaimAttempts.signedAt,
      })
      .from(providerReclaimAttempts)
      .innerJoin(
        providerTransactionAttempts,
        eq(
          providerTransactionAttempts.id,
          providerReclaimAttempts.sourceProviderTransactionAttemptId,
        ),
      )
      .innerJoin(
        providerDeliveries,
        eq(
          providerDeliveries.id,
          providerTransactionAttempts.providerDeliveryId,
        ),
      )
      .where(eq(providerReclaimAttempts.attemptKey, normalizedKey))
      .limit(1);

    if (selected === undefined) return undefined;
    if (selected.providerName !== "tron-own-pool") {
      throw new Error("Reclaim signer provider is not allowed");
    }
    if (
      selected.signerUnsignedTxid === null &&
      selected.signerUnsignedDigest === null &&
      selected.signedTransaction === null &&
      selected.signedAt === null
    ) {
      return undefined;
    }
    if (
      selected.signerUnsignedTxid === null ||
      selected.signerUnsignedDigest === null ||
      selected.signedTransaction === null ||
      selected.signedAt === null
    ) {
      throw new Error("Reclaim signer persistence is incomplete");
    }
    return signedReclaim(
      normalizeTxid(
        selected.signerUnsignedTxid,
        "stored reclaim signer txid",
      ),
      selected.signedTransaction,
    );
  }
}
