import { describe, expect, it } from "vitest";
import { InMemoryIdentityStore } from "./in-memory-store.ts";
import { PostgresIdentityStore, UPSERT_IDENTITY_USER_SQL } from "./postgres-store.ts";
import { asTelegramUserId } from "./telegram-init-data.ts";
import type { IdentityUser, SqlClient } from "./types.ts";

describe("identity persistence", () => {
  it("does not create duplicate internal users for concurrent resolve of the same Telegram identity", async () => {
    const store = new InMemoryIdentityStore();
    const telegramUserId = asTelegramUserId("555");
    const [a, b, c] = await Promise.all([
      store.resolveByTelegramUserId(telegramUserId),
      store.resolveByTelegramUserId(telegramUserId),
      store.resolveByTelegramUserId(telegramUserId),
    ]);
    expect(a.userId).toBe(b.userId);
    expect(b.userId).toBe(c.userId);
    expect(store.snapshot()).toHaveLength(1);
  });

  it("upserts through a unique telegram_user_id constraint", async () => {
    expect(UPSERT_IDENTITY_USER_SQL).toContain("ON CONFLICT (telegram_user_id)");
    const rows: IdentityUser[] = [];
    const client: SqlClient = {
      async query<T>(sql: string, params: readonly unknown[]) {
        expect(sql).toBe(UPSERT_IDENTITY_USER_SQL);
        const telegramUserId = asTelegramUserId(String(params[1]));
        const existing = rows.find((row) => row.telegramUserId === telegramUserId);
        if (existing) {
          return {
            rows: [{ user_id: existing.userId, telegram_user_id: existing.telegramUserId }] as T[],
          };
        }
        const created = {
          userId: String(params[0]) as IdentityUser["userId"],
          telegramUserId,
        };
        rows.push(created);
        return {
          rows: [{ user_id: created.userId, telegram_user_id: created.telegramUserId }] as T[],
        };
      },
    };
    const store = new PostgresIdentityStore(client);
    const first = await store.resolveByTelegramUserId(asTelegramUserId("9"));
    const second = await store.resolveByTelegramUserId(asTelegramUserId("9"));
    expect(second.userId).toBe(first.userId);
    expect(rows).toHaveLength(1);
  });
});
