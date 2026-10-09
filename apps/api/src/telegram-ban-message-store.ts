/**
 * Side persistence for Template Ban Telegram bubbles.
 * Not Product State. Maps share attempt → inline_message_id and callback receipts.
 *
 * Attempt locks are process-local. PASS 3C targets the current single-replica API.
 * callback_query.id receipts remain durable in SQL for restart-safe duplicates.
 */

import type { PersistenceSqlClient } from "@98plus/persistence";
import { MemorySqlClient } from "@98plus/persistence";

export type TelegramBanCallbackOutcome =
  | "ACCEPTED"
  | "DUPLICATE"
  | "REJECTED"
  | "OVERBOARD_APPLIED"
  | "OVERBOARD_NOT_APPLIED"
  | "EDIT_FAILED";

export type TelegramBanMessageDelivery = Readonly<{
  attemptId: string;
  banId: string;
  shareToken: string;
  inlineMessageId: string | null;
}>;

export type TelegramBanCallbackReceipt = Readonly<{
  callbackQueryId: string;
  attemptId: string;
  telegramUserId: string;
  outcome: TelegramBanCallbackOutcome;
}>;

export type TelegramBanMessageStore = Readonly<{
  upsertDelivery(input: {
    attemptId: string;
    banId: string;
    shareToken: string;
  }): Promise<TelegramBanMessageDelivery>;
  findDeliveryByToken(token: string): Promise<TelegramBanMessageDelivery | null>;
  findDeliveryByAttemptId(attemptId: string): Promise<TelegramBanMessageDelivery | null>;
  setInlineMessageId(attemptId: string, inlineMessageId: string): Promise<TelegramBanMessageDelivery>;
  findCallbackReceipt(callbackQueryId: string): Promise<TelegramBanCallbackReceipt | null>;
  recordCallbackReceipt(input: {
    callbackQueryId: string;
    attemptId: string;
    telegramUserId: string;
    outcome: TelegramBanCallbackOutcome;
  }): Promise<{ created: boolean; receipt: TelegramBanCallbackReceipt }>;
  /** Serialize work for one Ban/share attempt within this process. */
  withAttemptLock<T>(attemptId: string, run: () => Promise<T>): Promise<T>;
}>;

const processAttemptLocks = new Map<string, Promise<unknown>>();

export function createTelegramBanMessageStore(sql: PersistenceSqlClient): TelegramBanMessageStore {
  if (sql instanceof MemorySqlClient) {
    return createMemoryTelegramBanMessageStore();
  }
  return createSqlTelegramBanMessageStore(sql);
}

function withProcessAttemptLock<T>(attemptId: string, run: () => Promise<T>): Promise<T> {
  const previous = processAttemptLocks.get(attemptId) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.then(() => gate);
  processAttemptLocks.set(attemptId, current);
  return previous.then(async () => {
    try {
      return await run();
    } finally {
      release();
      if (processAttemptLocks.get(attemptId) === current) {
        processAttemptLocks.delete(attemptId);
      }
    }
  });
}

function createMemoryTelegramBanMessageStore(): TelegramBanMessageStore {
  const deliveries = new Map<string, TelegramBanMessageDelivery>();
  const byToken = new Map<string, string>();
  const receipts = new Map<string, TelegramBanCallbackReceipt>();

  return {
    async upsertDelivery(input) {
      const existing = deliveries.get(input.attemptId);
      const next: TelegramBanMessageDelivery = {
        attemptId: input.attemptId,
        banId: input.banId,
        shareToken: input.shareToken,
        inlineMessageId: existing?.inlineMessageId ?? null,
      };
      deliveries.set(input.attemptId, next);
      byToken.set(input.shareToken, input.attemptId);
      return next;
    },
    async findDeliveryByToken(token) {
      const attemptId = byToken.get(token);
      return attemptId ? (deliveries.get(attemptId) ?? null) : null;
    },
    async findDeliveryByAttemptId(attemptId) {
      return deliveries.get(attemptId) ?? null;
    },
    async setInlineMessageId(attemptId, inlineMessageId) {
      const existing = deliveries.get(attemptId);
      if (!existing) {
        throw new Error(`telegram ban delivery missing for attempt ${attemptId}`);
      }
      const next = { ...existing, inlineMessageId };
      deliveries.set(attemptId, next);
      return next;
    },
    async findCallbackReceipt(callbackQueryId) {
      return receipts.get(callbackQueryId) ?? null;
    },
    async recordCallbackReceipt(input) {
      const existing = receipts.get(input.callbackQueryId);
      if (existing) {
        return { created: false, receipt: existing };
      }
      const receipt: TelegramBanCallbackReceipt = {
        callbackQueryId: input.callbackQueryId,
        attemptId: input.attemptId,
        telegramUserId: input.telegramUserId,
        outcome: input.outcome,
      };
      receipts.set(input.callbackQueryId, receipt);
      return { created: true, receipt };
    },
    withAttemptLock: withProcessAttemptLock,
  };
}

function createSqlTelegramBanMessageStore(sql: PersistenceSqlClient): TelegramBanMessageStore {
  async function findDeliveryByAttemptId(
    attemptId: string,
  ): Promise<TelegramBanMessageDelivery | null> {
    const result = await sql.query<{
      attempt_id: string;
      ban_id: string;
      share_token: string;
      inline_message_id: string | null;
    }>(
      `SELECT attempt_id, ban_id, share_token, inline_message_id
       FROM telegram_ban_message_deliveries
       WHERE attempt_id = $1`,
      [attemptId],
    );
    const row = result.rows[0];
    return row ? deliveryFromRow(row) : null;
  }

  async function findCallbackReceipt(
    callbackQueryId: string,
  ): Promise<TelegramBanCallbackReceipt | null> {
    const result = await sql.query<{
      callback_query_id: string;
      attempt_id: string;
      telegram_user_id: string;
      outcome: TelegramBanCallbackOutcome;
    }>(
      `SELECT callback_query_id, attempt_id, telegram_user_id, outcome
       FROM telegram_ban_callback_receipts
       WHERE callback_query_id = $1`,
      [callbackQueryId],
    );
    const row = result.rows[0];
    return row
      ? {
          callbackQueryId: row.callback_query_id,
          attemptId: row.attempt_id,
          telegramUserId: row.telegram_user_id,
          outcome: row.outcome,
        }
      : null;
  }

  return {
    async upsertDelivery(input) {
      await sql.query(
        `INSERT INTO telegram_ban_message_deliveries (
           attempt_id, ban_id, share_token, inline_message_id
         ) VALUES ($1, $2, $3, NULL)
         ON CONFLICT (attempt_id) DO UPDATE
         SET ban_id = EXCLUDED.ban_id,
             share_token = EXCLUDED.share_token,
             updated_at = NOW()`,
        [input.attemptId, input.banId, input.shareToken],
      );
      const found = await findDeliveryByAttemptId(input.attemptId);
      if (!found) {
        throw new Error(`telegram ban delivery upsert failed for ${input.attemptId}`);
      }
      return found;
    },
    async findDeliveryByToken(token) {
      const result = await sql.query<{
        attempt_id: string;
        ban_id: string;
        share_token: string;
        inline_message_id: string | null;
      }>(
        `SELECT attempt_id, ban_id, share_token, inline_message_id
         FROM telegram_ban_message_deliveries
         WHERE share_token = $1`,
        [token],
      );
      const row = result.rows[0];
      return row ? deliveryFromRow(row) : null;
    },
    findDeliveryByAttemptId,
    async setInlineMessageId(attemptId, inlineMessageId) {
      const result = await sql.query<{
        attempt_id: string;
        ban_id: string;
        share_token: string;
        inline_message_id: string | null;
      }>(
        `UPDATE telegram_ban_message_deliveries
         SET inline_message_id = $2, updated_at = NOW()
         WHERE attempt_id = $1
         RETURNING attempt_id, ban_id, share_token, inline_message_id`,
        [attemptId, inlineMessageId],
      );
      const row = result.rows[0];
      if (!row) {
        throw new Error(`telegram ban delivery missing for attempt ${attemptId}`);
      }
      return deliveryFromRow(row);
    },
    findCallbackReceipt,
    async recordCallbackReceipt(input) {
      const result = await sql.query<{
        callback_query_id: string;
        attempt_id: string;
        telegram_user_id: string;
        outcome: TelegramBanCallbackOutcome;
      }>(
        `INSERT INTO telegram_ban_callback_receipts (
           callback_query_id, attempt_id, telegram_user_id, outcome
         ) VALUES ($1, $2, $3, $4)
         ON CONFLICT (callback_query_id) DO NOTHING
         RETURNING callback_query_id, attempt_id, telegram_user_id, outcome`,
        [input.callbackQueryId, input.attemptId, input.telegramUserId, input.outcome],
      );
      const inserted = result.rows[0];
      if (inserted) {
        return {
          created: true,
          receipt: {
            callbackQueryId: inserted.callback_query_id,
            attemptId: inserted.attempt_id,
            telegramUserId: inserted.telegram_user_id,
            outcome: inserted.outcome,
          },
        };
      }
      const existing = await findCallbackReceipt(input.callbackQueryId);
      if (!existing) {
        throw new Error(`telegram callback receipt race for ${input.callbackQueryId}`);
      }
      return { created: false, receipt: existing };
    },
    withAttemptLock: withProcessAttemptLock,
  };
}

function deliveryFromRow(row: {
  attempt_id: string;
  ban_id: string;
  share_token: string;
  inline_message_id: string | null;
}): TelegramBanMessageDelivery {
  return {
    attemptId: row.attempt_id,
    banId: row.ban_id,
    shareToken: row.share_token,
    inlineMessageId: row.inline_message_id,
  };
}

/** Test helper: clear process locks between cases. */
export function resetTelegramBanMessageProcessLocksForTests(): void {
  processAttemptLocks.clear();
}
