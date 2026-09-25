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

  it("hides unavailable actions from /start and shows read-only package entry", async () => {
    const bodies: string[] = [];
    const bot = createTelegramBot("123456:TEST_TOKEN", {
      start: { async execute() { return { kind: "ready", packages: [{ id: packageId, code: "demo", count: 10, priceUsdtMicros: 17_000_000n }] }; } },
      packageSelection: { async select() { return { kind: "unavailable" }; } },
      adminAccess: { async getRole() { return undefined; } },
    }, { botInfo: botInfo(), client: { fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.endsWith("/sendMessage")) bodies.push(String(init?.body ?? ""));
      return mockFetch([])(input, init);
    } } });
    await bot.handleUpdate({ update_id: 101, message: {
      message_id: 101, date: 1_700_000_000, chat: privateChat(), from: user(),
      text: "/start", entities: [{ offset: 0, length: 6, type: "bot_command" }],
    } });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("能量使用暂未开放");
    expect(bodies[0]).toContain("查看笔数套餐");
    expect(bodies[0]).not.toContain("使用能量");
  });

  it("uses purchase wording when purchase ordering is enabled", async () => {
    const bodies: string[] = [];
    const underlyingFetch = mockFetch([]);
    const bot = createTelegramBot("123456:TEST_TOKEN", {
      start: {
        async execute() {
          return {
            kind: "ready",
            packages: [
              {
                id: packageId,
                code: "demo",
                count: 10,
                priceUsdtMicros: 17_000_000n,
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
      purchaseOrderCreation: {
        async create() {
          return { kind: "invalid_request" };
        },
      },
    }, {
      botInfo: botInfo(),
      client: {
        fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

          if (url.endsWith("/sendMessage")) {
            bodies.push(String(init?.body ?? ""));
          }

          return underlyingFetch(input, init);
        },
      },
    });

    await bot.handleUpdate({
      update_id: 102,
      message: {
        message_id: 102,
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

    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("当前可购买笔数套餐");
    expect(bodies[0]).toContain("购买笔数");
    expect(bodies[0]).not.toContain("查看笔数套餐");
  });

  it("degrades purchase menus to read-only when payment reconciliation is unhealthy", async () => {
    const bodies: string[] = [];
    const underlyingFetch = mockFetch([]);
    const bot = createTelegramBot("123456:TEST_TOKEN", {
      start: {
        async execute() {
          return {
            kind: "ready",
            packages: [
              {
                id: packageId,
                code: "demo",
                count: 10,
                priceUsdtMicros: 17_000_000n,
              },
            ],
          };
        },
      },
      packageSelection: {
        async select() {
          return {
            kind: "ready",
            package: {
              id: packageId,
              code: "demo",
              count: 10,
              priceUsdtMicros: 17_000_000n,
            },
          };
        },
      },
      adminAccess: { async getRole() { return undefined; } },
      purchaseOrderCreation: {
        isAvailable: () => false,
        async create() {
          return { kind: "service_unavailable" };
        },
      },
    }, {
      botInfo: botInfo(),
      client: {
        fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
          if (url.endsWith("/sendMessage")) {
            bodies.push(String(init?.body ?? ""));
          }
          return underlyingFetch(input, init);
        },
      },
    });

    await bot.handleUpdate({
      update_id: 104,
      message: {
        message_id: 104,
        date: 1_700_000_000,
        chat: privateChat(),
        from: user(),
        text: "/start",
        entities: [{ offset: 0, length: 6, type: "bot_command" }],
      },
    });

    expect(bodies[0]).toContain("当前可查看笔数套餐");
    expect(bodies[0]).toContain("查看笔数套餐");
    expect(bodies[0]).not.toContain("购买笔数");

    await bot.handleUpdate({
      update_id: 105,
      callback_query: {
        id: "readonly-package",
        from: user(),
        chat_instance: "instance-1",
        data: `package:view:${packageId}`,
        message: {
          message_id: 105,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(bodies.at(-1)).toContain("支付功能暂未开放");
    expect(bodies.at(-1)).not.toContain("package:pay:");
  });

  it("answers stale private callback data instead of leaving the client loading", async () => {
    const calls: string[] = [];
    const callbackBodies: string[] = [];
    const underlyingFetch = mockFetch(calls);
    const bot = createTelegramBot("123456:TEST_TOKEN", {
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
    }, {
      botInfo: botInfo(),
      client: {
        fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;

          if (url.endsWith("/answerCallbackQuery")) {
            callbackBodies.push(String(init?.body ?? ""));
          }

          return underlyingFetch(input, init);
        },
      },
    });

    await bot.handleUpdate({
      update_id: 103,
      callback_query: {
        id: "stale-callback",
        from: user(),
        chat_instance: "instance-1",
        data: "legacy:unknown-action",
        message: {
          message_id: 103,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(calls.filter((url) => url.endsWith("/answerCallbackQuery"))).toHaveLength(1);
    expect(callbackBodies).toHaveLength(1);
    expect(callbackBodies[0]).toContain("操作已失效");
    expect(calls.some((url) => url.endsWith("/sendMessage"))).toBe(false);
  });

  it("rejects group callbacks before creating a purchase order", async () => {
    const calls: string[] = [];
    const purchaseInputs: unknown[] = [];
    const bot = createTelegramBot("123456:TEST_TOKEN", {
      start: { async execute() { return { kind: "ready", packages: [] }; } },
      packageSelection: { async select() { return { kind: "unavailable" }; } },
      adminAccess: { async getRole() { return undefined; } },
      purchaseOrderCreation: { async create(input) { purchaseInputs.push(input); throw new Error("must not create"); } },
    }, { botInfo: botInfo(), client: { fetch: mockFetch(calls) } });
    await bot.handleUpdate({ update_id: 102, callback_query: {
      id: "group-payment", from: user(), chat_instance: "group-instance",
      data: `package:pay:USDT:${packageId}`,
      message: { message_id: 102, date: 1_700_000_000, chat: { id: -1001, type: "supergroup", title: "测试群" } },
    } });
    expect(purchaseInputs).toEqual([]);
    expect(calls.filter((url) => url.endsWith("/answerCallbackQuery"))).toHaveLength(1);
    expect(calls.some((url) => url.endsWith("/sendMessage"))).toBe(false);
  });

  it("responds to unrecognized private text with a menu hint", async () => {
    const calls: string[] = [];
    const bot = createTelegramBot("123456:TEST_TOKEN", {
      start: { async execute() { return { kind: "ready", packages: [] }; } },
      packageSelection: { async select() { return { kind: "unavailable" }; } },
      adminAccess: { async getRole() { return undefined; } },
    }, { botInfo: botInfo(), client: { fetch: mockFetch(calls) } });
    await bot.handleUpdate({ update_id: 103, message: {
      message_id: 103, date: 1_700_000_000, chat: privateChat(), from: user(),
      text: "不是地址",
    } });
    expect(calls.filter((url) => url.endsWith("/sendMessage"))).toHaveLength(1);
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

  it("uses one purchase action identity across repeated button presses", async () => {
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
                "telegram:purchase:42:42:11",
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

    await bot.handleUpdate({
      update_id: 4,
      callback_query: {
        id: "callback-payment-2",
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

    expect(purchaseInputs).toHaveLength(2);
    expect(purchaseInputs[1]).toMatchObject({
      telegramUserId: 42n,
      packageId,
      asset: "USDT",
      idempotencyKey: "telegram:purchase:42:42:11",
      requestedAt: expect.any(Date),
    });
    expect(purchaseInputs[0]).toMatchObject({
      telegramUserId: 42n,
      packageId,
      asset: "USDT",
      idempotencyKey:
        "telegram:purchase:42:42:11",
      requestedAt: expect.any(Date),
    });
    expect(
      calls.some((url) => url.endsWith("/answerCallbackQuery")),
    ).toBe(true);
    expect(calls.some((url) => url.endsWith("/sendMessage"))).toBe(true);
  });

  it("fails closed for new purchases when the payment runtime is unavailable", async () => {
    const calls: string[] = [];
    const sentBodies: string[] = [];
    const underlyingFetch = mockFetch(calls);
    const bot = createTelegramBot("123456:TEST_TOKEN", {
      start: { async execute() { return { kind: "ready", packages: [] }; } },
      packageSelection: {
        async select() { return { kind: "unavailable" }; },
      },
      adminAccess: { async getRole() { return undefined; } },
      purchaseOrderCreation: {
        async create() {
          return { kind: "service_unavailable" };
        },
      },
    }, {
      botInfo: botInfo(),
      client: {
        fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
          if (url.endsWith("/sendMessage")) {
            sentBodies.push(String(init?.body ?? ""));
          }
          return underlyingFetch(input, init);
        },
      },
    });

    await bot.handleUpdate({
      update_id: 300,
      callback_query: {
        id: "callback-payment-unavailable",
        from: user(),
        chat_instance: "instance-1",
        data: `package:pay:USDT:${packageId}`,
        message: {
          message_id: 30,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(calls.some((url) => url.endsWith("/answerCallbackQuery"))).toBe(true);
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toContain("暂时不会创建新的支付订单");
    expect(sentBodies[0]).toContain("已有订单仍可查询状态");
  });

  it("gives a safe response when purchase processing fails after acknowledging a callback", async () => {
    const calls: string[] = [];
    const sentBodies: string[] = [];
    const underlyingFetch = mockFetch(calls);
    const bot = createTelegramBot("123456:TEST_TOKEN", {
      start: { async execute() { return { kind: "blocked" }; } },
      packageSelection: {
        async select() { return { kind: "unavailable" }; },
      },
      adminAccess: { async getRole() { return undefined; } },
      purchaseOrderCreation: {
        async create() {
          throw new Error("internal database detail");
        },
      },
    }, {
      botInfo: botInfo(),
      client: {
        fetch: async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = typeof input === "string"
            ? input
            : input instanceof URL
              ? input.toString()
              : input.url;
          if (url.endsWith("/sendMessage")) {
            sentBodies.push(String(init?.body ?? ""));
          }
          return underlyingFetch(input, init);
        },
      },
    });

    await bot.handleUpdate({
      update_id: 301,
      callback_query: {
        id: "callback-payment-failure",
        from: user(),
        chat_instance: "instance-1",
        data: `package:pay:USDT:${packageId}`,
        message: {
          message_id: 31,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(calls.some((url) => url.endsWith("/answerCallbackQuery"))).toBe(true);
    expect(sentBodies).toHaveLength(1);
    expect(sentBodies[0]).toContain("请先查询订单状态");
    expect(sentBodies[0]).not.toContain("internal database detail");
  });

  it("restores recent purchase orders even when new payment ordering is disabled", async () => {
    const calls: string[] = [];
    const listInputs: unknown[] = [];
    const getInputs: unknown[] = [];
    const orderId = "22222222-2222-4222-8222-222222222229";
    const order = {
      id: orderId,
      status: "waiting_payment" as const,
      payment: {
        packageCodeSnapshot: "demo",
        countSnapshot: 10,
        priceUsdtMicrosSnapshot: 17_000_000n,
        paymentAttributionOffsetAtomic: 137n,
        paymentAsset: "USDT" as const,
        paymentToAddressSnapshot: "TTEST_DESTINATION",
        paymentTokenContractAddressSnapshot:
          "TTEST_USDT_CONTRACT",
        requiredConfirmationsSnapshot: 2,
        quotedAmountAtomic: 17_000_137n,
        quoteExpiresAt: new Date("2026-09-22T03:30:00.000Z"),
      },
      availableCount: 7,
      updatedAt: new Date("2026-09-22T03:00:00.000Z"),
    };

    const bot = createTelegramBot("123456:TEST_TOKEN", {
      start: { async execute() { return { kind: "ready", packages: [] }; } },
      packageSelection: {
        async select() { return { kind: "unavailable" }; },
      },
      adminAccess: { async getRole() { return undefined; } },
      purchaseOrderStatus: {
        async listRecent(input) {
          listInputs.push(input);
          return { kind: "ready", orders: [order] };
        },
        async get(input) {
          getInputs.push(input);
          return { kind: "found", order };
        },
      },
    }, {
      botInfo: botInfo(),
      client: { fetch: mockFetch(calls) },
    });

    await bot.handleUpdate({
      update_id: 302,
      callback_query: {
        id: "purchase-orders-menu",
        from: user(),
        chat_instance: "instance-1",
        data: "menu:purchase-orders",
        message: {
          message_id: 32,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(listInputs).toEqual([
      { telegramUserId: 42n, limit: 5 },
    ]);
    expect(calls.some((url) => url.endsWith("/sendMessage"))).toBe(true);

    await bot.handleUpdate({
      update_id: 303,
      callback_query: {
        id: "purchase-restored-status",
        from: user(),
        chat_instance: "instance-1",
        data: `order:status:${orderId}`,
        message: {
          message_id: 33,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(getInputs).toEqual([
      { orderId, telegramUserId: 42n },
    ]);
    expect(calls.some((url) => url.endsWith("/editMessageText"))).toBe(true);
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
