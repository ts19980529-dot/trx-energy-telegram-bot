import { describe, expect, it } from "vitest";

import { InfisicalSecretProvider } from "../src/adapters/secrets/infisical-secret-provider.js";

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") {
    return input;
  }

  if (input instanceof URL) {
    return input.toString();
  }

  return input.url;
}

function jsonResponse(
  body: unknown,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

describe("InfisicalSecretProvider", () => {
  it("uses Universal Auth once and fetches concurrent runtime secrets", async () => {
    const requests: RecordedRequest[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = requestUrl(input);
      requests.push({ url, init });

      if (url.endsWith("/api/v1/auth/universal-auth/login")) {
        return jsonResponse({
          accessToken: "access-token",
          expiresIn: 7_200,
          accessTokenMaxTTL: 43_200,
          tokenType: "Bearer",
        });
      }

      const parsed = new URL(url);
      const name = decodeURIComponent(
        parsed.pathname.split("/").at(-1) ?? "",
      );

      expect(parsed.searchParams.get("projectId")).toBe(
        "project-id",
      );
      expect(parsed.searchParams.get("environment")).toBe("prod");
      expect(parsed.searchParams.get("secretPath")).toBe("/runtime");

      return jsonResponse({
        secret: {
          secretValue: `value-for-${name}`,
        },
      });
    };

    const provider = new InfisicalSecretProvider({
      siteUrl: "https://app.infisical.com",
      projectId: "project-id",
      environment: "prod",
      secretPath: "/runtime",
      clientId: "client-id",
      clientSecret: "client-secret",
      fetchImpl: fakeFetch,
    });

    await expect(
      Promise.all([
        provider.getSecret("BOT_TOKEN"),
        provider.getSecret("DATABASE_URL"),
      ]),
    ).resolves.toEqual([
      "value-for-BOT_TOKEN",
      "value-for-DATABASE_URL",
    ]);

    const authRequests = requests.filter((request) =>
      request.url.endsWith("/api/v1/auth/universal-auth/login"),
    );
    expect(authRequests).toHaveLength(1);

    const authHeaders = new Headers(authRequests[0]?.init?.headers);
    expect(authHeaders.get("Content-Type")).toBe(
      "application/x-www-form-urlencoded",
    );

    const authBody = authRequests[0]?.init?.body;
    expect(authBody).toBeInstanceOf(URLSearchParams);
    expect((authBody as URLSearchParams).get("clientId")).toBe(
      "client-id",
    );
    expect((authBody as URLSearchParams).get("clientSecret")).toBe(
      "client-secret",
    );
  });

  it("returns undefined for a missing secret", async () => {
    const fakeFetch: typeof fetch = async (input) => {
      const url = requestUrl(input);

      if (url.endsWith("/api/v1/auth/universal-auth/login")) {
        return jsonResponse({
          accessToken: "access-token",
          expiresIn: 7_200,
        });
      }

      return jsonResponse({ message: "not found" }, 404);
    };

    const provider = new InfisicalSecretProvider({
      siteUrl: "https://app.infisical.com",
      projectId: "project-id",
      environment: "prod",
      secretPath: "/",
      clientId: "client-id",
      clientSecret: "client-secret",
      fetchImpl: fakeFetch,
    });

    await expect(provider.getSecret("BOT_TOKEN")).resolves.toBeUndefined();
  });

  it("fails closed without exposing an authentication response body", async () => {
    const fakeFetch: typeof fetch = async () =>
      jsonResponse(
        {
          message: "sensitive-provider-detail",
        },
        401,
      );

    const provider = new InfisicalSecretProvider({
      siteUrl: "https://app.infisical.com",
      projectId: "project-id",
      environment: "prod",
      secretPath: "/",
      clientId: "client-id",
      clientSecret: "client-secret",
      fetchImpl: fakeFetch,
    });

    await expect(provider.getSecret("BOT_TOKEN")).rejects.toThrow(
      "Infisical authentication failed (401)",
    );
  });

  it("rejects non-HTTPS Infisical endpoints", () => {
    expect(
      () =>
        new InfisicalSecretProvider({
          siteUrl: "http://app.infisical.com",
          projectId: "project-id",
          environment: "prod",
          secretPath: "/",
          clientId: "client-id",
          clientSecret: "client-secret",
        }),
    ).toThrow(/must use https/);
  });
});
