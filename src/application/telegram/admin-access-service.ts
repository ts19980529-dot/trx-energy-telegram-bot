import type { AdminRole } from "../../core/admin/roles.js";
import type { TelegramUserRepository } from "./ports.js";

export class AdminAccessService {
  constructor(
    private readonly users: TelegramUserRepository,
    private readonly superAdminId?: bigint,
  ) {}

  async getRole(
    telegramUserId: bigint,
  ): Promise<AdminRole | undefined> {
    const access = await this.users.getAccessByTelegramUserId(
      telegramUserId,
    );

    if (access === undefined || access.status === "blocked") {
      return undefined;
    }

    if (
      this.superAdminId !== undefined &&
      telegramUserId === this.superAdminId
    ) {
      return "SUPER_ADMIN";
    }

    return access.role;
  }
}
