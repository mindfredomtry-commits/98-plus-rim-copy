/**
 * Telegram Mini App Share adapter boundary for Template Create Ban (Stage 11).
 *
 * Product path (Bot API 8.0+):
 * 1. Server prepares a message via Bot API `savePreparedInlineMessage` (requires TELEGRAM_BOT_TOKEN).
 * 2. Client invokes `Telegram.WebApp.shareMessage(preparedMessageId, callback)`.
 * 3. callback(true) and callback(false) are diagnostic only.
 *    Neither callback creates a Ban, cancels a Ban, or dispatches E-13.
 *    E-13 remains only the legacy unresolved SHARE_PENDING path whose createdBanId is null.
 *
 * Do NOT use `shareURL` / `t.me/share/url` as Ban-mint authority —
 * those APIs do not provide a reliable success vs cancel distinction.
 */

export const TELEGRAM_BAN_OVERBOARD_CALLBACK_PREFIX = "ob:";
export const TELEGRAM_BAN_OVERBOARD_BUTTON_TEXT = "ПЕРЕБОР";
export const TELEGRAM_BAN_REPLY_BUTTON_TEXT = "ЗАПРЕТИТЬ В ОТВЕТ";

export type TelegramSharePrepareInput = Readonly<{
  attemptId: string;
  token: string;
  banText: string;
  durationMinutes: number;
  /** Telegram user id of the Mini App user who will call shareMessage. */
  telegramUserId: string;
  botUsername?: string;
}>;

export type TelegramSharePrepareResult = Readonly<{
  attemptId: string;
  token: string;
  preparedMessageId: string;
  shareUrl: string;
  api: "shareMessage";
}>;

export type TelegramShareClientApi = Readonly<{
  shareMessage?: (msgId: string, callback?: (success: boolean) => void) => void;
  version?: string;
}>;

export class TelegramShareConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelegramShareConfigurationError";
  }
}

/** Strip leading @ and whitespace from a BotFather username. */
export function normalizeTelegramBotUsername(value: string): string {
  return value.trim().replace(/^@+/, "");
}

export function buildTemplateShareDeepLink(input: { botUsername: string; token: string }): string {
  const botUsername = normalizeTelegramBotUsername(input.botUsername);
  const startapp = `share_${input.token}`;
  return `https://t.me/${botUsername}?startapp=${encodeURIComponent(startapp)}`;
}

export function buildTelegramBanOverboardCallbackData(token: string): string {
  const data = `${TELEGRAM_BAN_OVERBOARD_CALLBACK_PREFIX}${token}`;
  if (Buffer.byteLength(data) > 64) {
    throw new TelegramShareConfigurationError(
      "OVERBOARD callback_data exceeds Telegram's 64-byte limit",
    );
  }
  return data;
}

export function parseTelegramBanOverboardCallbackData(data: string): string | null {
  if (!data.startsWith(TELEGRAM_BAN_OVERBOARD_CALLBACK_PREFIX)) {
    return null;
  }
  const token = data.slice(TELEGRAM_BAN_OVERBOARD_CALLBACK_PREFIX.length);
  return token.length > 0 ? token : null;
}

export function buildTelegramBanMessageText(input: {
  banText: string;
  durationMinutes: number;
  shareUrl: string;
  statusLine?: string | null;
}): string {
  const lines = ["98+ Template Ban", input.banText, `Duration: ${input.durationMinutes} min`];
  if (input.statusLine) {
    lines.push(input.statusLine);
  }
  lines.push(input.shareUrl);
  return lines.join("\n");
}

export function buildTelegramBanReplyMarkup(input: {
  shareUrl: string;
  token: string;
  includeOverboard: boolean;
}): {
  inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
} {
  const row: Array<{ text: string; callback_data?: string; url?: string }> = [];
  if (input.includeOverboard) {
    row.push({
      text: TELEGRAM_BAN_OVERBOARD_BUTTON_TEXT,
      callback_data: buildTelegramBanOverboardCallbackData(input.token),
    });
  }
  row.push({
    text: TELEGRAM_BAN_REPLY_BUTTON_TEXT,
    url: input.shareUrl,
  });
  return { inline_keyboard: [row] };
}

/**
 * Prepare a Telegram shareable prepared-inline message for WebApp.shareMessage.
 * Requires TELEGRAM_BOT_TOKEN. Tests should inject a mock prepare function instead.
 */
export async function prepareTelegramShareMessage(
  input: TelegramSharePrepareInput & { botToken: string },
): Promise<TelegramSharePrepareResult> {
  const botUsername = normalizeTelegramBotUsername(
    input.botUsername ?? process.env.TELEGRAM_BOT_USERNAME ?? "",
  );
  if (!botUsername) {
    throw new TelegramShareConfigurationError(
      "TELEGRAM_BOT_USERNAME is required to build the Template Share deep link",
    );
  }
  const shareUrl = buildTemplateShareDeepLink({ botUsername, token: input.token });
  const telegramUserId = Number(input.telegramUserId);
  if (!Number.isFinite(telegramUserId) || telegramUserId <= 0) {
    throw new TelegramShareConfigurationError(
      "telegramUserId must be a positive Telegram user id for savePreparedInlineMessage",
    );
  }
  const response = await fetch(
    `https://api.telegram.org/bot${input.botToken}/savePreparedInlineMessage`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        user_id: telegramUserId,
        result: {
          type: "article",
          id: input.attemptId,
          title: "98+ Ban",
          description: input.banText,
          input_message_content: {
            message_text: buildTelegramBanMessageText({
              banText: input.banText,
              durationMinutes: input.durationMinutes,
              shareUrl,
            }),
          },
          reply_markup: buildTelegramBanReplyMarkup({
            shareUrl,
            token: input.token,
            includeOverboard: true,
          }),
        },
        allow_user_chats: true,
        allow_bot_chats: false,
        allow_group_chats: false,
        allow_channel_chats: false,
      }),
    },
  );
  const body = (await response.json()) as {
    ok?: boolean;
    result?: { id?: string };
    description?: string;
  };
  if (!body.ok || typeof body.result?.id !== "string") {
    throw new TelegramShareConfigurationError(
      `savePreparedInlineMessage failed: ${body.description ?? response.statusText}`,
    );
  }
  return {
    attemptId: input.attemptId,
    token: input.token,
    preparedMessageId: body.result.id,
    shareUrl,
    api: "shareMessage",
  };
}

/**
 * Invoke Telegram.WebApp.shareMessage and map the boolean callback to product outcomes.
 * Returns null if shareMessage is unavailable (caller must not invent a Ban).
 */
export function invokeTelegramShareMessage(
  webApp: TelegramShareClientApi | null | undefined,
  preparedMessageId: string,
): Promise<"CONFIRMED" | "CANCELLED"> | null {
  if (!webApp?.shareMessage) {
    return null;
  }
  return new Promise((resolve) => {
    webApp.shareMessage!(preparedMessageId, (success) => {
      resolve(success ? "CONFIRMED" : "CANCELLED");
    });
  });
}

export function telegramShareOutcomeToEventName(
  outcome: "CONFIRMED" | "CANCELLED",
): "CREATE_BAN.SHARE_CANCELLED" | null {
  return outcome === "CANCELLED" ? "CREATE_BAN.SHARE_CANCELLED" : null;
}
