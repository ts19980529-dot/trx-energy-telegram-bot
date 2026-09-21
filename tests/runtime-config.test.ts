import { describe, expect, it } from "vitest";

import { parseRuntimeConfig } from "../src/runtime/config.js";

describe("parseRuntimeConfig", () => {
  it("defaults to environment secrets without inventing a super admin", () => {
    expect(parseRuntimeConfig({})).toEqual({
      secretProvider: "environment",
    });
  });

  it("accepts a positive numeric SUPER_ADMIN_ID", () => {
    expect(
      parseRuntimeConfig({
        SECRET_PROVIDER: "environment",
        SUPER_ADMIN_ID: "123456789",
      }),
    ).toEqual({
      secretProvider: "environment",
      superAdminId: 123456789n,
    });
  });

  it.each(["0", "-1", "abc", "1.5"])(
    "rejects invalid SUPER_ADMIN_ID %s",
    (value) => {
      expect(() =>
        parseRuntimeConfig({ SUPER_ADMIN_ID: value }),
      ).toThrow(/SUPER_ADMIN_ID/);
    },
  );

  it("fails closed for an unimplemented SecretProvider", () => {
    expect(() =>
      parseRuntimeConfig({ SECRET_PROVIDER: "1password" }),
    ).toThrow(/SecretProvider/);
  });
});
