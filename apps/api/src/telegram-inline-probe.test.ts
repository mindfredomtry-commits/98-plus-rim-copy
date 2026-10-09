import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createTelegramInitData } from "../../../packages/identity/src/create-init-data.ts";
import { InMemoryIdentityStore } from "@98plus/identity";
import { listenCreateBanContactServer } from "./http.ts";
import { createCreateBanContactRuntime } from "./runtime.ts";
import {
  INLINE_PROBE_EDITED_TEXT,
  INLINE_PROBE_PREPARE_PATH,
  INLINE_PROBE_TEXT,
  INLINE_PROBE_WATCH_PATH,
  prepareTelegramInlineProbe,
  resetTelegramInlineProbeStateForTests,
  setTelegramInlineProbeFetchForTests,
  watchTelegramInlineProbe,
  type TelegramInlineProbeResult,
} from "./telegram-inline-probe.ts";

const BOT_TOKEN = "test-bot-token";
const USER_ID = "4242";

type CapturedCall = Readonly<{ method: string; body: Record<string, unknown> }>;

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  resetTelegramInlineProbeStateForTests();
  delete process.env.TELEGRAM_BOT_TOKEN;
  while (servers.length > 0) {
    const server = servers.pop();
    if (server) {
      await server.close();
    }
  }
});

function telegramResponse(body: unknown): Response {
  return Response.json(body);
}

function scriptedFetch(handlers: {
  on(method: string, body: Record<string, unknown>): unknown | Promise<unknown>;
}): { fetchImpl: typeof fetch; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    return telegramResponse(await handlers.on(method, body));
  };
  return { fetchImpl, calls };
}

async function preparedProbe(fetchImpl: typeof fetch): Promise<TelegramInlineProbeResult> {
  return prepareTelegramInlineProbe(USER_ID, {
    botToken: BOT_TOKEN,
    fetchImpl,
    randomId: () => "abc123abc123abc123abc123",
  });
}

describe("telegram inline probe", () => {
  it("prepares a non-ban article with one callback button", async () => {
    const { fetchImpl, calls } = scriptedFetch({
      on(method) {
        expect(method).toBe("savePreparedInlineMessage");
        return { ok: true, result: { id: "prepared-1" } };
      },
    });
    const prepared = await preparedProbe(fetchImpl);
    expect(prepared.ok).toBe(true);
    expect(prepared.code).toBe("PREPARED");
    expect(prepared.preparedMessageId).toBe("prepared-1");
    expect(prepared.callbackData).toBe("probe:abc123abc123abc123abc123");
    const body = calls[0]?.body;
    expect(body?.user_id).toBe(4242);
    expect(body?.allow_user_chats).toBe(true);
    expect(body?.allow_bot_chats).toBe(false);
    expect(body?.allow_group_chats).toBe(false);
    expect(body?.allow_channel_chats).toBe(false);
    const article = body?.result as {
      input_message_content: { message_text: string };
      reply_markup: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
    };
    expect(article.input_message_content.message_text).toBe(INLINE_PROBE_TEXT);
    expect(article.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toBe(prepared.callbackData);
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("Ban");
    expect(encoded).not.toContain("Duration");
    expect(encoded).not.toContain("startapp");
    expect(Buffer.byteLength(prepared.callbackData ?? "")).toBeLessThanOrEqual(64);
  });

  it("returns the Telegram error and redacts the bot token", async () => {
    const fetchImpl: typeof fetch = async (input) => {
      throw new Error(`network ${String(input)}`);
    };
    const prepared = await prepareTelegramInlineProbe(USER_ID, {
      botToken: "123456:SECRET-TOKEN",
      fetchImpl,
    });
    expect(prepared.ok).toBe(false);
    expect(prepared.code).toBe("TELEGRAM_API");
    expect(prepared.telegramMethod).toBe("savePreparedInlineMessage");
    expect(prepared.telegramDescription).toContain("[redacted]");
    expect(prepared.telegramDescription).not.toContain("123456:SECRET-TOKEN");
    expect(JSON.stringify(prepared)).not.toContain("123456:SECRET-TOKEN");
  });

  it("edits only the matching callback and advances offset", async () => {
    const callbackData = "probe:abc123abc123abc123abc123";
    let getUpdatesCount = 0;
    const { fetchImpl, calls } = scriptedFetch({
      on(method, body) {
        if (method === "savePreparedInlineMessage") {
          return { ok: true, result: { id: "prepared-1" } };
        }
        if (method === "getUpdates") {
          getUpdatesCount += 1;
          expect(body.allowed_updates).toBeUndefined();
          if (getUpdatesCount === 1) {
            expect(body.offset).toBeUndefined();
            return {
              ok: true,
              result: [
                {
                  update_id: 7,
                  callback_query: {
                    id: "other-query",
                    data: "probe:someone-else",
                    inline_message_id: "must-not-edit",
                  },
                },
                {
                  update_id: 8,
                  callback_query: {
                    id: "our-query",
                    data: callbackData,
                    inline_message_id: "inline-1",
                  },
                },
              ],
            };
          }
          expect(body.offset).toBe(9);
          return { ok: true, result: [] };
        }
        if (method === "answerCallbackQuery") {
          expect(body.callback_query_id).toBe("our-query");
          return { ok: true, result: true };
        }
        if (method === "editMessageText") {
          expect(body.inline_message_id).toBe("inline-1");
          expect(body.text).toBe(INLINE_PROBE_EDITED_TEXT);
          return { ok: true, result: true };
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const prepared = await preparedProbe(fetchImpl);
    const watched = await watchTelegramInlineProbe(USER_ID, prepared.probeId ?? "", {
      botToken: BOT_TOKEN,
      fetchImpl,
      pollForMs: 20_000,
    });
    expect(watched.ok).toBe(true);
    expect(watched.code).toBe("EDITED");
    expect(watched.inlineMessageId).toBe("inline-1");
    expect(watched.editedText).toBe(INLINE_PROBE_EDITED_TEXT);
    expect(watched.answerCallbackQueryOk).toBe(true);
    expect(watched.editMessageTextOk).toBe(true);
    expect(watched.ignoredUpdates).toBe(1);
    expect(watched.pollCalls).toBe(1);
    expect(calls.map((call) => call.method)).toEqual([
      "savePreparedInlineMessage",
      "getUpdates",
      "answerCallbackQuery",
      "editMessageText",
    ]);

    const again = await watchTelegramInlineProbe(USER_ID, prepared.probeId ?? "", {
      botToken: BOT_TOKEN,
      fetchImpl,
      pollForMs: 20_000,
    });
    expect(again.code).toBe("PROBE_POLL_NOT_HELD");
    expect(again.pollCalls).toBe(1);
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(1);
    expect(calls.filter((call) => call.method === "getUpdates").at(-1)?.body.offset).toBe(9);
  });

  it("does not edit when inline_message_id is missing", async () => {
    const callbackData = "probe:abc123abc123abc123abc123";
    const { fetchImpl, calls } = scriptedFetch({
      on(method) {
        if (method === "savePreparedInlineMessage") {
          return { ok: true, result: { id: "prepared-1" } };
        }
        if (method === "getUpdates") {
          return {
            ok: true,
            result: [
              {
                update_id: 1,
                callback_query: { id: "query-1", data: callbackData },
              },
            ],
          };
        }
        if (method === "answerCallbackQuery") {
          return { ok: true, result: true };
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const prepared = await preparedProbe(fetchImpl);
    const watched = await watchTelegramInlineProbe(USER_ID, prepared.probeId ?? "", {
      botToken: BOT_TOKEN,
      fetchImpl,
      pollForMs: 5_000,
    });
    expect(watched.ok).toBe(false);
    expect(watched.code).toBe("INLINE_MESSAGE_ID_MISSING");
    expect(watched.editMessageTextOk).toBeNull();
    expect(calls.map((call) => call.method)).not.toContain("editMessageText");
  });

  it("surfaces editMessageText failures and keeps a single poller", async () => {
    const callbackData = "probe:abc123abc123abc123abc123";
    let releaseFirst = (): void => {
      throw new Error("inline probe poll did not reach getUpdates");
    };
    let getUpdatesCalls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      const method = String(input).slice(String(input).lastIndexOf("/") + 1);
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      if (method === "savePreparedInlineMessage") {
        return telegramResponse({ ok: true, result: { id: "prepared-1" } });
      }
      if (method === "getUpdates") {
        getUpdatesCalls += 1;
        if (getUpdatesCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
          return telegramResponse({
            ok: false,
            description: "Conflict: terminated by other getUpdates request",
          });
        }
        return telegramResponse({
          ok: true,
          result: [
            {
              update_id: 4,
              callback_query: {
                id: "query-4",
                data: callbackData,
                inline_message_id: "inline-4",
              },
            },
          ],
        });
      }
      if (method === "answerCallbackQuery") {
        return telegramResponse({ ok: true, result: true });
      }
      if (method === "editMessageText") {
        expect(body.inline_message_id).toBe("inline-4");
        return telegramResponse({ ok: false, description: "Bad Request: message can't be edited" });
      }
      throw new Error(`unexpected ${method}`);
    };
    const prepared = await preparedProbe(fetchImpl);
    const first = watchTelegramInlineProbe(USER_ID, prepared.probeId ?? "", {
      botToken: BOT_TOKEN,
      fetchImpl,
      pollForMs: 20_000,
    });
    const second = await watchTelegramInlineProbe(USER_ID, prepared.probeId ?? "", {
      botToken: BOT_TOKEN,
      fetchImpl,
      pollForMs: 20_000,
    });
    expect(second.code).toBe("PROBE_POLL_BUSY");
    expect(getUpdatesCalls).toBe(1);
    releaseFirst();
    const failed = await first;
    expect(failed.code).toBe("TELEGRAM_API");
    expect(failed.telegramMethod).toBe("getUpdates");
    expect(failed.telegramDescription).toContain("Conflict");

    const edited = await watchTelegramInlineProbe(USER_ID, prepared.probeId ?? "", {
      botToken: BOT_TOKEN,
      fetchImpl,
      pollForMs: 20_000,
    });
    expect(edited.ok).toBe(false);
    expect(edited.code).toBe("TELEGRAM_API");
    expect(edited.telegramMethod).toBe("editMessageText");
    expect(edited.telegramDescription).toContain("can't be edited");
    expect(edited.inlineMessageId).toBe("inline-4");
    expect(edited.answerCallbackQueryOk).toBe(true);
    expect(edited.editMessageTextOk).toBe(false);
  });

  it("finishes polling when no callback arrives", async () => {
    const { fetchImpl } = scriptedFetch({
      on(method) {
        if (method === "savePreparedInlineMessage") {
          return { ok: true, result: { id: "prepared-1" } };
        }
        throw new Error(`unexpected ${method}`);
      },
    });
    const prepared = await preparedProbe(fetchImpl);
    const watched = await watchTelegramInlineProbe(USER_ID, prepared.probeId ?? "", {
      botToken: BOT_TOKEN,
      fetchImpl,
      pollForMs: 0,
    });
    expect(watched.ok).toBe(false);
    expect(watched.code).toBe("PROBE_CALLBACK_TIMEOUT");
    expect(watched.pollCalls).toBe(0);
    expect(watched.editedText).toBeNull();
  });

  it("does not create an identity user or a Ban from the probe routes", async () => {
    process.env.TELEGRAM_BOT_TOKEN = BOT_TOKEN;
    const identityStore = new InMemoryIdentityStore();
    const app = await listenCreateBanContactServer({
      runtime: createCreateBanContactRuntime({
        identityStore,
        telegramSharePrepare: "mock",
      }),
      seedTelegramUserIds: [],
    });
    servers.push(app);
    const calls: string[] = [];
    setTelegramInlineProbeFetchForTests(async (input, init) => {
      const method = String(input).slice(String(input).lastIndexOf("/") + 1);
      calls.push(method);
      const body = JSON.parse(String(init?.body ?? "{}")) as { result?: { input_message_content?: { message_text?: string } } };
      if (method === "savePreparedInlineMessage") {
        expect(body.result?.input_message_content?.message_text).toBe(INLINE_PROBE_TEXT);
        return telegramResponse({ ok: true, result: { id: "prepared-http" } });
      }
      if (method === "getUpdates") {
        return telegramResponse({ ok: true, result: [] });
      }
      return telegramResponse({ ok: true, result: true });
    });
    const initData = createTelegramInitData(
      { id: 4242, first_name: "Ada" },
      {
        authDate: Math.floor(Date.now() / 1000),
        extra: { start_param: "inline_probe" },
      },
    );
    const headers = {
      "content-type": "application/json",
      "x-98-auth-method": "telegram",
      "x-98-init-data": initData,
    };
    const dev = await fetch(`${app.url}${INLINE_PROBE_PREPARE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-98-auth-method": "development",
        "x-98-dev-secret": "test-secret",
        "x-98-dev-telegram-user-id": "1001",
      },
      body: "{}",
    });
    expect(dev.status).toBe(401);
    const missingStart = await fetch(`${app.url}${INLINE_PROBE_PREPARE_PATH}`, {
      method: "POST",
      headers: {
        ...headers,
        "x-98-init-data": createTelegramInitData(
          { id: 4242 },
          { authDate: Math.floor(Date.now() / 1000) },
        ),
      },
      body: "{}",
    });
    expect(missingStart.status).toBe(403);
    expect(calls).toEqual([]);
    expect(identityStore.snapshot()).toHaveLength(0);

    const preparedResponse = await fetch(`${app.url}${INLINE_PROBE_PREPARE_PATH}`, {
      method: "POST",
      headers,
      body: "{}",
    });
    const prepared = (await preparedResponse.json()) as TelegramInlineProbeResult;
    expect(preparedResponse.status).toBe(200);
    expect(prepared.code).toBe("PREPARED");
    expect(identityStore.snapshot()).toHaveLength(0);

    const watchedResponse = await fetch(`${app.url}${INLINE_PROBE_WATCH_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify({ probeId: prepared.probeId }),
    });
    const watched = (await watchedResponse.json()) as TelegramInlineProbeResult;
    expect(watched.code).toBe("PROBE_POLL_NOT_HELD");
    expect(identityStore.snapshot()).toHaveLength(0);
    expect(calls).toEqual(["savePreparedInlineMessage", "getUpdates"]);
  });

  it("keeps the Ban share path and gates the probe panel", () => {
    const root = dirname(fileURLToPath(import.meta.url));
    const html = readFileSync(join(root, "../../miniapp/src/test-ui.html"), "utf8");
    const probeSource = readFileSync(join(root, "telegram-inline-probe.ts"), "utf8");
    const http = readFileSync(join(root, "http.ts"), "utf8");
    expect(html).toContain("Send inline probe");
    expect(html).toContain('telegramStartParam() === "inline_probe"');
    expect(html).toContain("if (isInlineProbeLaunch())");
    expect(html).toContain("enterInlineProbeMode()");
    const probeFn = html.slice(html.indexOf("async function runInlineProbe"), html.indexOf("async function sendOverboard"));
    expect(probeFn).toContain("/api/telegram-inline-probe/prepare");
    expect(probeFn).toContain("/api/telegram-inline-probe/watch");
    expect(probeFn).not.toContain("sendEvent");
    expect(probeFn).not.toContain("PRESS_FORBID");
    expect(probeFn).not.toContain("shareReturnLatch");
    const shareFn = html.slice(
      html.indexOf("async function maybeInvokeTelegramShare"),
      html.indexOf("function isInlineProbeLaunch"),
    );
    expect(shareFn).toContain("shareReturnLatch.arm");
    expect(shareFn).toContain("webApp.shareMessage");
    expect(shareFn).not.toContain("inline_probe");
    expect(shareFn).not.toContain("INLINE PROBE");
    const shareCall = html.slice(html.indexOf("webApp.shareMessage"));
    const callbackBody = shareCall.slice(0, shareCall.indexOf("});"));
    expect(callbackBody).toContain("callback:true");
    expect(callbackBody).not.toContain("SHARE_RETURNED");
    expect(probeSource).not.toContain("@98plus/application");
    expect(probeSource).not.toContain("@98plus/product-model");
    expect(probeSource).not.toContain("@98plus/persistence");
    expect(probeSource).not.toContain("allowed_updates");
    expect(http.indexOf("isTelegramInlineProbePath")).toBeLessThan(
      http.indexOf("authenticateRuntime(runtime, attempt)"),
    );
  });
});
