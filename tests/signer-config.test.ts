import { describe, expect, it } from "vitest";

import { parseSignerRuntimeConfig } from "../src/runtime/signer-config.js";

describe("parseSignerRuntimeConfig", () => {
  it("requires an owner address and explicit Railway port", () => {
    expect(
      parseSignerRuntimeConfig({
        TRON_SIGNER_OWNER_ADDRESS: "TOWNER",
        PORT: "8080",
        SECRET_PROVIDER: "infisical",
      }),
    ).toEqual({
      secretProvider: "infisical",
      ownerAddress: "TOWNER",
      port: 8080,
    });
  });

  it("fails closed when owner address or port is absent", () => {
    expect(() =>
      parseSignerRuntimeConfig({ PORT: "8080" }),
    ).toThrow(/TRON_SIGNER_OWNER_ADDRESS/);
    expect(() =>
      parseSignerRuntimeConfig({
        TRON_SIGNER_OWNER_ADDRESS: "TOWNER",
      }),
    ).toThrow(/PORT/);
  });

  it.each(["0", "65536", "abc"])(
    "rejects invalid signer port %s",
    (port) => {
      expect(() =>
        parseSignerRuntimeConfig({
          TRON_SIGNER_OWNER_ADDRESS: "TOWNER",
          PORT: port,
        }),
      ).toThrow(/PORT/);
    },
  );
});
