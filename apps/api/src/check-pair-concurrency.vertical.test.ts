import { afterEach, describe, expect, it } from "vitest";
import { APPLICATION_STAGE } from "@98plus/application";
import { IDENTITY_STAGE } from "@98plus/identity";
import { MemorySqlClient, PERSISTENCE_STAGE } from "@98plus/persistence";
import {
  ABSENT_EVENT_IDS,
  CANONICAL_EVENT_COUNT,
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
} from "@98plus/product-model";
import { completeCheckAnswer } from "./check-answer.ts";
import {
  CREATE_BAN_CONTACT_STAGE,
  INCOMING_OVERBOARD_STAGE,
  REPLY_BAN_FROM_INCOMING_STAGE,
  TIMER_CHECK_STATUS_STAGE,
} from "./stage.ts";
import { listenCreateBanContactServer } from "./http.ts";
import {
  authenticateRuntime,
  createCreateBanContactRuntime,
  executeAuthenticatedEvent,
  userIdOf,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import { grantContactBetweenTelegramUsers } from "./seed-contact.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const DEV_SECRET = "test-secret";
const AUTHORITATIVE_NOW = 8_000_000;
const BAN_DURATION = 10;
const DURATION_MS = BAN_DURATION * 60 * 1000;

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

function authHeaders(telegramUserId: string): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-98-auth-method": "development",
    "x-98-dev-secret": DEV_SECRET,
    "x-98-dev-telegram-user-id": telegramUserId,
  };
}

async function session(url: string, telegramUserId: string) {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ openIfNeeded: true }),
  });
  expect(response.status).toBe(200);
}

async function dispatch(url: string, telegramUserId: string, name: string) {
  const response = await fetch(`${url}/api/events`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ name, payload: {} }),
  });
  const body = (await response.json()) as {
    diagnostics?: {
      controlState: string | null;
      checkPairs: readonly {
        id: string;
        receiverAnswer: string | null;
        senderAnswer: string | null;
        resultingStatus: string | null;
      }[];
      notificationItems: readonly {
        kind: string;
        role?: string;
        status?: string;
        lifecycle: { status: string };
      }[];
      priorities: { statusItemId: string | null };
      activeNotificationItemId: string | null;
    };
    orchestration?: { serverEvent: { eventName: string } };
  };
  expect(response.status).toBe(200);
  return body;
}

async function reachBothChecks(now: { value: number }, sql: MemorySqlClient) {
  const runtime = createCreateBanContactRuntime({
    sql,
    clock: { nowMs: () => now.value },
    seedTelegramUserIds: [USER_A_TG, USER_B_TG],
  });
  const app = await listenCreateBanContactServer({
    runtime,
    seedTelegramUserIds: [USER_A_TG, USER_B_TG],
  });
  started.push(app);
  await session(app.url, USER_A_TG);
  await session(app.url, USER_B_TG);
  grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START");
  const contactsResponse = await fetch(`${app.url}/api/snapshot`, {
    headers: authHeaders(USER_A_TG),
  });
  const contactsBody = (await contactsResponse.json()) as {
    diagnostics: { contacts: readonly { telegramUserId: string; userId: string }[] };
  };
  const bId =
    contactsBody.diagnostics.contacts.find((contact) => contact.telegramUserId === USER_B_TG)
      ?.userId ?? userIdOf(app.runtime, USER_B_TG);
  await fetch(`${app.url}/api/events`, {
    method: "POST",
    headers: authHeaders(USER_A_TG),
    body: JSON.stringify({
      name: "CREATE_BAN.SELECT_CONTACT",
      payload: { contactId: bId },
    }),
  });
  await fetch(`${app.url}/api/events`, {
    method: "POST",
    headers: authHeaders(USER_A_TG),
    body: JSON.stringify({
      name: "CREATE_BAN.CHANGE_BAN_TEXT",
      payload: { banText: "не пропускай зал" },
    }),
  });
  await fetch(`${app.url}/api/events`, {
    method: "POST",
    headers: authHeaders(USER_A_TG),
    body: JSON.stringify({
      name: "CREATE_BAN.CHANGE_DURATION",
      payload: { durationMinutes: BAN_DURATION },
    }),
  });
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT");
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
  await session(app.url, USER_B_TG);
  await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS");
  await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN");
  await fetch(`${app.url}/api/events`, {
    method: "POST",
    headers: authHeaders(USER_B_TG),
    body: JSON.stringify({
      name: "REPLY_BAN.CHANGE_BAN_TEXT",
      payload: { banText: "ответный запрет" },
    }),
  });
  await fetch(`${app.url}/api/events`, {
    method: "POST",
    headers: authHeaders(USER_B_TG),
    body: JSON.stringify({
      name: "REPLY_BAN.CHANGE_DURATION",
      payload: { durationMinutes: 15 },
    }),
  });
  await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT");
  await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
  await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE");
  now.value += DURATION_MS;
  await fetch(`${app.url}/api/snapshot`, { headers: authHeaders(USER_B_TG) });
  await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS");
  await session(app.url, USER_A_TG);
  const aState = await fetch(`${app.url}/api/snapshot`, { headers: authHeaders(USER_A_TG) });
  const aBody = (await aState.json()) as { diagnostics: { controlState: string | null } };
  if (aBody.diagnostics.controlState === "CREATE_BAN.SUCCESS") {
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE");
  } else if (aBody.diagnostics.controlState === "RIM.LOBBY") {
    await dispatch(app.url, USER_A_TG, "RIM.PRESS_NOTIFICATIONS");
  }
  // MVP6: Incoming Y for reply Ban sits ahead of Check; process via OVERBOARD + E-19.
  for (;;) {
    const open = await fetch(`${app.url}/api/snapshot`, { headers: authHeaders(USER_A_TG) });
    const openBody = (await open.json()) as { diagnostics: { controlState: string | null } };
    if (openBody.diagnostics.controlState !== "NOTIFICATIONS.INCOMING_BAN") {
      break;
    }
    await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_OVERBOARD");
    await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_TO_BANS");
  }
  return { app, runtime };
}

describe("Stage 9 CheckPair shared-backend concurrency", () => {
  it("keeps frozen 30 / 60 / 360", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(60);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(360);
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(IDENTITY_STAGE).toBe(3);
    expect(PERSISTENCE_STAGE).toBe(4);
    expect(APPLICATION_STAGE).toBe(5);
    expect(CREATE_BAN_CONTACT_STAGE).toBe(6);
    expect(INCOMING_OVERBOARD_STAGE).toBe(7);
    expect(REPLY_BAN_FROM_INCOMING_STAGE).toBe(8);
    expect(TIMER_CHECK_STATUS_STAGE).toBe(9);
    expect(ABSENT_EVENT_IDS).toEqual(["E-36", "E-37", "E-38", "E-39", "E-40"]);
  });

  it("A. sequential FIRST then SECOND still works", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const { app } = await reachBothChecks(now, new MemorySqlClient());
    const first = await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED");
    expect(first.orchestration?.serverEvent.eventName).toBe(
      "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
    );
    const second = await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED");
    expect(second.orchestration?.serverEvent.eventName).toBe(
      "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
    );
    expect(second.diagnostics?.checkPairs[0]?.resultingStatus).toBe("BANTASTIC");
  });

  it("B–K / O. two independent runtimes sharing one SQL client produce one FIRST and one SECOND", async () => {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const now = { value: AUTHORITATIVE_NOW };
      const sql = new MemorySqlClient();
      const { app, runtime } = await reachBothChecks(now, sql);
      const runtimeA: CreateBanContactRuntime = createCreateBanContactRuntime({
        sql,
        identityStore: runtime.identityStore,
        clock: { nowMs: () => now.value },
      });
      const runtimeB: CreateBanContactRuntime = createCreateBanContactRuntime({
        sql,
        identityStore: runtime.identityStore,
        clock: { nowMs: () => now.value },
      });
      expect(runtimeA.productStore).not.toBe(runtimeB.productStore);
      const contextA = await authenticateRuntime(runtimeA, {
        method: "development",
        secret: DEV_SECRET,
        telegramUserId: USER_A_TG,
      });
      const contextB = await authenticateRuntime(runtimeB, {
        method: "development",
        secret: DEV_SECRET,
        telegramUserId: USER_B_TG,
      });
      const pressA = await executeAuthenticatedEvent(runtimeA, contextA, {
        name: "NOTIFICATIONS.CHECK_ANSWER.FULFILLED",
        payload: {},
      });
      const pressB = await executeAuthenticatedEvent(runtimeB, contextB, {
        name: "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED",
        payload: {},
      });
      expect(pressA.status).toBe("APPLIED");
      expect(pressB.status).toBe("APPLIED");
      const [a, b] = await Promise.all([
        completeCheckAnswer(runtimeA, contextA, pressA),
        completeCheckAnswer(runtimeB, contextB, pressB),
      ]);
      const names = [a.event.name, b.event.name];
      expect(names).toEqual(
        expect.arrayContaining([
          "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
          "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
        ]),
      );
      expect(new Set(names).size).toBe(2);
      const second = a.event.name.endsWith("SECOND") ? a : b;
      const first = a.event.name.endsWith("FIRST") ? a : b;
      expect(first.event.name).toBe("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST");
      expect(second.event.name).toBe("NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND");
      const reloadedSecond = await runtimeA.productStore.loadProductSnapshot(second.currentUserId);
      const reloadedFirst = await runtimeB.productStore.loadProductSnapshot(first.currentUserId);
      const finalPair = Object.values(reloadedSecond.snapshot.extended.entities.checkPairs)[0];
      expect(finalPair?.resultingStatus).toBe("BANFLICT");
      expect(finalPair).toEqual(
        Object.values(reloadedFirst.snapshot.extended.entities.checkPairs)[0],
      );
      const checks = [
        ...Object.values(reloadedFirst.snapshot.extended.entities.notificationItems),
        ...Object.values(reloadedSecond.snapshot.extended.entities.notificationItems),
      ].filter((item) => item.kind === "CHECK");
      expect(checks.every((item) => item.lifecycle.status === "PROCESSED")).toBe(true);
      const statuses = [
        ...Object.values(reloadedFirst.snapshot.extended.entities.notificationItems),
        ...Object.values(reloadedSecond.snapshot.extended.entities.notificationItems),
      ].filter((item) => item.kind === "STATUS" && item.status === "BANFLICT");
      expect(new Set(statuses.map((item) => item.id)).size).toBe(2);
      expect(reloadedSecond.snapshot.extended.entities.bans[finalPair!.banId]?.status).toBe(
        "BANFLICT",
      );
      const secondStatus = Object.values(
        reloadedSecond.snapshot.extended.entities.notificationItems,
      ).find(
        (item) =>
          item.kind === "STATUS" &&
          item.status === "BANFLICT" &&
          item.ownerId === second.currentUserId,
      );
      expect(reloadedSecond.snapshot.extended.priorities.statusItemId).toBe(secondStatus?.id);
      expect(reloadedSecond.snapshot.extended.activeNotificationItemId).toBe(secondStatus?.id);
      const firstBanflict = Object.values(
        reloadedFirst.snapshot.extended.entities.notificationItems,
      ).find(
        (item) =>
          item.kind === "STATUS" &&
          item.status === "BANFLICT" &&
          item.ownerId === first.currentUserId,
      );
      expect(reloadedFirst.snapshot.extended.priorities.statusItemId).not.toBe(firstBanflict?.id);
      expect(reloadedFirst.snapshot.extended.activeNotificationItemId).not.toBe(firstBanflict?.id);
      void app;
    }
  });

  it("L / M. duplicate FIRST and SECOND confirmations do not rewrite the pair", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const sql = new MemorySqlClient();
    const { app, runtime } = await reachBothChecks(now, sql);
    await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED");
    const second = await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED");
    const pair = second.diagnostics?.checkPairs[0];
    const contextB = await authenticateRuntime(runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const contextA = await authenticateRuntime(runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_A_TG,
    });
    const loadedB = await runtime.productStore.loadProductSnapshot(contextB.currentUserId);
    const loadedA = await runtime.productStore.loadProductSnapshot(contextA.currentUserId);
    const replayFirst = await executeAuthenticatedEvent(runtime, contextB, {
      name: "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
      payload: {
        checkItemId: Object.values(loadedB.snapshot.extended.entities.notificationItems).find(
          (item) => item.kind === "CHECK",
        )?.id,
        answer: "FULFILLED",
        checkPairId: pair?.id,
      },
    });
    expect(replayFirst.status).not.toBe("APPLIED");
    const replaySecond = await executeAuthenticatedEvent(runtime, contextA, {
      name: "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
      payload: {
        checkItemId: Object.values(loadedA.snapshot.extended.entities.notificationItems).find(
          (item) => item.kind === "CHECK",
        )?.id,
        answer: "FULFILLED",
        checkPairId: pair?.id,
        resultingStatus: "BANTASTIC",
      },
    });
    expect(replaySecond.status).not.toBe("APPLIED");
    const after = await runtime.productStore.loadProductSnapshot(contextA.currentUserId);
    expect(Object.values(after.snapshot.extended.entities.checkPairs)[0]?.resultingStatus).toBe(
      "BANTASTIC",
    );
    expect(
      Object.values(after.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "STATUS" && item.status === "BANTASTIC",
      ),
    ).toHaveLength(1);
  });
});
