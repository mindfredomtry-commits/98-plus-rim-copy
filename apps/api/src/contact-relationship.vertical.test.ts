import { afterEach, describe, expect, it } from "vitest";
import { PostgresProductStore } from "@98plus/persistence";
import {
  ABSENT_EVENT_IDS,
  CANONICAL_EVENT_COUNT,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  PRODUCT_SPECIFICATION_SOURCE,
} from "@98plus/product-model";
import { CONTACT_RELATIONSHIP_STAGE, STAGE_13B_EXCLUDES } from "./stage.ts";
import { listenCreateBanContactServer } from "./http.ts";
import {
  createCreateBanContactRuntime,
  seedRegisteredUsers,
  userIdOf,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import type { TestUiDiagnostics } from "./diagnostics.ts";
import { seedContactBetweenTelegramUsers } from "./seed-contact.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const USER_C_TG = "1003";
const DEV_SECRET = "test-secret";
const BAN_TEXT = "contact ban";

function asPostgresStore(runtime: CreateBanContactRuntime): PostgresProductStore {
  expect(runtime.productStore).toBeInstanceOf(PostgresProductStore);
  return runtime.productStore as PostgresProductStore;
}

type Started = Awaited<ReturnType<typeof listenCreateBanContactServer>>;
const started: Started[] = [];

afterEach(async () => {
  while (started.length > 0) {
    const app = started.pop();
    if (app) await app.close();
  }
});

async function start(runtime?: CreateBanContactRuntime): Promise<Started> {
  const app = await listenCreateBanContactServer(
    runtime === undefined
      ? {
          runtime: createCreateBanContactRuntime({ telegramSharePrepare: "mock" }),
          seedTelegramUserIds: [USER_A_TG, USER_B_TG, USER_C_TG],
        }
      : { runtime, seedTelegramUserIds: [] },
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
): Promise<{ diagnostics: TestUiDiagnostics; externalEntry?: unknown }> {
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
  return { diagnostics: json.diagnostics!, externalEntry: json.externalEntry };
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
    error?: { code?: string; reason?: string };
    orchestration?: unknown;
  };
  return {
    httpStatus: response.status,
    diagnostics: json.diagnostics ?? null,
    error: json.error ?? null,
    orchestration: json.orchestration ?? null,
  };
}

function contactIds(diagnostics: TestUiDiagnostics): string[] {
  return diagnostics.contacts.map((contact) => contact.userId).sort();
}

async function createTemplateShare(url: string, telegramUserId: string) {
  let current = await session(url, telegramUserId);
  if (current.diagnostics.controlState === "CREATE_BAN.SUCCESS") {
    current = {
      diagnostics: (await dispatch(url, telegramUserId, "CREATE_BAN.PRESS_FORBID_MORE"))
        .diagnostics!,
    };
  }
  if (current.diagnostics.controlState !== "CREATE_BAN.WHO") {
    if (current.diagnostics.controlState !== "RIM.LOBBY") {
      current = await session(url, telegramUserId);
    }
    const start = await dispatch(url, telegramUserId, "CREATE_BAN.PRESS_START");
    expect(start.diagnostics?.controlState).toBe("CREATE_BAN.WHO");
  }
  const template = await dispatch(url, telegramUserId, "CREATE_BAN.SELECT_TEMPLATE");
  expect(template.diagnostics?.controlState).toBe("CREATE_BAN.WHAT.TEMPLATE");
  await dispatch(url, telegramUserId, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
  await dispatch(url, telegramUserId, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
  const confirm = await dispatch(url, telegramUserId, "CREATE_BAN.PRESS_NEXT");
  expect(confirm.diagnostics?.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE");
  const forbid = await dispatch(url, telegramUserId, "CREATE_BAN.PRESS_FORBID");
  expect(forbid.diagnostics?.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
  const attemptId = forbid.diagnostics?.activeShareAttemptId;
  expect(attemptId).toBeTruthy();
  const created = (forbid.diagnostics?.bans ?? []) as Array<{
    id: string;
    receiverId: string | null;
  }>;
  expect(created).toHaveLength(1);
  expect(created[0]?.receiverId).toBeNull();
  const share = (
    forbid.diagnostics?.shareOperations as Array<{
      token: string;
      createdBanId: string | null;
      status?: string;
    }>
  )?.find((item) => item.status === "ACTIVE" && item.createdBanId === created[0]?.id);
  expect(share?.token).toBeTruthy();
  expect(share?.createdBanId).toBe(created[0]?.id);
  return { token: share!.token };
}

describe("Stage 13B MVP8 Contact relationship", () => {
  it("keeps frozen 30 / 60 / 360 under MVP10 authority", () => {
    expect(PRODUCT_SPECIFICATION_SOURCE.revision).toBe("10");
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
    expect(ABSENT_EVENT_IDS).toEqual(["E-36", "E-37", "E-38", "E-39", "E-40"]);
    expect(CONTACT_RELATIONSHIP_STAGE).toBe(13);
    expect(STAGE_13B_EXCLUDES).toContain("rim-ai");
  });

  it("WHO and RIM.SELECT_CONTACT stay empty without a qualifying Ban", async () => {
    const app = await start();
    const a = await session(app.url, USER_A_TG);
    const b = await session(app.url, USER_B_TG);
    await session(app.url, USER_C_TG);
    expect(contactIds(a.diagnostics)).toEqual([]);
    expect(contactIds(b.diagnostics)).toEqual([]);
    const who = (await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START")).diagnostics!;
    expect(who.controlState).toBe("CREATE_BAN.WHO");
    expect(contactIds(who)).toEqual([]);
    const bId = (await userIdOf(app.runtime, USER_B_TG))!;
    const rejected = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", {
      contactId: bId,
    });
    expect(rejected.httpStatus).toBe(400);
    expect(rejected.error?.reason).toBe("NOT_SELECTABLE");
  });

  it("historical authoritative Ban materializes symmetric Contact set", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    await session(app.url, USER_B_TG);
    await session(app.url, USER_C_TG);
    await seedContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
    const aId = (await userIdOf(app.runtime, USER_A_TG))!;
    const bId = (await userIdOf(app.runtime, USER_B_TG))!;
    const cId = (await userIdOf(app.runtime, USER_C_TG))!;
    const aWho = (await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START")).diagnostics!;
    const bWho = (await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_START")).diagnostics!;
    expect(contactIds(aWho)).toEqual([bId]);
    expect(contactIds(bWho)).toEqual([aId]);
    expect(contactIds(aWho)).not.toContain(cId);
    expect(contactIds(bWho)).not.toContain(cId);

    await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_BACK");
    await dispatch(app.url, USER_A_TG, "RIM.PRESS_START_CHAT");
    const aSelect = (await dispatch(app.url, USER_A_TG, "RIM.PRESS_SELECT_CONTACT")).diagnostics!;
    expect(aSelect.controlState).toBe("RIM.SELECT_CONTACT");
    expect(contactIds(aSelect)).toEqual(contactIds(aWho));
    await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_BACK");
    await dispatch(app.url, USER_B_TG, "RIM.PRESS_START_CHAT");
    const bSelect = (await dispatch(app.url, USER_B_TG, "RIM.PRESS_SELECT_CONTACT")).diagnostics!;
    expect(contactIds(bSelect)).toEqual(contactIds(bWho));
  });

  it("E-44 alone does not create Contact; E-45 binding does symmetrically once", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    await session(app.url, USER_B_TG);
    const aId = (await userIdOf(app.runtime, USER_A_TG))!;
    const bId = (await userIdOf(app.runtime, USER_B_TG))!;

    expect(contactIds((await session(app.url, USER_A_TG)).diagnostics)).toEqual([]);
    expect(contactIds((await session(app.url, USER_B_TG)).diagnostics)).toEqual([]);

    const created = await createTemplateShare(app.url, USER_A_TG);
    expect(
      Object.values(
        (await app.runtime.productStore.loadProductSnapshot(aId)).snapshot.extended.entities.bans,
      )[0]?.receiverId,
    ).toBeNull();

    await dispatch(app.url, USER_B_TG, "CONNECTION.LOST");
    const opened = await session(app.url, USER_B_TG, {
      openIfNeeded: false,
      startParam: `share_${created.token}`,
    });
    expect(opened.externalEntry).toMatchObject({ outcome: "PENDING" });
    expect(opened.diagnostics.lastEvent).toEqual({
      id: "E-44",
      name: "TELEGRAM_SHARE_LINK.OPENED",
    });
    expect(opened.diagnostics.pendingExternalEntry).not.toBeNull();
    expect(
      Object.values(
        (await app.runtime.productStore.loadProductSnapshot(aId)).snapshot.extended.entities.bans,
      )[0]?.receiverId,
    ).toBeNull();
    expect(contactIds(opened.diagnostics)).toEqual([]);
    expect(contactIds((await session(app.url, USER_A_TG)).diagnostics)).toEqual([]);

    const senderPending = (await session(app.url, USER_A_TG, { openIfNeeded: false })).diagnostics;
    expect(senderPending.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(contactIds(senderPending)).toEqual([]);

    const restored = await dispatch(app.url, USER_B_TG, "CONNECTION.RESTORED");
    expect(restored.diagnostics?.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const bound = Object.values(
      (await app.runtime.productStore.loadProductSnapshot(aId)).snapshot.extended.entities.bans,
    );
    expect(bound).toHaveLength(1);
    expect(bound[0]?.receiverId).toBe(bId);
    expect(contactIds(restored.diagnostics!)).toEqual([aId]);
    const senderAfterClaim = (await session(app.url, USER_A_TG, { openIfNeeded: false }))
      .diagnostics;
    expect(senderAfterClaim.controlState).toBe("CREATE_BAN.CONFIRM.TEMPLATE.SHARE_PENDING");
    expect(senderAfterClaim.successfulBanId).toBe(bound[0]?.id);
    expect(contactIds(senderAfterClaim)).toEqual([bId]);

    expect(contactIds((await session(app.url, USER_B_TG)).diagnostics)).toEqual([aId]);
    await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS");
    let bAfter = (await session(app.url, USER_B_TG)).diagnostics;
    if (bAfter.controlState !== "RIM.LOBBY") {
      bAfter = (await session(app.url, USER_B_TG, { openIfNeeded: true })).diagnostics;
    }
    expect(contactIds(bAfter)).toEqual([aId]);
    if (bAfter.controlState === "RIM.LOBBY") {
      const bWho = (await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_START")).diagnostics!;
      expect(contactIds(bWho)).toEqual([aId]);
      await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_BACK");
      await dispatch(app.url, USER_B_TG, "RIM.PRESS_START_CHAT");
      const bRim = (await dispatch(app.url, USER_B_TG, "RIM.PRESS_SELECT_CONTACT")).diagnostics!;
      expect(contactIds(bRim)).toEqual([aId]);
    }
  });

  it("E-45 atomicity: persistence failure rolls back receiverId and Contact; retry succeeds once", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    await session(app.url, USER_B_TG);
    const aId = (await userIdOf(app.runtime, USER_A_TG))!;
    const bId = (await userIdOf(app.runtime, USER_B_TG))!;
    const created = await createTemplateShare(app.url, USER_A_TG);
    expect(
      Object.values(
        (await app.runtime.productStore.loadProductSnapshot(aId)).snapshot.extended.entities.bans,
      )[0]?.receiverId,
    ).toBeNull();

    asPostgresStore(app.runtime).failNextWriteAfterBans();
    const failed = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(
      Object.values(
        (await app.runtime.productStore.loadProductSnapshot(aId)).snapshot.extended.entities.bans,
      )[0]?.receiverId,
    ).toBeNull();
    expect(contactIds(failed.diagnostics)).toEqual([]);
    expect(contactIds((await session(app.url, USER_A_TG)).diagnostics)).toEqual([]);
    expect(failed.diagnostics.incomingItems).toEqual([]);

    let aState = (await session(app.url, USER_A_TG)).diagnostics;
    if (aState.controlState === "CREATE_BAN.SUCCESS") {
      aState = (await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE")).diagnostics!;
    }
    if (aState.controlState === "RIM.LOBBY") {
      const aWho = (await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START")).diagnostics!;
      expect(contactIds(aWho)).toEqual([]);
      await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_BACK");
      await dispatch(app.url, USER_A_TG, "RIM.PRESS_START_CHAT");
      const aRim = (await dispatch(app.url, USER_A_TG, "RIM.PRESS_SELECT_CONTACT")).diagnostics!;
      expect(contactIds(aRim)).toEqual([]);
      await dispatch(app.url, USER_A_TG, "RIM.PRESS_BACK");
      await dispatch(app.url, USER_A_TG, "RIM.PRESS_BACK");
    }

    const resolved = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(resolved.diagnostics.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const bound = Object.values(
      (await app.runtime.productStore.loadProductSnapshot(aId)).snapshot.extended.entities.bans,
    );
    expect(bound).toHaveLength(1);
    expect(bound[0]?.receiverId).toBe(bId);
    expect(contactIds(resolved.diagnostics)).toEqual([aId]);
    expect(
      contactIds((await session(app.url, USER_A_TG, { openIfNeeded: false })).diagnostics),
    ).toEqual([bId]);
    expect(resolved.diagnostics.incomingItems).toHaveLength(1);

    const again = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(contactIds(again.diagnostics)).toEqual([aId]);
    expect(again.diagnostics.incomingItems).toHaveLength(1);
    expect(
      Object.keys(
        (await app.runtime.productStore.loadProductSnapshot(aId)).snapshot.extended.entities.bans,
      ),
    ).toHaveLength(1);
  });

  it("E-45 reconnect atomicity: failed restore leaves receiverId null; later restore binds once", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    await session(app.url, USER_B_TG);
    const aId = (await userIdOf(app.runtime, USER_A_TG))!;
    const bId = (await userIdOf(app.runtime, USER_B_TG))!;
    const created = await createTemplateShare(app.url, USER_A_TG);

    await dispatch(app.url, USER_B_TG, "CONNECTION.LOST");
    const opened = await session(app.url, USER_B_TG, {
      openIfNeeded: false,
      startParam: `share_${created.token}`,
    });
    expect(opened.externalEntry).toMatchObject({ outcome: "PENDING" });
    expect(
      Object.values(
        (await app.runtime.productStore.loadProductSnapshot(aId)).snapshot.extended.entities.bans,
      )[0]?.receiverId,
    ).toBeNull();
    expect(contactIds(opened.diagnostics)).toEqual([]);

    asPostgresStore(app.runtime).failNextWriteAfterBans();
    const failedRestore = await dispatch(app.url, USER_B_TG, "CONNECTION.RESTORED");
    expect(
      Object.values(
        (await app.runtime.productStore.loadProductSnapshot(aId)).snapshot.extended.entities.bans,
      )[0]?.receiverId,
    ).toBeNull();
    expect(contactIds(failedRestore.diagnostics!)).toEqual([]);
    expect(
      contactIds((await session(app.url, USER_A_TG, { openIfNeeded: false })).diagnostics),
    ).toEqual([]);

    const restored = await dispatch(app.url, USER_B_TG, "CONNECTION.RESTORED");
    expect(restored.diagnostics?.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const bound = Object.values(
      (await app.runtime.productStore.loadProductSnapshot(aId)).snapshot.extended.entities.bans,
    );
    expect(bound).toHaveLength(1);
    expect(bound[0]?.receiverId).toBe(bId);
    expect(contactIds(restored.diagnostics!)).toEqual([aId]);
    expect(contactIds((await session(app.url, USER_A_TG)).diagnostics)).toEqual([bId]);
  });

  it("template share does not create Contact until recipient claim; repeat open stays one", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    await session(app.url, USER_B_TG);
    const created = await createTemplateShare(app.url, USER_A_TG);
    const aAfterShare = await session(app.url, USER_A_TG);
    expect(contactIds(aAfterShare.diagnostics)).toEqual([]);
    const bAfterShare = await session(app.url, USER_B_TG);
    expect(contactIds(bAfterShare.diagnostics)).toEqual([]);

    const resolved = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(resolved.diagnostics.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const aId = (await userIdOf(app.runtime, USER_A_TG))!;
    const bId = (await userIdOf(app.runtime, USER_B_TG))!;
    expect(contactIds(resolved.diagnostics)).toEqual([aId]);
    const aAfterBind = await session(app.url, USER_A_TG);
    expect(contactIds(aAfterBind.diagnostics)).toEqual([bId]);

    const again = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: `share_${created.token}`,
    });
    expect(contactIds(again.diagnostics)).toEqual([aId]);
    expect(
      Object.keys(
        (await app.runtime.productStore.loadProductSnapshot(aId)).snapshot.extended.entities.bans,
      ),
    ).toHaveLength(1);
  });

  it("E-08 does not establish Contact; CONTACT E-10 does not duplicate", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    await session(app.url, USER_B_TG);
    await seedContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
    const bId = (await userIdOf(app.runtime, USER_B_TG))!;
    const aId = (await userIdOf(app.runtime, USER_A_TG))!;
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START");
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: bId });
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
    const beforeForbid = await session(app.url, USER_A_TG);
    expect(contactIds(beforeForbid.diagnostics)).toEqual([bId]);
    // E-08 is embedded in PRESS_FORBID orchestration; after success Contact set stays size 1.
    const success = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
    expect(success.diagnostics?.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(contactIds(success.diagnostics!)).toEqual([bId]);
    const bView = await session(app.url, USER_B_TG);
    expect(contactIds(bView.diagnostics)).toEqual([aId]);
  });

  it("E-46 rejection does not create Contact", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    await session(app.url, USER_B_TG);
    const rejected = await session(app.url, USER_B_TG, {
      openIfNeeded: true,
      startParam: "share_missing-token",
    });
    expect(rejected.externalEntry).toMatchObject({ outcome: "REJECTED" });
    expect(contactIds(rejected.diagnostics)).toEqual([]);
    const aView = await session(app.url, USER_A_TG);
    expect(contactIds(aView.diagnostics)).toEqual([]);
  });

  it("opposite-direction Ban and Reply Ban do not duplicate Contacts", async () => {
    const runtime = createCreateBanContactRuntime({
      telegramSharePrepare: "mock",
    });
    await seedRegisteredUsers(runtime, [USER_A_TG, USER_B_TG, USER_C_TG]);
    const app = await start(runtime);
    await session(app.url, USER_A_TG);
    await session(app.url, USER_B_TG);
    await seedContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
    const aId = (await userIdOf(app.runtime, USER_A_TG))!;
    const bId = (await userIdOf(app.runtime, USER_B_TG))!;

    await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_START");
    await dispatch(app.url, USER_B_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: aId });
    await dispatch(app.url, USER_B_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: "B to A" });
    await dispatch(app.url, USER_B_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
    await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_NEXT");
    await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_FORBID");
    expect(contactIds((await session(app.url, USER_A_TG)).diagnostics)).toEqual([bId]);
    expect(contactIds((await session(app.url, USER_B_TG)).diagnostics)).toEqual([aId]);

    await session(app.url, USER_A_TG);
    const aState = (await dispatch(app.url, USER_A_TG, "RIM.PRESS_NOTIFICATIONS")).diagnostics!;
    if (aState.controlState === "NOTIFICATIONS.INCOMING_BAN") {
      await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_REPLY_BAN");
      await dispatch(app.url, USER_A_TG, "REPLY_BAN.CHANGE_BAN_TEXT", { banText: "reply" });
      await dispatch(app.url, USER_A_TG, "REPLY_BAN.CHANGE_DURATION", { durationMinutes: 15 });
      await dispatch(app.url, USER_A_TG, "REPLY_BAN.PRESS_NEXT");
      await dispatch(app.url, USER_A_TG, "REPLY_BAN.PRESS_FORBID");
    }
    expect(contactIds((await session(app.url, USER_A_TG)).diagnostics)).toEqual([bId]);
    expect(contactIds((await session(app.url, USER_B_TG)).diagnostics)).toEqual([aId]);
  });

  it("self and registered non-Contacts stay excluded from both surfaces", async () => {
    const app = await start();
    await session(app.url, USER_A_TG);
    await session(app.url, USER_B_TG);
    await session(app.url, USER_C_TG);
    await seedContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
    const aId = (await userIdOf(app.runtime, USER_A_TG))!;
    const cId = (await userIdOf(app.runtime, USER_C_TG))!;
    const who = (await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START")).diagnostics!;
    expect(contactIds(who)).not.toContain(aId);
    expect(contactIds(who)).not.toContain(cId);
    const self = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", {
      contactId: aId,
    });
    expect(self.error?.reason).toBe("SELF");
    const stranger = await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", {
      contactId: cId,
    });
    expect(stranger.error?.reason).toBe("NOT_SELECTABLE");
  });
});
