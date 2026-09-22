import { createHash } from "node:crypto";

import type {
  TronAddressCodec,
  TronEncodedAddress,
} from "../../core/payments/tron-evidence-normalization.js";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(
  [...BASE58_ALPHABET].map((character, index) => [character, index]),
);
const HEX41_PATTERN = /^41[0-9a-fA-F]{40}$/;

function checksum(payload: Uint8Array): Buffer {
  const first = createHash("sha256").update(payload).digest();
  return createHash("sha256").update(first).digest().subarray(0, 4);
}

function base58Encode(bytes: Uint8Array): string {
  let value = 0n;

  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let encoded = "";

  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder]! + encoded;
    value /= 58n;
  }

  let leadingZeroes = 0;

  for (const byte of bytes) {
    if (byte !== 0) {
      break;
    }

    leadingZeroes += 1;
  }

  return "1".repeat(leadingZeroes) + (encoded || "");
}

function base58Decode(value: string): Buffer | undefined {
  if (value.length === 0) {
    return undefined;
  }

  let numeric = 0n;

  for (const character of value) {
    const index = BASE58_INDEX.get(character);

    if (index === undefined) {
      return undefined;
    }

    numeric = numeric * 58n + BigInt(index);
  }

  const decoded: number[] = [];

  while (numeric > 0n) {
    decoded.push(Number(numeric % 256n));
    numeric /= 256n;
  }

  decoded.reverse();

  let leadingZeroes = 0;

  for (const character of value) {
    if (character !== "1") {
      break;
    }

    leadingZeroes += 1;
  }

  return Buffer.from([
    ...Array.from({ length: leadingZeroes }, () => 0),
    ...decoded,
  ]);
}

function encodePayload(payload: Buffer): string {
  return base58Encode(Buffer.concat([payload, checksum(payload)]));
}

function validateBase58Check(value: string): string | undefined {
  const decoded = base58Decode(value);

  if (decoded === undefined || decoded.length !== 25) {
    return undefined;
  }

  const payload = decoded.subarray(0, 21);
  const suppliedChecksum = decoded.subarray(21);

  if (payload[0] !== 0x41 || !suppliedChecksum.equals(checksum(payload))) {
    return undefined;
  }

  const canonical = encodePayload(payload);

  return canonical === value ? canonical : undefined;
}

export class NodeTronAddressCodec implements TronAddressCodec {
  readonly name = "node-tron-base58check";

  toBase58Check(address: TronEncodedAddress): string | undefined {
    if (address.encoding === "base58check") {
      return validateBase58Check(address.value);
    }

    if (!HEX41_PATTERN.test(address.value)) {
      return undefined;
    }

    const payload = Buffer.from(address.value, "hex");

    if (payload.length !== 21 || payload[0] !== 0x41) {
      return undefined;
    }

    return encodePayload(payload);
  }
}
