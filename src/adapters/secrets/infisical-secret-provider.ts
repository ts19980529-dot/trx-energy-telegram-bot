import type {
  SecretName,
  SecretProvider,
} from "../../core/secrets/secret-provider.js";

type FetchLike = typeof fetch;

export interface InfisicalSecretProviderOptions {
  readonly siteUrl: string;
  readonly projectId: string;
  readonly environment: string;
  readonly secretPath: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetchImpl?: FetchLike;
  readonly now?: () => number;
}

interface CachedAccessToken {
  readonly value: string;
  readonly expiresAtMs: number;
}

const TOKEN_REFRESH_SKEW_MS = 30_000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizedSiteUrl(value: string): string {
  const url = new URL(value);

  if (url.protocol !== "https:") {
    throw new Error("INFISICAL_SITE_URL must use https");
  }

  if (url.username !== "" || url.password !== "") {
    throw new Error("INFISICAL_SITE_URL must not contain credentials");
  }

  if (url.pathname !== "/" && url.pathname !== "") {
    throw new Error("INFISICAL_SITE_URL must not contain a path");
  }

  return url.origin;
}

export class InfisicalSecretProvider implements SecretProvider {
  readonly name = "infisical";

  private readonly siteUrl: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private cachedAccessToken: CachedAccessToken | undefined;
  private tokenRequest: Promise<string> | undefined;

  constructor(private readonly options: InfisicalSecretProviderOptions) {
    this.siteUrl = normalizedSiteUrl(options.siteUrl);
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;
    this.now = options.now ?? Date.now;

    if (!options.secretPath.startsWith("/")) {
      throw new Error("INFISICAL_SECRET_PATH must start with /");
    }
  }

  async getSecret(name: SecretName): Promise<string | undefined> {
    const accessToken = await this.getAccessToken();
    const url = new URL(
      `/api/v4/secrets/${encodeURIComponent(name)}`,
      this.siteUrl,
    );
    url.searchParams.set("projectId", this.options.projectId);
    url.searchParams.set("environment", this.options.environment);
    url.searchParams.set("secretPath", this.options.secretPath);

    const response = await this.fetchImpl(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (response.status === 404) {
      return undefined;
    }

    if (!response.ok) {
      throw new Error(
        `Infisical secret request failed (${response.status})`,
      );
    }

    const payload = asRecord(await response.json());
    const secret = asRecord(payload?.secret);
    const value = secret?.secretValue;

    if (typeof value !== "string") {
      throw new Error("Infisical secret response is invalid");
    }

    return value.trim() === "" ? undefined : value;
  }

  private async getAccessToken(): Promise<string> {
    const cached = this.cachedAccessToken;

    if (
      cached !== undefined &&
      this.now() + TOKEN_REFRESH_SKEW_MS < cached.expiresAtMs
    ) {
      return cached.value;
    }

    const existingRequest = this.tokenRequest;

    if (existingRequest !== undefined) {
      return existingRequest;
    }

    const request = this.authenticate();
    this.tokenRequest = request;

    try {
      return await request;
    } finally {
      if (this.tokenRequest === request) {
        this.tokenRequest = undefined;
      }
    }
  }

  private async authenticate(): Promise<string> {
    const response = await this.fetchImpl(
      new URL("/api/v1/auth/universal-auth/login", this.siteUrl),
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          clientId: this.options.clientId,
          clientSecret: this.options.clientSecret,
        }),
      },
    );

    if (!response.ok) {
      throw new Error(
        `Infisical authentication failed (${response.status})`,
      );
    }

    const payload = asRecord(await response.json());
    const accessToken = payload?.accessToken;
    const expiresIn = payload?.expiresIn;

    if (
      typeof accessToken !== "string" ||
      accessToken.trim() === "" ||
      typeof expiresIn !== "number" ||
      !Number.isFinite(expiresIn) ||
      expiresIn <= 0
    ) {
      throw new Error("Infisical authentication response is invalid");
    }

    this.cachedAccessToken = {
      value: accessToken,
      expiresAtMs: this.now() + expiresIn * 1_000,
    };

    return accessToken;
  }
}
