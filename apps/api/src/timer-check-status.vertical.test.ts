import { afterEach, describe, expect, it } from "vitest";
import { APPLICATION_STAGE } from "@98plus/application";
import {
  ABSENT_EVENT_IDS,
  CANONICAL_EVENT_COUNT,
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
} from "@98plus/product-model";
import { IDENTITY_STAGE } from "@98plus/identity";
import { PERSISTENCE_STAGE } from "@98plus/persistence";
import { runDurationExpirationTick } from "../../worker/src/index.ts";
import {
  CREATE_BAN_CONTACT_STAGE,
  INCOMING_OVERBOARD_STAGE,
  REPLY_BAN_FROM_INCOMING_STAGE,
  REPLY_BAN_FROM_STATUS_STAGE,
  STAGE_8_EXCLUDES,
  STAGE_9_EXCLUDES,
  TIMER_CHECK_STATUS_STAGE,
  completeCheckAnswer,
} from "./index.ts";
import { listenCreateBanContactServer } from "./http.ts";
import {
  authenticateRuntime,
  createCreateBanContactRuntime,
  executeAuthenticatedEvent,
  userIdOf,
  type CreateBanContactRuntime,
} from "./runtime.ts";
import type { TestUiDiagnostics } from "./diagnostics.ts";
import type { ContactSendOrchestration } from "./contact-send.ts";
import { grantContactBetweenTelegramUsers } from "./seed-contact.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const BAN_TEXT = "не пропускай зал";
const REPLY_TEXT = "ответный запрет";
const REPLY_DURATION = 15;
const BAN_DURATION = 10;
const DEV_SECRET = "test-secret";
const AUTHORITATIVE_NOW = 8_000_000;
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

function clockAt(now: { value: number }): CreateBanContactRuntime {
  return createCreateBanContactRuntime({
    clock: { nowMs: () => now.value },
  });
}

async function start(runtime?: CreateBanContactRuntime): Promise<Started> {
  const app = await listenCreateBanContactServer(
    runtime === undefined ? {} : { runtime, seedTelegramUserIds: [USER_A_TG, USER_B_TG] },
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

async function session(url: string, telegramUserId: string): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/session`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ openIfNeeded: true }),
  });
  const body = (await response.json()) as { diagnostics?: TestUiDiagnostics; error?: unknown };
  expect(response.status, JSON.stringify(body)).toBe(200);
  return body.diagnostics!;
}

async function dispatch(
  url: string,
  telegramUserId: string,
  name: string,
  payload: Record<string, unknown> = {},
): Promise<{
  httpStatus: number;
  diagnostics: TestUiDiagnostics | null;
  executionStatus?: string;
  orchestration: ContactSendOrchestration | null;
  error: { code?: string; reason?: string; message?: string } | null;
}> {
  const response = await fetch(`${url}/api/events`, {
    method: "POST",
    headers: authHeaders(telegramUserId),
    body: JSON.stringify({ name, payload }),
  });
  const body = (await response.json()) as {
    diagnostics?: TestUiDiagnostics;
    executionStatus?: string;
    orchestration?: ContactSendOrchestration;
    error?: { code?: string; reason?: string; message?: string };
  };
  return {
    httpStatus: response.status,
    diagnostics: body.diagnostics ?? null,
    orchestration: body.orchestration ?? null,
    error: body.error ?? null,
    ...(body.executionStatus === undefined ? {} : { executionStatus: body.executionStatus }),
  };
}

function requireDiagnostics(result: Awaited<ReturnType<typeof dispatch>>): TestUiDiagnostics {
  expect(result.httpStatus, JSON.stringify(result.error)).toBe(200);
  expect(result.diagnostics).not.toBeNull();
  return result.diagnostics!;
}

async function snapshot(url: string, telegramUserId: string): Promise<TestUiDiagnostics> {
  const response = await fetch(`${url}/api/snapshot`, { headers: authHeaders(telegramUserId) });
  const body = (await response.json()) as { diagnostics: TestUiDiagnostics };
  expect(response.status).toBe(200);
  return body.diagnostics;
}

type BanJson = {
  id: string;
  senderId: string;
  receiverId: string | null;
  banText: string;
  durationMinutes: number;
  acceptance: string;
  status: string | null;
};

type NotificationJson = {
  id: string;
  ownerId: string;
  banId: string;
  kind: string;
  role?: string;
  status?: string;
  checkPairId?: string;
  lifecycle: { status: string; display?: string };
};

type TimerJson = {
  id: string;
  banId: string;
  startedAt: number;
  durationMinutes: number;
  state: string;
  checkPairCreated?: boolean;
};

type PairJson = {
  id: string;
  banId: string;
  receiverAnswer: string | null;
  senderAnswer: string | null;
  resultingStatus: string | null;
};

function bansOf(diagnostics: TestUiDiagnostics): BanJson[] {
  return diagnostics.bans as BanJson[];
}

function itemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return diagnostics.notificationItems as NotificationJson[];
}

function checkItemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return itemsOf(diagnostics).filter((item) => item.kind === "CHECK");
}

function statusItemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return itemsOf(diagnostics).filter((item) => item.kind === "STATUS");
}

function timerItemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return itemsOf(diagnostics).filter((item) => item.kind === "TIMER");
}

function domainTimersOf(diagnostics: TestUiDiagnostics): TimerJson[] {
  return diagnostics.domainTimers as TimerJson[];
}

function pairsOf(diagnostics: TestUiDiagnostics): PairJson[] {
  return diagnostics.checkPairs as PairJson[];
}

async function createRealIncomingFromA(app: Started): Promise<{ ban: BanJson }> {
  await session(app.url, USER_A_TG);
  await session(app.url, USER_B_TG);
  grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
  const who = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
  const listed = who.contacts.find((contact) => contact.telegramUserId === USER_B_TG);
  const bId = listed?.userId ?? userIdOf(app.runtime, USER_B_TG);
  requireDiagnostics(
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: bId }),
  );
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", {
    durationMinutes: BAN_DURATION,
  });
  requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
  const a = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID"));
  expect(a.controlState).toBe("CREATE_BAN.SUCCESS");
  return { ban: bansOf(a)[0]! };
}

async function reachAcceptedSuccess(app: Started): Promise<{
  ban: BanJson;
  success: TestUiDiagnostics;
}> {
  const { ban } = await createRealIncomingFromA(app);
  await session(app.url, USER_B_TG);
  requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
  requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"));
  requireDiagnostics(
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_BAN_TEXT", { banText: REPLY_TEXT }),
  );
  requireDiagnostics(
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_DURATION", {
      durationMinutes: REPLY_DURATION,
    }),
  );
  requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
  const success = requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"));
  expect(success.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
  return { ban, success };
}

async function reachTimer(app: Started): Promise<{ ban: BanJson; timer: TestUiDiagnostics }> {
  const { ban } = await reachAcceptedSuccess(app);
  const timer = requireDiagnostics(
    await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE"),
  );
  expect(timer.controlState).toBe("NOTIFICATIONS.TIMER");
  return { ban, timer };
}

async function openNotifications(app: Started, telegramUserId: string): Promise<TestUiDiagnostics> {
  const current = await snapshot(app.url, telegramUserId);
  if (current.controlState === "CREATE_BAN.SUCCESS") {
    return requireDiagnostics(
      await dispatch(app.url, telegramUserId, "CREATE_BAN.PRESS_FORBID_MORE"),
    );
  }
  if (current.controlState === "RIM.LOBBY") {
    return requireDiagnostics(await dispatch(app.url, telegramUserId, "RIM.PRESS_NOTIFICATIONS"));
  }
  return current;
}

/** MVP6: reply Incoming Y sits ahead of Check/Status for User A; process via N-01 OVERBOARD + E-19. */
async function drainLeadingIncomingBans(
  app: Started,
  telegramUserId: string,
  opened: TestUiDiagnostics,
): Promise<TestUiDiagnostics> {
  let current = opened;
  while (current.controlState === "NOTIFICATIONS.INCOMING_BAN") {
    const overboard = requireDiagnostics(
      await dispatch(app.url, telegramUserId, "NOTIFICATIONS.PRESS_OVERBOARD"),
    );
    expect(overboard.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    current = requireDiagnostics(
      await dispatch(app.url, telegramUserId, "NOTIFICATIONS.PRESS_TO_BANS"),
    );
  }
  return current;
}

async function openNotificationsPastReplyIncoming(
  app: Started,
  telegramUserId: string,
): Promise<TestUiDiagnostics> {
  const opened = await openNotifications(app, telegramUserId);
  return drainLeadingIncomingBans(app, telegramUserId, opened);
}

async function expireNow(now: { value: number }, app: Started): Promise<TestUiDiagnostics> {
  now.value += DURATION_MS;
  return snapshot(app.url, USER_B_TG);
}

describe("Stage 9 Timer expiration → Check → Status vertical", () => {
  it("keeps frozen 30 / 59 / 359 and TIMER_CHECK_STATUS_STAGE = 9", () => {
    expect(PRODUCT_CONTROL_STATE_COUNT).toBe(30);
    expect(CANONICAL_EVENT_COUNT).toBe(59);
    expect(MATRIX_CONTRACT_ROWS).toHaveLength(359);
    expect(IMPLEMENTATION_STAGE).toBe(2);
    expect(IDENTITY_STAGE).toBe(3);
    expect(PERSISTENCE_STAGE).toBe(4);
    expect(APPLICATION_STAGE).toBe(5);
    expect(CREATE_BAN_CONTACT_STAGE).toBe(6);
    expect(INCOMING_OVERBOARD_STAGE).toBe(7);
    expect(REPLY_BAN_FROM_INCOMING_STAGE).toBe(8);
    expect(TIMER_CHECK_STATUS_STAGE).toBe(9);
    expect(REPLY_BAN_FROM_STATUS_STAGE).toBe(10);
    expect(ABSENT_EVENT_IDS).toEqual(["E-36", "E-37", "E-38", "E-39", "E-40"]);
    expect(STAGE_8_EXCLUDES).toContain("timer-processing");
    expect(STAGE_9_EXCLUDES).not.toContain("timer-processing");
    expect(STAGE_9_EXCLUDES).not.toContain("check");
    expect(STAGE_9_EXCLUDES).toContain("reply-ban-from-status");
  });

  it("1–3. E-42 creates one CheckPair and two Check Items without interrupting SUCCESS", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));
    const { ban, success } = await reachAcceptedSuccess(app);
    expect(domainTimersOf(success)[0]?.state).toBe("RUNNING");
    const expired = await expireNow(now, app);
    expect(expired.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(pairsOf(expired)).toHaveLength(1);
    expect(pairsOf(expired)[0]?.banId).toBe(ban.id);
    const checks = checkItemsOf(expired);
    expect(checks).toHaveLength(1);
    expect(checks[0]?.role).toBe("RECEIVER");
    expect(checks[0]?.lifecycle.status).toBe("UNPROCESSED");
    const senderView = await snapshot(app.url, USER_A_TG);
    expect(checkItemsOf(senderView)).toHaveLength(1);
    expect(checkItemsOf(senderView)[0]?.role).toBe("SENDER");
    expect(pairsOf(senderView)).toHaveLength(1);
    expect(pairsOf(senderView)[0]?.id).toBe(pairsOf(expired)[0]?.id);
    const again = await snapshot(app.url, USER_B_TG);
    expect(pairsOf(again)).toHaveLength(1);
    expect(domainTimersOf(again)[0]?.state).toBe("EXPIRED");
  });

  it("4–5. processed Timer Item does not stop DomainTimer; FULL_CLOSE still lets duration expire", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));
    const { ban } = await reachTimer(app);
    const closed = requireDiagnostics(await dispatch(app.url, USER_B_TG, "APP.FULL_CLOSE"));
    expect(timerItemsOf(closed).every((item) => item.lifecycle.status === "PROCESSED")).toBe(true);
    expect(domainTimersOf(closed)[0]?.state).toBe("RUNNING");
    expect(domainTimersOf(closed)[0]?.banId).toBe(ban.id);
    now.value += DURATION_MS;
    expect(await runDurationExpirationTick(app.runtime)).toBeGreaterThan(0);
    const after = await snapshot(app.url, USER_B_TG);
    expect(pairsOf(after)).toHaveLength(1);
    expect(domainTimersOf(after)[0]?.state).toBe("EXPIRED");
    expect(after.controlState).toBeNull();
  });

  it("6–9 / 21. E-19 processes Timer then Check first answer is E-22 without Status", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));
    await reachTimer(app);
    await expireNow(now, app);
    const afterTimer = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
    );
    expect(afterTimer.controlState).toBe("NOTIFICATIONS.CHECK.RECEIVER");
    expect(timerItemsOf(afterTimer).every((item) => item.lifecycle.status === "PROCESSED")).toBe(
      true,
    );
    expect(domainTimersOf(afterTimer)[0]?.state).toBe("EXPIRED");
    const answer = await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED");
    const first = requireDiagnostics(answer);
    expect(answer.orchestration?.serverEvent.eventName).toBe(
      "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
    );
    expect(pairsOf(first)[0]?.receiverAnswer).toBe("FULFILLED");
    expect(pairsOf(first)[0]?.senderAnswer).toBeNull();
    expect(pairsOf(first)[0]?.resultingStatus).toBeNull();
    expect(statusItemsOf(first).filter((item) => item.status !== "OVERBOARD")).toHaveLength(0);
    expect(checkItemsOf(first)[0]?.lifecycle.status).toBe("PROCESSED");
    expect(first.controlState).toBe("RIM.LOBBY");
    const firstOps = Object.values(first.pendingOperations).filter(
      (operation) => operation.kind === "CHECK_ANSWER",
    );
    expect(firstOps).toHaveLength(1);
    expect(firstOps[0]?.resultApplied).toBe(true);
    expect(firstOps[0]?.originatingItemId).toBe(checkItemsOf(first)[0]?.id);
  });

  it("10–16. second answer maps Status and opens the second-answer user's Status screen", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));
    await reachTimer(app);
    await expireNow(now, app);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED"));
    await session(app.url, USER_A_TG);
    const senderCheck = await openNotificationsPastReplyIncoming(app, USER_A_TG);
    expect(senderCheck.controlState).toBe("NOTIFICATIONS.CHECK.SENDER");
    const second = await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED");
    const done = requireDiagnostics(second);
    expect(second.orchestration?.serverEvent.eventName).toBe(
      "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
    );
    expect(pairsOf(done)[0]?.resultingStatus).toBe("BANTASTIC");
    expect(statusItemsOf(done).filter((item) => item.status === "BANTASTIC")).toHaveLength(1);
    expect(done.controlState).toBe("NOTIFICATIONS.STATUS.BANTASTIC.SENDER");
    expect(done.priorities.statusItemId).toBe(done.activeNotificationItemId);
    const receiverView = await snapshot(app.url, USER_B_TG);
    expect(statusItemsOf(receiverView).filter((item) => item.status === "BANTASTIC")).toHaveLength(
      1,
    );
  });

  it("11–13. F/NF → BANFLICT and NF/NF → FAIR_ENOUGH", async () => {
    async function secondStatus(firstAnswer: string, secondAnswer: string, expected: string) {
      const now = { value: AUTHORITATIVE_NOW };
      const app = await start(clockAt(now));
      await reachTimer(app);
      await expireNow(now, app);
      requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
      requireDiagnostics(await dispatch(app.url, USER_B_TG, firstAnswer));
      await session(app.url, USER_A_TG);
      await openNotificationsPastReplyIncoming(app, USER_A_TG);
      const done = requireDiagnostics(await dispatch(app.url, USER_A_TG, secondAnswer));
      expect(pairsOf(done)[0]?.resultingStatus).toBe(expected);
      expect(done.controlState).toBe(`NOTIFICATIONS.STATUS.${expected}.SENDER`);
    }
    await secondStatus(
      "NOTIFICATIONS.CHECK_ANSWER.FULFILLED",
      "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED",
      "BANFLICT",
    );
    await secondStatus(
      "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED",
      "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED",
      "FAIR_ENOUGH",
    );
  });

  it("15. second-answer receiver opens the matching receiver Status", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));
    await reachTimer(app);
    await expireNow(now, app);
    await session(app.url, USER_A_TG);
    await openNotificationsPastReplyIncoming(app, USER_A_TG);
    requireDiagnostics(await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
    const done = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED"),
    );
    expect(pairsOf(done)[0]?.resultingStatus).toBe("BANFLICT");
    expect(done.controlState).toBe("NOTIFICATIONS.STATUS.BANFLICT.RECEIVER");
  });

  it("17. E-21 keeps Check unprocessed and retryable", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(
      createCreateBanContactRuntime({
        clock: { nowMs: () => now.value },
        checkAnswerCompletion: "fail-once",
      }),
    );
    await reachTimer(app);
    await expireNow(now, app);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
    const failed = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED"),
    );
    expect(failed.controlState).toBe("NOTIFICATIONS.CHECK.RECEIVER");
    expect(checkItemsOf(failed)[0]?.lifecycle.status).toBe("UNPROCESSED");
    expect(pairsOf(failed)[0]?.receiverAnswer).toBeNull();
    const retry = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED"),
    );
    expect(pairsOf(retry)[0]?.receiverAnswer).toBe("FULFILLED");
  });

  it("18. duplicate confirmed Check answer does not create a second pair or Status", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));
    await reachTimer(app);
    await expireNow(now, app);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
    const first = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED"),
    );
    const pair = pairsOf(first)[0]!;
    const checkItem = checkItemsOf(first)[0]!;
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const replay = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
      payload: {
        checkItemId: checkItem.id as never,
        answer: "FULFILLED",
        checkPairId: pair.id as never,
      },
    });
    expect(replay.status).not.toBe("APPLIED");
    const loaded = await snapshot(app.url, USER_B_TG);
    expect(pairsOf(loaded)).toHaveLength(1);
    expect(statusItemsOf(loaded).filter((item) => item.status === "BANTASTIC")).toEqual([]);
  });

  it("19. concurrent Check answers produce exactly one FIRST and one SECOND", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));
    await reachTimer(app);
    await expireNow(now, app);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
    await session(app.url, USER_A_TG);
    await openNotificationsPastReplyIncoming(app, USER_A_TG);
    const [b, a] = await Promise.all([
      dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED"),
      dispatch(app.url, USER_A_TG, "NOTIFICATIONS.CHECK_ANSWER.NOT_FULFILLED"),
    ]);
    const names = [b.orchestration?.serverEvent.eventName, a.orchestration?.serverEvent.eventName];
    expect(names).toEqual(
      expect.arrayContaining([
        "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
        "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
      ]),
    );
    expect(new Set(names).size).toBe(2);
    const done = await snapshot(app.url, USER_B_TG);
    expect(pairsOf(done)).toHaveLength(1);
    expect(pairsOf(done)[0]?.resultingStatus).toBe("BANFLICT");
    expect(statusItemsOf(done).filter((item) => item.status === "BANFLICT").length).toBeGreaterThan(
      0,
    );
  });

  it("20. late E-23 after a newer control state persists Status without stealing UI", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));
    await reachTimer(app);
    await expireNow(now, app);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED"));
    await session(app.url, USER_A_TG);
    const onCheck = await openNotificationsPastReplyIncoming(app, USER_A_TG);
    expect(onCheck.controlState).toBe("NOTIFICATIONS.CHECK.SENDER");
    if (onCheck.priorities.statusItemId) {
      const stale = itemsOf(onCheck).find((item) => item.id === onCheck.priorities.statusItemId);
      expect(stale?.kind).toBe("STATUS");
      expect(stale?.lifecycle.status).toBe("PROCESSED");
    }
    const press = await executeAuthenticatedEvent(
      app.runtime,
      await authenticateRuntime(app.runtime, {
        method: "development",
        secret: DEV_SECRET,
        telegramUserId: USER_A_TG,
      }),
      { name: "NOTIFICATIONS.CHECK_ANSWER.FULFILLED", payload: {} },
    );
    expect(press.status).toBe("APPLIED");
    const operation = Object.values(press.snapshot.runtime.pendingOperations).find(
      (item) => item.kind === "CHECK_ANSWER",
    );
    expect(operation).toBeTruthy();
    const userId = press.currentUserId;
    app.runtime.sql.tables.upsertOperation(userId, {
      ...operation!,
      supersededByExternalEntry: true,
    });
    const sessionRow = app.runtime.sql.tables.lockSession(userId);
    expect(sessionRow).toBeTruthy();
    app.runtime.sql.tables.writeSession({
      ...sessionRow!,
      controlState: "NOTIFICATIONS.INCOMING_BAN",
    });
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_A_TG,
    });
    const late = await completeCheckAnswer(app.runtime, context, {
      ...press,
      snapshot: {
        ...press.snapshot,
        controlState: "NOTIFICATIONS.INCOMING_BAN",
        runtime: {
          ...press.snapshot.runtime,
          pendingOperations: {
            [operation!.operationId]: { ...operation!, supersededByExternalEntry: true },
          },
        },
      },
    });
    expect(late.status).toBe("APPLIED");
    expect(late.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const bantastic = Object.values(late.snapshot.extended.entities.notificationItems).find(
      (item) => item.kind === "STATUS" && item.status === "BANTASTIC" && item.ownerId === userId,
    );
    expect(late.snapshot.extended.priorities.statusItemId).not.toBe(bantastic?.id);
    expect(late.snapshot.extended.activeNotificationItemId).not.toBe(bantastic?.id);
    expect(Object.values(late.snapshot.extended.entities.checkPairs)[0]?.resultingStatus).toBe(
      "BANTASTIC",
    );
    expect(
      Object.values(late.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "STATUS" && item.status === "BANTASTIC",
      ).length,
    ).toBeGreaterThan(0);
  });

  it("21–22. Status E-19 processes the Status Item and continues through E-43", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));
    await reachTimer(app);
    await expireNow(now, app);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED"));
    await session(app.url, USER_A_TG);
    await openNotificationsPastReplyIncoming(app, USER_A_TG);
    const status = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED"),
    );
    expect(status.controlState).toBe("NOTIFICATIONS.STATUS.BANTASTIC.SENDER");
    const after = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
    );
    expect(statusItemsOf(after).find((item) => item.role === "SENDER")?.lifecycle.status).toBe(
      "PROCESSED",
    );
    expect(after.controlState).toBe("RIM.LOBBY");
    await session(app.url, USER_B_TG);
    let receiverOpen = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"),
    );
    // A's OVERBOARD of reply Ban Y creates OVERBOARD.SENDER Status for B ahead of Ban X Status.
    while (
      receiverOpen.controlState === "NOTIFICATIONS.STATUS.OVERBOARD.SENDER" ||
      receiverOpen.controlState === "NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER"
    ) {
      receiverOpen = requireDiagnostics(
        await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
      );
    }
    expect(receiverOpen.controlState).toBe("NOTIFICATIONS.STATUS.BANTASTIC.RECEIVER");
    const receiverDone = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
    );
    expect(receiverDone.controlState).toBe("RIM.LOBBY");
    expect(
      statusItemsOf(receiverDone).find((item) => item.role === "RECEIVER")?.lifecycle.status,
    ).toBe("PROCESSED");
  });

  it("Correction 2. Stage 8→9 path: Incoming Y ahead of Check; Ban X/Y stay independent", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));
    const { ban, success } = await reachAcceptedSuccess(app);
    const replyY = bansOf(success).find((item) => item.id !== ban.id)!;
    expect(replyY).toBeTruthy();
    expect(replyY.acceptance).toBe("PENDING");
    expect(ban.id).not.toBe(replyY.id);

    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE"));
    await expireNow(now, app);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED"));

    await session(app.url, USER_A_TG);
    const firstOpen = await openNotifications(app, USER_A_TG);
    expect(firstOpen.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(
      itemsOf(firstOpen).some((item) => item.kind === "INCOMING_BAN" && item.banId === replyY.id),
    ).toBe(true);
    const afterY = await drainLeadingIncomingBans(app, USER_A_TG, firstOpen);
    expect(afterY.controlState).toBe("NOTIFICATIONS.CHECK.SENDER");
    expect(pairsOf(afterY)[0]?.banId).toBe(ban.id);
    expect(pairsOf(afterY)[0]?.banId).not.toBe(replyY.id);

    const done = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED"),
    );
    expect(pairsOf(done)[0]?.banId).toBe(ban.id);
    expect(pairsOf(done)[0]?.resultingStatus).toBe("BANTASTIC");
    const banX = bansOf(done).find((item) => item.id === ban.id)!;
    const banY = bansOf(done).find((item) => item.id === replyY.id)!;
    expect(banX.acceptance).toBe("ACCEPTED");
    expect(banX.status).toBe("BANTASTIC");
    expect(banY.acceptance).toBe("PENDING");
    expect(banY.status).toBe("OVERBOARD");
    expect(domainTimersOf(done).every((timer) => timer.banId === ban.id)).toBe(true);
    expect(domainTimersOf(done).every((timer) => timer.banId !== replyY.id)).toBe(true);
    expect(pairsOf(done).every((pair) => pair.banId === ban.id)).toBe(true);
  });

  it("E-22 marks Pair A CHECK_ANSWER applied so later Pair B CHECK.RECEIVER E-16 is not blocked", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));

    // Pair A: Ban1 A→B → Reply → Timer → Checks. A answers FIRST as CHECK.SENDER.
    await createRealIncomingFromA(app);
    await session(app.url, USER_B_TG);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"));
    requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_BAN_TEXT", { banText: REPLY_TEXT }),
    );
    requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_DURATION", {
        durationMinutes: REPLY_DURATION,
      }),
    );
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE"));
    now.value += DURATION_MS;
    await snapshot(app.url, USER_B_TG);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));

    await session(app.url, USER_A_TG);
    const onSender = await openNotificationsPastReplyIncoming(app, USER_A_TG);
    expect(onSender.controlState).toBe("NOTIFICATIONS.CHECK.SENDER");
    const pairACheckId = onSender.activeNotificationItemId;
    const pairAId = pairsOf(onSender)[0]?.id;
    expect(pairACheckId).toBeTruthy();
    expect(pairAId).toBeTruthy();

    const first = await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED");
    const afterFirst = requireDiagnostics(first);
    expect(first.orchestration?.serverEvent.eventName).toBe(
      "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
    );
    expect(pairsOf(afterFirst).find((pair) => pair.id === pairAId)?.senderAnswer).toBe("FULFILLED");
    expect(pairsOf(afterFirst).find((pair) => pair.id === pairAId)?.receiverAnswer).toBeNull();
    expect(pairsOf(afterFirst).find((pair) => pair.id === pairAId)?.resultingStatus).toBeNull();
    expect(
      checkItemsOf(afterFirst).find((item) => item.id === pairACheckId)?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(
      statusItemsOf(afterFirst).filter(
        (item) =>
          item.status === "BANTASTIC" ||
          item.status === "BANFLICT" ||
          item.status === "FAIR_ENOUGH",
      ),
    ).toHaveLength(0);
    const pairAOps = Object.values(afterFirst.pendingOperations).filter(
      (operation) =>
        operation.kind === "CHECK_ANSWER" && operation.originatingItemId === pairACheckId,
    );
    expect(pairAOps).toHaveLength(1);
    expect(pairAOps[0]?.resultApplied).toBe(true);
    expect(pairAOps[0]?.originatingState).toBe("NOTIFICATIONS.CHECK.SENDER");

    // Pair B: Ban2 B→A → Reply by A → Timer → A is CHECK.RECEIVER.
    await session(app.url, USER_B_TG);
    let bState = await snapshot(app.url, USER_B_TG);
    if (bState.controlState === "NOTIFICATIONS.CHECK.RECEIVER") {
      requireDiagnostics(
        await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED"),
      );
      bState = await snapshot(app.url, USER_B_TG);
    }
    while (
      bState.controlState?.startsWith("NOTIFICATIONS.STATUS") ||
      bState.controlState === "NOTIFICATIONS.TIMER" ||
      bState.controlState === "NOTIFICATIONS.INCOMING_BAN"
    ) {
      if (bState.controlState === "NOTIFICATIONS.INCOMING_BAN") {
        requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"));
      }
      requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
      bState = await snapshot(app.url, USER_B_TG);
    }
    if (bState.controlState === "RIM.LOBBY" || bState.controlState === null) {
      requireDiagnostics(await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_START"));
    }
    const contacts = (await snapshot(app.url, USER_B_TG)).contacts;
    const aId = contacts.find((contact) => contact.telegramUserId === USER_A_TG)?.userId;
    expect(aId).toBeTruthy();
    requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: aId }),
    );
    await dispatch(app.url, USER_B_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: "ban two" });
    await dispatch(app.url, USER_B_TG, "CREATE_BAN.CHANGE_DURATION", {
      durationMinutes: BAN_DURATION,
    });
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_NEXT"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "CREATE_BAN.PRESS_FORBID"));

    await session(app.url, USER_A_TG);
    let aState = await snapshot(app.url, USER_A_TG);
    if (aState.controlState === "RIM.LOBBY") {
      aState = requireDiagnostics(await dispatch(app.url, USER_A_TG, "RIM.PRESS_NOTIFICATIONS"));
    }
    while (
      aState.controlState?.startsWith("NOTIFICATIONS.STATUS") ||
      aState.controlState === "NOTIFICATIONS.INCOMING_BAN"
    ) {
      if (aState.controlState === "NOTIFICATIONS.INCOMING_BAN") {
        // Prefer Reply Ban so Ban2 is ACCEPTED and gets a Timer/Check.
        const reply = await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_REPLY_BAN");
        if (reply.httpStatus === 200 && reply.diagnostics?.controlState?.startsWith("REPLY_BAN")) {
          requireDiagnostics(
            await dispatch(app.url, USER_A_TG, "REPLY_BAN.CHANGE_BAN_TEXT", {
              banText: "reply two",
            }),
          );
          requireDiagnostics(
            await dispatch(app.url, USER_A_TG, "REPLY_BAN.CHANGE_DURATION", {
              durationMinutes: REPLY_DURATION,
            }),
          );
          requireDiagnostics(await dispatch(app.url, USER_A_TG, "REPLY_BAN.PRESS_NEXT"));
          requireDiagnostics(await dispatch(app.url, USER_A_TG, "REPLY_BAN.PRESS_FORBID"));
          requireDiagnostics(await dispatch(app.url, USER_A_TG, "REPLY_BAN.PRESS_FORBID_MORE"));
        } else {
          requireDiagnostics(await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_OVERBOARD"));
          requireDiagnostics(await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
        }
      } else {
        requireDiagnostics(await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
      }
      aState = await snapshot(app.url, USER_A_TG);
    }
    if (aState.controlState === "NOTIFICATIONS.TIMER") {
      requireDiagnostics(await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_TO_BANS"));
      aState = await snapshot(app.url, USER_A_TG);
    }
    now.value += DURATION_MS;
    aState = await snapshot(app.url, USER_A_TG);
    if (aState.controlState === "NOTIFICATIONS.TIMER") {
      aState = requireDiagnostics(
        await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
      );
    }
    if (aState.controlState === "RIM.LOBBY" || aState.controlState === null) {
      aState = requireDiagnostics(await dispatch(app.url, USER_A_TG, "RIM.PRESS_NOTIFICATIONS"));
    }
    while (aState.controlState?.startsWith("NOTIFICATIONS.STATUS")) {
      aState = requireDiagnostics(
        await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
      );
    }
    expect(aState.controlState).toBe("NOTIFICATIONS.CHECK.RECEIVER");
    expect(pairsOf(aState).length).toBeGreaterThanOrEqual(2);
    const pairBCheckId = aState.activeNotificationItemId;
    const pairBId = checkItemsOf(aState).find((item) => item.id === pairBCheckId)?.checkPairId;
    expect(pairBCheckId).toBeTruthy();
    expect(pairBId).toBeTruthy();
    expect(pairBId).not.toBe(pairAId);
    expect(pairBCheckId).not.toBe(pairACheckId);

    const stalePairA = Object.values(aState.pendingOperations).find(
      (operation) =>
        operation.kind === "CHECK_ANSWER" && operation.originatingItemId === pairACheckId,
    );
    expect(stalePairA?.resultApplied).toBe(true);
    expect(stalePairA?.originatingState).toBe("NOTIFICATIONS.CHECK.SENDER");

    const second = await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.CHECK_ANSWER.FULFILLED");
    const afterSecond = requireDiagnostics(second);
    expect(second.httpStatus).toBe(200);
    expect(afterSecond.kernelOutcome).toBe("APPLIED");
    expect(afterSecond.controlState).not.toBe("NOTIFICATIONS.CHECK.RECEIVER");
    expect(second.orchestration?.serverEvent.eventName).toMatch(
      /CHECK_ANSWER_CONFIRMED\.(FIRST|SECOND)/,
    );
    const pairBOps = Object.values(afterSecond.pendingOperations).filter(
      (operation) =>
        operation.kind === "CHECK_ANSWER" && operation.originatingItemId === pairBCheckId,
    );
    expect(pairBOps).toHaveLength(1);
    expect(pairBOps[0]?.originatingItemId).toBe(pairBCheckId);
    expect(pairBOps[0]?.originatingState).toBe("NOTIFICATIONS.CHECK.RECEIVER");
    expect(pairBOps[0]?.resultApplied).toBe(true);
    expect(
      Object.values(afterSecond.pendingOperations).some(
        (operation) =>
          operation.kind === "CHECK_ANSWER" &&
          operation.originatingItemId === pairACheckId &&
          !operation.resultApplied,
      ),
    ).toBe(false);
  });

  it("23. E-43 still uses Status Priority / Timer Priority / FIFO / Lobby", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));
    await reachTimer(app);
    const timer = await snapshot(app.url, USER_B_TG);
    expect(timer.controlState).toBe("NOTIFICATIONS.TIMER");
    expect(timer.priorities.timerItemId).toBe(timer.activeNotificationItemId);
    const toLobby = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
    );
    expect(toLobby.controlState).toBe("RIM.LOBBY");
  });

  it("24. OVERBOARD Ban never produces E-42 / CheckPair", async () => {
    const now = { value: AUTHORITATIVE_NOW };
    const app = await start(clockAt(now));
    await createRealIncomingFromA(app);
    await session(app.url, USER_B_TG);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
    const overboard = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_OVERBOARD"),
    );
    expect(overboard.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(domainTimersOf(overboard)).toEqual([]);
    now.value += DURATION_MS;
    const after = await snapshot(app.url, USER_B_TG);
    expect(pairsOf(after)).toEqual([]);
    expect(checkItemsOf(after)).toEqual([]);
  });

  it("transport rejects E-22 / E-23 / E-42 from TEST UI", async () => {
    const app = await start();
    await session(app.url, USER_B_TG);
    for (const name of [
      "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.FIRST",
      "NOTIFICATIONS.CHECK_ANSWER_CONFIRMED.SECOND",
      "BAN.DURATION_EXPIRED",
    ]) {
      const result = await dispatch(app.url, USER_B_TG, name);
      expect(result.httpStatus).toBe(400);
      expect(result.error?.code).toBe("SERVER_RESULT_NOT_ACCEPTED");
    }
  });
});
