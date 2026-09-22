import { describe, expect, it } from "vitest";

import { NodeTronAddressCodec } from "../src/adapters/tron/node-tron-address-codec.js";

describe("NodeTronAddressCodec", () => {
  const codec = new NodeTronAddressCodec();

  it("converts TRON 41-hex addresses to canonical Base58Check", () => {
    expect(
      codec.toBase58Check({
        encoding: "hex41",
        value: "41a614f803b6fd780986a42c78ec9c7f77e6ded13c",
      }),
    ).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");

    expect(
      codec.toBase58Check({
        encoding: "hex41",
        value: "418840e6c55b9ada326d211d818c34a994aeced808",
      }),
    ).toBe("TNPeeaaFB7K9cmo4uQpcU32zGK8G1NYqeL");
  });

  it("checksum-validates canonical Base58Check input", () => {
    expect(
      codec.toBase58Check({
        encoding: "base58check",
        value: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      }),
    ).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");

    expect(
      codec.toBase58Check({
        encoding: "base58check",
        value: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj61",
      }),
    ).toBeUndefined();
  });

  it("rejects malformed or non-TRON payloads", () => {
    expect(
      codec.toBase58Check({
        encoding: "hex41",
        value: "40a614f803b6fd780986a42c78ec9c7f77e6ded13c",
      }),
    ).toBeUndefined();

    expect(
      codec.toBase58Check({
        encoding: "base58check",
        value: "not-an-address",
      }),
    ).toBeUndefined();
  });
});
