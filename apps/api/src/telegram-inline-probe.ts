/**
 * Temporary inline-edit probe for one Mini App launch: startapp=inline_probe.
 *
 * savePreparedInlineMessage → shareMessage → callback_query → inline_message_id
 * → answerCallbackQuery → editMessageText.
 *
 * This is not a Telegram updates service. Offset and the single-flight poll lock
 * live only in this process. No webhook, no product event, no database write.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AuthenticationError,
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
  verifyTelegramInitData,
} from "@98plus/identity";

export const INLINE_PROBE_START_PARAM = "inline_probe";
export const INLINE_PROBE_TEXT = "98+ INLINE PROBE";
export const INLINE_PROBE_EDITED_TEXT = "98+ INLINE PROBE — EDITED";
export const INLINE_PROBE_PREPARE_PATH = "/api/telegram-inline-probe/prepare";
export const INLINE_PROBE_WATCH_PATH = "/api/telegram-inline-probe/watch";
export const INLINE_PROBE_POLL_MS = 20_000;

const PROBE_ID_BYTES = 12;
const MAX_POLL_CALLS = 20;
const BUTTON_TEXT = "Edit this probe";

export type TelegramInlineProbeResult = Readonly<{
  ok: boolean;
  code: string;
  message: string;
  probeId: string | null;
  preparedMessageId: string | null;
  callbackData: string | null;
  inlineMessageId: string | null;
  editedText: string | null;
  updatesSeen: number;
  ignoredUpdates: number;
  pollCalls: number;
  answerCallbackQueryOk: boolean | null;
  editMessageTextOk: boolean | null;
  telegramMethod: string | null;
  telegramDescription: string | null;
}>;

type PreparedProbe = Readonly<{
  probeId: string;
  callbackData: string;
  telegramUserId: string;
  preparedMessageId: string;
}>;

type TelegramUpdate = Readonly<{
  update_id?: number;
  callback_query?: Readonly<{
    id?: string;
    data?: string;
    inline_message_id?: string;
  }>;
}>;

type ProbeDeps = Readonly<{
  fetchImpl?: typeof fetch;
  now?: () => number;
  pollForMs?: number;
  botToken?: string;
  randomId?: () => string;
}>;

const preparedProbes = new Map<string, PreparedProbe>();
let nextOffset: number | undefined;
let polling = false;
let fetchOverride: typeof fetch | null = null;

const identityClock = {
  nowSeconds: () => Math.floor(Date.now() / 1000),
};

export function isTelegramInlineProbePath(pathname: string): boolean {
  return pathname === INLINE_PROBE_PREPARE_PATH || pathname === INLINE_PROBE_WATCH_PATH;
}

export function resetTelegramInlineProbeStateForTests(): void {
  preparedProbes.clear();
  nextOffset = undefined;
  polling = false;
  fetchOverride = null;
}

export function setTelegramInlineProbeFetchForTests(fetchImpl: typeof fetch | null): void {
  fetchOverride = fetchImpl;
}

export async function handleTelegramInlineProbeRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const body = await readProbeBody(req);
  if (body === null) {
    writeProbeJson(res, 400, result({ code: "INVALID_BODY", message: "JSON body must be an object" }));
    return;
  }
  const verified = verifyProbeCaller(headerValue(req, "x-98-init-data"));
  if (!verified.ok) {
    writeProbeJson(res, statusFor(verified.result), verified.result);
    return;
  }
  const deps: ProbeDeps = {};
  if (pathname === INLINE_PROBE_PREPARE_PATH) {
    const prepared = await prepareTelegramInlineProbe(verified.telegramUserId, deps);
    writeProbeJson(res, statusFor(prepared), prepared);
    return;
  }
  const probeId = typeof body.probeId === "string" ? body.probeId : "";
  const watched = await watchTelegramInlineProbe(verified.telegramUserId, probeId, deps);
  writeProbeJson(res, statusFor(watched), watched);
}

export async function prepareTelegramInlineProbe(
  telegramUserId: string,
  deps: ProbeDeps = {},
): Promise<TelegramInlineProbeResult> {
  const botToken = resolveBotToken(deps);
  if (botToken === null) {
    return result({
      code: "TELEGRAM_BOT_TOKEN_MISSING",
      message: "TELEGRAM_BOT_TOKEN is required to prepare the inline probe",
    });
  }
  const userId = Number(telegramUserId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return result({
      code: "INVALID_TELEGRAM_USER",
      message: "Telegram user id must be a positive integer",
    });
  }
  const probeId = (deps.randomId ?? randomProbeId)();
  const callbackData = `probe:${probeId}`;
  if (Buffer.byteLength(callbackData) > 64) {
    return result({
      code: "PROBE_CALLBACK_DATA_TOO_LONG",
      message: "Probe callback_data exceeds 64 bytes",
      probeId,
      callbackData,
    });
  }
  const telegram = await callTelegram(resolveFetch(deps), botToken, "savePreparedInlineMessage", {
    user_id: userId,
    result: {
      type: "article",
      id: probeId,
      title: INLINE_PROBE_TEXT,
      input_message_content: {
        message_text: INLINE_PROBE_TEXT,
      },
      reply_markup: inlineKeyboard(callbackData),
    },
    allow_user_chats: true,
    allow_bot_chats: false,
    allow_group_chats: false,
    allow_channel_chats: false,
  });
  if (!telegram.ok) {
    return result({
      code: "TELEGRAM_API",
      message: "savePreparedInlineMessage failed",
      probeId,
      callbackData,
      telegramMethod: "savePreparedInlineMessage",
      telegramDescription: telegram.description,
    });
  }
  const preparedMessageId = readPreparedId(telegram.result);
  if (preparedMessageId === null) {
    return result({
      code: "TELEGRAM_API",
      message: "savePreparedInlineMessage did not return a prepared message id",
      probeId,
      callbackData,
      telegramMethod: "savePreparedInlineMessage",
      telegramDescription: "result.id missing",
    });
  }
  preparedProbes.set(probeId, {
    probeId,
    callbackData,
    telegramUserId,
    preparedMessageId,
  });
  return result({
    ok: true,
    code: "PREPARED",
    message: "Prepared inline probe. shareMessage can send it. This is not a Ban.",
    probeId,
    preparedMessageId,
    callbackData,
  });
}

export async function watchTelegramInlineProbe(
  telegramUserId: string,
  probeId: string,
  deps: ProbeDeps = {},
): Promise<TelegramInlineProbeResult> {
  const probe = preparedProbes.get(probeId);
  if (!probe || probe.telegramUserId !== telegramUserId) {
    return result({
      code: "PROBE_UNKNOWN",
      message: "Unknown inline probe for this Telegram user",
      probeId: probeId.length > 0 ? probeId : null,
    });
  }
  if (polling) {
    return result({
      code: "PROBE_POLL_BUSY",
      message: "Another inline probe poll is already running",
      probeId: probe.probeId,
      preparedMessageId: probe.preparedMessageId,
      callbackData: probe.callbackData,
    });
  }
  const botToken = resolveBotToken(deps);
  if (botToken === null) {
    return result({
      code: "TELEGRAM_BOT_TOKEN_MISSING",
      message: "TELEGRAM_BOT_TOKEN is required to watch the inline probe",
      probeId: probe.probeId,
      preparedMessageId: probe.preparedMessageId,
      callbackData: probe.callbackData,
    });
  }
  if ((process.env.TELEGRAM_WEBHOOK_SECRET ?? "").trim().length > 0) {
    return result({
      code: "PROBE_WEBHOOK_CONFIGURED",
      message:
        "TELEGRAM_WEBHOOK_SECRET is set. Probe getUpdates must not run beside the Ban webhook.",
      probeId: probe.probeId,
      preparedMessageId: probe.preparedMessageId,
      callbackData: probe.callbackData,
    });
  }

  polling = true;
  const now = deps.now ?? Date.now;
  const pollForMs = deps.pollForMs ?? INLINE_PROBE_POLL_MS;
  const deadline = now() + pollForMs;
  let updatesSeen = 0;
  let ignoredUpdates = 0;
  let pollCalls = 0;
  try {
    while (now() < deadline && pollCalls < MAX_POLL_CALLS) {
      const remainingMs = deadline - now();
      const timeoutSec = Math.min(20, Math.max(1, Math.ceil(remainingMs / 1000)));
      const startedCall = now();
      const requestBody: Record<string, number> = { timeout: timeoutSec, limit: 100 };
      if (nextOffset !== undefined) {
        requestBody.offset = nextOffset;
      }
      const telegram = await callTelegram(
        resolveFetch(deps),
        botToken,
        "getUpdates",
        requestBody,
      );
      pollCalls += 1;
      if (!telegram.ok) {
        return result({
          code: "TELEGRAM_API",
          message: "getUpdates failed",
          probeId: probe.probeId,
          preparedMessageId: probe.preparedMessageId,
          callbackData: probe.callbackData,
          updatesSeen,
          ignoredUpdates,
          pollCalls,
          telegramMethod: "getUpdates",
          telegramDescription: telegram.description,
        });
      }
      const updates = readUpdates(telegram.result);
      confirmOffset(updates);
      updatesSeen += updates.length;
      const match = matchingCallback(updates, probe.callbackData);
      ignoredUpdates += updates.length - (match ? 1 : 0);
      if (match) {
        return await editMatchedProbe(probe, match, botToken, deps, {
          updatesSeen,
          ignoredUpdates,
          pollCalls,
        });
      }
      if (updates.length === 0 && now() - startedCall < timeoutSec * 1000 - 500) {
        return result({
          code: "PROBE_POLL_NOT_HELD",
          message:
            "getUpdates returned no updates without holding the long poll. Polling stopped.",
          probeId: probe.probeId,
          preparedMessageId: probe.preparedMessageId,
          callbackData: probe.callbackData,
          updatesSeen,
          ignoredUpdates,
          pollCalls,
          telegramMethod: "getUpdates",
        });
      }
    }
    const code = pollCalls >= MAX_POLL_CALLS ? "PROBE_POLL_CALL_LIMIT" : "PROBE_CALLBACK_TIMEOUT";
    return result({
      code,
      message:
        code === "PROBE_POLL_CALL_LIMIT"
          ? "Polling stopped at the call limit before a matching callback_query."
          : "Polling finished. No callback_query matched this probe.",
      probeId: probe.probeId,
      preparedMessageId: probe.preparedMessageId,
      callbackData: probe.callbackData,
      updatesSeen,
      ignoredUpdates,
      pollCalls,
    });
  } finally {
    polling = false;
  }
}

function verifyProbeCaller(
  initData: string | null,
): { ok: true; telegramUserId: string } | { ok: false; result: TelegramInlineProbeResult } {
  if (!initData) {
    return {
      ok: false,
      result: result({
        code: "MISSING_INIT_DATA",
        message: "Telegram initData is required. Development auth cannot run the inline probe.",
      }),
    };
  }
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim() ?? "";
  if (botToken.length === 0) {
    return {
      ok: false,
      result: result({
        code: "TELEGRAM_BOT_TOKEN_MISSING",
        message: "TELEGRAM_BOT_TOKEN is required to verify the inline probe",
      }),
    };
  }
  try {
    const verified = verifyTelegramInitData(
      initData,
      botToken,
      TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
      identityClock,
    );
    const startParam = new URLSearchParams(initData).get("start_param");
    if (startParam !== INLINE_PROBE_START_PARAM) {
      return {
        ok: false,
        result: result({
          code: "PROBE_START_PARAM_REQUIRED",
          message: "Inline probe routes accept only start_param inline_probe",
        }),
      };
    }
    return { ok: true, telegramUserId: String(verified.telegramUserId) };
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return {
        ok: false,
        result: result({ code: error.code, message: error.message }),
      };
    }
    throw error;
  }
}

async function editMatchedProbe(
  probe: PreparedProbe,
  match: { callbackQueryId: string | null; inlineMessageId: string | null },
  botToken: string,
  deps: ProbeDeps,
  counts: { updatesSeen: number; ignoredUpdates: number; pollCalls: number },
): Promise<TelegramInlineProbeResult> {
  const base = {
    probeId: probe.probeId,
    preparedMessageId: probe.preparedMessageId,
    callbackData: probe.callbackData,
    updatesSeen: counts.updatesSeen,
    ignoredUpdates: counts.ignoredUpdates,
    pollCalls: counts.pollCalls,
  };
  if (!match.callbackQueryId) {
    return result({
      ...base,
      code: "CALLBACK_QUERY_ID_MISSING",
      message: "Matching callback_query had no id. editMessageText was not called.",
    });
  }
  const answer = await callTelegram(resolveFetch(deps), botToken, "answerCallbackQuery", {
    callback_query_id: match.callbackQueryId,
  });
  if (!match.inlineMessageId) {
    return result({
      ...base,
      code: "INLINE_MESSAGE_ID_MISSING",
      message: "Matching callback_query had no inline_message_id. editMessageText was not called.",
      answerCallbackQueryOk: answer.ok,
      telegramMethod: answer.ok ? null : "answerCallbackQuery",
      telegramDescription: answer.ok ? null : answer.description,
    });
  }
  const edited = await callTelegram(resolveFetch(deps), botToken, "editMessageText", {
    inline_message_id: match.inlineMessageId,
    text: INLINE_PROBE_EDITED_TEXT,
    reply_markup: inlineKeyboard(probe.callbackData),
  });
  if (!edited.ok) {
    const answerNote = answer.ok ? "" : ` answerCallbackQuery failed: ${answer.description}`;
    return result({
      ...base,
      code: "TELEGRAM_API",
      message: `editMessageText failed.${answerNote}`,
      inlineMessageId: match.inlineMessageId,
      answerCallbackQueryOk: answer.ok,
      editMessageTextOk: false,
      telegramMethod: "editMessageText",
      telegramDescription: edited.description,
    });
  }
  const answerNote = answer.ok ? "" : ` answerCallbackQuery failed: ${answer.description}`;
  return result({
    ...base,
    ok: true,
    code: "EDITED",
    message: `Edited the inline probe message.${answerNote}`,
    inlineMessageId: match.inlineMessageId,
    editedText: INLINE_PROBE_EDITED_TEXT,
    answerCallbackQueryOk: answer.ok,
    editMessageTextOk: true,
    telegramMethod: answer.ok ? null : "answerCallbackQuery",
    telegramDescription: answer.ok ? null : answer.description,
  });
}

function matchingCallback(
  updates: readonly TelegramUpdate[],
  callbackData: string,
): { callbackQueryId: string | null; inlineMessageId: string | null } | null {
  for (const update of updates) {
    const query = update.callback_query;
    if (!query || query.data !== callbackData) {
      continue;
    }
    return {
      callbackQueryId: typeof query.id === "string" && query.id.length > 0 ? query.id : null,
      inlineMessageId:
        typeof query.inline_message_id === "string" && query.inline_message_id.length > 0
          ? query.inline_message_id
          : null,
    };
  }
  return null;
}

function confirmOffset(updates: readonly TelegramUpdate[]): void {
  for (const update of updates) {
    if (typeof update.update_id !== "number" || !Number.isInteger(update.update_id)) {
      continue;
    }
    const candidate = update.update_id + 1;
    if (nextOffset === undefined || candidate > nextOffset) {
      nextOffset = candidate;
    }
  }
}

function readUpdates(value: unknown): TelegramUpdate[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const updates: TelegramUpdate[] = [];
  for (const entry of value) {
    if (entry !== null && typeof entry === "object") {
      updates.push(entry as TelegramUpdate);
    }
  }
  return updates;
}

function readPreparedId(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function inlineKeyboard(callbackData: string): {
  inline_keyboard: [[{ text: string; callback_data: string }]];
} {
  return {
    inline_keyboard: [[{ text: BUTTON_TEXT, callback_data: callbackData }]],
  };
}

async function callTelegram(
  fetchImpl: typeof fetch,
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; result: unknown } | { ok: false; description: string }> {
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
      description: redact(`${method} returned a non-JSON body (HTTP ${response.status})`, botToken),
    };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, description: `${method} returned an unexpected body` };
  }
  const record = parsed as { ok?: unknown; description?: unknown; result?: unknown };
  if (record.ok !== true) {
    const description =
      typeof record.description === "string" ? record.description : `HTTP ${response.status}`;
    return { ok: false, description: redact(description, botToken) };
  }
  return { ok: true, result: record.result };
}

function resolveFetch(deps: ProbeDeps): typeof fetch {
  return deps.fetchImpl ?? fetchOverride ?? fetch;
}

function resolveBotToken(deps: ProbeDeps): string | null {
  const token = (deps.botToken ?? process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  return token.length > 0 ? token : null;
}

function randomProbeId(): string {
  return randomBytes(PROBE_ID_BYTES).toString("hex");
}

function redact(value: string, botToken: string): string {
  if (botToken.length === 0) {
    return value;
  }
  return value.split(botToken).join("[redacted]");
}

function result(
  partial: Partial<TelegramInlineProbeResult> & Pick<TelegramInlineProbeResult, "code" | "message">,
): TelegramInlineProbeResult {
  return {
    ok: partial.ok ?? false,
    code: partial.code,
    message: partial.message,
    probeId: partial.probeId ?? null,
    preparedMessageId: partial.preparedMessageId ?? null,
    callbackData: partial.callbackData ?? null,
    inlineMessageId: partial.inlineMessageId ?? null,
    editedText: partial.editedText ?? null,
    updatesSeen: partial.updatesSeen ?? 0,
    ignoredUpdates: partial.ignoredUpdates ?? 0,
    pollCalls: partial.pollCalls ?? 0,
    answerCallbackQueryOk: partial.answerCallbackQueryOk ?? null,
    editMessageTextOk: partial.editMessageTextOk ?? null,
    telegramMethod: partial.telegramMethod ?? null,
    telegramDescription: partial.telegramDescription ?? null,
  };
}

function statusFor(value: TelegramInlineProbeResult): number {
  if (value.ok) {
    return 200;
  }
  switch (value.code) {
    case "MISSING_INIT_DATA":
    case "MISSING_BOT_TOKEN":
    case "MISSING_REQUIRED_DATA":
    case "INVALID_SIGNATURE":
    case "INVALID_INIT_DATA":
    case "STALE_AUTH_DATE":
    case "TAMPERED_USER":
      return 401;
    case "PROBE_START_PARAM_REQUIRED":
      return 403;
    case "PROBE_UNKNOWN":
    case "INVALID_BODY":
    case "INVALID_TELEGRAM_USER":
      return 400;
    case "PROBE_POLL_BUSY":
      return 409;
    case "TELEGRAM_BOT_TOKEN_MISSING":
    case "TELEGRAM_API":
      return 502;
    default:
      return 200;
  }
}

function writeProbeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
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

async function readProbeBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
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
