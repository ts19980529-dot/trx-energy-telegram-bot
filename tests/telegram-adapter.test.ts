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

    if (
      url.endsWith("/sendMessage") ||
      url.endsWith("/editMessageText")
    ) {
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

  it("acknowledges the package menu while its database query is pending", async () => {
    const calls: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const bot = createTelegramBot("123456:TEST_TOKEN", {
      start: {
        async execute() {
          entered();
          await pending;
          return { kind: "ready", packages: [] };
        },
      },
      packageSelection: {
        async select() { return { kind: "unavailable" }; },
      },
      adminAccess: {
        async getRole() { return undefined; },
      },
    }, { botInfo: botInfo(), client: { fetch: mockFetch(calls) } });

    const handling = bot.handleUpdate({
      update_id: 200,
      callback_query: {
        id: "callback-menu-pending",
        from: user(),
        chat_instance: "instance-1",
        data: "menu:packages",
        message: {
          message_id: 10,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    await started;
    expect(calls.some((url) => url.endsWith("/answerCallbackQuery"))).toBe(true);
    expect(calls.some((url) => url.endsWith("/sendMessage"))).toBe(false);
    release();
    await handling;
    expect(calls.some((url) => url.endsWith("/sendMessage"))).toBe(true);
  });

  it("acknowledges package selection while its database query is pending", async () => {
    const calls: string[] = [];
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const bot = createTelegramBot("123456:TEST_TOKEN", {
      start: {
        async execute() { return { kind: "ready", packages: [] }; },
      },
      packageSelection: {
        async select() {
          entered();
          await pending;
          return { kind: "unavailable" };
        },
      },
      adminAccess: {
        async getRole() { return undefined; },
      },
    }, { botInfo: botInfo(), client: { fetch: mockFetch(calls) } });

    const handling = bot.handleUpdate({
      update_id: 201,
      callback_query: {
        id: "callback-package-pending",
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

    await started;
    expect(calls.some((url) => url.endsWith("/answerCallbackQuery"))).toBe(true);
    expect(calls.some((url) => url.endsWith("/sendMessage"))).toBe(false);
    release();
    await handling;
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

  it("creates a USDT purchase order from the payment callback using callback identity for idempotency", async () => {
    const calls: string[] = [];
    const purchaseInputs: unknown[] = [];

    const services: TelegramBotServices = {
      start: {
        async execute() {
          return { kind: "blocked" };
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
      purchaseOrderCreation: {
        async create(input) {
          purchaseInputs.push(input);

          return {
            kind: "ready",
            created: true,
            order: {
              id: "22222222-2222-4222-8222-222222222222",
              userId: "33333333-3333-4333-8333-333333333333",
              packageId,
              idempotencyKey:
                "telegram:purchase:callback-payment-1",
              status: "waiting_payment",
              payment: {
                packageCodeSnapshot: "demo",
                countSnapshot: 3,
                priceUsdtMicrosSnapshot: 4_250_000n,
                paymentAttributionOffsetAtomic: 137n,
                paymentAsset: "USDT",
                paymentToAddressSnapshot: "TTEST_DESTINATION",
                paymentTokenContractAddressSnapshot:
                  "TTEST_USDT_CONTRACT",
                requiredConfirmationsSnapshot: 2,
                quotedAmountAtomic: 4_250_137n,
                quoteExpiresAt: null,
              },
              expectation: {
                asset: "USDT",
                tokenContractAddress: "TTEST_USDT_CONTRACT",
                toAddress: "TTEST_DESTINATION",
                amountAtomic: 4_250_137n,
                requiredConfirmations: 2,
              },
            },
          };
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
      update_id: 3,
      callback_query: {
        id: "callback-payment-1",
        from: user(),
        chat_instance: "instance-1",
        data: `package:pay:USDT:${packageId}`,
        message: {
          message_id: 11,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(purchaseInputs).toHaveLength(1);
    expect(purchaseInputs[0]).toMatchObject({
      telegramUserId: 42n,
      packageId,
      asset: "USDT",
      idempotencyKey:
        "telegram:purchase:callback-payment-1",
      requestedAt: expect.any(Date),
    });
    expect(
      calls.some((url) => url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(calls.some((url) => url.endsWith("/sendMessage"))).toBe(true);
  });

  it("refreshes an owned purchase order status using numeric Telegram identity", async () => {
    const calls: string[] = [];
    const statusInputs: unknown[] = [];
    const orderId = "22222222-2222-4222-8222-222222222222";

    const services: TelegramBotServices = {
      start: {
        async execute() {
          return { kind: "blocked" };
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
      purchaseOrderStatus: {
        async get(input) {
          statusInputs.push(input);
          return {
            kind: "found",
            order: {
              id: orderId,
              status: "credited",
              payment: {
                packageCodeSnapshot: "demo",
                countSnapshot: 10,
                priceUsdtMicrosSnapshot: 17_000_000n,
                paymentAttributionOffsetAtomic: 137n,
                paymentAsset: "USDT",
                paymentToAddressSnapshot: "TTEST_DESTINATION",
                paymentTokenContractAddressSnapshot:
                  "TTEST_USDT_CONTRACT",
                requiredConfirmationsSnapshot: 2,
                quotedAmountAtomic: 17_000_137n,
                quoteExpiresAt: null,
              },
              availableCount: 10,
              updatedAt: new Date(
                "2026-09-22T03:00:00.000Z",
              ),
            },
          };
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
      update_id: 4,
      callback_query: {
        id: "callback-status-1",
        from: user(),
        chat_instance: "instance-1",
        data: `order:status:${orderId}`,
        message: {
          message_id: 12,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(statusInputs).toEqual([
      {
        orderId,
        telegramUserId: 42n,
      },
    ]);
    expect(
      calls.some((url) => url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(
      calls.some((url) => url.endsWith("/editMessageText")),
    ).toBe(true);
  });

});
