import {
  Bot,
  Context,
  GrammyError,
  HttpError,
  type BotConfig,
} from "grammy";

import type { AdminAccessService } from "../../application/telegram/admin-access-service.js";
import type { PackageSelectionService } from "../../application/telegram/package-selection-service.js";
import type { TelegramStartService } from "../../application/telegram/start-service.js";
import {
  adminRoleLabel,
  buildPackageKeyboard,
  formatUsdtMicros,
  parsePackageCallbackData,
} from "./package-menu.js";

export const telegramAllowedUpdates = [
  "message",
  "callback_query",
] as const;

export interface TelegramBotServices {
  readonly start: Pick<TelegramStartService, "execute">;
  readonly packageSelection: Pick<PackageSelectionService, "select">;
  readonly adminAccess: Pick<AdminAccessService, "getRole">;
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

    await ctx.answerCallbackQuery({
      text: `已选择：${result.package.count} 笔 · ${formatUsdtMicros(result.package.priceUsdtMicros)} USDT`,
      show_alert: true,
    });
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
