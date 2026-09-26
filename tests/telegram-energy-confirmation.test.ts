import { describe, expect, it } from "vitest";

import {
  buildEnergyOptionKeyboard,
  energyConfirmCallbackData,
  energyExecuteCallbackData,
  energyUseCallbackData,
} from "../src/adapters/telegram/energy-menu.js";
import { createTelegramBot } from "../src/adapters/telegram/create-bot.js";

const recipientAddress = "T" + "A".repeat(33);

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

function mockFetch(
  requests: Array<{ url: string; body: Record<string, unknown> | null }>,
): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    let body: Record<string, unknown> | null = null;
    if (typeof init?.body === "string" && init.body.length > 0) {
      body = JSON.parse(init.body) as Record<string, unknown>;
    }
    requests.push({ url, body });

    if (url.endsWith("/answerCallbackQuery")) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
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

function baseServices(overrides: {
  prepare?: (...args: any[]) => Promise<any>;
  execute?: (...args: any[]) => Promise<any>;
}) {
  return {
    start: {
      async execute() {
        return { kind: "ready" as const, packages: [] };
      },
    },
    packageSelection: {
      async select() {
        return { kind: "unavailable" as const };
      },
    },
    adminAccess: {
      async getRole() {
        return undefined;
      },
    },
    energyUsage: {
      prepare:
        overrides.prepare ??
        (async () => ({
          kind: "ready" as const,
          recipientAddress,
          availableCount: 3,
          reservedCount: 0,
          options: [
            {
              id: "11111111-1111-4111-8111-111111111111",
              code: "E65",
              energyAmount: 65_000n,
              countCost: 1,
            },
          ],
        })),
      execute:
        overrides.execute ??
        (async () => ({
          kind: "insufficient_balance" as const,
          availableCount: 0,
          requiredCount: 1,
        })),
      async getStatus() {
        return { kind: "not_found" as const };
      },
    },
  };
}

describe("Telegram Energy confirmation flow", () => {
  it("keeps confirmation and execution callback payloads within Telegram's 64-byte limit", () => {
    const optionCode = "A".repeat(16);

    expect(
      Buffer.byteLength(
        energyConfirmCallbackData(optionCode, recipientAddress),
        "utf8",
      ),
    ).toBeLessThanOrEqual(64);

    expect(
      Buffer.byteLength(
        energyExecuteCallbackData(optionCode, recipientAddress),
        "utf8",
      ),
    ).toBeLessThanOrEqual(64);
  });

  it("renders Energy options as confirmation actions, not direct execution actions", () => {
    const keyboard = buildEnergyOptionKeyboard(
      [
        {
          id: "11111111-1111-4111-8111-111111111111",
          code: "E65",
          energyAmount: 65_000n,
          countCost: 1,
        },
      ],
      recipientAddress,
    );

    const button = keyboard.inline_keyboard[0]?.[0];
    expect(button && "callback_data" in button ? button.callback_data : undefined)
      .toBe(energyConfirmCallbackData("E65", recipientAddress));
  });

  it("revalidates the address and option before showing confirmation without executing", async () => {
    const requests: Array<{
      url: string;
      body: Record<string, unknown> | null;
    }> = [];
    const prepareInputs: unknown[] = [];
    const executeInputs: unknown[] = [];

    const bot = createTelegramBot(
      "123456:TEST_TOKEN",
      baseServices({
        prepare: async (input) => {
          prepareInputs.push(input);
          return {
            kind: "ready" as const,
            recipientAddress,
            availableCount: 3,
            reservedCount: 0,
            options: [
              {
                id: "11111111-1111-4111-8111-111111111111",
                code: "E65",
                energyAmount: 65_000n,
                countCost: 1,
              },
            ],
          };
        },
        execute: async (input) => {
          executeInputs.push(input);
          return {
            kind: "insufficient_balance" as const,
            availableCount: 0,
            requiredCount: 1,
          };
        },
      }),
      { botInfo: botInfo(), client: { fetch: mockFetch(requests) } },
    );

    await bot.handleUpdate({
      update_id: 501,
      callback_query: {
        id: "energy-confirm",
        from: user(),
        chat_instance: "instance-energy",
        data: energyConfirmCallbackData("E65", recipientAddress),
        message: {
          message_id: 50,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(prepareInputs).toEqual([
      {
        telegramUserId: 42n,
        recipientAddress,
      },
    ]);
    expect(executeInputs).toEqual([]);

    const rendered = requests.find((request) =>
      request.url.endsWith("/editMessageText"),
    );
    expect(rendered?.body?.text).toContain("确认使用能量");

    const replyMarkup = rendered?.body?.reply_markup as
      | { inline_keyboard?: Array<Array<{ callback_data?: string }>> }
      | undefined;
    expect(replyMarkup?.inline_keyboard?.[0]?.[0]?.callback_data)
      .toBe(energyExecuteCallbackData("E65", recipientAddress));
  });

  it("executes only after explicit confirmation and keeps repeated presses idempotent", async () => {
    const requests: Array<{
      url: string;
      body: Record<string, unknown> | null;
    }> = [];
    const executeInputs: unknown[] = [];

    const bot = createTelegramBot(
      "123456:TEST_TOKEN",
      baseServices({
        execute: async (input) => {
          executeInputs.push(input);
          return {
            kind: "insufficient_balance" as const,
            availableCount: 0,
            requiredCount: 1,
          };
        },
      }),
      { botInfo: botInfo(), client: { fetch: mockFetch(requests) } },
    );

    const update = {
      callback_query: {
        from: user(),
        chat_instance: "instance-energy",
        data: energyExecuteCallbackData("E65", recipientAddress),
        message: {
          message_id: 51,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    };

    await bot.handleUpdate({
      update_id: 502,
      callback_query: {
        ...update.callback_query,
        id: "energy-execute-1",
      },
    });
    await bot.handleUpdate({
      update_id: 503,
      callback_query: {
        ...update.callback_query,
        id: "energy-execute-2",
      },
    });

    expect(executeInputs).toHaveLength(2);
    expect(executeInputs[0]).toMatchObject({
      telegramUserId: 42n,
      optionCode: "E65",
      recipientAddress,
      idempotencyKey: "telegram:energy:42:42:51",
    });
    expect(executeInputs[1]).toMatchObject({
      idempotencyKey: "telegram:energy:42:42:51",
    });
  });

  it("keeps Energy preparation visible before a delivery provider is activated and fails closed at execution", async () => {
    const requests: Array<{
      url: string;
      body: Record<string, unknown> | null;
    }> = [];
    const prepareInputs: unknown[] = [];

    const bot = createTelegramBot(
      "123456:TEST_TOKEN",
      {
        start: {
          async execute() {
            return { kind: "ready" as const, packages: [] };
          },
        },
        packageSelection: {
          async select() {
            return { kind: "unavailable" as const };
          },
        },
        adminAccess: {
          async getRole() {
            return undefined;
          },
        },
        energyPreparation: {
          async prepare(input) {
            prepareInputs.push(input);
            return {
              kind: "ready" as const,
              recipientAddress,
              availableCount: 3,
              reservedCount: 0,
              options: [
                {
                  id: "11111111-1111-4111-8111-111111111111",
                  code: "E65",
                  energyAmount: 65_000n,
                  countCost: 1,
                },
              ],
            };
          },
        },
      },
      { botInfo: botInfo(), client: { fetch: mockFetch(requests) } },
    );

    await bot.handleUpdate({
      update_id: 505,
      message: {
        message_id: 53,
        date: 1_700_000_000,
        chat: privateChat(),
        from: user(),
        text: "/start",
        entities: [{ offset: 0, length: 6, type: "bot_command" }],
      },
    });

    const home = requests.find((request) =>
      request.url.endsWith("/sendMessage"),
    );
    expect(home?.body?.reply_markup).toBeDefined();
    expect(JSON.stringify(home?.body?.reply_markup)).toContain("使用能量");

    requests.length = 0;
    await bot.handleUpdate({
      update_id: 506,
      callback_query: {
        id: "energy-preparation-only",
        from: user(),
        chat_instance: "instance-energy",
        data: energyConfirmCallbackData("E65", recipientAddress),
        message: {
          message_id: 54,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(prepareInputs).toEqual([
      {
        telegramUserId: 42n,
        recipientAddress,
      },
    ]);
    const confirmation = requests.find((request) =>
      request.url.endsWith("/editMessageText"),
    );
    expect(confirmation?.body?.text).toContain("确认使用能量");

    requests.length = 0;
    await bot.handleUpdate({
      update_id: 507,
      callback_query: {
        id: "energy-execution-without-provider",
        from: user(),
        chat_instance: "instance-energy",
        data: energyExecuteCallbackData("E65", recipientAddress),
        message: {
          message_id: 54,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    const blockedExecution = requests.find((request) =>
      request.url.endsWith("/answerCallbackQuery"),
    );
    expect(blockedExecution?.body?.text).toContain("能量投递暂不可用");
    expect(blockedExecution?.body?.text).toContain("不会扣除笔数");
    expect(
      requests.some((request) =>
        request.url.endsWith("/sendMessage") ||
        request.url.endsWith("/editMessageText"),
      ),
    ).toBe(false);
  });

  it("does not let historical direct-use buttons bypass confirmation", async () => {
    const requests: Array<{
      url: string;
      body: Record<string, unknown> | null;
    }> = [];
    const executeInputs: unknown[] = [];

    const bot = createTelegramBot(
      "123456:TEST_TOKEN",
      baseServices({
        execute: async (input) => {
          executeInputs.push(input);
          return {
            kind: "insufficient_balance" as const,
            availableCount: 0,
            requiredCount: 1,
          };
        },
      }),
      { botInfo: botInfo(), client: { fetch: mockFetch(requests) } },
    );

    await bot.handleUpdate({
      update_id: 504,
      callback_query: {
        id: "legacy-energy-use",
        from: user(),
        chat_instance: "instance-energy",
        data: energyUseCallbackData("E65", recipientAddress),
        message: {
          message_id: 52,
          date: 1_700_000_000,
          chat: privateChat(),
        },
      },
    });

    expect(executeInputs).toEqual([]);
    const answered = requests.find((request) =>
      request.url.endsWith("/answerCallbackQuery"),
    );
    expect(answered?.body?.text).toContain("已更新");
  });
});
