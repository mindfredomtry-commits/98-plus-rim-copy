import { randomUUID } from "node:crypto";
import type { UserId } from "@98plus/product-model";
import type { IdentityStore, IdentityUser, TelegramUserId } from "./types.ts";

export class InMemoryIdentityStore implements IdentityStore {
  private readonly usersByTelegramId = new Map<TelegramUserId, IdentityUser>();
  private readonly inflight = new Map<TelegramUserId, Promise<IdentityUser>>();

  async resolveByTelegramUserId(telegramUserId: TelegramUserId): Promise<IdentityUser> {
    const existing = this.usersByTelegramId.get(telegramUserId);
    if (existing) {
      return existing;
    }
    const pending = this.inflight.get(telegramUserId);
    if (pending) {
      return pending;
    }
    const created = Promise.resolve().then(() => {
      const raced = this.usersByTelegramId.get(telegramUserId);
      if (raced) {
        return raced;
      }
      const user: IdentityUser = {
        userId: randomUUID() as UserId,
        telegramUserId,
      };
      this.usersByTelegramId.set(telegramUserId, user);
      return user;
    });
    this.inflight.set(telegramUserId, created);
    try {
      return await created;
    } finally {
      this.inflight.delete(telegramUserId);
    }
  }

  snapshot(): readonly IdentityUser[] {
    return [...this.usersByTelegramId.values()];
  }
}
