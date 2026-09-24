import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type {
  TronDelegationSigner,
  TronReclaimSigner,
  TronUnsignedDelegation,
  TronUnsignedReclaim,
} from "../adapters/energy/tron-own-pool-energy-provider.js";

const MAX_BODY_BYTES = 512 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function json(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  response.end(payload);
}

function authorized(
  header: string | undefined,
  expectedToken: string,
): boolean {
  if (header === undefined || !header.startsWith("Bearer ")) {
    return false;
  }

  const provided = Buffer.from(header.slice("Bearer ".length), "utf8");
  const expected = Buffer.from(expectedToken, "utf8");

  return (
    provided.length === expected.length &&
    provided.length > 0 &&
    timingSafeEqual(provided, expected)
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let size = 0;
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;

    if (size > MAX_BODY_BYTES) {
      throw new Error("request_too_large");
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    throw new Error("invalid_json");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new Error("invalid_json");
  }
}

function parseAttemptKey(body: unknown): string {
  if (!isRecord(body)) {
    throw new Error("invalid_request");
  }

  const attemptKey = body.attemptKey;
  if (typeof attemptKey !== "string" || attemptKey.trim() === "") {
    throw new Error("invalid_request");
  }

  return attemptKey.trim();
}

function parseSignBody(body: unknown): {
  readonly attemptKey: string;
  readonly unsigned: TronUnsignedDelegation;
} {
  if (!isRecord(body) || !isRecord(body.unsigned)) {
    throw new Error("invalid_request");
  }

  const attemptKey = parseAttemptKey(body);
  const txid = body.unsigned.txid;
  const transaction = body.unsigned.transaction;

  if (
    typeof txid !== "string" ||
    !/^[0-9a-fA-F]{64}$/.test(txid) ||
    !isRecord(transaction)
  ) {
    throw new Error("invalid_request");
  }

  return {
    attemptKey,
    unsigned: {
      txid: txid.toLowerCase(),
      transaction,
    },
  };
}

function parseReclaimSignBody(body: unknown): {
  readonly attemptKey: string;
  readonly unsigned: TronUnsignedReclaim;
} {
  return parseSignBody(body);
}

export function createSignerHttpServer(input: {
  readonly signer: TronDelegationSigner;
  readonly reclaimSigner: TronReclaimSigner;
  readonly authToken: string;
}): Server {
  const authToken = input.authToken.trim();

  if (authToken === "") {
    throw new Error("TRON_SIGNER_AUTH_TOKEN must not be empty");
  }

  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      json(response, 200, { ok: true });
      return;
    }

    if (
      request.method !== "POST" ||
      (
        request.url !== "/v1/sign" &&
        request.url !== "/v1/recover" &&
        request.url !== "/v1/reclaim/sign" &&
        request.url !== "/v1/reclaim/recover"
      )
    ) {
      json(response, 404, { error: "not_found" });
      return;
    }

    if (!authorized(request.headers.authorization, authToken)) {
      json(response, 401, { error: "unauthorized" });
      return;
    }

    try {
      const body = await readJsonBody(request);

      if (request.url === "/v1/sign") {
        const result = await input.signer.sign(parseSignBody(body));
        json(response, 200, result);
        return;
      }
      if (request.url === "/v1/reclaim/sign") {
        const result = await input.reclaimSigner.sign(parseReclaimSignBody(body));
        json(response, 200, result);
        return;
      }

      const attemptKey = parseAttemptKey(body);
      const result =
        request.url === "/v1/recover"
          ? await input.signer.findSignedByAttemptKey(attemptKey)
          : await input.reclaimSigner.findSignedByAttemptKey(attemptKey);

      if (result === undefined) {
        json(response, 404, { error: "not_found" });
        return;
      }

      json(response, 200, result);
    } catch (error) {
      const code =
        error instanceof Error ? error.message : "internal_error";

      if (
        code === "invalid_request" ||
        code === "invalid_json" ||
        code === "request_too_large"
      ) {
        json(
          response,
          code === "request_too_large" ? 413 : 400,
          { error: code },
        );
        return;
      }

      console.error("TRON signer request failed");
      json(response, 500, { error: "signer_failed" });
    }
  });

  server.requestTimeout = 10_000;
  server.headersTimeout = 12_000;
  server.keepAliveTimeout = 5_000;

  return server;
}
