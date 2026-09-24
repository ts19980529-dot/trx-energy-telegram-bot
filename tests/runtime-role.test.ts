import { describe, expect, it } from "vitest";

import { resolveRuntimeRole } from "../src/runtime/runtime-role.js";

describe("resolveRuntimeRole", () => {
  it("routes the dedicated Railway signer service to the signer runtime", () => {
    expect(
      resolveRuntimeRole({
        RAILWAY_SERVICE_NAME: "tron-signer",
      }),
    ).toBe("signer");
  });

  it("keeps the ordinary Railway bot service on the bot runtime", () => {
    expect(
      resolveRuntimeRole({
        RAILWAY_SERVICE_NAME: "bot",
      }),
    ).toBe("bot");
  });

  it("allows an explicit runtime role to override the Railway service name", () => {
    expect(
      resolveRuntimeRole({
        RAILWAY_SERVICE_NAME: "bot",
        TRX_RUNTIME_ROLE: "signer",
      }),
    ).toBe("signer");
  });

  it("fails closed on an invalid explicit runtime role", () => {
    expect(() =>
      resolveRuntimeRole({
        TRX_RUNTIME_ROLE: "worker",
      }),
    ).toThrow("TRX_RUNTIME_ROLE must be bot or signer");
  });
});
