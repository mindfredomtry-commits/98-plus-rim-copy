import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import type { IncomingMessage } from "node:http";
import {
  beginPc02ProbePrepareSlot,
  buildPc02ProbeOpenUrl,
  endPc02ProbePrepareSlot,
  handleTelegramPc02ProbeRequest,
  isPc02ProbeCallbackData,
  isPc02ProbeStartParam,
  PC02_PROBE_CALLBACK_DATA,
  PC02_PROBE_MAX_BODY_BYTES,
  PC02_PROBE_PREPARE_PATH,
  PC02_PROBE_PREPARE_WINDOW_MS,
  PC02_PROBE_RESULTS_PATH,
  preparePc02ProbeMessage,
  processPc02ProbeCallback,
  readPc02ProbeConfig,
  readPc02ProbeJsonBody,
  resetPc02ProbeStateForTests,
} from "./telegram-pc02-probe.ts";
import { processTelegramBanUpdate } from "./telegram-ban-callback.ts";
import { resolveTelegramShareExternalEntry } from "./external-entry.ts";
import { listenCreateBanContactServer } from "./http.ts";
import { testUiHtmlSource } from "./test-ui-assets.ts";
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

function stubAnswerFetch(
  capture: { bodies: Array<Record<string, unknown>> },
  options: { ok?: boolean; description?: string } = {},
): typeof fetch {
  const ok = options.ok !== false;
  return (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    capture.bodies.push(body);
    return new Response(
      JSON.stringify(
        ok
          ? { ok: true, result: true }
          : { ok: false, description: options.description ?? "bad request" },
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
}

function fakeRequest(
  body: string,
  headers: Record<string, string | undefined> = {},
): IncomingMessage {
  const stream = Readable.from([Buffer.from(body)]) as IncomingMessage;
  stream.headers = headers;
  return stream;
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

  describe("FIX1 body limit", () => {
    it("accepts a small JSON object", async () => {
      const read = await readPc02ProbeJsonBody(fakeRequest('{"ping":true}'));
      expect(read).toEqual({ ok: true, body: { ping: true } });
    });

    it("rejects oversized Content-Length before reading body", async () => {
      const read = await readPc02ProbeJsonBody(
        fakeRequest("{}", { "content-length": String(PC02_PROBE_MAX_BODY_BYTES + 1) }),
      );
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.code).toBe("PAYLOAD_TOO_LARGE");
      }
    });

    it("rejects oversized streamed body without Content-Length", async () => {
      const huge = "x".repeat(PC02_PROBE_MAX_BODY_BYTES + 32);
      const read = await readPc02ProbeJsonBody(fakeRequest(huge));
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.code).toBe("PAYLOAD_TOO_LARGE");
      }
    });

    it("rejects invalid JSON", async () => {
      const read = await readPc02ProbeJsonBody(fakeRequest("{not-json"));
      expect(read.ok).toBe(false);
      if (!read.ok) {
        expect(read.code).toBe("INVALID_BODY");
      }
    });

    it("HTTP prepare returns 413 for oversized Content-Length without Telegram API", async () => {
      const previous = { ...process.env };
      const originalFetch = globalThis.fetch;
      let telegramCalls = 0;
      Object.assign(process.env, envEnabled());
      globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        if (String(input).includes("api.telegram.org")) {
          telegramCalls += 1;
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      const req = fakeRequest("{}", {
        "content-length": String(PC02_PROBE_MAX_BODY_BYTES + 1),
        "x-98-init-data": "unused-because-body-limit-runs-first",
      });
      (req as IncomingMessage & { url?: string }).url = PC02_PROBE_PREPARE_PATH;

      let statusCode = 0;
      let responseBody = "";
      const res = {
        writeHead(status: number) {
          statusCode = status;
          return res;
        },
        end(chunk?: string) {
          responseBody = String(chunk ?? "");
        },
      };

      try {
        await handleTelegramPc02ProbeRequest(req, res as never);
        expect(statusCode).toBe(413);
        expect(JSON.parse(responseBody).code).toBe("PAYLOAD_TOO_LARGE");
        expect(telegramCalls).toBe(0);
      } finally {
        globalThis.fetch = originalFetch;
        for (const key of Object.keys(process.env)) {
          if (!(key in previous)) delete process.env[key];
        }
        Object.assign(process.env, previous);
      }
    });
  });

  describe("FIX2 prepare rate limit", () => {
    it("allows first prepare and rejects immediate repeat", async () => {
      let clock = 1_000_000;
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ ok: true, result: { id: "prep-1" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      const first = await preparePc02ProbeMessage(SENDER_ID, {
        env: envEnabled(),
        fetchImpl,
        botToken: BOT_TOKEN,
        nowMs: () => clock,
      });
      expect(first.ok).toBe(true);
      const second = await preparePc02ProbeMessage(SENDER_ID, {
        env: envEnabled(),
        fetchImpl,
        botToken: BOT_TOKEN,
        nowMs: () => clock + 1,
      });
      expect(second.ok).toBe(false);
      expect(second.code).toBe("PC02_PROBE_RATE_LIMITED");
    });

    it("rejects parallel prepares for the same account before Telegram returns", async () => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const fetchImpl = (async () => {
        calls += 1;
        await gate;
        return new Response(JSON.stringify({ ok: true, result: { id: `prep-${calls}` } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const clock = 2_000_000;
      const a = preparePc02ProbeMessage(SENDER_ID, {
        env: envEnabled(),
        fetchImpl,
        botToken: BOT_TOKEN,
        nowMs: () => clock,
      });
      await Promise.resolve();
      const b = await preparePc02ProbeMessage(SENDER_ID, {
        env: envEnabled(),
        fetchImpl,
        botToken: BOT_TOKEN,
        nowMs: () => clock,
      });
      expect(b.code).toBe("PC02_PROBE_PREPARE_IN_FLIGHT");
      release();
      const first = await a;
      expect(first.ok).toBe(true);
      expect(calls).toBe(1);
    });

    it("allows independent prepare for the other test account", async () => {
      let n = 0;
      const fetchImpl = (async () => {
        n += 1;
        return new Response(JSON.stringify({ ok: true, result: { id: `prep-${n}` } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const clock = 3_000_000;
      const sender = await preparePc02ProbeMessage(SENDER_ID, {
        env: envEnabled(),
        fetchImpl,
        botToken: BOT_TOKEN,
        nowMs: () => clock,
      });
      const receiver = await preparePc02ProbeMessage(RECEIVER_ID, {
        env: envEnabled(),
        fetchImpl,
        botToken: BOT_TOKEN,
        nowMs: () => clock,
      });
      expect(sender.ok).toBe(true);
      expect(receiver.ok).toBe(true);
    });

    it("resets after the 60s window", async () => {
      let clock = 4_000_000;
      const fetchImpl = (async () =>
        new Response(JSON.stringify({ ok: true, result: { id: "prep-window" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      const first = await preparePc02ProbeMessage(SENDER_ID, {
        env: envEnabled(),
        fetchImpl,
        botToken: BOT_TOKEN,
        nowMs: () => clock,
      });
      expect(first.ok).toBe(true);
      clock += PC02_PROBE_PREPARE_WINDOW_MS;
      const again = await preparePc02ProbeMessage(SENDER_ID, {
        env: envEnabled(),
        fetchImpl,
        botToken: BOT_TOKEN,
        nowMs: () => clock,
      });
      expect(again.ok).toBe(true);
    });

    it("begin/end slot helpers enforce in-flight and window", () => {
      expect(beginPc02ProbePrepareSlot(SENDER_ID, 10).ok).toBe(true);
      expect(beginPc02ProbePrepareSlot(SENDER_ID, 11).ok).toBe(false);
      endPc02ProbePrepareSlot(SENDER_ID, { success: true, nowMs: 10 });
      expect(beginPc02ProbePrepareSlot(SENDER_ID, 11).ok).toBe(false);
      expect(beginPc02ProbePrepareSlot(SENDER_ID, 10 + PC02_PROBE_PREPARE_WINDOW_MS).ok).toBe(
        true,
      );
      endPc02ProbePrepareSlot(SENDER_ID, { success: false, nowMs: 99 });
    });
  });

  describe("FIX3 telegram API diagnostics", () => {
    it("sender success records API accept without claiming Mini App open", async () => {
      const capture = { bodies: [] as Array<Record<string, unknown>> };
      const result = await processPc02ProbeCallback(
        { callbackQueryId: "cq-sender", fromTelegramUserId: SENDER_ID },
        { fetchImpl: stubAnswerFetch(capture), env: envEnabled(), botToken: BOT_TOKEN },
      );
      expect(result.ok).toBe(true);
      expect(result.code).toBe("PC02_SENDER_NOOP");
      expect(result.branch).toBe("SENDER_NOOP");
      expect(result.telegramApiAccepted).toBe(true);
      expect(result.miniAppOpenConfirmed).toBe(false);
      expect(result.message).toContain("NOT confirmed");
      expect(capture.bodies[0]).not.toHaveProperty("url");
    });

    it("receiver API failure keeps branch but does not report success", async () => {
      const capture = { bodies: [] as Array<Record<string, unknown>> };
      const result = await processPc02ProbeCallback(
        { callbackQueryId: "cq-recv-fail", fromTelegramUserId: RECEIVER_ID },
        {
          fetchImpl: stubAnswerFetch(capture, {
            ok: false,
            description: "URL_INVALID",
          }),
          env: envEnabled(),
          botToken: BOT_TOKEN,
        },
      );
      expect(result.ok).toBe(false);
      expect(result.code).toBe("PC02_TELEGRAM_API_FAILED");
      expect(result.branch).toBe("RECEIVER_OPEN");
      expect(result.telegramApiAccepted).toBe(false);
      expect(result.telegramApiError).toContain("URL_INVALID");
      expect(result.miniAppOpenConfirmed).toBe(false);
      expect(capture.bodies[0]?.url).toContain("startapp=pc02_probe");
    });
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
    expect(result.miniAppOpenConfirmed).toBe(false);
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
        if (!(key in previous)) delete process.env[key];
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
        if (!(key in previous)) delete process.env[key];
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
        if (!(key in previous)) delete process.env[key];
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

  it("FIX4 test UI exposes isolated pc02 prepare→shareMessage path", () => {
    const html = testUiHtmlSource();
    expect(html).toContain('id="pc02-probe"');
    expect(html).toContain("isPc02ProbeLaunch");
    expect(html).toContain("enterPc02ProbeMode");
    expect(html).toContain("/api/telegram-pc02-probe/prepare");
    expect(html).toContain("shareMessage(preparedPayload.preparedMessageId");
    expect(html).toContain('start_param=pc02_probe');
  });
});
