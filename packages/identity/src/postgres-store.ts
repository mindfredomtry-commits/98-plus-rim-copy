import { randomUUID } from "node:crypto";
import type { UserId } from "@98plus/product-model";
import type { IdentityStore, IdentityUser, SqlClient, TelegramUserId } from "./types.ts";

type IdentityUserRow = {
  user_id: string;
  telegram_user_id: string;
};

export const UPSERT_IDENTITY_USER_SQL = `
INSERT INTO identity_users (user_id, telegram_user_id)
VALUES ($1, $2)
ON CONFLICT (telegram_user_id) DO UPDATE
SET telegram_user_id = identity_users.telegram_user_id
RETURNING user_id, telegram_user_id
`.trim();

export class PostgresIdentityStore implements IdentityStore {
  constructor(private readonly client: SqlClient) {}

  async resolveByTelegramUserId(telegramUserId: TelegramUserId): Promise<IdentityUser> {
    const candidateUserId = randomUUID();
    const result = await this.client.query<IdentityUserRow>(UPSERT_IDENTITY_USER_SQL, [
      candidateUserId,
      telegramUserId,
    ]);
    const row = result.rows[0];
    if (!row) {
      throw new Error("identity_users upsert returned no row");
    }
    return {
      userId: row.user_id as UserId,
      telegramUserId: row.telegram_user_id as TelegramUserId,
    };
  }
}
