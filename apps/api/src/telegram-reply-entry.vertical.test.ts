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
const BAN_DURATION = 10;
const AUTHORITATIVE_NOW = 9_000_000;
const DURATION_MS = BAN_DURATION * 60 * 1000;

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

async function createTemplateBanWithToken(
  url: string,
): Promise<{ token: string; attemptId: string }> {
  await session(url, USER_A_TG);
  await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_START");
  await dispatch(url, USER_A_TG, "CREATE_BAN.SELECT_TEMPLATE", { templateContext: {} });
  await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
  await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", {
    durationMinutes: BAN_DURATION,
  });
  await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
  const pending = await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
  const share = (
    pending.shareOperations as Array<{
      token: string;
      attemptId: string;
      createdBanId: string | null;
    }>
  )[0]!;
  return { token: share.token, attemptId: share.attemptId };
}

async function snapshot(url: string, telegramUserId: string): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/snapshot`, {
    headers: authHeaders(telegramUserId),
  });
  const json = (await response.json()) as { diagnostics?: TestUiDiagnostics };
  expect(response.status).toBe(200);
  return json.diagnostics!;
}

function stepNames(externalEntry: { steps?: Array<{ eventName: string }> } | undefined): string[] {
  return externalEntry?.steps?.map((step) => step.eventName) ?? [];
}

function banFingerprint(diagnostics: TestUiDiagnostics) {
  return (diagnostics.bans as Array<{ id: string; receiverId: string | null; acceptance: string }>)
    .map((ban) => `${ban.id}:${ban.receiverId}:${ban.acceptance}`)
    .sort();
}

function notificationFingerprint(diagnostics: TestUiDiagnostics) {
  return (
    diagnostics.notificationItems as Array<{
      id: string;
      kind: string;
      lifecycle: { status: string };
    }>
  )
    .map((item) => `${item.id}:${item.kind}:${item.lifecycle.status}`)
    .sort();
}

async function completeReplyFromWhat(url: string): Promise<TestUiDiagnostics> {
  await dispatch(url, USER_B_TG, "REPLY_BAN.CHANGE_BAN_TEXT", { banText: REPLY_TEXT });
  await dispatch(url, USER_B_TG, "REPLY_BAN.CHANGE_DURATION", {
    durationMinutes: REPLY_DURATION,
  });
  await dispatch(url, USER_B_TG, "REPLY_BAN.PRESS_NEXT");
  return dispatch(url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
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
    expect(sender.diagnostics.controlState).toBe("CREATE_BAN.SUCCESS");
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

  describe("Stage 2B — OA-1 sender characterization (no Lobby reset)", () => {
    it("SENDER re-entry reaches Success, not Lobby, and does not dispatch Reply", async () => {
      const app = await start();
      const created = await createTemplateBanWithToken(app.url);
      const first = await session(app.url, USER_A_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      expect(first.externalEntry).toMatchObject({ outcome: "REJECTED" });
      expect(first.diagnostics.controlState).toBe("CREATE_BAN.SUCCESS");
      expect(first.diagnostics.controlState).not.toBe("RIM.LOBBY");
      expect(stepNames(first.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
      expect(stepNames(first.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_BAN_MORE");
      expect(stepNames(first.externalEntry)).not.toContain("APP.NORMAL_OPEN");
      const again = await session(app.url, USER_A_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      expect(again.diagnostics.controlState).toBe("CREATE_BAN.SUCCESS");
      expect(stepNames(again.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
    });

    it("SENDER on CREATE_BAN.SUCCESS after SHARE_RETURNED: stays SUCCESS; no Reply events", async () => {
      const app = await start();
      const created = await createTemplateBanWithToken(app.url);
      const success = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_RETURNED", {
        shareAttemptId: created.attemptId,
      });
      expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
      const opened = await session(app.url, USER_A_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      expect(opened.externalEntry).toMatchObject({ outcome: "REJECTED" });
      expect(opened.diagnostics.controlState).toBe("CREATE_BAN.SUCCESS");
      expect(opened.diagnostics.controlState).not.toBe("RIM.LOBBY");
      expect(stepNames(opened.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
      expect(stepNames(opened.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_BAN_MORE");
    });
  });

  describe("Stage 2B — CHECK / TIMER protection", () => {
    it("RECEIVER on CHECK + valid share token → no E-14, no WHAT, Check unchanged", async () => {
      const now = { value: AUTHORITATIVE_NOW };
      const runtime = createCreateBanContactRuntime({
        telegramSharePrepare: "mock",
        clock: { nowMs: () => now.value },
      });
      const app = await start(runtime);
      const created = await createTemplateBanWithToken(app.url);
      await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      await completeReplyFromWhat(app.url);
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE");
      expect((await snapshot(app.url, USER_B_TG)).controlState).toBe("NOTIFICATIONS.TIMER");
      now.value += DURATION_MS;
      const afterExpire = await snapshot(app.url, USER_B_TG);
      expect(afterExpire.controlState).toBe("NOTIFICATIONS.TIMER");
      const onCheck = await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS");
      expect(onCheck.controlState).toBe("NOTIFICATIONS.CHECK.RECEIVER");
      const beforeBans = banFingerprint(onCheck);
      const beforeItems = notificationFingerprint(onCheck);
      const beforeActive = onCheck.activeNotificationItemId;
      const reopened = await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      expect(reopened.diagnostics.controlState).toBe("NOTIFICATIONS.CHECK.RECEIVER");
      expect(reopened.diagnostics.controlState).not.toMatch(/^REPLY_BAN\.WHAT/);
      expect(stepNames(reopened.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
      expect(stepNames(reopened.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_BAN_MORE");
      expect(banFingerprint(reopened.diagnostics)).toEqual(beforeBans);
      expect(notificationFingerprint(reopened.diagnostics)).toEqual(beforeItems);
      expect(reopened.diagnostics.activeNotificationItemId).toBe(beforeActive);
      expect(reopened.diagnostics.replyBanDraft).toBeNull();
    });

    it("RECEIVER on TIMER remains protected (no E-14) after re-open", async () => {
      const app = await start();
      const created = await createTemplateBanWithToken(app.url);
      await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      await completeReplyFromWhat(app.url);
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE");
      const onTimer = await snapshot(app.url, USER_B_TG);
      expect(onTimer.controlState).toBe("NOTIFICATIONS.TIMER");
      const beforeItems = notificationFingerprint(onTimer);
      const first = await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      const second = await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      expect(first.diagnostics.controlState).toBe("NOTIFICATIONS.TIMER");
      expect(second.diagnostics.controlState).toBe("NOTIFICATIONS.TIMER");
      expect(stepNames(first.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
      expect(stepNames(second.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
      expect(notificationFingerprint(second.diagnostics)).toEqual(beforeItems);
    });
  });

  describe("Stage 2B — re-entry / idempotency", () => {
    it("RECEIVER already in Reply WHAT: repeated URL short-circuits without E-44/E-45/E-14", async () => {
      const app = await start();
      const created = await createTemplateBanWithToken(app.url);
      const first = await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      expect(first.diagnostics.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
      expect(stepNames(first.externalEntry)).toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_BAN_TEXT", {
        banText: "draft in progress",
      });
      const second = await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      expect(second.diagnostics.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
      expect(second.externalEntry).toMatchObject({ outcome: "NOOP" });
      expect(stepNames(second.externalEntry)).toEqual([]);
      expect(second.diagnostics.incomingItems).toHaveLength(1);
      expect(second.diagnostics.replyBanDraft).toEqual({
        banText: "draft in progress",
        durationMinutes: null,
      });
    });

    it("RECEIVER after E-30: repeated URL stays SUCCESS without E-14", async () => {
      const app = await start();
      const created = await createTemplateBanWithToken(app.url);
      await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      await completeReplyFromWhat(app.url);
      const first = await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      const second = await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      expect(first.diagnostics.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
      expect(second.diagnostics.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
      expect(stepNames(first.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
      expect(stepNames(second.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
    });

    it("RECEIVER with processed Status source: no WHAT after leaving Status", async () => {
      const app = await start();
      const created = await createTemplateBanWithToken(app.url);
      await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_BACK");
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD");
      const afterStatus = await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS");
      expect(afterStatus.controlState).not.toMatch(/^NOTIFICATIONS\.STATUS\./);
      const beforeState = afterStatus.controlState;
      const beforeItems = notificationFingerprint(afterStatus);
      const reopen = await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      expect(reopen.diagnostics.controlState).toBe(beforeState);
      expect(reopen.diagnostics.controlState).not.toMatch(/^REPLY_BAN\.WHAT/);
      expect(stepNames(reopen.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
      expect(notificationFingerprint(reopen.diagnostics)).toEqual(beforeItems);
    });

    it("SENDER opening the same URL repeatedly reaches Success without Reply events", async () => {
      const app = await start();
      const created = await createTemplateBanWithToken(app.url);
      const opens = [];
      for (let i = 0; i < 3; i += 1) {
        opens.push(
          await session(app.url, USER_A_TG, {
            openIfNeeded: true,
            startParam: `share_${created.token}`,
          }),
        );
      }
      for (const opened of opens) {
        expect(opened.diagnostics.controlState).toBe("CREATE_BAN.SUCCESS");
        expect(opened.externalEntry).toMatchObject({ outcome: "REJECTED" });
        expect(stepNames(opened.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
        expect(stepNames(opened.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_BAN_MORE");
      }
    });

    it("THIRD PARTY opening the same URL repeatedly stays Lobby without Reply", async () => {
      const app = await start();
      const created = await createTemplateBanWithToken(app.url);
      await session(app.url, USER_B_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      const first = await session(app.url, USER_C_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      const second = await session(app.url, USER_C_TG, {
        openIfNeeded: true,
        startParam: `share_${created.token}`,
      });
      expect(first.diagnostics.controlState).toBe("RIM.LOBBY");
      expect(second.diagnostics.controlState).toBe("RIM.LOBBY");
      expect(first.externalEntry).toMatchObject({ outcome: "REJECTED" });
      expect(second.externalEntry).toMatchObject({ outcome: "REJECTED" });
      expect(stepNames(first.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
      expect(stepNames(second.externalEntry)).not.toContain("NOTIFICATIONS.PRESS_REPLY_BAN");
      expect(first.diagnostics.incomingItems).toEqual([]);
      expect(second.diagnostics.incomingItems).toEqual([]);
    });
  });
});
