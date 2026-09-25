import {
  GrammyError,
  type Bot,
  type Context,
  type PollingOptions,
} from "grammy";

const DEFAULT_CONFLICT_RETRY_WINDOW_MS = 30_000;
const DEFAULT_CONFLICT_RETRY_DELAY_MS = 1_000;

function waitForRetry(
  delayMs: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", onAbort);
      resolve();
    };

    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function isTelegramPollingConflict(
  error: unknown,
): error is GrammyError {
  return error instanceof GrammyError && error.error_code === 409;
}

export async function runTelegramLongPollingWithOverlapRetry(
  bot: Pick<Bot<Context>, "start">,
  input: {
    readonly allowedUpdates: NonNullable<
      PollingOptions["allowed_updates"]
    >;
    readonly signal: AbortSignal;
    readonly retryWindowMs?: number;
    readonly retryDelayMs?: number;
    readonly now?: () => number;
    readonly wait?: (
      delayMs: number,
      signal: AbortSignal,
    ) => Promise<void>;
  },
): Promise<void> {
  const retryWindowMs =
    input.retryWindowMs ?? DEFAULT_CONFLICT_RETRY_WINDOW_MS;
  const retryDelayMs =
    input.retryDelayMs ?? DEFAULT_CONFLICT_RETRY_DELAY_MS;
  const now = input.now ?? Date.now;
  const wait = input.wait ?? waitForRetry;

  if (
    !Number.isSafeInteger(retryWindowMs) ||
    retryWindowMs <= 0 ||
    !Number.isSafeInteger(retryDelayMs) ||
    retryDelayMs <= 0
  ) {
    throw new Error(
      "Telegram polling retry timing must be positive safe integers",
    );
  }

  const retryDeadline = now() + retryWindowMs;
  let conflictCount = 0;

  while (!input.signal.aborted) {
    try {
      await bot.start({
        allowed_updates: [...input.allowedUpdates],
      });
      return;
    } catch (error) {
      if (
        !isTelegramPollingConflict(error) ||
        now() >= retryDeadline ||
        input.signal.aborted
      ) {
        throw error;
      }

      conflictCount += 1;
      console.error(
        `Telegram long polling deployment overlap; code=409; retry=${conflictCount}`,
      );

      await wait(retryDelayMs, input.signal);
    }
  }
}
