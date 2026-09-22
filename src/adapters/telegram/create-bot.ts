import {
  Bot,
  Context,
  GrammyError,
  HttpError,
  type BotConfig,
} from "grammy";

import type { PurchaseOrderCreationService } from "../../application/payments/purchase-order-service.js";
import type { AdminAccessService } from "../../application/telegram/admin-access-service.js";
import type { PackageSelectionService } from "../../application/telegram/package-selection-service.js";
import type { TelegramStartService } from "../../application/telegram/start-service.js";
import {
  adminRoleLabel,
  buildPackageKeyboard,
  buildPaymentMethodKeyboard,
  formatPurchaseOrderInstructions,
  formatUsdtMicros,
  parsePackageCallbackData,
  parsePackagePaymentCallbackData,
} from "./package-menu.js";

export const telegramAllowedUpdates = [
  "message",
  "callback_query",
] as const;

export interface TelegramBotServices {
  readonly start: Pick<TelegramStartService, "execute">;
  readonly packageSelection: Pick<PackageSelectionService, "select">;
  readonly adminAccess: Pick<AdminAccessService, "getRole">;
  readonly purchaseOrderCreation?: Pick<
    PurchaseOrderCreationService,
    "create"
  >;
}

export function createTelegramBot(
  token: string,
  services: TelegramBotServices,
  config?: BotConfig<Context>,
): Bot {
  const bot = new Bot(token, config);

  bot.command("start", async (ctx) => {
    if (ctx.from === undefined) {
      return;
    }

    const result = await services.start.execute({
      telegramUserId: BigInt(ctx.from.id),
      username: ctx.from.username ?? null,
    });

    if (result.kind === "blocked") {
      await ctx.reply("账号当前不可用。");
      return;
    }

    if (result.packages.length === 0) {
      await ctx.reply("当前暂无可用套餐。");
      return;
    }

    await ctx.reply("请选择能量套餐：", {
      reply_markup: buildPackageKeyboard(result.packages),
    });
  });

  bot.callbackQuery(/^package:view:/, async (ctx) => {
    const packageId = parsePackageCallbackData(ctx.callbackQuery.data);

    if (packageId === undefined) {
      await ctx.answerCallbackQuery({
        text: "无效操作。",
        show_alert: true,
      });
      return;
    }

    const result = await services.packageSelection.select({
      telegramUserId: BigInt(ctx.from.id),
      packageId,
    });

    if (result.kind === "denied") {
      await ctx.answerCallbackQuery({
        text: "账号当前不可用。",
        show_alert: true,
      });
      return;
    }

    if (result.kind === "unavailable") {
      await ctx.answerCallbackQuery({
        text: "套餐已下架或不存在。",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    await ctx.reply(
      [
        "套餐详情",
        "",
        `笔数：${result.package.count} 笔`,
        `价格：${formatUsdtMicros(result.package.priceUsdtMicros)} USDT`,
        "",
        "请选择支付方式：",
      ].join("\n"),
      {
        reply_markup: buildPaymentMethodKeyboard(result.package.id),
      },
    );
  });

  bot.callbackQuery(/^package:pay:/, async (ctx) => {
    const selection = parsePackagePaymentCallbackData(
      ctx.callbackQuery.data,
    );

    if (selection === undefined) {
      await ctx.answerCallbackQuery({
        text: "无效支付操作。",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    if (services.purchaseOrderCreation === undefined) {
      await ctx.reply("当前支付功能尚未启用。");
      return;
    }

    const result = await services.purchaseOrderCreation.create({
      telegramUserId: BigInt(ctx.from.id),
      packageId: selection.packageId,
      asset: selection.asset,
      idempotencyKey: `telegram:purchase:${ctx.callbackQuery.id}`,
      requestedAt: new Date(),
    });

    switch (result.kind) {
      case "ready":
        await ctx.reply(formatPurchaseOrderInstructions(result.order));
        return;
      case "denied":
        await ctx.reply("账号当前不可用。");
        return;
      case "package_unavailable":
        await ctx.reply("套餐已下架或不存在。");
        return;
      case "unsupported_asset":
        await ctx.reply(`${result.asset} 支付尚未启用。`);
        return;
      case "quote_unavailable":
        await ctx.reply("当前无法获取支付报价，请稍后重试。");
        return;
      case "payment_attribution_unavailable":
        await ctx.reply(
          "当前 USDT 支付通道暂不可用，请稍后重试或联系客服。",
        );
        return;
      case "idempotency_conflict":
        await ctx.reply("本次支付操作状态冲突，请返回套餐重新发起。");
        return;
      case "invalid_request":
        await ctx.reply("支付请求无效，请返回套餐重新选择。");
        return;
    }
  });

  bot.command("admin", async (ctx) => {
    if (ctx.from === undefined) {
      return;
    }

    const role = await services.adminAccess.getRole(BigInt(ctx.from.id));

    if (role === undefined) {
      await ctx.reply("无权限。");
      return;
    }

    await ctx.reply(`当前权限：${adminRoleLabel(role)}`);
  });

  bot.catch((err) => {
    const updateId = err.ctx.update.update_id;
    const error = err.error;

    if (error instanceof GrammyError) {
      console.error(
        `Telegram API error; update_id=${updateId}; code=${error.error_code}`,
      );
      return;
    }

    if (error instanceof HttpError) {
      console.error(`Telegram transport error; update_id=${updateId}`);
      return;
    }

    console.error(`Telegram handler error; update_id=${updateId}`);
  });

  return bot;
}

export async function assertLongPollingAvailable(bot: Bot): Promise<void> {
  const webhookInfo = await bot.api.getWebhookInfo();

  if (webhookInfo.url !== "") {
    throw new Error(
      "Telegram webhook is configured; long polling startup refused",
    );
  }
}
