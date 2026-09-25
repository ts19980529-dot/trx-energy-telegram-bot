import {
  Bot,
  Context,
  GrammyError,
} from "grammy";
import { describe, expect, it, vi } from "vitest";

import {
  runTelegramLongPollingWithOverlapRetry,
} from "../src/runtime/telegram-long-polling.js";

function grammyError(code: number): GrammyError {
  const error = Object.create(GrammyError.prototype) as GrammyError;
  Object.defineProperty(error, "error_code", {
    value: code,
    enumerable: true,
  });
  return error;
}

function fakeBot(
  start: () => Promise<void>,
): Pick<Bot<Context>, "start"> {
  return { start } as unknown as Pick<Bot<Context>, "start">;
}

describe("Telegram long-polling deployment overlap", () => {
  it("retries a transient 409 conflict and then continues", async () => {
    const conflict = grammyError(409);
    let calls = 0;
    const waits: number[] = [];
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runTelegramLongPollingWithOverlapRetry(
          fakeBot(async () => {
            calls += 1;
            if (calls === 1) throw conflict;
          }),
          {
            allowedUpdates: ["message", "callback_query"],
            signal: new AbortController().signal,
            now: () => 0,
            wait: async (delayMs) => {
              waits.push(delayMs);
            },
          },
        ),
      ).resolves.toBeUndefined();

      expect(calls).toBe(2);
      expect(waits).toEqual([1_000]);
      expect(errors).toHaveBeenCalledWith(
        "Telegram long polling deployment overlap; code=409; retry=1",
      );
    } finally {
      errors.mockRestore();
    }
  });

  it("does not retry non-conflict Telegram errors", async () => {
    const unauthorized = grammyError(401);
    let calls = 0;

    await expect(
      runTelegramLongPollingWithOverlapRetry(
        fakeBot(async () => {
          calls += 1;
          throw unauthorized;
        }),
        {
          allowedUpdates: ["message"],
          signal: new AbortController().signal,
          now: () => 0,
          wait: async () => undefined,
        },
      ),
    ).rejects.toBe(unauthorized);

    expect(calls).toBe(1);
  });

  it("fails closed when the deployment conflict outlives the retry window", async () => {
    const conflict = grammyError(409);
    const times = [0, 30_000];
    let calls = 0;

    await expect(
      runTelegramLongPollingWithOverlapRetry(
        fakeBot(async () => {
          calls += 1;
          throw conflict;
        }),
        {
          allowedUpdates: ["message"],
          signal: new AbortController().signal,
          now: () => times.shift() ?? 30_000,
          wait: async () => undefined,
        },
      ),
    ).rejects.toBe(conflict);

    expect(calls).toBe(1);
  });

  it("stops retrying when the runtime is terminating", async () => {
    const conflict = grammyError(409);
    const controller = new AbortController();
    let calls = 0;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runTelegramLongPollingWithOverlapRetry(
          fakeBot(async () => {
            calls += 1;
            throw conflict;
          }),
          {
            allowedUpdates: ["message"],
            signal: controller.signal,
            now: () => 0,
            wait: async () => {
              controller.abort();
            },
          },
        ),
      ).resolves.toBeUndefined();

      expect(calls).toBe(1);
    } finally {
      errors.mockRestore();
    }
  });
});
