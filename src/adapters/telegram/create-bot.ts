import {
  Bot,
  Context,
  GrammyError,
  InlineKeyboard,
  HttpError,
  type BotConfig,
} from "grammy";

import type { EnergyOrderQueryService } from "../../application/energy/energy-order-query-service.js";
import type { EnergyUsageService } from "../../application/energy/energy-usage-service.js";
import type { PurchaseOrderCreationService } from "../../application/payments/purchase-order-service.js";
import type { PurchaseOrderStatusService } from "../../application/payments/purchase-order-status-service.js";
import type { AdminAccessService } from "../../application/telegram/admin-access-service.js";
import type { BalanceQueryService } from "../../application/telegram/balance-query-service.js";
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
  isPurchaseOrdersMenuCallback,
  parseEnergyConfirmCallbackData,
  parseEnergyExecuteCallbackData,
  parseEnergyOrdersPageCallbackData,
  parseEnergyStatusCallbackData,
  parseEnergyUseCallbackData,
} from "./energy-menu.js";
import {
  adminRoleLabel,
  buildOrderStatusKeyboard,
  buildPackageKeyboard,
  buildPackageNavigationKeyboard,
  buildPurchaseOrderListKeyboard,
  buildPaymentMethodKeyboard,
  formatPurchaseOrderInstructions,
  formatPurchaseOrderStatus,
  formatUsdtMicros,
  parseOrderStatusCallbackData,
  parsePackageCallbackData,
  parsePackagePaymentCallbackData,
  parsePurchaseOrdersPageCallbackData,
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
  readonly balanceQuery?: Pick<BalanceQueryService, "get">;
  readonly adminAccess: Pick<AdminAccessService, "getRole">;
  readonly energyUsage?: Pick<
    EnergyUsageService,
    "prepare" | "execute"
  >;
  readonly energyOrderQuery?: Pick<
    EnergyOrderQueryService,
    "listPage" | "get"
  >;
  readonly purchaseOrderCreation?: Pick<
    PurchaseOrderCreationService,
    "create"
  > & {
    readonly isAvailable?: () => boolean;
  };
  readonly purchaseOrderStatus?: Pick<
    PurchaseOrderStatusService,
    "get"
  > &
    Partial<Pick<PurchaseOrderStatusService, "listPage">>;
}

export function createTelegramBot(
  token: string,
  services: TelegramBotServices,
  config?: BotConfig<Context>,
): Bot {
  const bot = new Bot(token, config);
  const purchaseOrderCreationAvailable = (): boolean =>
    services.purchaseOrderCreation !== undefined &&
    (services.purchaseOrderCreation.isAvailable?.() ?? true);

  const renderInteractive = async (
    ctx: Context,
    text: string,
    keyboard?: InlineKeyboard,
  ): Promise<void> => {
    const extra =
      keyboard === undefined ? {} : { reply_markup: keyboard };

    if (ctx.callbackQuery?.message !== undefined) {
      try {
        await ctx.editMessageText(text, extra);
        return;
      } catch (error) {
        if (
          error instanceof GrammyError &&
          /message is not modified/i.test(error.description)
        ) {
          return;
        }

        if (
          !(
            error instanceof GrammyError &&
            /message (?:to edit not found|can't be edited)/i.test(
              error.description,
            )
          )
        ) {
          throw error;
        }
      }
    }

    await ctx.reply(text, extra);
  };

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
      await renderInteractive(ctx, "账号当前不可用。");
      return;
    }

    const balance =
      services.balanceQuery === undefined
        ? undefined
        : await services.balanceQuery.get(BigInt(ctx.from.id));

    if (balance?.kind === "denied") {
      await renderInteractive(ctx, "账号当前不可用。");
      return;
    }

    const energyEnabled = services.energyUsage !== undefined;
    const packageCatalogAvailable = result.packages.length > 0;
    const purchaseEnabled =
      packageCatalogAvailable && purchaseOrderCreationAvailable();
    const energyHistoryEnabled =
      services.energyOrderQuery !== undefined;
    const purchaseHistoryEnabled =
      services.purchaseOrderStatus?.listPage !== undefined;

    if (
      !packageCatalogAvailable &&
      !energyEnabled &&
      !energyHistoryEnabled &&
      !purchaseHistoryEnabled
    ) {
      await renderInteractive(
        ctx,
        [
          ...(balance?.kind === "ready"
            ? [
                `可用笔数：${balance.balance.availableCount} 笔`,
                `预留笔数：${balance.balance.reservedCount} 笔`,
                "",
              ]
            : []),
          "当前暂无可用服务，请稍后再试。",
        ].join("\n"),
      );
      return;
    }

    const serviceMessage = energyEnabled
      ? "请选择服务："
      : purchaseEnabled
        ? "能量使用暂未开放，当前可购买笔数套餐。"
        : packageCatalogAvailable
          ? "能量使用暂未开放，当前可查看笔数套餐。"
          : "能量使用暂未开放，可查询历史订单。";

    await renderInteractive(
      ctx,
      [
        ...(balance?.kind === "ready"
          ? [
              `可用笔数：${balance.balance.availableCount} 笔`,
              `预留笔数：${balance.balance.reservedCount} 笔`,
              "",
            ]
          : []),
        serviceMessage,
      ].join("\n"),
      buildMainMenuKeyboard(
        energyEnabled,
        purchaseEnabled,
        energyHistoryEnabled,
        purchaseHistoryEnabled,
        packageCatalogAvailable,
      ),
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
      await renderInteractive(ctx, "账号当前不可用。");
      return;
    }

    if (result.packages.length === 0) {
      await renderInteractive(
        ctx,
        "当前暂无可用套餐。",
        buildHomeKeyboard(),
      );
      return;
    }

    await renderInteractive(
      ctx,
      "请选择笔数套餐：",
      buildPackageKeyboard(result.packages),
    );
  });

  handlers.callbackQuery("menu:energy", async (ctx) => {
    if (!isEnergyMenuCallback(ctx.callbackQuery.data)) {
      return;
    }

    await ctx.answerCallbackQuery();

    if (services.energyUsage === undefined) {
      await renderInteractive(
        ctx,
        "当前能量服务尚未启用。",
        buildHomeKeyboard(),
      );
      return;
    }

    await renderInteractive(
      ctx,
      "请发送需要接收能量的 TRON 地址。",
      buildHomeKeyboard(),
    );
  });

  const showEnergyOrders = async (
    ctx: Context,
    page?: {
      readonly direction: "next" | "previous";
      readonly cursorId: string;
    },
  ): Promise<void> => {
    if (ctx.from === undefined || services.energyOrderQuery === undefined) {
      await renderInteractive(
        ctx,
        "能量订单查询暂不可用。",
        buildHomeKeyboard(),
      );
      return;
    }

    let result = await services.energyOrderQuery.listPage({
      telegramUserId: BigInt(ctx.from.id),
      limit: 5,
      ...(page === undefined
        ? {}
        : {
            cursorId: page.cursorId,
            direction: page.direction,
          }),
    });

    if (
      result.kind === "ready" &&
      result.orders.length === 0 &&
      page !== undefined
    ) {
      result = await services.energyOrderQuery.listPage({
        telegramUserId: BigInt(ctx.from.id),
        limit: 5,
      });
    }

    if (result.kind === "denied") {
      await renderInteractive(ctx, "账号当前不可用。");
      return;
    }

    if (result.orders.length === 0) {
      await renderInteractive(
        ctx,
        "暂无能量订单。",
        buildHomeKeyboard(),
      );
      return;
    }

    await renderInteractive(
      ctx,
      "我的能量订单：",
      buildEnergyOrderListKeyboard(result.orders, {
        previousCursor: result.previousCursor,
        nextCursor: result.nextCursor,
      }),
    );
  };

  handlers.callbackQuery("menu:energy-orders", async (ctx) => {
    if (!isEnergyOrdersMenuCallback(ctx.callbackQuery.data)) {
      return;
    }

    await ctx.answerCallbackQuery();
    await showEnergyOrders(ctx);
  });

  handlers.callbackQuery(/^menu:energy-orders:/, async (ctx) => {
    const page = parseEnergyOrdersPageCallbackData(
      ctx.callbackQuery.data,
    );
    if (page === undefined) {
      await ctx.answerCallbackQuery({
        text: "订单翻页操作已失效。",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();
    await showEnergyOrders(ctx, page);
  });

  const showPurchaseOrders = async (
    ctx: Context,
    page?: {
      readonly direction: "next" | "previous";
      readonly cursorId: string;
    },
  ): Promise<void> => {
    if (
      ctx.from === undefined ||
      services.purchaseOrderStatus === undefined ||
      services.purchaseOrderStatus.listPage === undefined
    ) {
      await renderInteractive(
        ctx,
        "支付订单查询暂不可用。",
        buildHomeKeyboard(),
      );
      return;
    }

    let result = await services.purchaseOrderStatus.listPage({
      telegramUserId: BigInt(ctx.from.id),
      limit: 5,
      ...(page === undefined
        ? {}
        : {
            cursorId: page.cursorId,
            direction: page.direction,
          }),
    });

    if (
      result.kind === "ready" &&
      result.orders.length === 0 &&
      page !== undefined
    ) {
      result = await services.purchaseOrderStatus.listPage({
        telegramUserId: BigInt(ctx.from.id),
        limit: 5,
      });
    }

    if (result.kind === "denied") {
      await renderInteractive(ctx, "账号当前不可用。");
      return;
    }

    if (result.orders.length === 0) {
      await renderInteractive(
        ctx,
        "暂无支付订单。",
        buildHomeKeyboard(),
      );
      return;
    }

    await renderInteractive(
      ctx,
      "我的支付订单：",
      buildPurchaseOrderListKeyboard(result.orders, {
        previousCursor: result.previousCursor,
        nextCursor: result.nextCursor,
      }),
    );
  };

  handlers.callbackQuery("menu:purchase-orders", async (ctx) => {
    if (!isPurchaseOrdersMenuCallback(ctx.callbackQuery.data)) {
      return;
    }

    await ctx.answerCallbackQuery();
    await showPurchaseOrders(ctx);
  });

  handlers.callbackQuery(/^menu:purchase-orders:/, async (ctx) => {
    const page = parsePurchaseOrdersPageCallbackData(
      ctx.callbackQuery.data,
    );
    if (page === undefined) {
      await ctx.answerCallbackQuery({
        text: "订单翻页操作已失效。",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();
    await showPurchaseOrders(ctx, page);
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
        await renderInteractive(ctx, "账号当前不可用。");
        return;
      case "invalid_address":
        await renderInteractive(
          ctx,
          "TRON 地址无效，请重新发送。",
          buildHomeKeyboard(),
        );
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
          await renderInteractive(
            ctx,
            "该能量规格已下架或不存在。",
            buildHomeKeyboard(),
          );
          return;
        }

        if (result.availableCount < option.countCost) {
          await renderInteractive(
            ctx,
            `可用笔数不足：当前 ${result.availableCount} 笔，需要 ${option.countCost} 笔。请先购买笔数。`,
            buildHomeKeyboard(),
          );
          return;
        }

        await renderInteractive(
          ctx,
          formatEnergyConfirmation({
            recipientAddress: result.recipientAddress,
            option,
            availableCount: result.availableCount,
            reservedCount: result.reservedCount,
          }),
          buildEnergyConfirmationKeyboard(
            option.code,
            result.recipientAddress,
          ),
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
        await renderInteractive(ctx, "账号当前不可用。");
        return;
      case "invalid_address":
        await renderInteractive(
          ctx,
          "TRON 地址无效，请重新发送。",
          buildHomeKeyboard(),
        );
        return;
      case "option_unavailable":
        await renderInteractive(
          ctx,
          "该能量规格已下架或不存在。",
          buildHomeKeyboard(),
        );
        return;
      case "insufficient_balance":
        await renderInteractive(
          ctx,
          `可用笔数不足：当前 ${result.availableCount} 笔，需要 ${result.requiredCount} 笔。请先购买笔数。`,
          buildHomeKeyboard(),
        );
        return;
      case "conflict":
        await renderInteractive(
          ctx,
          "本次能量操作状态冲突，请重新发起。",
          buildHomeKeyboard(),
        );
        return;
      case "not_found":
        await renderInteractive(
          ctx,
          "能量订单不存在。",
          buildHomeKeyboard(),
        );
        return;
      case "completed":
      case "released":
      case "processing":
        await renderInteractive(
          ctx,
          formatEnergyOrder(result.order),
          buildEnergyStatusKeyboard(
            result.order.id,
            result.kind === "processing",
          ),
        );
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

    if (services.energyOrderQuery === undefined) {
      await ctx.answerCallbackQuery({
        text: "能量订单查询暂不可用。",
        show_alert: true,
      });
      return;
    }

    await ctx.answerCallbackQuery();

    const result = await services.energyOrderQuery.get({
      orderId,
      telegramUserId: BigInt(ctx.from.id),
    });

    if (result.kind === "not_found") {
      await renderInteractive(
        ctx,
        "能量订单不存在或无权查看。",
        buildHomeKeyboard(),
      );
      return;
    }

    const refreshable =
      result.order.status !== "completed" &&
      result.order.status !== "released" &&
      result.order.status !== "cancelled";

    try {
      await ctx.editMessageText(formatEnergyOrder(result.order), {
        reply_markup: buildEnergyStatusKeyboard(
          result.order.id,
          refreshable,
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
      await renderInteractive(ctx, "账号当前不可用。");
      return;
    }

    if (result.kind === "unavailable") {
      await renderInteractive(
        ctx,
        "套餐已下架或不存在。",
        buildPackageNavigationKeyboard(),
      );
      return;
    }

    const paymentEnabled = purchaseOrderCreationAvailable();
    await renderInteractive(
      ctx,
      [
        "套餐详情",
        "",
        `笔数：${result.package.count} 笔`,
        `价格：${formatUsdtMicros(result.package.priceUsdtMicros)} USDT`,
        "",
        paymentEnabled
          ? "请选择支付方式："
          : "支付功能暂未开放，可先查看套餐信息。",
      ].join("\n"),
      paymentEnabled
        ? buildPaymentMethodKeyboard(result.package.id)
        : buildPackageNavigationKeyboard(),
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
      await renderInteractive(
        ctx,
        "当前支付功能尚未启用。",
        buildPackageNavigationKeyboard(),
      );
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
      case "service_unavailable":
        await renderInteractive(
          ctx,
          "支付服务当前不可用，暂时不会创建新的支付订单。已有订单仍可查询状态。",
          buildPackageNavigationKeyboard(),
        );
        return;
      case "ready":
        await renderInteractive(
          ctx,
          formatPurchaseOrderInstructions(result.order),
          buildOrderStatusKeyboard(result.order.id),
        );
        return;
      case "denied":
        await renderInteractive(ctx, "账号当前不可用。");
        return;
      case "package_unavailable":
        await renderInteractive(
          ctx,
          "套餐已下架或不存在。",
          buildPackageNavigationKeyboard(),
        );
        return;
      case "unsupported_asset":
        await renderInteractive(
          ctx,
          `${result.asset} 支付尚未启用。`,
          buildPackageNavigationKeyboard(),
        );
        return;
      case "quote_unavailable":
        await renderInteractive(
          ctx,
          "当前无法获取支付报价，请稍后重试。",
          buildPackageNavigationKeyboard(),
        );
        return;
      case "payment_attribution_unavailable":
        await renderInteractive(
          ctx,
          "当前 USDT 支付通道暂不可用，请稍后重试或联系客服。",
          buildPackageNavigationKeyboard(),
        );
        return;
      case "idempotency_conflict":
        await renderInteractive(
          ctx,
          "本次支付操作状态冲突，请返回套餐重新发起。",
          buildPackageNavigationKeyboard(),
        );
        return;
      case "invalid_request":
        await renderInteractive(
          ctx,
          "支付请求无效，请返回套餐重新选择。",
          buildPackageNavigationKeyboard(),
        );
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
      await renderInteractive(
        ctx,
        "订单不存在或无权查看。",
        buildHomeKeyboard(),
      );
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
