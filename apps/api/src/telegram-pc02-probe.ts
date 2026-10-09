/**
 * PC-02 device probe — isolated diagnostic only.
 *
 * callback_data namespace: pc02_probe
 * Does not touch Product Engine, Ban lifecycle, OVERBOARD, or Reply URL buttons.
 * TEST_* IDs come from env only; never commit real values.
 */

import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  AuthenticationError,
  TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
  verifyTelegramInitData,
} from "@98plus/identity";
import { normalizeTelegramBotUsername } from "./telegram-share.ts";

export const PC02_PROBE_CALLBACK_DATA = "pc02_probe";
export const PC02_PROBE_START_PARAM = "pc02_probe";
export const PC02_PROBE_BUTTON_TEXT = "PC02 TEST";
export const PC02_PROBE_MESSAGE_TEXT =
  "98+ PC-02 PROBE\nIsolated role-gated Mini App open test.\nNot a Ban.";
export const PC02_PROBE_PREPARE_PATH = "/api/telegram-pc02-probe/prepare";
export const PC02_PROBE_RESULTS_PATH = "/api/telegram-pc02-probe/results";

const MAX_DIAGNOSTIC_EVENTS = 40;
const PREPARE_ID_BYTES = 8;

export type Pc02ProbeRoleBranch =
  | "SENDER_NOOP"
  | "RECEIVER_OPEN"
  | "UNKNOWN_NOOP"
  | "DISABLED_NOOP"
  | "MISCONFIGURED_NOOP";

export type Pc02ProbeUrlMode = "startapp" | "start";

export type Pc02ProbeAnswerKind = "no_url" | "url_startapp" | "url_start";

export type Pc02ProbeDiagnosticEvent = Readonly<{
  atMs: number;
  callbackReceived: true;
  branch: Pc02ProbeRoleBranch;
  answerKind: Pc02ProbeAnswerKind;
  openUrlHostPath: string | null;
  telegramApiAccepted: boolean | null;
  telegramApiError: string | null;
}>;

export type Pc02ProbeCallbackResult = Readonly<{
  ok: boolean;
  code: string;
  message: string;
  branch: Pc02ProbeRoleBranch;
  answerKind: Pc02ProbeAnswerKind;
  telegramApiAccepted: boolean | null;
  telegramApiError: string | null;
}>;

export type Pc02ProbePrepareResult = Readonly<{
  ok: boolean;
  code: string;
  message: string;
  preparedMessageId: string | null;
  callbackData: string | null;
  urlMode: Pc02ProbeUrlMode | null;
  controlStartUrl: string | null;
  startappUrl: string | null;
}>;

export type Pc02ProbeResultsResult = Readonly<{
  ok: boolean;
  code: string;
  message: string;
  enabled: boolean;
  urlMode: Pc02ProbeUrlMode;
  events: readonly Pc02ProbeDiagnosticEvent[];
}>;

type ProbeDeps = Readonly<{
  fetchImpl?: typeof fetch;
  botToken?: string;
  botUsername?: string;
  env?: NodeJS.ProcessEnv;
  nowMs?: () => number;
}>;

const diagnosticEvents: Pc02ProbeDiagnosticEvent[] = [];

const identityClock = {
  nowSeconds: () => Math.floor(Date.now() / 1000),
};

export function isPc02ProbeHttpPath(pathname: string): boolean {
  return pathname === PC02_PROBE_PREPARE_PATH || pathname === PC02_PROBE_RESULTS_PATH;
}

export function isPc02ProbeCallbackData(data: string): boolean {
  return data === PC02_PROBE_CALLBACK_DATA;
}

export function isPc02ProbeStartParam(raw: string | null | undefined): boolean {
  return typeof raw === "string" && raw.trim() === PC02_PROBE_START_PARAM;
}

export function resetPc02ProbeStateForTests(): void {
  diagnosticEvents.length = 0;
}

export function readPc02ProbeConfig(env: NodeJS.ProcessEnv = process.env): Readonly<{
  enabled: boolean;
  senderId: string | null;
  receiverId: string | null;
  urlMode: Pc02ProbeUrlMode;
  botUsername: string | null;
}> {
  const enabled = (env.PC02_PROBE_ENABLED ?? "").trim() === "1";
  const senderId = positiveId(env.PC02_PROBE_TEST_SENDER_ID);
  const receiverId = positiveId(env.PC02_PROBE_TEST_RECEIVER_ID);
  const modeRaw = (env.PC02_PROBE_URL_MODE ?? "startapp").trim().toLowerCase();
  const urlMode: Pc02ProbeUrlMode = modeRaw === "start" ? "start" : "startapp";
  const botUsername = normalizeTelegramBotUsername(env.TELEGRAM_BOT_USERNAME ?? "");
  return {
    enabled,
    senderId,
    receiverId,
    urlMode,
    botUsername: botUsername.length > 0 ? botUsername : null,
  };
}

export function buildPc02ProbeOpenUrl(input: {
  botUsername: string;
  mode: Pc02ProbeUrlMode;
}): string {
  const bot = normalizeTelegramBotUsername(input.botUsername);
  if (input.mode === "start") {
    return `https://t.me/${bot}?start=${PC02_PROBE_START_PARAM}`;
  }
  return `https://t.me/${bot}?startapp=${PC02_PROBE_START_PARAM}`;
}

export async function processPc02ProbeCallback(
  input: Readonly<{
    callbackQueryId: string;
    fromTelegramUserId: string;
  }>,
  deps: ProbeDeps = {},
): Promise<Pc02ProbeCallbackResult> {
  const env = deps.env ?? process.env;
  const config = readPc02ProbeConfig(env);
  const nowMs = deps.nowMs ?? Date.now;

  if (!config.enabled) {
    return finishProbe({
      deps,
      callbackQueryId: input.callbackQueryId,
      branch: "DISABLED_NOOP",
      answerKind: "no_url",
      openUrl: null,
      code: "PC02_PROBE_DISABLED",
      message: "PC02 probe is disabled (PC02_PROBE_ENABLED!=1)",
      nowMs: nowMs(),
    });
  }

  if (!config.senderId || !config.receiverId) {
    return finishProbe({
      deps,
      callbackQueryId: input.callbackQueryId,
      branch: "MISCONFIGURED_NOOP",
      answerKind: "no_url",
      openUrl: null,
      code: "PC02_PROBE_IDS_MISSING",
      message: "PC02_PROBE_TEST_SENDER_ID / PC02_PROBE_TEST_RECEIVER_ID must be set in env",
      nowMs: nowMs(),
    });
  }

  if (input.fromTelegramUserId === config.senderId) {
    return finishProbe({
      deps,
      callbackQueryId: input.callbackQueryId,
      branch: "SENDER_NOOP",
      answerKind: "no_url",
      openUrl: null,
      code: "PC02_SENDER_NOOP",
      message: "Sender branch: answerCallbackQuery without url",
      nowMs: nowMs(),
    });
  }

  if (input.fromTelegramUserId === config.receiverId) {
    if (!config.botUsername) {
      return finishProbe({
        deps,
        callbackQueryId: input.callbackQueryId,
        branch: "MISCONFIGURED_NOOP",
        answerKind: "no_url",
        openUrl: null,
        code: "PC02_PROBE_BOT_USERNAME_MISSING",
        message: "TELEGRAM_BOT_USERNAME required to build Mini App open url",
        nowMs: nowMs(),
      });
    }
    const openUrl = buildPc02ProbeOpenUrl({
      botUsername: config.botUsername,
      mode: config.urlMode,
    });
    const answerKind: Pc02ProbeAnswerKind =
      config.urlMode === "start" ? "url_start" : "url_startapp";
    return finishProbe({
      deps,
      callbackQueryId: input.callbackQueryId,
      branch: "RECEIVER_OPEN",
      answerKind,
      openUrl,
      code: "PC02_RECEIVER_OPEN",
      message:
        config.urlMode === "start"
          ? "Receiver branch: answerCallbackQuery with ?start= control url"
          : "Receiver branch: answerCallbackQuery with ?startapp= url",
      nowMs: nowMs(),
    });
  }

  return finishProbe({
    deps,
    callbackQueryId: input.callbackQueryId,
    branch: "UNKNOWN_NOOP",
    answerKind: "no_url",
    openUrl: null,
    code: "PC02_UNKNOWN_NOOP",
    message: "Unknown Telegram user for PC02 probe: no-op without url",
    nowMs: nowMs(),
  });
}

export async function handleTelegramPc02ProbeRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://127.0.0.1").pathname;
  const body = await readJsonBody(req);
  if (body === null) {
    writeJson(res, 400, {
      ok: false,
      code: "INVALID_BODY",
      message: "JSON body must be an object",
      preparedMessageId: null,
      callbackData: null,
      urlMode: null,
      controlStartUrl: null,
      startappUrl: null,
    } satisfies Pc02ProbePrepareResult);
    return;
  }

  const verified = verifyProbeCaller(headerValue(req, "x-98-init-data"));
  if (!verified.ok) {
    writeJson(res, statusForAuth(verified.code), {
      ok: false,
      code: verified.code,
      message: verified.message,
      preparedMessageId: null,
      callbackData: null,
      urlMode: null,
      controlStartUrl: null,
      startappUrl: null,
    } satisfies Pc02ProbePrepareResult);
    return;
  }

  if (pathname === PC02_PROBE_RESULTS_PATH) {
    const results = readResultsForCaller(verified.telegramUserId);
    writeJson(res, results.ok ? 200 : statusForPrepare(results.code), results);
    return;
  }

  const prepared = await preparePc02ProbeMessage(verified.telegramUserId, {});
  writeJson(res, prepared.ok ? 200 : statusForPrepare(prepared.code), prepared);
}

export async function preparePc02ProbeMessage(
  callerTelegramUserId: string,
  deps: ProbeDeps = {},
): Promise<Pc02ProbePrepareResult> {
  const env = deps.env ?? process.env;
  const config = readPc02ProbeConfig(env);
  if (!config.enabled) {
    return prepareFail(
      "PC02_PROBE_DISABLED",
      "PC02 probe prepare requires PC02_PROBE_ENABLED=1",
    );
  }
  if (!config.senderId || !config.receiverId) {
    return prepareFail(
      "PC02_PROBE_IDS_MISSING",
      "Set PC02_PROBE_TEST_SENDER_ID and PC02_PROBE_TEST_RECEIVER_ID in process env",
    );
  }
  if (
    callerTelegramUserId !== config.senderId &&
    callerTelegramUserId !== config.receiverId
  ) {
    return prepareFail(
      "PC02_PROBE_CALLER_FORBIDDEN",
      "Prepare is limited to the configured test sender or receiver Telegram ids",
    );
  }
  if (!config.botUsername) {
    return prepareFail(
      "PC02_PROBE_BOT_USERNAME_MISSING",
      "TELEGRAM_BOT_USERNAME is required",
    );
  }
  const botToken = (deps.botToken ?? env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken) {
    return prepareFail("TELEGRAM_BOT_TOKEN_MISSING", "TELEGRAM_BOT_TOKEN is required");
  }
  const userId = Number(callerTelegramUserId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return prepareFail("INVALID_TELEGRAM_USER", "Telegram user id must be a positive integer");
  }

  const articleId = randomBytes(PREPARE_ID_BYTES).toString("hex");
  const telegram = await callTelegram(
    deps.fetchImpl ?? fetch,
    botToken,
    "savePreparedInlineMessage",
    {
      user_id: userId,
      result: {
        type: "article",
        id: articleId,
        title: "98+ PC02 PROBE",
        description: "Isolated PC-02 callback probe",
        input_message_content: {
          message_text: PC02_PROBE_MESSAGE_TEXT,
        },
        reply_markup: {
          inline_keyboard: [
            [{ text: PC02_PROBE_BUTTON_TEXT, callback_data: PC02_PROBE_CALLBACK_DATA }],
          ],
        },
      },
      allow_user_chats: true,
      allow_bot_chats: false,
      allow_group_chats: false,
      allow_channel_chats: false,
    },
  );
  if (!telegram.ok) {
    return {
      ok: false,
      code: "TELEGRAM_API",
      message: "savePreparedInlineMessage failed",
      preparedMessageId: null,
      callbackData: PC02_PROBE_CALLBACK_DATA,
      urlMode: config.urlMode,
      controlStartUrl: buildPc02ProbeOpenUrl({
        botUsername: config.botUsername,
        mode: "start",
      }),
      startappUrl: buildPc02ProbeOpenUrl({
        botUsername: config.botUsername,
        mode: "startapp",
      }),
    };
  }
  const preparedMessageId = readPreparedId(telegram.result);
  if (!preparedMessageId) {
    return prepareFail(
      "TELEGRAM_API",
      "savePreparedInlineMessage did not return result.id",
    );
  }
  return {
    ok: true,
    code: "PREPARED",
    message:
      "PC02 probe prepared. Share via Mini App shareMessage to a test peer chat. Not a Ban.",
    preparedMessageId,
    callbackData: PC02_PROBE_CALLBACK_DATA,
    urlMode: config.urlMode,
    controlStartUrl: buildPc02ProbeOpenUrl({
      botUsername: config.botUsername,
      mode: "start",
    }),
    startappUrl: buildPc02ProbeOpenUrl({
      botUsername: config.botUsername,
      mode: "startapp",
    }),
  };
}

function readResultsForCaller(callerTelegramUserId: string): Pc02ProbeResultsResult {
  const config = readPc02ProbeConfig();
  if (!config.enabled) {
    return {
      ok: false,
      code: "PC02_PROBE_DISABLED",
      message: "PC02 probe results require PC02_PROBE_ENABLED=1",
      enabled: false,
      urlMode: config.urlMode,
      events: [],
    };
  }
  if (!config.senderId || !config.receiverId) {
    return {
      ok: false,
      code: "PC02_PROBE_IDS_MISSING",
      message: "Test Telegram ids are not configured",
      enabled: true,
      urlMode: config.urlMode,
      events: [],
    };
  }
  if (
    callerTelegramUserId !== config.senderId &&
    callerTelegramUserId !== config.receiverId
  ) {
    return {
      ok: false,
      code: "PC02_PROBE_CALLER_FORBIDDEN",
      message: "Results are limited to the configured test accounts",
      enabled: true,
      urlMode: config.urlMode,
      events: [],
    };
  }
  return {
    ok: true,
    code: "PC02_PROBE_RESULTS",
    message: "Recent PC02 probe callback diagnostics (no Telegram user ids)",
    enabled: true,
    urlMode: config.urlMode,
    events: [...diagnosticEvents],
  };
}

async function finishProbe(input: {
  deps: ProbeDeps;
  callbackQueryId: string;
  branch: Pc02ProbeRoleBranch;
  answerKind: Pc02ProbeAnswerKind;
  openUrl: string | null;
  code: string;
  message: string;
  nowMs: number;
}): Promise<Pc02ProbeCallbackResult> {
  const answered = await answerCallbackQuery(input.deps, input.callbackQueryId, input.openUrl);
  pushDiagnostic({
    atMs: input.nowMs,
    callbackReceived: true,
    branch: input.branch,
    answerKind: input.answerKind,
    openUrlHostPath: sanitizeOpenUrl(input.openUrl),
    telegramApiAccepted: answered.accepted,
    telegramApiError: answered.error,
  });
  return {
    ok: true,
    code: input.code,
    message: input.message,
    branch: input.branch,
    answerKind: input.answerKind,
    telegramApiAccepted: answered.accepted,
    telegramApiError: answered.error,
  };
}

async function answerCallbackQuery(
  deps: ProbeDeps,
  callbackQueryId: string,
  openUrl: string | null,
): Promise<{ accepted: boolean | null; error: string | null }> {
  if (!callbackQueryId) {
    return { accepted: null, error: "missing callback_query id" };
  }
  const botToken = (deps.botToken ?? (deps.env ?? process.env).TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken) {
    return { accepted: null, error: "TELEGRAM_BOT_TOKEN missing" };
  }
  const body: Record<string, unknown> = { callback_query_id: callbackQueryId };
  if (openUrl) {
    body.url = openUrl;
  }
  const telegram = await callTelegram(deps.fetchImpl ?? fetch, botToken, "answerCallbackQuery", body);
  if (!telegram.ok) {
    return { accepted: false, error: telegram.description };
  }
  return { accepted: true, error: null };
}

function pushDiagnostic(event: Pc02ProbeDiagnosticEvent): void {
  diagnosticEvents.push(event);
  while (diagnosticEvents.length > MAX_DIAGNOSTIC_EVENTS) {
    diagnosticEvents.shift();
  }
}

function sanitizeOpenUrl(url: string | null): string | null {
  if (!url) {
    return null;
  }
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}${parsed.search}`;
  } catch {
    return "invalid-url";
  }
}

function positiveId(raw: string | undefined): string | null {
  const value = (raw ?? "").trim();
  if (!/^\d+$/.test(value) || value === "0") {
    return null;
  }
  return value;
}

function prepareFail(code: string, message: string): Pc02ProbePrepareResult {
  return {
    ok: false,
    code,
    message,
    preparedMessageId: null,
    callbackData: null,
    urlMode: null,
    controlStartUrl: null,
    startappUrl: null,
  };
}

function verifyProbeCaller(
  initData: string | null,
):
  | { ok: true; telegramUserId: string }
  | { ok: false; code: string; message: string } {
  if (!initData) {
    return { ok: false, code: "MISSING_INIT_DATA", message: "x-98-init-data required" };
  }
  const botToken = (process.env.TELEGRAM_BOT_TOKEN ?? "").trim();
  if (!botToken) {
    return { ok: false, code: "MISSING_BOT_TOKEN", message: "TELEGRAM_BOT_TOKEN missing" };
  }
  try {
    const verified = verifyTelegramInitData(
      initData,
      botToken,
      TELEGRAM_INIT_DATA_MAX_AGE_SECONDS,
      identityClock,
    );
    const startParam = new URLSearchParams(initData).get("start_param");
    if (startParam !== PC02_PROBE_START_PARAM) {
      return {
        ok: false,
        code: "PC02_PROBE_START_PARAM_REQUIRED",
        message: "PC02 probe HTTP routes accept only start_param=pc02_probe",
      };
    }
    return { ok: true, telegramUserId: String(verified.telegramUserId) };
  } catch (error) {
    if (error instanceof AuthenticationError) {
      return { ok: false, code: error.code, message: error.message };
    }
    return { ok: false, code: "INVALID_INIT_DATA", message: "initData verification failed" };
  }
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
      description: redact(`${method} returned non-JSON (HTTP ${response.status})`, botToken),
    };
  }
  if (parsed === null || typeof parsed !== "object") {
    return { ok: false, description: `${method} returned unexpected body` };
  }
  const record = parsed as { ok?: unknown; description?: unknown; result?: unknown };
  if (record.ok !== true) {
    const description =
      typeof record.description === "string" ? record.description : `HTTP ${response.status}`;
    return { ok: false, description: redact(description, botToken) };
  }
  return { ok: true, result: record.result };
}

function readPreparedId(value: unknown): string | null {
  if (value === null || typeof value !== "object") {
    return null;
  }
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function redact(value: string, botToken: string): string {
  if (botToken.length === 0) {
    return value;
  }
  return value.split(botToken).join("[redacted]");
}

function statusForAuth(code: string): number {
  switch (code) {
    case "PC02_PROBE_START_PARAM_REQUIRED":
      return 403;
    case "MISSING_INIT_DATA":
    case "MISSING_BOT_TOKEN":
    case "MISSING_REQUIRED_DATA":
    case "INVALID_SIGNATURE":
    case "INVALID_INIT_DATA":
    case "STALE_AUTH_DATE":
    case "TAMPERED_USER":
      return 401;
    default:
      return 401;
  }
}

function statusForPrepare(code: string): number {
  switch (code) {
    case "PC02_PROBE_DISABLED":
    case "PC02_PROBE_CALLER_FORBIDDEN":
    case "PC02_PROBE_START_PARAM_REQUIRED":
      return 403;
    case "PC02_PROBE_IDS_MISSING":
    case "PC02_PROBE_BOT_USERNAME_MISSING":
    case "INVALID_TELEGRAM_USER":
    case "INVALID_BODY":
      return 400;
    case "TELEGRAM_BOT_TOKEN_MISSING":
    case "TELEGRAM_API":
      return 502;
    default:
      return 400;
  }
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

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(JSON.stringify(body));
}
