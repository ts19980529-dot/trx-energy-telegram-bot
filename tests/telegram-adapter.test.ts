import { describe, expect, it } from "vitest";

import type { TelegramBotServices } from "../src/adapters/telegram/create-bot.js";
import { createTelegramBot } from "../src/adapters/telegram/create-bot.js";

const packageId = "123e4567-e89b-12d3-a456-426614174000";

function botInfo() {
  return {
    id: 900001,
    is_bot: true as const,
    first_name: "测试机器人",
    username: "phase1_test_bot",
    can_join_groups: true,
    can_read_all_group_messages: false,
    supports_inline_queries: false,
    can_connect_to_business: false,
    has_main_web_app: false,
    has_topics_enabled: false,
    allows_users_to_create_topics: false,
    can_manage_bots: false,
    supports_join_request_queries: false,
  };
}

function privateChat() {
  return {
    id: 42,
    type: "private" as const,
    first_name: "测试用户",
    username: "demo_user",
  };
}

function user() {
  return {
    id: 42,
    is_bot: false,
    first_name: "测试用户",
    username: "demo_user",
  };
}

function mockFetch(calls: string[]): typeof fetch {
  return async (input) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    calls.push(url);

    if (url.endsWith("/answerCallbackQuery")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: true,
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    if (url.endsWith("/sendMessage")) {
      return new Response(
        JSON.stringify({
          ok: true,
          result: {
            message_id: 99,
            date: 1_700_000_000,
            chat: privateChat(),
            text: "mock response",
          },
        }),
        {
          status: 200,
          headers: { "content-type": "application/json" },
        },
      );
    }

    throw new Error(`Unexpected Bot API request: ${url}`);
  };
}

describe("Telegram adapter", () => {
  it("routes /start through the application service and replies through Bot API", async () => {
    const calls: string[] = [];
    const startInputs: unknown[] = [];

    const services: TelegramBotServices = {
      start: {
        async execute(input) {
          startInputs.push(input);
          return {
            kind: "ready",
            packages: [
              {
                id: packageId,
                code: "demo",
                count: 3,
                priceUsdtMicros: 4_250_000n,
              },
            ],
          };
        },
      },
      packageSelection: {
        async select() {
          return { kind: "unavailable" };
        },
      },
      adminAccess: {
        async getRole() {
          return undefined;
        },
      },
    };

    const bot = createTelegramBot("123456:TEST_TOKEN", services, {
      botInfo: botInfo(),
      client: {
        fetch: mockFetch(calls),
      },
    });

    await bot.handleUpdate({
      update_id: 1,
      message: {
        message_id: 1,
        date: 1_700_000_000,
        chat: privateChat(),
        from: user(),
        text: "/start",
        entities: [
          {
            offset: 0,
            length: 6,
            type: "bot_command",
          },
        ],
      },
    });

    expect(startInputs).toEqual([
      {
        telegramUserId: 42n,
        username: "demo_user",
      },
    ]);
    expect(calls.some((url) => url.endsWith("/sendMessage"))).toBe(true);
  });

  it("rechecks access for historical package callbacks and answers denied", async () => {
    const calls: string[] = [];
    const selectionInputs: unknown[] = [];

    const services: TelegramBotServices = {
      start: {
        async execute() {
          return { kind: "blocked" };
        },
      },
      packageSelection: {
        async select(input) {
          selectionInputs.push(input);
          return { kind: "denied" };
        },
      },
      adminAccess: {
        async getRole() {
          return undefined;
        },
      },
    };

    const bot = createTelegramBot("123456:TEST_TOKEN", services, {
      botInfo: botInfo(),
      client: {
        fetch: mockFetch(calls),
      },
    });

    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: "callback-1",
        from: user(),
        chat_instance: "instance-1",
        data: `package:view:${packageId}`,
        message: {
          message_id: 10,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(selectionInputs).toEqual([
      {
        telegramUserId: 42n,
        packageId,
      },
    ]);
    expect(
      calls.some((url) => url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
  });
});
