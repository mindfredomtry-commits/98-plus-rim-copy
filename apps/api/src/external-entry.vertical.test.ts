import { afterEach, describe, expect, it } from "vitest";
import {
  ABSENT_EVENT_IDS,
  CANONICAL_EVENT_COUNT,
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  PENDING_EXTERNAL_ENTRY_TTL_MS,
  PRODUCT_CONTROL_STATE_COUNT,
} from "@98plus/product-model";
import {
  EXTERNAL_ENTRY_STAGE,
  STAGE_11_EXCLUDES,
  STAGE_12_EXCLUDES,
  TEMPLATE_CREATE_BAN_STAGE,
  parseShareStartParam,
} from "./index.ts";
import { listenCreateBanContactServer } from "./http.ts";
import {
  createCreateBanContactRuntime,
  userIdOf,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import type { TestUiDiagnostics } from "./diagnostics.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const USER_C_TG = "1003";
const BAN_TEXT = "external entry ban";
const DEV_SECRET = "test-secret";

type Started = Awaited<ReturnType<typeof listenCreateBanContactServer>>;
const started: Started[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const app = started.pop();
    if (app) {
      await app.close();
    }
  }
});

async function start(runtime?: CreateBanContactRuntime): Promise<Started> {
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
  externalEntry?: unknown;
  httpStatus: number;
}> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify(body),
  });
  const json = (await response.json()) as {
    diagnostics?: TestUiDiagnostics;
    externalEntry?: unknown;
    error?: unknown;
  };
  expect(response.status, JSON.stringify(json)).toBe(200);
  return {
    httpStatus: response.status,
    diagnostics: json.diagnostics!,
    externalEntry: json.externalEntry,
  };
}

async function dispatch(
  url: string,
  telegramUserId: string,
  name: string,
  payload: Record<string, unknown> = {},
) {
  const response = await fetch(`${url}/api/events`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ name, payload }),
  });
  const json = (await response.json()) as {
    diagnostics?: TestUiDiagnostics;
    executionStatus?: string;
    error?: { code?: string; reason?: string; message?: string };
  };
  return {
    httpStatus: response.status,
    diagnostics: json.diagnostics ?? null,
    executionStatus: json.executionStatus,
    error: json.error ?? null,
  };
}

async function createTemplateBanWithToken(url: string): Promise<{
  banId: string;
  token: string;
  attemptId: string;
}> {
  await session(url, USER_A_TG);
  await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_START");
  await dispatch(url, USER_A_TG, "CREATE_BAN.SELECT_TEMPLATE", { templateContext: {} });
  await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
  await dispatch(url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
  await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
  const pending = (await dispatch(url, USER_A_TG, "CREATE_BAN.PRESS_FORBID")).diagnostics!;
  const share = (pending.shareOperations as Array<{ attemptId: string; token: string }>)[0]!;
  const success = (
    await dispatch(url, USER_A_TG, "CREATE_BAN.SHARE_CONFIRMED", {
      shareAttemptId: share.attemptId,
      result: {},
    })
  ).diagnostics!;
  const ban = (success.bans as Array<{ id: string; receiverId: string | null }>)[0]!;
  expect(ban.receiverId).toBeNull();
  return { banId: ban.id, token: share.token, attemptId: share.attemptId };
}

describe("Stage 12 Telegram Share Link External Entry", () => {
  it("keeps frozen 30 / 55 / 333 and exposes EXTERNAL_ENTRY_STAGE = 12", async () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(55);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(333);
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(TEMPLATE_CREATE_BAN_STAGE).toBe(11);
    expect(EXTERNAL_ENTRY_STAGE).toBe(12);
    expect(STAGE_11_EXCLUDES).toContain("external-entry");
    expect(STAGE_12_EXCLUDES).not.toContain("external-entry");
    for (const id of ABSENT_EVENT_IDS) {
      expect(["E-36", "E-37", "E-38", "E-39", "E-40"]).toContain(id);
    }
    const app = await start();
    const meta = await (await fetch(`${app.url}/api/meta`)).json();
    expect(meta.EXTERNAL_ENTRY_STAGE).toBe(12);
    expect(meta.MATRIX_RULE_COUNT).toBe(333);
  });

  it("parses start_param share_<token>", () => {
    expect(parseShareStartParam("share_tok-1")).toEqual({ kind: "share", token: "tok-1" });
    expect(parseShareStartParam("")).toEqual({ kind: "absent" });
    expect(parseShareStartParam("other")).toEqual({ kind: "invalid", raw: "other" });
  });

  it("first-launch External Entry → N-01, binds same Ban, exactly one Incoming", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    const receiver = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(receiver.diagnostics.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(receiver.diagnostics.bootstrapStatus).toBe("COMPLETE");
    const bans = receiver.diagnostics.bans as Array<{
      id: string;
      receiverId: string | null;
      banText: string;
    }>;
    expect(bans).toHaveLength(1);
    expect(bans[0]?.id).toBe(created.banId);
    expect(bans[0]?.banText).toBe(BAN_TEXT);
    const receiverUserId = userIdOf(app.runtime, USER_B_TG);
    expect(bans[0]?.receiverId).toBe(receiverUserId);
    const incoming = receiver.diagnostics.incomingItems as Array<{
      id: string;
      banId: string;
      ownerId: string;
      kind: string;
    }>;
    expect(incoming).toHaveLength(1);
    expect(incoming[0]?.banId).toBe(created.banId);
    expect(incoming[0]?.ownerId).toBe(receiverUserId);
    expect(incoming[0]?.kind).toBe("INCOMING_BAN");
    expect(receiver.diagnostics.activeNotificationItemId).toBe(incoming[0]?.id);
    expect(receiver.externalEntry).toMatchObject({
      outcome: "RESOLVED",
      token: created.token,
      shareTargetBanId: created.banId,
      bindStatus: "BOUND",
    });
  });

  it("re-entry while Incoming unprocessed does not create a second Incoming", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    const again = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(again.diagnostics.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(
      (again.diagnostics.incomingItems as Array<{ banId: string }>).filter(
        (item) => item.banId === created.banId,
      ),
    ).toHaveLength(1);
  });

  it("Guard B: processed Incoming + bound Ban stays without new Incoming", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    const afterOverboard = (await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"))
      .diagnostics!;
    const statusState = afterOverboard.controlState;
    expect(String(statusState)).toMatch(/^NOTIFICATIONS\.STATUS\.OVERBOARD/);

    const stayed = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(stayed.diagnostics.controlState).toBe(statusState);
    expect(stayed.externalEntry).toMatchObject({ outcome: "RESOLVED" });
    expect(
      (stayed.diagnostics.incomingItems as Array<{ banId: string }>).filter(
        (item) => item.banId === created.banId,
      ),
    ).toHaveLength(1);
  });

  it("rejects unknown token with E-46 and preserves current state", async () => {
    const app = await start();
    await session(app.url, USER_B_TG, { openIfNeeded: true });
    const rejected = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: "share_missing-token",
    });
    expect(rejected.diagnostics.controlState).toBe("RIM.LOBBY");
    expect(rejected.externalEntry).toMatchObject({ outcome: "REJECTED" });
    expect(rejected.diagnostics.lastEvent?.name).toBe("TELEGRAM_SHARE_LINK.REJECTED");
    expect(rejected.diagnostics.incomingItems).toEqual([]);
  });

  it("does not recreate Ban; sender Ban count stays one after receiver bind", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    const sender = await session(app.url, USER_A_TG, { openIfNeeded: true });
    expect(sender.diagnostics.bans).toHaveLength(1);
    expect((sender.diagnostics.bans as Array<{ id: string }>)[0]?.id).toBe(created.banId);
    expect((sender.diagnostics.bans as Array<{ receiverId: string | null }>)[0]?.receiverId).toBe(
      userIdOf(app.runtime, USER_B_TG),
    );
  });

  it("existing-session displacement: receiver on RIM.LOBBY → N-01", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    const lobby = await session(app.url, USER_B_TG, { openIfNeeded: true });
    expect(lobby.diagnostics.controlState).toBe("RIM.LOBBY");
    const resolved = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(resolved.diagnostics.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(resolved.externalEntry).toMatchObject({ outcome: "RESOLVED", bindStatus: "BOUND" });
  });

  it("offline E-44 leaves pending; CONNECTION.RESTORED resolves to N-01", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    await session(app.url, USER_B_TG, { openIfNeeded: true });
    await dispatch(app.url, USER_B_TG, "CONNECTION.LOST");
    const offline = await session(app.url, USER_B_TG, {
      openIfNeeded: false,
      startParam: `share_${created.token}`,
    });
    expect(offline.externalEntry).toMatchObject({ outcome: "PENDING" });
    expect(offline.diagnostics.pendingExternalEntry).not.toBeNull();

    const restored = await dispatch(app.url, USER_B_TG, "CONNECTION.RESTORED");
    expect(restored.diagnostics?.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(
      (restored.diagnostics?.incomingItems as Array<{ banId: string }> | undefined)?.some(
        (item) => item.banId === created.banId,
      ),
    ).toBe(true);
  });

  it("E-41 TTL expiry clears pending External Entry and preserves established state", async () => {
    let now = 1_000_000;
    const runtime = createCreateBanContactRuntime({
      telegramSharePrepare: "mock",
      clock: { nowMs: () => now },
    });
    const app = await start(runtime);
    const created = await createTemplateBanWithToken(app.url);
    await session(app.url, USER_B_TG, { openIfNeeded: true });
    await dispatch(app.url, USER_B_TG, "CONNECTION.LOST");
    const offline = await session(app.url, USER_B_TG, {
      openIfNeeded: false,
      startParam: `share_${created.token}`,
    });
    expect(offline.externalEntry).toMatchObject({ outcome: "PENDING" });
    expect(offline.diagnostics.pendingExternalEntry).not.toBeNull();
    expect(offline.diagnostics.controlState).toBe("RIM.LOBBY");

    now += PENDING_EXTERNAL_ENTRY_TTL_MS;
    const expired = await session(app.url, USER_B_TG, { openIfNeeded: true });
    expect(expired.diagnostics.pendingExternalEntry).toBeNull();
    expect(expired.diagnostics.controlState).toBe("RIM.LOBBY");
    expect(expired.diagnostics.incomingItems).toEqual([]);
  });

  it("different user cannot steal a Ban already bound to another receiver", async () => {
    const app = await start();
    const created = await createTemplateBanWithToken(app.url);
    await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    const stolen = await session(app.url, USER_C_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(stolen.externalEntry).toMatchObject({ outcome: "REJECTED", bindStatus: "CONFLICT" });
    expect(stolen.diagnostics.controlState).toBe("RIM.LOBBY");
    expect(stolen.diagnostics.incomingItems).toEqual([]);
  });

  it("transport rejects E-44 / E-45 / E-46 from TEST UI events", async () => {
    const app = await start();
    await session(app.url, USER_B_TG, { openIfNeeded: true });
    for (const name of [
      "TELEGRAM_SHARE_LINK.OPENED",
      "TELEGRAM_SHARE_LINK.RESOLVED",
      "TELEGRAM_SHARE_LINK.REJECTED",
      "EXTERNAL_ENTRY.PENDING_EXPIRED",
    ]) {
      const blocked = await dispatch(app.url, USER_B_TG, name, {});
      expect(blocked.httpStatus).toBe(400);
      expect(blocked.error?.code).toBe("SERVER_RESULT_NOT_ACCEPTED");
    }
  });
});
