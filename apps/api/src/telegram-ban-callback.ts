/**
 * Telegram webhook callback for Template Ban OVERBOARD (PASS 3C).
 *
 * Binding uses resolveTelegramShareExternalEntry (E-44/E-45).
 * OVERBOARD uses executeIncomingOverboardVertical (E-15 → E-20).
 * Product Engine / Matrix / Kernel are not modified.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { asTelegramUserId, type AuthenticatedContext } from "@98plus/identity";
import {
  buildTelegramBanMessageText,
  buildTelegramBanReplyMarkup,
  buildTemplateShareDeepLink,
  normalizeTelegramBotUsername,
  parseTelegramBanOverboardCallbackData,
} from "./telegram-share.ts";
import { resolveTelegramShareExternalEntry } from "./external-entry.ts";
import { executeIncomingOverboardVertical } from "./overboard.ts";
import type { CreateBanContactRuntime } from "./runtime.ts";
import type { TelegramBanCallbackOutcome } from "./telegram-ban-message-store.ts";
import {
  isPc02ProbeCallbackData,
  processPc02ProbeCallback,
} from "./telegram-pc02-probe.ts";

export const TELEGRAM_BAN_WEBHOOK_PATH = "/api/telegram/webhook";
export const TELEGRAM_WEBHOOK_SECRET_HEADER = "x-telegram-bot-api-secret-token";

export type TelegramBanCallbackResult = Readonly<{
  ok: boolean;
  code: string;
  message: string;
  attemptId: string | null;
  banId: string | null;
  controlState: string | null;
  edited: boolean;
  telegramDescription: string | null;
}>;

type CallbackQuery = Readonly<{
  id?: string;
  from?: { id?: number };
  data?: string;
  inline_message_id?: string;
}>;

type TelegramUpdate = Readonly<{
  update_id?: number;
  callback_query?: CallbackQuery;
}>;

type CallbackDeps = Readonly<{
  fetchImpl?: typeof fetch;
  botToken?: string;
  botUsername?: string;
  webhookSecret?: string;
}>;

export function isTelegramBanWebhookPath(pathname: string): boolean {
  return pathname === TELEGRAM_BAN_WEBHOOK_PATH;
}

export function expectedTelegramWebhookSecret(
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const value = env.TELEGRAM_WEBHOOK_SECRET?.trim() ?? "";
  return value.length > 0 ? value : null;
}

export async function handleTelegramBanWebhookRequest(
  runtime: CreateBanContactRuntime,
  req: IncomingMessage,
  res: ServerResponse,
  deps: CallbackDeps = {},
): Promise<void> {
  const expectedSecret = deps.webhookSecret ?? expectedTelegramWebhookSecret();
  if (!expectedSecret) {
    writeJson(res, 503, {
      ok: false,
      code: "WEBHOOK_SECRET_MISSING",
      message: "TELEGRAM_WEBHOOK_SECRET is not configured",
    });
    return;
  }
  const provided = headerValue(req, TELEGRAM_WEBHOOK_SECRET_HEADER);
  if (provided !== expectedSecret) {
    writeJson(res, 401, {
      ok: false,
      code: "WEBHOOK_SECRET_INVALID",
      message: "Telegram webhook secret token mismatch",
    });
    return;
  }
  const body = await readJsonBody(req);
  if (body === null) {
    writeJson(res, 400, {
      ok: false,
      code: "INVALID_BODY",
      message: "Telegram update must be a JSON object",
    });
    return;
  }
  const result = await processTelegramBanUpdate(runtime, body as TelegramUpdate, deps);
  // Always acknowledge validly authenticated updates so Telegram does not retry forever.
  writeJson(res, 200, result);
}

export async function processTelegramBanUpdate(
  runtime: CreateBanContactRuntime,
  update: TelegramUpdate,
  deps: CallbackDeps = {},
): Promise<TelegramBanCallbackResult> {
  const query = update.callback_query;
  if (!query) {
    return result({
      code: "IGNORED_UPDATE",
      message: "Update has no callback_query",
    });
  }
  const callbackQueryId = typeof query.id === "string" ? query.id : "";
  const telegramUserId =
    typeof query.from?.id === "number" && Number.isInteger(query.from.id) && query.from.id > 0
      ? String(query.from.id)
      : "";
  const callbackData = typeof query.data === "string" ? query.data : "";
  const inlineMessageId =
    typeof query.inline_message_id === "string" && query.inline_message_id.length > 0
      ? query.inline_message_id
      : null;

  // PC-02 isolated probe branch — must run before Ban OVERBOARD parsing.
  // Unknown / disabled probe paths never reach Product Engine or Ban stores.
  if (callbackQueryId && telegramUserId && isPc02ProbeCallbackData(callbackData)) {
    const probe = await processPc02ProbeCallback(
      { callbackQueryId, fromTelegramUserId: telegramUserId },
      deps,
    );
    return result({
      ok: probe.ok,
      code: probe.code,
      message: probe.message,
      telegramDescription: probe.telegramApiError,
    });
  }

  const token = parseTelegramBanOverboardCallbackData(callbackData);
  if (!callbackQueryId || !telegramUserId || !token) {
    await answerCallbackQuery(deps, callbackQueryId || "missing", "Unsupported button");
    return result({
      code: "UNSUPPORTED_CALLBACK",
      message: "callback_query is missing fields or is not an OVERBOARD button",
    });
  }

  const prior = await runtime.telegramBanMessageStore.findCallbackReceipt(callbackQueryId);
  if (prior) {
    await answerCallbackQuery(deps, callbackQueryId);
    return result({
      code: "DUPLICATE_CALLBACK",
      message: "callback_query.id already processed",
      attemptId: prior.attemptId,
    });
  }

  const delivery =
    (await runtime.telegramBanMessageStore.findDeliveryByToken(token)) ??
    (await hydrateDeliveryFromShare(runtime, token));
  if (!delivery) {
    await answerCallbackQuery(deps, callbackQueryId, "Ban not found");
    return result({
      code: "SHARE_NOT_FOUND",
      message: "No Template share matches this callback token",
    });
  }

  return runtime.telegramBanMessageStore.withAttemptLock(delivery.attemptId, async () => {
    const duplicate = await runtime.telegramBanMessageStore.findCallbackReceipt(callbackQueryId);
    if (duplicate) {
      await answerCallbackQuery(deps, callbackQueryId);
      return result({
        code: "DUPLICATE_CALLBACK",
        message: "callback_query.id already processed",
        attemptId: duplicate.attemptId,
        banId: delivery.banId,
      });
    }

    if (inlineMessageId) {
      await runtime.telegramBanMessageStore.setInlineMessageId(delivery.attemptId, inlineMessageId);
    }

    const identity = await runtime.identityStore.resolveByTelegramUserId(
      asTelegramUserId(telegramUserId),
    );
    const context: AuthenticatedContext = {
      currentUserId: identity.userId,
      currentTelegramUser: { telegramUserId: identity.telegramUserId },
      authenticationMethod: "telegram",
    };

    const shareLookup = await runtime.productStore.findShareByToken(token);
    if (!shareLookup) {
      await record(runtime, callbackQueryId, delivery.attemptId, telegramUserId, "REJECTED");
      await answerCallbackQuery(deps, callbackQueryId, "Share missing");
      return result({
        code: "SHARE_NOT_FOUND",
        message: "ShareOperation no longer exists",
        attemptId: delivery.attemptId,
        banId: delivery.banId,
      });
    }
    if (shareLookup.ownerId === context.currentUserId) {
      await record(runtime, callbackQueryId, delivery.attemptId, telegramUserId, "REJECTED");
      await answerCallbackQuery(deps, callbackQueryId, "Sender cannot press ПЕРЕБОР");
      return result({
        code: "SENDER_FORBIDDEN",
        message: "Share owner cannot OVERBOARD their own Ban",
        attemptId: delivery.attemptId,
        banId: delivery.banId,
      });
    }

    const bound = await resolveTelegramShareExternalEntry(
      runtime,
      context,
      `share_${token}`,
    );
    if (bound.orchestration.outcome !== "RESOLVED") {
      await record(runtime, callbackQueryId, delivery.attemptId, telegramUserId, "REJECTED");
      await answerCallbackQuery(deps, callbackQueryId, "Cannot bind this Ban");
      return result({
        code: "BINDING_REJECTED",
        message: `Share binding outcome ${bound.orchestration.outcome}`,
        attemptId: delivery.attemptId,
        banId: delivery.banId,
        controlState: bound.last?.controlState ?? null,
      });
    }

    const loaded = await runtime.productStore.loadProductSnapshot(context.currentUserId);
    if (loaded.snapshot.controlState !== "NOTIFICATIONS.INCOMING_BAN") {
      await record(runtime, callbackQueryId, delivery.attemptId, telegramUserId, "REJECTED");
      await answerCallbackQuery(deps, callbackQueryId, "Ban is not Incoming");
      return result({
        code: "INCOMING_NOT_ACTIVE",
        message: "E-15 requires NOTIFICATIONS.INCOMING_BAN after binding",
        attemptId: delivery.attemptId,
        banId: delivery.banId,
        controlState: loaded.snapshot.controlState,
      });
    }

    const overboard = await executeIncomingOverboardVertical(runtime, context, {
      name: "NOTIFICATIONS.PRESS_OVERBOARD",
      payload: {},
    });
    const applied =
      overboard.last.event.name === "NOTIFICATIONS.OVERBOARD_CONFIRMED" &&
      overboard.last.status === "APPLIED";
    if (!applied) {
      await record(
        runtime,
        callbackQueryId,
        delivery.attemptId,
        telegramUserId,
        "OVERBOARD_NOT_APPLIED",
      );
      await answerCallbackQuery(deps, callbackQueryId, "ПЕРЕБОР is not available");
      return result({
        code: "OVERBOARD_NOT_APPLIED",
        message: `Product guard rejected OVERBOARD (${overboard.last.event.name}/${overboard.last.status})`,
        attemptId: delivery.attemptId,
        banId: delivery.banId,
        controlState: overboard.last.controlState,
      });
    }

    const editTarget =
      inlineMessageId ??
      (await runtime.telegramBanMessageStore.findDeliveryByAttemptId(delivery.attemptId))
        ?.inlineMessageId ??
      null;
    let edited = false;
    let telegramDescription: string | null = null;
    if (editTarget) {
      const ban = overboard.last.snapshot.extended.entities.bans[delivery.banId as never];
      const botUsername = normalizeTelegramBotUsername(
        deps.botUsername ?? process.env.TELEGRAM_BOT_USERNAME ?? "",
      );
      const shareUrl = botUsername
        ? buildTemplateShareDeepLink({ botUsername, token })
        : "";
      const edit = await editOverboardMessage(deps, {
        inlineMessageId: editTarget,
        banText: ban?.banText ?? "",
        durationMinutes: Number(ban?.durationMinutes ?? 0),
        shareUrl,
        token,
      });
      edited = edit.ok;
      telegramDescription = edit.ok ? null : edit.description;
    }

    await record(
      runtime,
      callbackQueryId,
      delivery.attemptId,
      telegramUserId,
      edited || !editTarget ? "OVERBOARD_APPLIED" : "EDIT_FAILED",
    );
    await answerCallbackQuery(deps, callbackQueryId, "ПЕРЕБОР");
    return result({
      ok: true,
      code: edited || !editTarget ? "OVERBOARD_APPLIED" : "OVERBOARD_APPLIED_EDIT_FAILED",
      message:
        edited || !editTarget
          ? "OVERBOARD applied through existing Product Events"
          : "OVERBOARD applied; Telegram editMessageText failed",
      attemptId: delivery.attemptId,
      banId: delivery.banId,
      controlState: overboard.last.controlState,
      edited,
      telegramDescription,
    });
  });
}

async function hydrateDeliveryFromShare(
  runtime: CreateBanContactRuntime,
  token: string,
): Promise<Awaited<ReturnType<CreateBanContactRuntime["telegramBanMessageStore"]["findDeliveryByToken"]>>> {
  const lookup = await runtime.productStore.findShareByToken(token);
  if (!lookup?.share.createdBanId) {
    return null;
  }
  return runtime.telegramBanMessageStore.upsertDelivery({
    attemptId: String(lookup.share.attemptId),
    banId: String(lookup.share.createdBanId),
    shareToken: token,
  });
}

async function record(
  runtime: CreateBanContactRuntime,
  callbackQueryId: string,
  attemptId: string,
  telegramUserId: string,
  outcome: TelegramBanCallbackOutcome,
): Promise<void> {
  await runtime.telegramBanMessageStore.recordCallbackReceipt({
    callbackQueryId,
    attemptId,
    telegramUserId,
    outcome,
  });
}

async function answerCallbackQuery(
  deps: CallbackDeps,
  callbackQueryId: string,
  text?: string,
): Promise<void> {
  if (!callbackQueryId || callbackQueryId === "missing") {
    return;
  }
  const botToken = (deps.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken) {
    return;
  }
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (text) {
    body.text = text;
    body.show_alert = false;
  }
  await callTelegram(deps.fetchImpl ?? fetch, botToken, "answerCallbackQuery", body);
}

async function editOverboardMessage(
  deps: CallbackDeps,
  input: {
    inlineMessageId: string;
    banText: string;
    durationMinutes: number;
    shareUrl: string;
    token: string;
  },
): Promise<{ ok: true } | { ok: false; description: string }> {
  const botToken = (deps.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken) {
    return { ok: false, description: "TELEGRAM_BOT_TOKEN missing" };
  }
  if (!input.shareUrl) {
    return { ok: false, description: "TELEGRAM_BOT_USERNAME missing for reply URL" };
  }
  return callTelegram(deps.fetchImpl ?? fetch, botToken, "editMessageText", {
    inline_message_id: input.inlineMessageId,
    text: buildTelegramBanMessageText({
      banText: input.banText,
      durationMinutes: input.durationMinutes,
      shareUrl: input.shareUrl,
      statusLine: "Status: ПЕРЕБОР",
    }),
    reply_markup: buildTelegramBanReplyMarkup({
      shareUrl: input.shareUrl,
      token: input.token,
      includeOverboard: false,
    }),
  });
}

async function callTelegram(
  fetchImpl: typeof fetch,
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: true } | { ok: false; description: string }> {
  let response: Response;
  try {
    response = await fetchImpl(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "network failure";
    return { ok: false, description: redact(`${method} network failure: ${message}`, botToken) };
  }
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return {
      ok: false,
      description: redact(`${method} returned non-JSON (HTTP ${response.status})`, botToken),
    };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, description: `${method} returned an unexpected body` };
  }
  const record = parsed as { ok?: unknown; description?: unknown };
  if (record.ok !== true) {
    const description =
      typeof record.description === "string" ? record.description : `HTTP ${response.status}`;
    return { ok: false, description: redact(description, botToken) };
  }
  return { ok: true };
}

function redact(value: string, botToken: string): string {
  return botToken.length > 0 ? value.split(botToken).join("[redacted]") : value;
}

function result(
  partial: Partial<TelegramBanCallbackResult> &
    Pick<TelegramBanCallbackResult, "code" | "message">,
): TelegramBanCallbackResult {
  return {
    ok: partial.ok ?? false,
    code: partial.code,
    message: partial.message,
    attemptId: partial.attemptId ?? null,
    banId: partial.banId ?? null,
    controlState: partial.controlState ?? null,
    edited: partial.edited ?? false,
    telegramDescription: partial.telegramDescription ?? null,
  };
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(JSON.stringify(body));
}

function headerValue(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (Array.isArray(value) && typeof value[0] === "string" && value[0].trim().length > 0) {
    return value[0].trim();
  }
  return null;
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return {};
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (raw.length === 0) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}
