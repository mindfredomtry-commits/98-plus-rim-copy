import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildPc02ProbeOpenUrl,
  isPc02ProbeCallbackData,
  isPc02ProbeStartParam,
  PC02_PROBE_CALLBACK_DATA,
  PC02_PROBE_PREPARE_PATH,
  PC02_PROBE_RESULTS_PATH,
  preparePc02ProbeMessage,
  processPc02ProbeCallback,
  readPc02ProbeConfig,
  resetPc02ProbeStateForTests,
} from "./telegram-pc02-probe.ts";
import { processTelegramBanUpdate } from "./telegram-ban-callback.ts";
import { resolveTelegramShareExternalEntry } from "./external-entry.ts";
import { listenCreateBanContactServer } from "./http.ts";
import { asTelegramUserId } from "@98plus/identity";
import { createTelegramInitData } from "../../../packages/identity/src/create-init-data.ts";

const SENDER_ID = "111000111";
const RECEIVER_ID = "222000222";
const OTHER_ID = "333000333";
const BOT_TOKEN = "123456:AA-pc02-probe-test-token";
const BOT_USERNAME = "98plus_probe_bot";

function envEnabled(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PC02_PROBE_ENABLED: "1",
    PC02_PROBE_TEST_SENDER_ID: SENDER_ID,
    PC02_PROBE_TEST_RECEIVER_ID: RECEIVER_ID,
    PC02_PROBE_URL_MODE: "startapp",
    TELEGRAM_BOT_USERNAME: BOT_USERNAME,
    TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    ...extra,
  };
}

function stubAnswerFetch(capture: {
  bodies: Array<Record<string, unknown>>;
}): typeof fetch {
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    capture.bodies.push(body);
    return new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

describe("telegram-pc02-probe", () => {
  beforeEach(() => {
    resetPc02ProbeStateForTests();
  });

  afterEach(() => {
    resetPc02ProbeStateForTests();
  });

  it("uses a dedicated callback_data namespace that does not match OVERBOARD", () => {
    expect(isPc02ProbeCallbackData(PC02_PROBE_CALLBACK_DATA)).toBe(true);
    expect(isPc02ProbeCallbackData("ob:tok")).toBe(false);
    expect(isPc02ProbeCallbackData("pc02_probe:extra")).toBe(false);
    expect(isPc02ProbeStartParam("pc02_probe")).toBe(true);
    expect(isPc02ProbeStartParam("share_tok")).toBe(false);
  });

  it("builds startapp and start control urls", () => {
    expect(buildPc02ProbeOpenUrl({ botUsername: BOT_USERNAME, mode: "startapp" })).toBe(
      `https://t.me/${BOT_USERNAME}?startapp=pc02_probe`,
    );
    expect(buildPc02ProbeOpenUrl({ botUsername: `@${BOT_USERNAME}`, mode: "start" })).toBe(
      `https://t.me/${BOT_USERNAME}?start=pc02_probe`,
    );
  });

  it("sender branch answers without url", async () => {
    const capture = { bodies: [] as Array<Record<string, unknown>> };
    const result = await processPc02ProbeCallback(
      { callbackQueryId: "cq-sender", fromTelegramUserId: SENDER_ID },
      { fetchImpl: stubAnswerFetch(capture), env: envEnabled(), botToken: BOT_TOKEN },
    );
    expect(result.code).toBe("PC02_SENDER_NOOP");
    expect(result.branch).toBe("SENDER_NOOP");
    expect(result.answerKind).toBe("no_url");
    expect(result.telegramApiAccepted).toBe(true);
    expect(capture.bodies[0]).toEqual({ callback_query_id: "cq-sender" });
    expect(capture.bodies[0]).not.toHaveProperty("url");
  });

  it("receiver branch answers with startapp url by default", async () => {
    const capture = { bodies: [] as Array<Record<string, unknown>> };
    const result = await processPc02ProbeCallback(
      { callbackQueryId: "cq-recv", fromTelegramUserId: RECEIVER_ID },
      { fetchImpl: stubAnswerFetch(capture), env: envEnabled(), botToken: BOT_TOKEN },
    );
    expect(result.code).toBe("PC02_RECEIVER_OPEN");
    expect(result.branch).toBe("RECEIVER_OPEN");
    expect(result.answerKind).toBe("url_startapp");
    expect(capture.bodies[0]?.url).toBe(`https://t.me/${BOT_USERNAME}?startapp=pc02_probe`);
  });

  it("receiver control mode uses start url", async () => {
    const capture = { bodies: [] as Array<Record<string, unknown>> };
    const result = await processPc02ProbeCallback(
      { callbackQueryId: "cq-ctrl", fromTelegramUserId: RECEIVER_ID },
      {
        fetchImpl: stubAnswerFetch(capture),
        env: envEnabled({ PC02_PROBE_URL_MODE: "start" }),
        botToken: BOT_TOKEN,
      },
    );
    expect(result.answerKind).toBe("url_start");
    expect(capture.bodies[0]?.url).toBe(`https://t.me/${BOT_USERNAME}?start=pc02_probe`);
  });

  it("unknown and disabled branches are no-op without url", async () => {
    const capture = { bodies: [] as Array<Record<string, unknown>> };
    const unknown = await processPc02ProbeCallback(
      { callbackQueryId: "cq-unk", fromTelegramUserId: OTHER_ID },
      { fetchImpl: stubAnswerFetch(capture), env: envEnabled(), botToken: BOT_TOKEN },
    );
    expect(unknown.branch).toBe("UNKNOWN_NOOP");
    expect(capture.bodies[0]).not.toHaveProperty("url");

    const disabled = await processPc02ProbeCallback(
      { callbackQueryId: "cq-off", fromTelegramUserId: RECEIVER_ID },
      {
        fetchImpl: stubAnswerFetch(capture),
        env: envEnabled({ PC02_PROBE_ENABLED: "0" }),
        botToken: BOT_TOKEN,
      },
    );
    expect(disabled.branch).toBe("DISABLED_NOOP");
  });

  it("webhook Ban update routes pc02_probe before OVERBOARD and skips Ban stores", async () => {
    const capture = { bodies: [] as Array<Record<string, unknown>> };
    const previous = { ...process.env };
    Object.assign(process.env, envEnabled());
    try {
      const processed = await processTelegramBanUpdate(
        {
          identityStore: {
            resolveByTelegramUserId: async () => {
              throw new Error("identity must not run for pc02 probe");
            },
          },
          telegramBanMessageStore: {
            findCallbackReceipt: async () => {
              throw new Error("ban callback store must not run for pc02 probe");
            },
          },
        } as never,
        {
          update_id: 1,
          callback_query: {
            id: "cq-pc02",
            from: { id: Number(SENDER_ID) },
            data: PC02_PROBE_CALLBACK_DATA,
            inline_message_id: "inline-pc02",
          },
        },
        { fetchImpl: stubAnswerFetch(capture), botToken: BOT_TOKEN },
      );
      expect(processed.code).toBe("PC02_SENDER_NOOP");
      expect(processed.banId).toBeNull();
      expect(processed.attemptId).toBeNull();
      expect(capture.bodies[0]).not.toHaveProperty("url");
    } finally {
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, previous);
    }
  });

  it("prepare refuses when disabled or caller is not a test id", async () => {
    const disabled = await preparePc02ProbeMessage(SENDER_ID, {
      env: envEnabled({ PC02_PROBE_ENABLED: "0" }),
    });
    expect(disabled.code).toBe("PC02_PROBE_DISABLED");

    const forbidden = await preparePc02ProbeMessage(OTHER_ID, { env: envEnabled() });
    expect(forbidden.code).toBe("PC02_PROBE_CALLER_FORBIDDEN");
  });

  it("prepare calls savePreparedInlineMessage with callback_data only", async () => {
    const capture = { bodies: [] as Array<Record<string, unknown>> };
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      capture.bodies.push(body);
      return new Response(JSON.stringify({ ok: true, result: { id: "prepared-pc02" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const prepared = await preparePc02ProbeMessage(SENDER_ID, {
      env: envEnabled(),
      fetchImpl,
      botToken: BOT_TOKEN,
    });
    expect(prepared.ok).toBe(true);
    expect(prepared.preparedMessageId).toBe("prepared-pc02");
    expect(prepared.callbackData).toBe(PC02_PROBE_CALLBACK_DATA);
    const markup = (
      capture.bodies[0]?.result as {
        reply_markup: { inline_keyboard: Array<Array<{ callback_data?: string; url?: string }>> };
      }
    ).reply_markup;
    expect(markup.inline_keyboard[0]?.[0]?.callback_data).toBe(PC02_PROBE_CALLBACK_DATA);
    expect(markup.inline_keyboard[0]?.[0]).not.toHaveProperty("url");
    expect(prepared.startappUrl).toContain("startapp=pc02_probe");
    expect(prepared.controlStartUrl).toContain("start=pc02_probe");
  });

  it("http prepare/results require initData and stay off the Ban webhook path", async () => {
    const previous = { ...process.env };
    const originalFetch = globalThis.fetch;
    Object.assign(process.env, {
      ...envEnabled(),
      TELEGRAM_WEBHOOK_SECRET: "webhook-secret-pc02",
      IDENTITY_ALLOW_DEV_AUTH: "true",
      IDENTITY_DEV_AUTH_SECRET: "dev-secret",
    });
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("api.telegram.org") && url.includes("savePreparedInlineMessage")) {
        return new Response(JSON.stringify({ ok: true, result: { id: "prepared-http-pc02" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return originalFetch(input, init);
    }) as typeof fetch;

    const app = await listenCreateBanContactServer({
      seedTelegramUserIds: [SENDER_ID, RECEIVER_ID],
    });
    try {
      const unauthorized = await fetch(`${app.url}${PC02_PROBE_PREPARE_PATH}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(unauthorized.status).toBe(401);

      const wrongStart = createTelegramInitData(
        { id: Number(SENDER_ID) },
        {
          botToken: BOT_TOKEN,
          authDate: Math.floor(Date.now() / 1000),
          extra: { start_param: "inline_probe" },
        },
      );
      const rejectedStart = await fetch(`${app.url}${PC02_PROBE_PREPARE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-98-init-data": wrongStart,
        },
        body: "{}",
      });
      expect(rejectedStart.status).toBe(403);

      const initData = createTelegramInitData(
        { id: Number(SENDER_ID) },
        {
          botToken: BOT_TOKEN,
          authDate: Math.floor(Date.now() / 1000),
          extra: { start_param: "pc02_probe" },
        },
      );
      const prepare = await fetch(`${app.url}${PC02_PROBE_PREPARE_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-98-init-data": initData,
        },
        body: "{}",
      });
      expect(prepare.status).toBe(200);
      const preparedBody = (await prepare.json()) as { code: string; preparedMessageId: string };
      expect(preparedBody.code).toBe("PREPARED");
      expect(preparedBody.preparedMessageId).toBe("prepared-http-pc02");

      const results = await fetch(`${app.url}${PC02_PROBE_RESULTS_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-98-init-data": initData,
        },
        body: "{}",
      });
      expect(results.status).toBe(200);
      const body = (await results.json()) as { code: string; events: unknown[] };
      expect(body.code).toBe("PC02_PROBE_RESULTS");
      expect(Array.isArray(body.events)).toBe(true);
    } finally {
      await app.close();
      globalThis.fetch = originalFetch;
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, previous);
    }
  });

  it("pc02 start_param resolves as NOOP without Product Events", async () => {
    const previous = { ...process.env };
    Object.assign(process.env, {
      IDENTITY_ALLOW_DEV_AUTH: "true",
      IDENTITY_DEV_AUTH_SECRET: "dev-secret",
    });
    const app = await listenCreateBanContactServer({
      seedTelegramUserIds: [RECEIVER_ID],
    });
    try {
      const identity = await app.runtime.identityStore.resolveByTelegramUserId(
        asTelegramUserId(RECEIVER_ID),
      );
      const resolved = await resolveTelegramShareExternalEntry(
        app.runtime,
        {
          currentUserId: identity.userId,
          currentTelegramUser: { telegramUserId: identity.telegramUserId },
          authenticationMethod: "telegram",
        },
        "pc02_probe",
      );
      expect(resolved.orchestration.outcome).toBe("NOOP");
      expect(resolved.orchestration.steps).toEqual([]);
      expect(resolved.last).toBeNull();
    } finally {
      await app.close();
      for (const key of Object.keys(process.env)) {
        if (!(key in previous)) {
          delete process.env[key];
        }
      }
      Object.assign(process.env, previous);
    }
  });

  it("readPc02ProbeConfig does not invent ids", () => {
    const config = readPc02ProbeConfig({
      PC02_PROBE_ENABLED: "1",
      PC02_PROBE_URL_MODE: "startapp",
      TELEGRAM_BOT_USERNAME: BOT_USERNAME,
    });
    expect(config.enabled).toBe(true);
    expect(config.senderId).toBeNull();
    expect(config.receiverId).toBeNull();
  });
});

