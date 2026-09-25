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
  buildEnergyConfirmationKeyboard,
  buildEnergyOptionKeyboard,
  buildEnergyOrderListKeyboard,
  buildEnergyStatusKeyboard,
  buildHomeKeyboard,
  buildMainMenuKeyboard,
  formatEnergyConfirmation,
  formatEnergyOrder,
  isEnergyMenuCallback,
  isEnergyOrdersMenuCallback,
  isHomeMenuCallback,
  isPackageMenuCallback,
  parseEnergyConfirmCallbackData,
  parseEnergyExecuteCallbackData,
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

function callbackActionKey(
  kind: "purchase" | "energy",
  userId: number,
  message: { message_id: number; chat: { id: number } } | undefined,
): string | undefined {
  if (message === undefined || message.message_id <= 0) {
    return undefined;
  }

  return `telegram:${kind}:${userId}:${message.chat.id}:${message.message_id}`;
}

export const telegramAllowedUpdates = [
  "message",
  "callback_query",
] as const;

export interface TelegramBotServices {
  readonly start: Pick<TelegramStartService, "execute">;
  readonly packageSelection: Pick<PackageSelectionService, "select">;
  readonly adminAccess: Pick<AdminAccessService, "getRole">;
  readonly energyUsage?: Pick<
    EnergyUsageService,
    "prepare" | "execute" | "getStatus"
  > &
    Partial<Pick<EnergyUsageService, "listRecent">>;
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

  bot.use(async (ctx, next) => {
    if (ctx.chat?.type === "private") {
      await next();
      return;
    }

    if (ctx.callbackQuery !== undefined) {
      await ctx.answerCallbackQuery({
        text: "请在机器人私聊中操作。",
        show_alert: true,
      });
    }
  });

  const handlers = bot.errorBoundary(async (err) => {
    if (err.error instanceof GrammyError || err.error instanceof HttpError) {
      throw err.error;
    }

    const updateId = err.ctx.update.update_id;
    console.error(`Telegram handler error; update_id=${updateId}`);

    if (err.ctx.chat?.type !== "private") {
      return;
    }

    try {
      await err.ctx.reply(
        "操作暂时无法完成。如已提交支付或能量操作，请先查询订单状态，避免重复操作。",
      );
    } catch {
      console.error(`Telegram error feedback failed; update_id=${updateId}`);
    }
  });

  const showMainMenu = async (ctx: Context): Promise<void> => {
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

    if (result.packages.length === 0 && services.energyUsage === undefined) {
      await ctx.reply("当前暂无可用服务，请稍后再试。");
      return;
    }

    const energyEnabled = services.energyUsage !== undefined;
    const purchaseEnabled =
      services.purchaseOrderCreation !== undefined;

    await ctx.reply(
      energyEnabled
        ? "请选择服务："
        : purchaseEnabled
          ? "能量使用暂未开放，当前可购买笔数套餐。"
          : "能量使用暂未开放，当前可查看笔数套餐。",
      {
        reply_markup: buildMainMenuKeyboard(
          energyEnabled,
          purchaseEnabled,
        ),
      },
    );
  };

  handlers.command("start", showMainMenu);

  handlers.callbackQuery("menu:home", async (ctx) => {
    if (!isHomeMenuCallback(ctx.callbackQuery.data)) {
      return;
    }

    await ctx.answerCallbackQuery();
    await showMainMenu(ctx);
  });

  handlers.callbackQuery("menu:packages", async (ctx) => {
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

  handlers.callbackQuery("menu:energy", async (ctx) => {
    if (!isEnergyMenuCallback(ctx.callbackQuery.data)) {
      return;
    }

    await ctx.answerCallbackQuery();

    if (services.energyUsage === undefined) {
      await ctx.reply("当前能量服务尚未启用。");
      return;
    }

    await ctx.reply("请发送需要接收能量的 TRON 地址。", {
      reply_markup: buildHomeKeyboard(),
    });
  });

  handlers.callbackQuery("menu:energy-orders", async (ctx) => {
    if (!isEnergyOrdersMenuCallback(ctx.callbackQuery.data)) {
      return;
    }

    if (
      services.energyUsage === undefined ||
      services.energyUsage.listRecent === undefined
    ) {
      await ctx.answerCallbackQuery({
        text: "能量订单查询暂不可用。",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    const result = await services.energyUsage.listRecent({
      telegramUserId: BigInt(ctx.from.id),
      limit: 5,
    });

    if (result.kind === "denied") {
      await ctx.reply("账号当前不可用。");
      return;
    }

    if (result.orders.length === 0) {
      await ctx.reply("暂无能量订单。", {
        reply_markup: buildHomeKeyboard(),
      });
      return;
    }

    await ctx.reply("最近能量订单：", {
      reply_markup: buildEnergyOrderListKeyboard(result.orders),
    });
  });

  handlers.hears(/^(?:T\S{20,50}|41[0-9A-Za-z]{20,70})$/, async (ctx) => {
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

  handlers.callbackQuery(/^energy:cf:/, async (ctx) => {
    const selection = parseEnergyConfirmCallbackData(
      ctx.callbackQuery.data,
    );

    if (selection === undefined) {
      await ctx.answerCallbackQuery({
        text: "无效能量规格。",
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

    const result = await services.energyUsage.prepare({
      telegramUserId: BigInt(ctx.from.id),
      recipientAddress: selection.recipientAddress,
    });

    switch (result.kind) {
      case "denied":
        await ctx.reply("账号当前不可用。");
        return;
      case "invalid_address":
        await ctx.reply("TRON 地址无效，请重新发送。");
        return;
      case "ready": {
        const option = result.options.find(
          (item) => item.code === selection.optionCode,
        );

        if (option === undefined) {
          await ctx.reply("该能量规格已下架或不存在。");
          return;
        }

        if (result.availableCount < option.countCost) {
          await ctx.reply(
            `可用笔数不足：当前 ${result.availableCount} 笔，需要 ${option.countCost} 笔。请先购买笔数。`,
          );
          return;
        }

        await ctx.reply(
          formatEnergyConfirmation({
            recipientAddress: result.recipientAddress,
            option,
            availableCount: result.availableCount,
            reservedCount: result.reservedCount,
          }),
          {
            reply_markup: buildEnergyConfirmationKeyboard(
              option.code,
              result.recipientAddress,
            ),
          },
        );
        return;
      }
    }
  });

  handlers.callbackQuery(/^energy:use:/, async (ctx) => {
    const selection = parseEnergyUseCallbackData(ctx.callbackQuery.data);

    if (selection === undefined) {
      await ctx.answerCallbackQuery({
        text: "无效能量操作。",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery({
      text: "该能量操作已更新，请重新发送地址并选择能量规格。",
      show_alert: true,
    });
  });

  handlers.callbackQuery(/^energy:go:/, async (ctx) => {
    const selection = parseEnergyExecuteCallbackData(
      ctx.callbackQuery.data,
    );

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

    const idempotencyKey = callbackActionKey(
      "energy",
      ctx.from.id,
      ctx.callbackQuery.message,
    );

    if (idempotencyKey === undefined) {
      await ctx.answerCallbackQuery({
        text: "操作消息已失效，请重新打开菜单。",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    const result = await services.energyUsage.execute({
      telegramUserId: BigInt(ctx.from.id),
      optionCode: selection.optionCode,
      recipientAddress: selection.recipientAddress,
      idempotencyKey,
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

  handlers.callbackQuery("energy:cancel", async (ctx) => {
    await ctx.answerCallbackQuery();

    try {
      await ctx.editMessageText(
        "已取消本次能量操作。未提交能量订单，也不会扣除笔数。",
        { reply_markup: buildHomeKeyboard() },
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

  handlers.callbackQuery(/^energy:status:/, async (ctx) => {
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

  handlers.callbackQuery(/^package:view:/, async (ctx) => {
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
        services.purchaseOrderCreation === undefined
          ? "支付功能暂未开放，可先查看套餐信息。"
          : "请选择支付方式：",
      ].join("\n"),
      services.purchaseOrderCreation === undefined
        ? {}
        : { reply_markup: buildPaymentMethodKeyboard(result.package.id) },
    );
  });

  handlers.callbackQuery(/^package:pay:/, async (ctx) => {
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

    if (selection.asset === "TRX") {
      await ctx.answerCallbackQuery({
        text: "TRX 支付尚未启用。",
        show_alert: true,
      });
      return;
    }

    const idempotencyKey = callbackActionKey(
      "purchase",
      ctx.from.id,
      ctx.callbackQuery.message,
    );

    if (idempotencyKey === undefined) {
      await ctx.answerCallbackQuery({
        text: "操作消息已失效，请重新打开菜单。",
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
      idempotencyKey,
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

  handlers.callbackQuery(/^order:status:/, async (ctx) => {
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

  handlers.command("admin", async (ctx) => {
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

  handlers.on("callback_query:data", async (ctx) => {
    await ctx.answerCallbackQuery({
      text: "操作已失效，请发送 /start 重新打开菜单。",
      show_alert: true,
    });
  });

  handlers.on("message:text", async (ctx) => {
    await ctx.reply(
      services.energyUsage === undefined
        ? "未识别输入，请发送 /start 打开服务菜单。"
        : "未识别输入，请发送有效的 TRON 地址，或发送 /start 返回菜单。",
    );
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
