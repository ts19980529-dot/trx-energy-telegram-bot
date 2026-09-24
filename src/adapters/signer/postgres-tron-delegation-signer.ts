import { createHash } from "node:crypto";

import { eq, sql } from "drizzle-orm";
import { TronWeb, utils } from "tronweb";

import type {
  TronDelegationSigner,
  TronSignedDelegation,
  TronUnsignedDelegation,
} from "../energy/tron-own-pool-energy-provider.js";
import {
  providerDeliveries,
  providerTransactionAttempts,
} from "../../db/schema.js";
import type { AppDatabase } from "../database/postgres.js";

const TXID_PATTERN = /^[0-9a-f]{64}$/;
const HEX_41_ADDRESS_PATTERN = /^41[0-9a-f]{40}$/;
const MIN_DELEGATION_SUN = 1_000_000;

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
    if (!HEX_41_ADDRESS_PATTERN.test(hex)) {
      throw new Error("invalid");
    }
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
        throw new Error("Signer transaction contains a non-finite number");
      }
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map((item) => stableJson(item)).join(",")}]`;
      }

      if (!isRecord(value)) {
        throw new Error("Signer transaction contains a non-JSON value");
      }

      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
        .join(",")}}`;
    default:
      throw new Error("Signer transaction contains a non-JSON value");
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

interface ValidatedUnsigned {
  readonly txid: string;
  readonly digest: string;
  readonly ownerAddressHex: string;
  readonly receiverAddressHex: string;
  readonly balanceSun: bigint;
}

function validateUnsignedDelegation(
  unsigned: TronUnsignedDelegation,
  ownerAddressHex: string,
  now: () => number,
): ValidatedUnsigned {
  const txid = normalizeTxid(unsigned.txid, "unsigned txid");
  const transaction = unsigned.transaction;

  const embeddedTxid = normalizeTxid(
    requireString(transaction.txID, "transaction.txID"),
    "transaction.txID",
  );
  if (embeddedTxid !== txid) {
    throw new Error("Signer transaction identity mismatch");
  }

  if (
    "signature" in transaction &&
    Array.isArray(transaction.signature) &&
    transaction.signature.length > 0
  ) {
    throw new Error("Signer refuses an already-signed transaction");
  }

  let transactionValid = false;
  try {
    transactionValid = utils.transaction.txCheck(transaction);
  } catch {
    transactionValid = false;
  }
  if (!transactionValid) {
    throw new Error(
      "Signer transaction raw_data, raw_data_hex and txID are inconsistent",
    );
  }

  const rawData = transaction.raw_data;
  if (!isRecord(rawData) || !Array.isArray(rawData.contract)) {
    throw new Error("Signer transaction raw_data is malformed");
  }
  if (rawData.contract.length !== 1 || !isRecord(rawData.contract[0])) {
    throw new Error("Signer requires exactly one TRON contract");
  }

  const contract = rawData.contract[0];
  if (contract.type !== "DelegateResourceContract") {
    throw new Error("Signer only accepts DelegateResourceContract");
  }

  const parameter = contract.parameter;
  if (!isRecord(parameter) || !isRecord(parameter.value)) {
    throw new Error("Signer DelegateResource parameter is malformed");
  }
  const value = parameter.value;

  if (value.resource !== "ENERGY") {
    throw new Error("Signer only accepts ENERGY delegation");
  }
  if (value.lock === true) {
    throw new Error("Signer refuses locked Energy delegation");
  }
  if (
    value.lock_period !== undefined &&
    value.lock_period !== 0 &&
    value.lock_period !== "0"
  ) {
    throw new Error("Signer refuses a delegation lock period");
  }

  const ownerAddress = canonicalAddress(
    requireString(value.owner_address, "DelegateResource owner_address"),
    "DelegateResource owner_address",
  );
  if (ownerAddress !== ownerAddressHex) {
    throw new Error("Signer owner address mismatch");
  }

  const receiverAddress = canonicalAddress(
    requireString(value.receiver_address, "DelegateResource receiver_address"),
    "DelegateResource receiver_address",
  );

  const balance = safePositiveInteger(
    value.balance,
    "DelegateResource balance",
  );
  if (balance < MIN_DELEGATION_SUN) {
    throw new Error("Signer delegation is below the 1 TRX minimum");
  }

  const expiration = safePositiveInteger(
    rawData.expiration,
    "transaction expiration",
  );
  if (expiration <= now()) {
    throw new Error("Signer refuses an expired transaction");
  }

  return {
    txid,
    digest: transactionDigest(transaction),
    ownerAddressHex: ownerAddress,
    receiverAddressHex: receiverAddress,
    balanceSun: BigInt(balance),
  };
}

function signedDelegation(
  txid: string,
  value: unknown,
): TronSignedDelegation {
  if (!isRecord(value)) {
    throw new Error("Stored signer transaction is malformed");
  }

  const embeddedTxid = normalizeTxid(
    requireString(value.txID, "signed transaction txID"),
    "signed transaction txID",
  );
  if (embeddedTxid !== txid) {
    throw new Error("Stored signer transaction identity mismatch");
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
    throw new Error("Stored signer transaction signature is malformed");
  }

  return {
    txid,
    transaction: value,
  };
}

export class PostgresTronDelegationSigner implements TronDelegationSigner {
  private readonly ownerAddressHex: string;
  private readonly privateKey: string;

  constructor(
    private readonly db: AppDatabase,
    ownerAddress: string,
    privateKey: string,
    private readonly now: () => number = Date.now,
  ) {
    this.ownerAddressHex = canonicalAddress(ownerAddress, "signer owner address");

    const normalizedPrivateKey = privateKey.trim().replace(/^0x/, "");
    if (!/^[0-9a-fA-F]{64}$/.test(normalizedPrivateKey)) {
      throw new Error("TRON signer private key is invalid");
    }
    this.privateKey = normalizedPrivateKey;

    const derivedAddress = TronWeb.address.fromPrivateKey(this.privateKey);
    if (
      typeof derivedAddress !== "string" ||
      canonicalAddress(derivedAddress, "derived signer address") !==
        this.ownerAddressHex
    ) {
      throw new Error("TRON signer private key does not match owner address");
    }
  }

  async sign(input: {
    readonly attemptKey: string;
    readonly unsigned: TronUnsignedDelegation;
  }): Promise<TronSignedDelegation> {
    const attemptKey = requireString(input.attemptKey, "attemptKey");
    const validated = validateUnsignedDelegation(
      input.unsigned,
      this.ownerAddressHex,
      this.now,
    );

    return this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(
          hashtext('tron-energy-signer'),
          hashtext(${attemptKey})
        )`,
      );

      const [selected] = await tx
        .select({
          attempt: providerTransactionAttempts,
          providerName: providerDeliveries.providerName,
        })
        .from(providerTransactionAttempts)
        .innerJoin(
          providerDeliveries,
          eq(
            providerDeliveries.id,
            providerTransactionAttempts.providerDeliveryId,
          ),
        )
        .where(eq(providerTransactionAttempts.attemptKey, attemptKey))
        .limit(1)
        .for("update");

      if (selected === undefined) {
        throw new Error("Signer attempt is not registered");
      }
      if (selected.providerName !== "tron-own-pool") {
        throw new Error("Signer attempt provider is not allowed");
      }
      if (
        selected.attempt.delegatedOwnerAddress === null ||
        selected.attempt.delegatedReceiverAddress === null ||
        selected.attempt.delegatedResource === null ||
        selected.attempt.delegatedBalanceSun === null
      ) {
        throw new Error("Signer attempt delegation binding is missing");
      }
      if (
        canonicalAddress(selected.attempt.delegatedOwnerAddress, "bound delegation owner address") !==
        validated.ownerAddressHex
      ) throw new Error("Signer bound owner address mismatch");
      if (
        canonicalAddress(selected.attempt.delegatedReceiverAddress, "bound delegation receiver address") !==
        validated.receiverAddressHex
      ) throw new Error("Signer bound receiver address mismatch");
      if (selected.attempt.delegatedResource !== "ENERGY") throw new Error("Signer bound resource mismatch");
      if (selected.attempt.delegatedBalanceSun !== validated.balanceSun) {
        throw new Error("Signer bound delegation balance mismatch");
      }

      const existingTxid = selected.attempt.signerUnsignedTxid;
      const existingDigest = selected.attempt.signerUnsignedDigest;
      const existingSigned = selected.attempt.signedTransaction;
      const existingSignedAt = selected.attempt.signedAt;
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
          throw new Error("Signer attempt persistence is incomplete");
        }
        if (
          normalizeTxid(existingTxid, "stored signer txid") !==
            validated.txid ||
          existingDigest !== validated.digest
        ) {
          throw new Error("Signer attempt identity changed");
        }
        return signedDelegation(validated.txid, existingSigned);
      }

      if (selected.attempt.status !== "created") {
        throw new Error("Signer attempt is no longer signable");
      }

      const transaction = cloneTransaction(input.unsigned.transaction);
      const signed = utils.crypto.signTransaction(
        this.privateKey,
        transaction,
      ) as unknown;
      const result = signedDelegation(validated.txid, signed);

      const [updated] = await tx
        .update(providerTransactionAttempts)
        .set({
          signerUnsignedTxid: validated.txid,
          signerUnsignedDigest: validated.digest,
          signedTransaction: result.transaction,
          signedAt: new Date(this.now()),
          updatedAt: new Date(this.now()),
        })
        .where(eq(providerTransactionAttempts.id, selected.attempt.id))
        .returning({ id: providerTransactionAttempts.id });

      if (updated === undefined) {
        throw new Error("Signer attempt persistence failed");
      }

      return result;
    });
  }

  async findSignedByAttemptKey(
    attemptKey: string,
  ): Promise<TronSignedDelegation | undefined> {
    const normalizedKey = requireString(attemptKey, "attemptKey");
    const [selected] = await this.db
      .select({
        providerName: providerDeliveries.providerName,
        signerUnsignedTxid: providerTransactionAttempts.signerUnsignedTxid,
        signerUnsignedDigest:
          providerTransactionAttempts.signerUnsignedDigest,
        signedTransaction: providerTransactionAttempts.signedTransaction,
        signedAt: providerTransactionAttempts.signedAt,
      })
      .from(providerTransactionAttempts)
      .innerJoin(
        providerDeliveries,
        eq(
          providerDeliveries.id,
          providerTransactionAttempts.providerDeliveryId,
        ),
      )
      .where(eq(providerTransactionAttempts.attemptKey, normalizedKey))
      .limit(1);

    if (selected === undefined) return undefined;
    if (selected.providerName !== "tron-own-pool") {
      throw new Error("Signer attempt provider is not allowed");
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
      throw new Error("Signer attempt persistence is incomplete");
    }

    return signedDelegation(
      normalizeTxid(selected.signerUnsignedTxid, "stored signer txid"),
      selected.signedTransaction,
    );
  }
}
