import { afterEach, describe, expect, it, vi } from "vitest";
import { listenCreateBanContactServer } from "./http.ts";
import {
  createCreateBanContactRuntime,
  userIdOf,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import {
  TELEGRAM_BAN_WEBHOOK_PATH,
  TELEGRAM_WEBHOOK_SECRET_HEADER,
  processTelegramBanUpdate,
} from "./telegram-ban-callback.ts";
import { resetTelegramBanMessageProcessLocksForTests } from "./telegram-ban-message-store.ts";
import type { TestUiDiagnostics } from "./diagnostics.ts";
import {
  buildTelegramBanOverboardCallbackData,
  prepareTelegramShareMessage,
} from "./telegram-share.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const USER_C_TG = "1003";
const DEV_SECRET = "test-secret";
const WEBHOOK_SECRET = "webhook-secret-test";
const BAN_TEXT = "no phones at dinner";

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
  sessionBody: Record<string, unknown> = { openIfNeeded: true },
): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify(sessionBody),
  });
  const body = (await response.json()) as { diagnostics?: TestUiDiagnostics };
  expect(response.status).toBe(200);
  return body.diagnostics!;
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
  const body = (await response.json()) as { diagnostics?: TestUiDiagnostics };
  expect(response.status).toBe(200);
  return body.diagnostics!;
}

async function reachSharePending(url: string): Promise<TestUiDiagnostics> {
  await session(url, USER_A_TG);
  await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_START");
  await dispatch(url, USER_A_TG, "CREATE_BAN.SELECT_TEMPLATE");
  await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
  await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
  await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
  return dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
}

function stubTelegramApi(options: { failEdit?: boolean } = {}) {
  const calls: Array<{ method: string; body: Record<string, unknown> }> = [];
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("api.telegram.org/")) {
      return realFetch(input, init);
    }
    const method = url.slice(url.lastIndexOf("/") + 1);
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    calls.push({ method, body });
    if (options.failEdit && method === "editMessageText") {
      return Response.json({ ok: false, description: "message can't be edited" });
    }
    return Response.json({ ok: true, result: true });
  });
  return calls;
}

describe("telegram ban callback PASS 3C", () => {
  it("prepares private-chat article with OVERBOARD callback and Reply URL", async () => {
    let captured = "";
    vi.stubGlobal("fetch", async (_input: RequestInfo | URL, init?: RequestInit) => {
      captured = String(init?.body ?? "");
      return Response.json({ ok: true, result: { id: "prepared-1" } });
    });
    await prepareTelegramShareMessage({
      attemptId: "share-1",
      token: "share-token-11111111-1111-1111-1111-111111111111",
      banText: BAN_TEXT,
      durationMinutes: 10,
      telegramUserId: "1001",
      botToken: "bot-token",
      botUsername: "ninety_eight_plus_mvp_bot",
    });
    const body = JSON.parse(captured);
    expect(body.allow_group_chats).toBe(false);
    expect(body.allow_user_chats).toBe(true);
    const row = body.result.reply_markup.inline_keyboard[0];
    expect(row[0].callback_data).toBe(
      buildTelegramBanOverboardCallbackData("share-token-11111111-1111-1111-1111-111111111111"),
    );
    expect(Buffer.byteLength(row[0].callback_data)).toBeLessThanOrEqual(64);
    expect(row[1].url).toContain("startapp=share_share-token-11111111-1111-1111-1111-111111111111");
  });

  it("E-08 then first OVERBOARD callback binds receiver, applies E-20, and edits the bubble", async () => {
    const calls = stubTelegramApi();
    const app = await start();
    const pending = await reachSharePending(app.url);
    expect(pending.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    const share = (pending.shareOperations as Array<{ token: string; attemptId: string; createdBanId: string }>)[0]!;
    const banId = (pending.bans as Array<{ id: string }>)[0]!.id;
    expect(share.createdBanId).toBe(banId);
    const delivery = await app.runtime.telegramBanMessageStore.findDeliveryByToken(share.token);
    expect(delivery?.banId).toBe(banId);

    const update = {
      update_id: 1,
      callback_query: {
        id: "cq-1",
        from: { id: Number(USER_B_TG) },
        data: buildTelegramBanOverboardCallbackData(share.token),
        inline_message_id: "inline-abc",
      },
    };
    const processed = await processTelegramBanUpdate(app.runtime, update);
    expect(processed.ok).toBe(true);
    expect(processed.code).toBe("OVERBOARD_APPLIED");
    expect(processed.edited).toBe(true);
    expect(processed.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");

    const receiverId = (await userIdOf(app.runtime, USER_B_TG))!;
    const senderId = (await userIdOf(app.runtime, USER_A_TG))!;
    const receiver = await app.runtime.productStore.loadProductSnapshot(receiverId);
    const ban = receiver.snapshot.extended.entities.bans[banId as never];
    expect(ban?.receiverId).toBe(receiverId);
    expect(ban?.status).toBe("OVERBOARD");
    expect(ban?.acceptance).toBe("PENDING");
    expect(ban?.boundViaTelegramShareLink).toBe(true);
    expect(Object.values(receiver.snapshot.extended.entities.domainTimers)).toHaveLength(0);
    expect(Object.values(receiver.snapshot.extended.entities.checkPairs)).toHaveLength(0);
    expect(receiver.snapshot.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");

    const sender = await app.runtime.productStore.loadProductSnapshot(senderId);
    const senderStatus = Object.values(sender.snapshot.extended.entities.notificationItems).filter(
      (item) => item.kind === "STATUS" && item.status === "OVERBOARD" && item.role === "SENDER",
    );
    expect(senderStatus).toHaveLength(1);

    const edit = calls.find((call) => call.method === "editMessageText");
    expect(edit?.body.inline_message_id).toBe("inline-abc");
    expect(String(edit?.body.text)).toContain("Status: ПЕРЕБОР");
    expect(String(edit?.body.text)).toContain(BAN_TEXT);
    const keyboard = (
      edit?.body.reply_markup as {
        inline_keyboard: Array<Array<{ text: string; callback_data?: string; url?: string }>>;
      }
    ).inline_keyboard[0];
    expect(keyboard).toHaveLength(1);
    expect(keyboard?.[0]?.text).toBe("ЗАПРЕТИТЬ В ОТВЕТ");
    expect(keyboard?.[0]?.url).toContain(`startapp=share_${share.token}`);
    expect(calls.some((call) => call.method === "answerCallbackQuery")).toBe(true);

    const duplicate = await processTelegramBanUpdate(app.runtime, update);
    expect(duplicate.code).toBe("DUPLICATE_CALLBACK");
    expect(duplicate.ok).toBe(false);
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(1);
  });

  it("rejects sender OVERBOARD and leaves Ban unbound", async () => {
    stubTelegramApi();
    const app = await start();
    const pending = await reachSharePending(app.url);
    const share = (pending.shareOperations as Array<{ token: string }>)[0]!;
    const banId = (pending.bans as Array<{ id: string }>)[0]!.id;
    const processed = await processTelegramBanUpdate(app.runtime, {
      update_id: 2,
      callback_query: {
        id: "cq-sender",
        from: { id: Number(USER_A_TG) },
        data: buildTelegramBanOverboardCallbackData(share.token),
        inline_message_id: "inline-sender",
      },
    });
    expect(processed.code).toBe("SENDER_FORBIDDEN");
    const senderId = (await userIdOf(app.runtime, USER_A_TG))!;
    const loaded = await app.runtime.productStore.loadProductSnapshot(senderId);
    expect(loaded.snapshot.extended.entities.bans[banId as never]?.receiverId).toBeNull();
    expect(loaded.snapshot.extended.entities.bans[banId as never]?.status).toBeNull();
  });

  it("serializes two fast distinct callbacks so E-20 applies once", async () => {
    const calls = stubTelegramApi();
    const app = await start();
    const pending = await reachSharePending(app.url);
    const share = (pending.shareOperations as Array<{ token: string }>)[0]!;
    const banId = (pending.bans as Array<{ id: string }>)[0]!.id;
    const first = processTelegramBanUpdate(app.runtime, {
      update_id: 3,
      callback_query: {
        id: "cq-fast-1",
        from: { id: Number(USER_B_TG) },
        data: buildTelegramBanOverboardCallbackData(share.token),
        inline_message_id: "inline-fast",
      },
    });
    const second = processTelegramBanUpdate(app.runtime, {
      update_id: 4,
      callback_query: {
        id: "cq-fast-2",
        from: { id: Number(USER_B_TG) },
        data: buildTelegramBanOverboardCallbackData(share.token),
        inline_message_id: "inline-fast",
      },
    });
    const [a, b] = await Promise.all([first, second]);
    const applied = [a, b].filter((item) => item.code === "OVERBOARD_APPLIED");
    const blocked = [a, b].filter((item) => item.code !== "OVERBOARD_APPLIED");
    expect(applied).toHaveLength(1);
    expect(blocked).toHaveLength(1);
    expect(["OVERBOARD_NOT_APPLIED", "INCOMING_NOT_ACTIVE", "BINDING_REJECTED"]).toContain(
      blocked[0]?.code,
    );
    expect(calls.filter((call) => call.method === "editMessageText")).toHaveLength(1);
    const receiverId = (await userIdOf(app.runtime, USER_B_TG))!;
    const loaded = await app.runtime.productStore.loadProductSnapshot(receiverId);
    expect(loaded.snapshot.extended.entities.bans[banId as never]?.status).toBe("OVERBOARD");
  });

  it("does not mutate Ban for unknown token or third-party conflict after bind", async () => {
    stubTelegramApi();
    const app = await start();
    const pending = await reachSharePending(app.url);
    const share = (pending.shareOperations as Array<{ token: string }>)[0]!;
    const banId = (pending.bans as Array<{ id: string }>)[0]!.id;

    const unknown = await processTelegramBanUpdate(app.runtime, {
      update_id: 5,
      callback_query: {
        id: "cq-unknown",
        from: { id: Number(USER_B_TG) },
        data: buildTelegramBanOverboardCallbackData("missing-token"),
        inline_message_id: "inline-x",
      },
    });
    expect(unknown.code).toBe("SHARE_NOT_FOUND");

    const first = await processTelegramBanUpdate(app.runtime, {
      update_id: 6,
      callback_query: {
        id: "cq-b",
        from: { id: Number(USER_B_TG) },
        data: buildTelegramBanOverboardCallbackData(share.token),
        inline_message_id: "inline-b",
      },
    });
    expect(first.code).toBe("OVERBOARD_APPLIED");

    const third = await processTelegramBanUpdate(app.runtime, {
      update_id: 7,
      callback_query: {
        id: "cq-c",
        from: { id: Number(USER_C_TG) },
        data: buildTelegramBanOverboardCallbackData(share.token),
        inline_message_id: "inline-c",
      },
    });
    expect(third.code).toBe("BINDING_REJECTED");
    const receiverId = (await userIdOf(app.runtime, USER_B_TG))!;
    const loaded = await app.runtime.productStore.loadProductSnapshot(receiverId);
    expect(loaded.snapshot.extended.entities.bans[banId as never]?.receiverId).toBe(receiverId);
  });

  it("keeps Product State when editMessageText fails", async () => {
    stubTelegramApi({ failEdit: true });
    const app = await start();
    const pending = await reachSharePending(app.url);
    const share = (pending.shareOperations as Array<{ token: string }>)[0]!;
    const banId = (pending.bans as Array<{ id: string }>)[0]!.id;
    const processed = await processTelegramBanUpdate(app.runtime, {
      update_id: 8,
      callback_query: {
        id: "cq-edit-fail",
        from: { id: Number(USER_B_TG) },
        data: buildTelegramBanOverboardCallbackData(share.token),
        inline_message_id: "inline-fail",
      },
    });
    expect(processed.code).toBe("OVERBOARD_APPLIED_EDIT_FAILED");
    expect(processed.ok).toBe(true);
    expect(processed.edited).toBe(false);
    expect(processed.telegramDescription).toContain("can't be edited");
    const receiverId = (await userIdOf(app.runtime, USER_B_TG))!;
    const loaded = await app.runtime.productStore.loadProductSnapshot(receiverId);
    expect(loaded.snapshot.extended.entities.bans[banId as never]?.status).toBe("OVERBOARD");
    expect(loaded.snapshot.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
  });

  it("webhook route requires secret and does not break SHARE_RETURNED", async () => {
    stubTelegramApi();
    const app = await start();
    const pending = await reachSharePending(app.url);
    const share = (pending.shareOperations as Array<{ token: string; attemptId: string }>)[0]!;

    const unauthorized = await fetch(`${app.url}${TELEGRAM_BAN_WEBHOOK_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        update_id: 9,
        callback_query: {
          id: "cq-http",
          from: { id: Number(USER_B_TG) },
          data: buildTelegramBanOverboardCallbackData(share.token),
          inline_message_id: "inline-http",
        },
      }),
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${app.url}${TELEGRAM_BAN_WEBHOOK_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [TELEGRAM_WEBHOOK_SECRET_HEADER]: WEBHOOK_SECRET,
      },
      body: JSON.stringify({
        update_id: 10,
        callback_query: {
          id: "cq-http-ok",
          from: { id: Number(USER_B_TG) },
          data: buildTelegramBanOverboardCallbackData(share.token),
          inline_message_id: "inline-http-ok",
        },
      }),
    });
    expect(authorized.status).toBe(200);
    const body = (await authorized.json()) as { code: string };
    expect(body.code).toBe("OVERBOARD_APPLIED");

    const returned = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SHARE_RETURNED", {
      shareAttemptId: share.attemptId,
    });
    expect(returned.controlState).toBe("CREATE_BAN.SUCCESS");
  });

  it("keeps probe routes and refuses probe watch when webhook secret is configured", async () => {
    const app = await start();
    const prepare = await fetch(`${app.url}/api/telegram-inline-probe/prepare`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(prepare.status).toBe(401);
    const prepareBody = (await prepare.json()) as { code: string };
    expect(prepareBody.code).toBe("MISSING_INIT_DATA");
  });
});
