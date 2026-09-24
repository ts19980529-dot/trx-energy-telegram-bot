import {
  Bot,
  Context,
  GrammyError,
  HttpError,
  type BotConfig,
} from "grammy";

import type { EnergyUsageService } from "../../application/energy/energy-usage-service.js";
import type { PurchaseOrderCreationService } from "../../application/payments/purchase-order-service.js";
import type { PurchaseOrderStatusService } from "../../application/payments/purchase-order-status-service.js";
import type { AdminAccessService } from "../../application/telegram/admin-access-service.js";
import type { PackageSelectionService } from "../../application/telegram/package-selection-service.js";
import type { TelegramStartService } from "../../application/telegram/start-service.js";
import {
  buildEnergyOptionKeyboard,
  buildEnergyStatusKeyboard,
  buildMainMenuKeyboard,
  formatEnergyOrder,
  isEnergyMenuCallback,
  isPackageMenuCallback,
  parseEnergyStatusCallbackData,
  parseEnergyUseCallbackData,
} from "./energy-menu.js";
import {
  adminRoleLabel,
  buildOrderStatusKeyboard,
  buildPackageKeyboard,
  buildPaymentMethodKeyboard,
  formatPurchaseOrderInstructions,
  formatPurchaseOrderStatus,
  formatUsdtMicros,
  parseOrderStatusCallbackData,
  parsePackageCallbackData,
  parsePackagePaymentCallbackData,
  purchaseOrderStatusIsTerminal,
} from "./package-menu.js";

export const telegramAllowedUpdates = [
  "message",
  "callback_query",
] as const;

export interface TelegramBotServices {
  readonly start: Pick<TelegramStartService, "execute">;
  readonly packageSelection: Pick<PackageSelectionService, "select">;
  readonly adminAccess: Pick<AdminAccessService, "getRole">;
  readonly energyUsage?: Pick<EnergyUsageService, "prepare" | "execute" | "getStatus">;
  readonly purchaseOrderCreation?: Pick<
    PurchaseOrderCreationService,
    "create"
  >;
  readonly purchaseOrderStatus?: Pick<
    PurchaseOrderStatusService,
    "get"
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

    await ctx.reply("请选择服务：", {
      reply_markup: buildMainMenuKeyboard(),
    });
  });

  bot.callbackQuery("menu:packages", async (ctx) => {
    if (!isPackageMenuCallback(ctx.callbackQuery.data)) {
      return;
    }

    await ctx.answerCallbackQuery();

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

    await ctx.reply("请选择笔数套餐：", {
      reply_markup: buildPackageKeyboard(result.packages),
    });
  });

  bot.callbackQuery("menu:energy", async (ctx) => {
    if (!isEnergyMenuCallback(ctx.callbackQuery.data)) {
      return;
    }

    await ctx.answerCallbackQuery();

    if (services.energyUsage === undefined) {
      await ctx.reply("当前能量服务尚未启用。");
      return;
    }

    await ctx.reply("请发送需要接收能量的 TRON 地址。");
  });

  bot.hears(/^(?:T\S{20,50}|41[0-9A-Za-z]{20,70})$/, async (ctx) => {
    if (ctx.from === undefined) {
      return;
    }

    if (services.energyUsage === undefined) {
      await ctx.reply("当前能量服务尚未启用。");
      return;
    }

    const recipientAddress = ctx.message?.text;

    if (recipientAddress === undefined) {
      return;
    }

    const result = await services.energyUsage.prepare({
      telegramUserId: BigInt(ctx.from.id),
      recipientAddress,
    });

    switch (result.kind) {
      case "denied":
        await ctx.reply("账号当前不可用。");
        return;
      case "invalid_address":
        await ctx.reply("TRON 地址无效，请重新发送。");
        return;
      case "ready":
        if (result.options.length === 0) {
          await ctx.reply("当前暂无可用能量规格。");
          return;
        }

        await ctx.reply(
          [
            "请选择能量规格：",
            "",
            `接收地址：${result.recipientAddress}`,
            `可用笔数：${result.availableCount} 笔`,
            `预留笔数：${result.reservedCount} 笔`,
          ].join("\n"),
          {
            reply_markup: buildEnergyOptionKeyboard(
              result.options,
              result.recipientAddress,
            ),
          },
        );
        return;
    }
  });

  bot.callbackQuery(/^energy:use:/, async (ctx) => {
    const selection = parseEnergyUseCallbackData(ctx.callbackQuery.data);

    if (selection === undefined) {
      await ctx.answerCallbackQuery({
        text: "无效能量操作。",
        show_alert: true,
      });
      return;
    }

    if (services.energyUsage === undefined) {
      await ctx.answerCallbackQuery({
        text: "当前能量服务尚未启用。",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    const result = await services.energyUsage.execute({
      telegramUserId: BigInt(ctx.from.id),
      optionCode: selection.optionCode,
      recipientAddress: selection.recipientAddress,
      idempotencyKey: `telegram:energy:${ctx.callbackQuery.id}`,
    });

    switch (result.kind) {
      case "denied":
        await ctx.reply("账号当前不可用。");
        return;
      case "invalid_address":
        await ctx.reply("TRON 地址无效，请重新发送。");
        return;
      case "option_unavailable":
        await ctx.reply("该能量规格已下架或不存在。");
        return;
      case "insufficient_balance":
        await ctx.reply(
          `可用笔数不足：当前 ${result.availableCount} 笔，需要 ${result.requiredCount} 笔。请先购买笔数。`,
        );
        return;
      case "conflict":
        await ctx.reply("本次能量操作状态冲突，请重新发起。");
        return;
      case "not_found":
        await ctx.reply("能量订单不存在。");
        return;
      case "completed":
      case "released":
      case "processing":
        await ctx.reply(formatEnergyOrder(result.order), {
          reply_markup: buildEnergyStatusKeyboard(
            result.order.id,
            result.kind === "processing",
          ),
        });
        return;
    }
  });

  bot.callbackQuery(/^energy:status:/, async (ctx) => {
    const orderId = parseEnergyStatusCallbackData(ctx.callbackQuery.data);

    if (orderId === undefined) {
      await ctx.answerCallbackQuery({
        text: "无效能量订单。",
        show_alert: true,
      });
      return;
    }

    if (services.energyUsage === undefined) {
      await ctx.answerCallbackQuery({
        text: "当前能量服务尚未启用。",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    const result = await services.energyUsage.getStatus({
      orderId,
      telegramUserId: BigInt(ctx.from.id),
    });

    if (result.kind === "not_found") {
      await ctx.reply("能量订单不存在或无权查看。");
      return;
    }

    if (
      result.kind !== "completed" &&
      result.kind !== "released" &&
      result.kind !== "processing"
    ) {
      await ctx.reply("当前无法查询能量订单状态。");
      return;
    }

    try {
      await ctx.editMessageText(formatEnergyOrder(result.order), {
        reply_markup: buildEnergyStatusKeyboard(
          result.order.id,
          result.kind === "processing",
        ),
      });
    } catch (error) {
      if (
        error instanceof GrammyError &&
        /message is not modified/i.test(error.description)
      ) {
        return;
      }

      throw error;
    }
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

    await ctx.answerCallbackQuery();

    const result = await services.packageSelection.select({
      telegramUserId: BigInt(ctx.from.id),
      packageId,
    });

    if (result.kind === "denied") {
      await ctx.reply("账号当前不可用。");
      return;
    }

    if (result.kind === "unavailable") {
      await ctx.reply("套餐已下架或不存在。");
      return;
    }

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
        await ctx.reply(
          formatPurchaseOrderInstructions(result.order),
          {
            reply_markup: buildOrderStatusKeyboard(
              result.order.id,
            ),
          },
        );
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

  bot.callbackQuery(/^order:status:/, async (ctx) => {
    const orderId = parseOrderStatusCallbackData(
      ctx.callbackQuery.data,
    );

    if (orderId === undefined) {
      await ctx.answerCallbackQuery({
        text: "无效订单。",
        show_alert: true,
      });
      return;
    }

    if (services.purchaseOrderStatus === undefined) {
      await ctx.answerCallbackQuery({
        text: "订单状态查询尚未启用。",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    const result = await services.purchaseOrderStatus.get({
      orderId,
      telegramUserId: BigInt(ctx.from.id),
    });

    if (result.kind === "not_found") {
      await ctx.reply("订单不存在或无权查看。");
      return;
    }

    const terminal = purchaseOrderStatusIsTerminal(
      result.order.status,
    );

    try {
      await ctx.editMessageText(
        formatPurchaseOrderStatus(result.order),
        {
          reply_markup: buildOrderStatusKeyboard(
            result.order.id,
            !terminal,
          ),
        },
      );
    } catch (error) {
      if (
        error instanceof GrammyError &&
        /message is not modified/i.test(error.description)
      ) {
        return;
      }

      throw error;
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
