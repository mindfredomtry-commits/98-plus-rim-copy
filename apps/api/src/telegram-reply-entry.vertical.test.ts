import { afterEach, describe, expect, it, vi } from "vitest";
import { listenCreateBanContactServer } from "./http.ts";
import {
  createCreateBanContactRuntime,
  userIdOf,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import type { TestUiDiagnostics } from "./diagnostics.ts";
import { buildTelegramBanOverboardCallbackData } from "./telegram-share.ts";
import { processTelegramBanUpdate } from "./telegram-ban-callback.ts";
import { resetTelegramBanMessageProcessLocksForTests } from "./telegram-ban-message-store.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const USER_C_TG = "1003";
const DEV_SECRET = "test-secret";
const WEBHOOK_SECRET = "webhook-secret-test";
const BAN_TEXT = "pc02 variant a ban";
const REPLY_TEXT = "ответный запрет";
const REPLY_DURATION = 12;

type Started = Awaited<ReturnType<typeof listenCreateBanContactServer>>;
const started: Started[] = [];

afterEach(async () => {
  resetTelegramBanMessageProcessLocksForTests();
  delete process.env.TELEGRAM_WEBHOOK_SECRET;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_BOT_USERNAME;
  vi.unstubAllGlobals();
  while (started.length > 0) {
    const app = started.pop();
    if (app) {
      await app.close();
    }
  }
});

async function start(runtime?: CreateBanContactRuntime): Promise<Started> {
  process.env.TELEGRAM_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.TELEGRAM_BOT_TOKEN = "bot-token-test";
  process.env.TELEGRAM_BOT_USERNAME = "ninety_eight_plus_mvp_bot";
  const app = await listenCreateBanContactServer(
    runtime === undefined
      ? {
          runtime: createCreateBanContactRuntime({ telegramSharePrepare: "mock" }),
          seedTelegramUserIds: [USER_A_TG, USER_B_TG, USER_C_TG],
        }
      : { runtime, seedTelegramUserIds: [USER_A_TG, USER_B_TG, USER_C_TG] },
  );
  started.push(app);
  return app;
}

function authHeaders(telegramUserId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-98-auth-method": "development",
    "x-98-dev-secret": DEV_SECRET,
    "x-98-dev-telegram-user-id": telegramUserId,
  };
}

async function session(
  url: string,
  telegramUserId: string,
  body: Record<string, unknown> = { openIfNeeded: true },
): Promise<{
  diagnostics: TestUiDiagnostics;
  externalEntry: { outcome?: string; steps?: Array<{ eventName: string }> } | undefined;
}> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as {
    diagnostics?: TestUiDiagnostics;
    externalEntry?: { outcome?: string; steps?: Array<{ eventName: string }> };
  };
  expect(response.status, JSON.stringify(json)).toBe(200);
  return { diagnostics: json.diagnostics!, externalEntry: json.externalEntry };
}

async function externalEntryPost(
  url: string,
  telegramUserId: string,
  startParam: string,
): Promise<{
  diagnostics: TestUiDiagnostics;
  externalEntry: { outcome?: string; steps?: Array<{ eventName: string }> } | undefined;
}> {
  const response = await fetch(`${url}/api/external-entry`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ startParam }),
  });
  const json = (await response.json()) as {
    diagnostics?: TestUiDiagnostics;
    externalEntry?: { outcome?: string; steps?: Array<{ eventName: string }> };
  };
  expect(response.status).toBe(200);
  return { diagnostics: json.diagnostics!, externalEntry: json.externalEntry };
}

async function dispatch(
  url: string,
  telegramUserId: string,
  name: string,
  payload: Record<string, unknown> = {},
): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/events`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ name, payload }),
  });
  const json = (await response.json()) as { diagnostics?: TestUiDiagnostics };
  expect(response.status).toBe(200);
  return json.diagnostics!;
}

async function createTemplateBanWithToken(url: string): Promise<{ token: string }> {
  await session(url, USER_A_TG);
  await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_START");
  await dispatch(url, USER_A_TG, "CREATE_BAN.SELECT_TEMPLATE", { templateContext: {} });
  await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
  await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
  await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
  const pending = await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
  const share = (
    pending.shareOperations as Array<{ token: string; createdBanId: string | null }>
  )[0]!;
  return { token: share.token };
}

function stepNames(externalEntry: { steps?: Array<{ eventName: string }> } | undefined): string[] {
  return externalEntry?.steps?.map((step) => step.eventName) ?? [];
}

describe("PC-02 Variant A — Telegram share Reply entry orchestration", () => {
  it("receiver Incoming share URL → WHAT (E-14 after E-44/E-45)", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    const opened = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(opened.diagnostics.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(opened.externalEntry).toMatchObject({ outcome: "RESOLVED" });
    expect(stepNames(opened.externalEntry)).toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
  });

  it("receiver OVERBOARD Status share URL → WHAT.FROM_STATUS", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_BACK");
    await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD");
    const onStatus = await session(app.url, USER_B_TG, { openIfNeeded: true });
    expect(String(onStatus.diagnostics.controlState)).toMatch(
      /^NOTIFICATIONS\.STATUS\.OVERBOARD\.RECEIVER$/,
    );
    const replyUrl = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(replyUrl.diagnostics.controlState).toBe("REPLY_BAN.WHAT.FROM_STATUS");
    expect(stepNames(replyUrl.externalEntry)).toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
  });

  it("receiver TIMER share URL does not enter WHAT", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN");
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_BAN_TEXT", { banText: REPLY_TEXT });
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_DURATION", {
      durationMinutes: REPLY_DURATION,
    });
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT");
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE");
    const onTimer = await session(app.url, USER_B_TG, { openIfNeeded: true });
    expect(onTimer.diagnostics.controlState).toBe("NOTIFICATIONS.TIMER");
    const reopened = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(reopened.diagnostics.controlState).toBe("NOTIFICATIONS.TIMER");
    expect(stepNames(reopened.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
  });

  it("sender share URL stays on workflow; no Reply Ban dispatch", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    const sender = await session(app.url, USER_A_TG, {
      openIfNeeded: false,
      startParam: `share_${created.token}`,
    });
    expect(sender.externalEntry).toMatchObject({ outcome: "REJECTED" });
    expect(sender.diagnostics.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(stepNames(sender.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
    expect(stepNames(sender.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_BAN_MORE");
  });

  it("third party share URL → Lobby without Reply", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    const stranger = await session(app.url, USER_C_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(stranger.externalEntry).toMatchObject({ outcome: "REJECTED" });
    expect(stranger.diagnostics.controlState).toBe("RIM.LOBBY");
    expect(stepNames(stranger.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
  });

  it("invalid token → safe Lobby fallback", async () => {
    const app = await start();
    await session(app.url, USER_B_TG, { openIfNeeded: true });
    const rejected = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: "share_missing-token",
    });
    expect(rejected.diagnostics.controlState).toBe("RIM.LOBBY");
    expect(rejected.externalEntry).toMatchObject({ outcome: "REJECTED" });
    expect(stepNames(rejected.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
  });

  it("consumed Reply (SUCCESS) share URL does not re-enter WHAT", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_BAN_TEXT", { banText: REPLY_TEXT });
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_DURATION", {
      durationMinutes: REPLY_DURATION,
    });
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT");
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
    const success = await session(app.url, USER_B_TG, { openIfNeeded: true });
    expect(success.diagnostics.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    const reopened = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(reopened.diagnostics.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(stepNames(reopened.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
  });

  it("pending External Entry reconnect without startParam stays on Notifications (not auto WHAT)", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    await session(app.url, USER_B_TG, { openIfNeeded: true });
    await dispatch(app.url, USER_B_TG, "CONNECTION.LOST");
    await session(app.url, USER_B_TG, {
      openIfNeeded: false,
      startParam: `share_${created.token}`,
    });
    const restored = await dispatch(app.url, USER_B_TG, "CONNECTION.RESTORED");
    expect(restored.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(restored.lastEvent?.name).not.toBe("NOTIFICATIONS.PRESS_REPLY_BAN");
  });

  it("repeated share URL opens are idempotent on WHAT", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    const first = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    const second = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(first.diagnostics.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(second.diagnostics.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(second.diagnostics.incomingItems).toHaveLength(1);
  });

  it("E-30 reply send still completes after URL-orchestrated WHAT entry", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_BAN_TEXT", { banText: REPLY_TEXT });
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_DURATION", {
      durationMinutes: REPLY_DURATION,
    });
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT");
    const forbid = await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
    expect(forbid.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(forbid.lastEvent?.name).toBe("REPLY_BAN.SEND_CONFIRMED");
  });

  it("OVERBOARD Telegram callback path unchanged (binding stays Incoming until E-15)", async () => {
    const realFetch = globalThis.fetch;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("api.telegram.org")) {
          return new Response(JSON.stringify({ ok: true, result: true }), { status: 200 });
        }
        return realFetch(input, init);
      }),
    );
    const app = await start();
    await session(app.url, USER_A_TG);
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START");
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_TEMPLATE", { templateContext: {} });
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
    const forbid = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
    const share = (forbid.shareOperations as Array<{ token: string }>)[0]!;
    const processed = await processTelegramBanUpdate(app.runtime, {
      update_id: 99,
      callback_query: {
        id: "cq-overboard",
        from: { id: Number(USER_B_TG) },
        data: buildTelegramBanOverboardCallbackData(share.token),
        inline_message_id: "inline-pc02",
      },
    });
    expect(processed.code).toBe("OVERBOARD_APPLIED");
    const receiverId = (await userIdOf(app.runtime, USER_B_TG))!;
    const loaded = await app.runtime.productStore.loadProductSnapshot(receiverId);
    expect(loaded.snapshot.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(loaded.snapshot.controlState).not.toMatch(/^REPLY_BAN\./);
  });

  it("/api/external-entry applies the same Reply orchestration as session", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    const viaPost = await externalEntryPost(app.url, USER_B_TG, `share_${created.token}`);
    expect(viaPost.diagnostics.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(stepNames(viaPost.externalEntry)).toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
  });
});
