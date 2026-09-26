import { describe, expect, it } from "vitest";

import type { TelegramBotServices } from "../src/adapters/telegram/create-bot.js";
import { createTelegramBot } from "../src/adapters/telegram/create-bot.js";

const recipient = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

function botInfo() {
  return {
    id: 900001,
    is_bot: true as const,
    first_name: "测试机器人",
    username: "energy_test_bot",
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
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    if (url.endsWith("/sendMessage") || url.endsWith("/editMessageText")) {
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

function services(overrides: Partial<TelegramBotServices>): TelegramBotServices {
  return {
    start: {
      async execute() {
        return { kind: "ready", packages: [] };
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
    ...overrides,
  };
}

describe("Telegram Energy adapter", () => {
  it("reports address-like invalid input through the validator", async () => {
    const calls: string[] = [];
    const prepareInputs: unknown[] = [];
    const bot = createTelegramBot(
      "123456:TEST_TOKEN",
      services({
        energyUsage: {
          async prepare(input) {
            prepareInputs.push(input);
            return { kind: "invalid_address" };
          },
          async execute() { return { kind: "option_unavailable" }; },
        },
      }),
      { botInfo: botInfo(), client: { fetch: mockFetch(calls) } },
    );

    const malformed = "T0" + recipient.slice(2);
    await bot.handleUpdate({
      update_id: 91,
      message: {
        message_id: 91,
        date: 1_700_000_000,
        chat: privateChat(),
        from: user(),
        text: malformed,
      },
    });

    expect(prepareInputs).toEqual([
      { telegramUserId: 42n, recipientAddress: malformed },
    ]);
    expect(calls.some((url) => url.endsWith("/sendMessage"))).toBe(true);
  });

  it("responds when a direct address arrives before a supplier is enabled", async () => {
    const calls: string[] = [];
    const bot = createTelegramBot(
      "123456:TEST_TOKEN",
      services({}),
      { botInfo: botInfo(), client: { fetch: mockFetch(calls) } },
    );

    await bot.handleUpdate({
      update_id: 92,
      message: {
        message_id: 92,
        date: 1_700_000_000,
        chat: privateChat(),
        from: user(),
        text: recipient,
      },
    });

    expect(calls.some((url) => url.endsWith("/sendMessage"))).toBe(true);
  });

  it("turns a valid TRON address into configured Energy options", async () => {
    const calls: string[] = [];
    const prepareInputs: unknown[] = [];
    const bot = createTelegramBot(
      "123456:TEST_TOKEN",
      services({
        energyUsage: {
          async prepare(input) {
            prepareInputs.push(input);
            return {
              kind: "ready",
              recipientAddress: recipient,
              availableCount: 10,
              reservedCount: 0,
              options: [
                {
                  id: "11111111-1111-4111-8111-111111111111",
                  code: "energy_65k",
                  energyAmount: 65_000n,
                  countCost: 1,
                },
              ],
            };
          },
          async execute() {
            return { kind: "option_unavailable" };
          },
        },
      }),
      {
        botInfo: botInfo(),
        client: { fetch: mockFetch(calls) },
      },
    );

    await bot.handleUpdate({
      update_id: 10,
      message: {
        message_id: 10,
        date: 1_700_000_000,
        chat: privateChat(),
        from: user(),
        text: recipient,
      },
    });

    expect(prepareInputs).toEqual([
      { telegramUserId: 42n, recipientAddress: recipient },
    ]);
    expect(calls.some((url) => url.endsWith("/sendMessage"))).toBe(true);
  });

  it("restores recent owned Energy orders and reopens their status", async () => {
    const calls: string[] = [];
    const listInputs: unknown[] = [];
    const statusInputs: unknown[] = [];
    const orderId = "22222222-2222-4222-8222-222222222229";
    const order = {
      id: orderId,
      userId: "33333333-3333-4333-8333-333333333339",
      optionCode: "energy_65k",
      recipientAddress: recipient,
      energyAmount: 65_000n,
      countCost: 1,
      status: "completed" as const,
      availableCount: 9,
      reservedCount: 0,
      delivery: {
        id: "44444444-4444-4444-8444-444444444449",
        idempotencyKey: `energy-delivery:${orderId}`,
        providerName: "fake-energy",
        providerOrderId: "provider-restore-1",
        status: "completed" as const,
      },
    };

    const bot = createTelegramBot(
      "123456:TEST_TOKEN",
      services({
        energyOrderQuery: {
          async listPage(input) {
            listInputs.push(input);
            return {
              kind: "ready",
              orders: [order],
              previousCursor: null,
              nextCursor: null,
            };
          },
          async get(input) {
            statusInputs.push(input);
            return { kind: "found", order };
          },
        },
      }),
      {
        botInfo: botInfo(),
        client: { fetch: mockFetch(calls) },
      },
    );

    await bot.handleUpdate({
      update_id: 13,
      callback_query: {
        id: "energy-orders-menu",
        from: user(),
        chat_instance: "instance-1",
        data: "menu:energy-orders",
        message: {
          message_id: 13,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(listInputs).toEqual([
      { telegramUserId: 42n, limit: 5 },
    ]);
    expect(calls.some((url) => url.endsWith("/editMessageText"))).toBe(true);

    await bot.handleUpdate({
      update_id: 14,
      callback_query: {
        id: "energy-restored-status",
        from: user(),
        chat_instance: "instance-1",
        data: `energy:status:${orderId}`,
        message: {
          message_id: 14,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(statusInputs).toEqual([
      { orderId, telegramUserId: 42n },
    ]);
    expect(calls.some((url) => url.endsWith("/editMessageText"))).toBe(true);
  });

  it("uses one Energy action identity across repeated button presses", async () => {
    const calls: string[] = [];
    const executeInputs: unknown[] = [];
    const orderId = "22222222-2222-4222-8222-222222222222";
    const bot = createTelegramBot(
      "123456:TEST_TOKEN",
      services({
        energyUsage: {
          async prepare() {
            return { kind: "invalid_address" };
          },
          async execute(input) {
            executeInputs.push(input);
            return {
              kind: "completed",
              order: {
                id: orderId,
                userId: "33333333-3333-4333-8333-333333333333",
                optionCode: "energy_65k",
                recipientAddress: recipient,
                energyAmount: 65_000n,
                countCost: 1,
                status: "completed",
                availableCount: 9,
                reservedCount: 0,
                delivery: {
                  id: "44444444-4444-4444-8444-444444444444",
                  idempotencyKey: `energy-delivery:${orderId}`,
                  providerName: "fake-energy",
                  providerOrderId: "provider-1",
                  status: "completed",
                },
              },
            };
          },
        },
      }),
      {
        botInfo: botInfo(),
        client: { fetch: mockFetch(calls) },
      },
    );

    await bot.handleUpdate({
      update_id: 11,
      callback_query: {
        id: "energy-callback-1",
        from: user(),
        chat_instance: "instance-1",
        data: `energy:go:energy_65k:${recipient}`,
        message: {
          message_id: 11,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    await bot.handleUpdate({
      update_id: 12,
      callback_query: {
        id: "energy-callback-2",
        from: user(),
        chat_instance: "instance-1",
        data: `energy:go:energy_65k:${recipient}`,
        message: {
          message_id: 11,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(executeInputs).toEqual([
      {
        telegramUserId: 42n,
        optionCode: "energy_65k",
        recipientAddress: recipient,
        idempotencyKey: "telegram:energy:42:42:11",
      },
      {
        telegramUserId: 42n,
        optionCode: "energy_65k",
        recipientAddress: recipient,
        idempotencyKey: "telegram:energy:42:42:11",
      },
    ]);
    expect(calls.some((url) => url.endsWith("/answerCallbackQuery"))).toBe(true);
    expect(calls.some((url) => url.endsWith("/editMessageText"))).toBe(true);
  });
});
