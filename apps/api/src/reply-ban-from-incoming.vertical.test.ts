import { afterEach, describe, expect, it } from "vitest";
import { APPLICATION_STAGE } from "@98plus/application";
import {
  ABSENT_EVENT_IDS,
  CANONICAL_EVENT_COUNT,
  IMPLEMENTATION_STAGE,
  MATRIX_CONTRACT_ROWS,
  PRODUCT_CONTROL_STATE_COUNT,
  emptySnapshot,
  reduce,
  type CanonicalEvent,
  type DurationMinutes,
  type ProductSnapshot,
} from "@98plus/product-model";
import { IDENTITY_STAGE } from "@98plus/identity";
import { PERSISTENCE_STAGE } from "@98plus/persistence";
import {
  CREATE_BAN_CONTACT_STAGE,
  INCOMING_OVERBOARD_STAGE,
  REPLY_BAN_FROM_INCOMING_STAGE,
  STAGE_7_EXCLUDES,
  STAGE_8_EXCLUDES,
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
import {
  BAN_ID,
  INCOMING_ITEM_ID,
  OP_ID,
  OTHER_USER,
  REPLY_BAN_ID,
  USER_ID,
  defaultEvent,
  eventOf,
  incomingItem,
  kernelContext,
  makeBan,
  pendingOp,
  timerItem,
  withControlState,
  withEntities,
  withOperation,
} from "../../../packages/product-model/src/kernel.fixtures.ts";

const USER_A_TG = "1001";
const USER_B_TG = "1002";
const BAN_TEXT = "не пропускай зал";
const REPLY_TEXT = "ответный запрет";
const REPLY_DURATION = 15;
const DEV_SECRET = "test-secret";
const AUTHORITATIVE_NOW = 8_000_000;

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
  lifecycle: { status: string; display?: string };
};

type TimerJson = {
  id: string;
  banId: string;
  startedAt: number;
  durationMinutes: number;
  state: string;
};

function bansOf(diagnostics: TestUiDiagnostics): BanJson[] {
  return diagnostics.bans as BanJson[];
}

function incomingOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return diagnostics.incomingItems as NotificationJson[];
}

function itemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return diagnostics.notificationItems as NotificationJson[];
}

function timerItemsOf(diagnostics: TestUiDiagnostics): NotificationJson[] {
  return itemsOf(diagnostics).filter((item) => item.kind === "TIMER");
}

function domainTimersOf(diagnostics: TestUiDiagnostics): TimerJson[] {
  return diagnostics.domainTimers as TimerJson[];
}

async function createRealIncomingFromA(app: Started): Promise<{
  bId: string;
  ban: BanJson;
}> {
  await session(app.url, USER_A_TG);
  await session(app.url, USER_B_TG);
  grantContactBetweenTelegramUsers(app.runtime, USER_A_TG, USER_B_TG);
  const opened = await session(app.url, USER_A_TG);
  expect(opened.controlState).toBe("RIM.LOBBY");
  const who = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
  const listed = who.contacts.find((contact) => contact.telegramUserId === USER_B_TG);
  const bId = listed?.userId ?? userIdOf(app.runtime, USER_B_TG);
  expect(bId).toBeTruthy();
  requireDiagnostics(
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: bId }),
  );
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: BAN_TEXT });
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", { durationMinutes: 10 });
  requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
  const forbid = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
  const a = requireDiagnostics(forbid);
  expect(a.controlState).toBe("CREATE_BAN.SUCCESS");
  const created = bansOf(a);
  expect(created).toHaveLength(1);
  return { bId: bId!, ban: created[0]! };
}

async function openIncomingAsB(app: Started): Promise<{
  incoming: TestUiDiagnostics;
  incomingItem: NotificationJson;
}> {
  const lobby = await session(app.url, USER_B_TG);
  expect(lobby.controlState).toBe("RIM.LOBBY");
  const opened = requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
  const incomingItem = incomingOf(opened)[0];
  expect(incomingItem).toBeTruthy();
  return { incoming: opened, incomingItem: incomingItem! };
}

async function fillReplyDraft(
  url: string,
  options: { banText?: string; durationMinutes?: number; telegramUserId?: string } = {},
): Promise<TestUiDiagnostics> {
  const telegramUserId = options.telegramUserId ?? USER_B_TG;
  const banText = options.banText ?? REPLY_TEXT;
  const durationMinutes = options.durationMinutes ?? REPLY_DURATION;
  requireDiagnostics(await dispatch(url, telegramUserId, "REPLY_BAN.CHANGE_BAN_TEXT", { banText }));
  return requireDiagnostics(
    await dispatch(url, telegramUserId, "REPLY_BAN.CHANGE_DURATION", { durationMinutes }),
  );
}

async function createAnotherIncomingFromA(
  app: Started,
  options: { banText: string; durationMinutes: number },
): Promise<BanJson> {
  let a = await snapshot(app.url, USER_A_TG);
  if (a.controlState === "CREATE_BAN.SUCCESS") {
    a = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE"));
  }
  if (a.controlState !== "RIM.LOBBY") {
    a = await session(app.url, USER_A_TG);
  }
  expect(a.controlState).toBe("RIM.LOBBY");
  const who = requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_START"));
  const listed = who.contacts.find((contact) => contact.telegramUserId === USER_B_TG);
  const bId = listed?.userId ?? userIdOf(app.runtime, USER_B_TG);
  requireDiagnostics(
    await dispatch(app.url, USER_A_TG, "CREATE_BAN.SELECT_CONTACT", { contactId: bId }),
  );
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_BAN_TEXT", { banText: options.banText });
  await dispatch(app.url, USER_A_TG, "CREATE_BAN.CHANGE_DURATION", {
    durationMinutes: options.durationMinutes,
  });
  requireDiagnostics(await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_NEXT"));
  const forbid = await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID");
  const success = requireDiagnostics(forbid);
  expect(success.controlState).toBe("CREATE_BAN.SUCCESS");
  const created = bansOf(success).find((item) => item.banText === options.banText);
  expect(created).toBeTruthy();
  return created!;
}

async function reachReplyConfirm(app: Started): Promise<{
  ban: BanJson;
  incomingItem: NotificationJson;
  confirm: TestUiDiagnostics;
}> {
  const { ban } = await createRealIncomingFromA(app);
  const { incomingItem } = await openIncomingAsB(app);
  const what = requireDiagnostics(
    await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"),
  );
  expect(what.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
  expect(what.replyBanDraft).toEqual({ banText: "", durationMinutes: null });
  await fillReplyDraft(app.url);
  const confirm = requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
  expect(confirm.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
  return { ban, incomingItem, confirm };
}

function applied(snapshot: ProductSnapshot, event: CanonicalEvent) {
  return reduce(snapshot, event, kernelContext());
}

function replyConfirmWorld(): ProductSnapshot {
  const sourceItem = incomingItem({ lifecycle: { status: "UNPROCESSED", display: "ACTIVE" } });
  let snapshot = withControlState(emptySnapshot(), "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
  snapshot = withEntities(snapshot, {
    bans: {
      [BAN_ID]: makeBan({
        senderId: OTHER_USER,
        receiverId: USER_ID,
        acceptance: "PENDING",
        durationMinutes: 12 as DurationMinutes,
      }),
    },
    notificationItems: { [sourceItem.id]: sourceItem },
  });
  snapshot = {
    ...snapshot,
    extended: {
      ...snapshot.extended,
      activeNotificationItemId: sourceItem.id,
      replyBanDraft: { banText: "reply text", durationMinutes: 15 as DurationMinutes },
      replySource: { kind: "INCOMING_BAN", itemId: sourceItem.id, banId: BAN_ID },
    },
  };
  return withOperation(
    snapshot,
    pendingOp({
      kind: "REPLY_BAN_SEND",
      originatingState: "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN",
      originatingItemId: sourceItem.id,
    }),
  );
}

describe("Stage 8 Reply Ban FROM_INCOMING_BAN vertical", () => {
  it("keeps frozen 30 / 59 / 359 and adds REPLY_BAN_FROM_INCOMING_STAGE = 8 only", () => {
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
    expect(ABSENT_EVENT_IDS).toEqual(["E-36", "E-37", "E-38", "E-39", "E-40"]);
    expect(STAGE_7_EXCLUDES).toContain("reply-ban-from-incoming-ban");
    expect(STAGE_8_EXCLUDES).not.toContain("reply-ban-from-incoming-ban");
    expect(STAGE_8_EXCLUDES).toContain("reply-ban-from-status");
    expect(STAGE_8_EXCLUDES).toContain("timer-processing");
    expect(STAGE_8_EXCLUDES).toContain("check");
    expect(STAGE_8_EXCLUDES).toContain("external-entry");
  });

  it("A–G / I. real Incoming → E-14 → RB-01 → draft changes → valid E-26 → RB-02", async () => {
    const app = await start();
    const { ban } = await createRealIncomingFromA(app);
    const { incoming, incomingItem } = await openIncomingAsB(app);
    expect(incoming.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(incomingItem.lifecycle.status).toBe("UNPROCESSED");
    expect(bansOf(incoming)[0]?.id).toBe(ban.id);
    const what = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"),
    );
    expect(what.lastEvent).toEqual({ id: "E-14", name: "NOTIFICATIONS.PRESS_REPLY_BAN" });
    expect(what.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(what.replySource).toEqual({
      kind: "INCOMING_BAN",
      itemId: incomingItem.id,
      banId: ban.id,
    });
    expect(incomingOf(what).find((item) => item.id === incomingItem.id)?.lifecycle.status).toBe(
      "UNPROCESSED",
    );
    expect(bansOf(what)).toHaveLength(1);
    expect(domainTimersOf(what)).toEqual([]);
    const other = ban.senderId === what.currentUserId ? ban.receiverId : ban.senderId;
    expect(other).toBe(ban.senderId);
    const afterText = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_BAN_TEXT", { banText: REPLY_TEXT }),
    );
    expect(afterText.replyBanDraft?.banText).toBe(REPLY_TEXT);
    const afterDuration = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.CHANGE_DURATION", {
        durationMinutes: REPLY_DURATION,
      }),
    );
    expect(afterDuration.replyBanDraft?.durationMinutes).toBe(REPLY_DURATION);
    const confirm = requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    expect(confirm.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    expect(confirm.replyBanDraft).toEqual({
      banText: REPLY_TEXT,
      durationMinutes: REPLY_DURATION,
    });
  });

  it("H. invalid E-26 remains RB-01", async () => {
    const app = await start();
    await createRealIncomingFromA(app);
    await openIncomingAsB(app);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"));
    const invalid = requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    expect(invalid.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(invalid.matrixResult).toBe("IGNORE_NOT_ALLOWED");
  });

  it("J / K. RB-01 Back returns the exact source Incoming and deletes the reply draft", async () => {
    const app = await start();
    const { ban } = await createRealIncomingFromA(app);
    const { incomingItem } = await openIncomingAsB(app);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"));
    await fillReplyDraft(app.url);
    const back = requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_BACK"));
    expect(back.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(back.activeNotificationItemId).toBe(incomingItem.id);
    expect(back.replyBanDraft).toBeNull();
    expect(incomingOf(back).find((item) => item.id === incomingItem.id)?.lifecycle.status).toBe(
      "UNPROCESSED",
    );
    expect(bansOf(back).find((item) => item.id === ban.id)?.acceptance).toBe("PENDING");
    expect(domainTimersOf(back)).toEqual([]);
    expect(timerItemsOf(back)).toEqual([]);
    const again = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"),
    );
    expect(again.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(again.replySource?.itemId).toBe(incomingItem.id);
    expect(again.replyBanDraft).toEqual({ banText: "", durationMinutes: null });
  });

  it("L. RB-02 Back preserves the reply draft on RB-01", async () => {
    const app = await start();
    await reachReplyConfirm(app);
    const back = requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_BACK"));
    expect(back.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(back.replyBanDraft).toEqual({
      banText: REPLY_TEXT,
      durationMinutes: REPLY_DURATION,
    });
  });

  it("M–O / S–AF. E-28→E-30 creates one reply Ban, accepts original, starts original Timer, then E-29 → N-02", async () => {
    const runtime = createCreateBanContactRuntime({
      clock: { nowMs: () => AUTHORITATIVE_NOW },
    });
    const app = await start(runtime);
    const { ban, incomingItem, confirm } = await reachReplyConfirm(app);
    expect(domainTimersOf(confirm)).toEqual([]);
    expect(timerItemsOf(confirm)).toEqual([]);
    const forbid = await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
    const success = requireDiagnostics(forbid);
    expect(forbid.orchestration).not.toBeNull();
    expect(forbid.orchestration?.userEvent.eventName).toBe("REPLY_BAN.PRESS_FORBID");
    expect(forbid.orchestration?.serverEvent.eventName).toBe("REPLY_BAN.SEND_CONFIRMED");
    expect(success.previousEvent).toEqual({ id: "E-28", name: "REPLY_BAN.PRESS_FORBID" });
    expect(success.lastEvent).toEqual({ id: "E-30", name: "REPLY_BAN.SEND_CONFIRMED" });
    expect(success.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(success.replyBanDraft).toBeNull();
    const original = bansOf(success).find((item) => item.id === ban.id);
    const replies = bansOf(success).filter((item) => item.id !== ban.id);
    expect(replies).toHaveLength(1);
    const reply = replies[0]!;
    expect(reply.senderId).toBe(success.currentUserId);
    expect(reply.receiverId).toBe(ban.senderId);
    expect(reply.banText).toBe(REPLY_TEXT);
    expect(reply.durationMinutes).toBe(REPLY_DURATION);
    expect(reply.acceptance).toBe("PENDING");
    expect(original?.acceptance).toBe("ACCEPTED");
    expect(incomingOf(success).find((item) => item.id === incomingItem.id)?.lifecycle.status).toBe(
      "PROCESSED",
    );
    expect(timerItemsOf(success)).toHaveLength(1);
    expect(timerItemsOf(success)[0]?.banId).toBe(ban.id);
    expect(timerItemsOf(success)[0]?.lifecycle.status).toBe("UNPROCESSED");
    expect(success.priorities.timerItemId).toBe(timerItemsOf(success)[0]?.id);
    expect(success.activeNotificationItemId).not.toBe(timerItemsOf(success)[0]?.id);
    const timers = domainTimersOf(success);
    expect(timers).toHaveLength(1);
    expect(timers[0]?.banId).toBe(ban.id);
    expect(timers[0]?.durationMinutes).toBe(ban.durationMinutes);
    expect(timers[0]?.startedAt).toBe(AUTHORITATIVE_NOW);
    expect(timers[0]?.state).toBe("RUNNING");
    expect(
      itemsOf(success).filter(
        (item) =>
          item.kind === "INCOMING_BAN" &&
          item.banId === reply.id &&
          item.ownerId === success.currentUserId,
      ),
    ).toEqual([]);
    const toTimer = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE"),
    );
    expect(toTimer.controlState).toBe("NOTIFICATIONS.TIMER");
    expect(toTimer.activeNotificationItemId).toBe(timerItemsOf(toTimer)[0]?.id);
    expect(timerItemsOf(toTimer)[0]?.banId).toBe(ban.id);
    expect(toTimer.priorities.timerItemId).toBe(timerItemsOf(toTimer)[0]?.id);

    const reloadedB = await snapshot(app.url, USER_B_TG);
    expect(reloadedB.controlState).toBe("NOTIFICATIONS.TIMER");
    expect(reloadedB.replyBanDraft).toBeNull();
    expect(bansOf(reloadedB).find((item) => item.id === ban.id)?.acceptance).toBe("ACCEPTED");
    expect(domainTimersOf(reloadedB)[0]?.startedAt).toBe(AUTHORITATIVE_NOW);
    expect(domainTimersOf(reloadedB)[0]?.banId).toBe(ban.id);
    expect(timerItemsOf(reloadedB)).toHaveLength(1);
    expect(timerItemsOf(reloadedB)[0]?.banId).toBe(ban.id);
    expect(
      itemsOf(reloadedB).filter(
        (item) =>
          item.kind === "INCOMING_BAN" &&
          item.banId === reply.id &&
          item.ownerId === reloadedB.currentUserId,
      ),
    ).toEqual([]);

    const reloadedA = await snapshot(app.url, USER_A_TG);
    expect(bansOf(reloadedA).find((item) => item.id === ban.id)?.acceptance).toBe("ACCEPTED");
    expect(bansOf(reloadedA).some((item) => item.id === reply.id)).toBe(true);
    const replyForA = bansOf(reloadedA).find((item) => item.id === reply.id);
    expect(replyForA?.senderId).toBe(success.currentUserId);
    expect(replyForA?.receiverId).toBe(reloadedA.currentUserId);
    expect(replyForA?.acceptance).toBe("PENDING");
    expect(replyForA?.status).toBeNull();
    const replyIncoming = itemsOf(reloadedA).filter(
      (item) => item.kind === "INCOMING_BAN" && item.banId === reply.id,
    );
    expect(replyIncoming).toHaveLength(1);
    expect(replyIncoming[0]?.ownerId).toBe(reloadedA.currentUserId);
    expect(replyIncoming[0]?.banId).toBe(reply.id);
    expect(replyIncoming[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    expect(reloadedA.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(reloadedA.activeNotificationItemId).not.toBe(replyIncoming[0]?.id);
    expect(domainTimersOf(reloadedA)[0]?.banId).toBe(ban.id);
    expect(domainTimersOf(reloadedA).every((timer) => timer.banId !== reply.id)).toBe(true);
  });

  it("N / O. duplicate E-28 and Back are blocked while Reply Ban send is genuinely pending", async () => {
    const app = await start();
    await reachReplyConfirm(app);
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const press = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.PRESS_FORBID",
      payload: {},
    });
    expect(press.status).toBe("APPLIED");
    expect(press.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    const pending = Object.values(press.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "REPLY_BAN_SEND",
    );
    expect(pending?.resultApplied).toBe(false);
    const duplicate = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.PRESS_FORBID",
      payload: {},
    });
    expect(duplicate.status).not.toBe("APPLIED");
    const back = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.PRESS_BACK",
      payload: {},
    });
    expect(back.status).not.toBe("APPLIED");
    expect(back.snapshot.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
  });

  it("P–R. E-31 creates no Ban/Timer and retry E-28 works", async () => {
    const runtime = createCreateBanContactRuntime({ replyBanCompletion: "fail-once" });
    const app = await start(runtime);
    const { ban, incomingItem } = await reachReplyConfirm(app);
    const failed = await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
    const afterFail = requireDiagnostics(failed);
    expect(failed.orchestration?.serverEvent.eventName).toBe("REPLY_BAN.SEND_FAILED");
    expect(afterFail.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    expect(afterFail.replyBanDraft).toEqual({
      banText: REPLY_TEXT,
      durationMinutes: REPLY_DURATION,
    });
    expect(bansOf(afterFail)).toHaveLength(1);
    expect(bansOf(afterFail)[0]?.id).toBe(ban.id);
    expect(bansOf(afterFail)[0]?.acceptance).toBe("PENDING");
    expect(
      incomingOf(afterFail).find((item) => item.id === incomingItem.id)?.lifecycle.status,
    ).toBe("UNPROCESSED");
    expect(domainTimersOf(afterFail)).toEqual([]);
    expect(timerItemsOf(afterFail)).toEqual([]);
    const retry = await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
    const success = requireDiagnostics(retry);
    expect(retry.orchestration?.serverEvent.eventName).toBe("REPLY_BAN.SEND_CONFIRMED");
    expect(success.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(success.replyBanDraft).toBeNull();
    expect(bansOf(success)).toHaveLength(2);
  });

  it("AI. duplicate E-30 does not duplicate business facts", async () => {
    const app = await start();
    await reachReplyConfirm(app);
    const first = await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID");
    const success = requireDiagnostics(first);
    const operationId = first.orchestration?.userEvent.correlatedOperationId;
    expect(operationId).toBeTruthy();
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const duplicate = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.SEND_CONFIRMED",
      payload: {
        operationId,
        replyBanId: "ban-duplicate",
        source: success.replySource,
      },
    });
    expect(duplicate.outcome).not.toBe("APPLIED");
    expect(Object.keys(duplicate.snapshot.extended.entities.bans)).toHaveLength(2);
    expect(
      Object.values(duplicate.snapshot.extended.entities.notificationItems).filter(
        (item) => item.kind === "TIMER",
      ),
    ).toHaveLength(1);
    const replyBan = bansOf(success).find(
      (item) => item.senderId === success.currentUserId && item.banText === REPLY_TEXT,
    );
    expect(replyBan).toBeTruthy();
    const afterA = await snapshot(app.url, USER_A_TG);
    expect(
      itemsOf(afterA).filter((item) => item.kind === "INCOMING_BAN" && item.banId === replyBan!.id),
    ).toHaveLength(1);
    const afterB = await snapshot(app.url, USER_B_TG);
    expect(domainTimersOf(afterB)).toHaveLength(1);
    expect(timerItemsOf(afterB)).toHaveLength(1);
    expect(
      itemsOf(afterB).filter((item) => item.kind === "INCOMING_BAN" && item.banId === replyBan!.id),
    ).toEqual([]);
  });

  it("AJ–AL. stale attempt A cannot confirm or cancel attempt B", async () => {
    const app = await start();
    await reachReplyConfirm(app);
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const pressA = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.PRESS_FORBID",
      payload: {},
    });
    const opA = Object.values(pressA.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "REPLY_BAN_SEND",
    );
    const failedA = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.SEND_FAILED",
      payload: { operationId: opA!.operationId, failure: { code: "REPLY_BAN_SEND_FAILED" } },
    });
    expect(failedA.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    const pressB = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.PRESS_FORBID",
      payload: {},
    });
    const opB = Object.values(pressB.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "REPLY_BAN_SEND",
    );
    expect(opB?.operationId).not.toBe(opA?.operationId);
    const staleSuccess = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.SEND_CONFIRMED",
      payload: {
        operationId: opA!.operationId,
        replyBanId: "ban-stale-a",
        source: pressB.snapshot.extended.replySource,
      },
    });
    expect(staleSuccess.outcome).not.toBe("APPLIED");
    expect(staleSuccess.snapshot.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    const staleFailure = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.SEND_FAILED",
      payload: { operationId: opA!.operationId, failure: { code: "STALE" } },
    });
    expect(staleFailure.snapshot.runtime.pendingOperations[opB!.operationId]).toMatchObject({
      resultApplied: false,
    });
    const confirmedB = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.SEND_CONFIRMED",
      payload: {
        operationId: opB!.operationId,
        replyBanId: "ban-attempt-b",
        source: pressB.snapshot.extended.replySource,
      },
    });
    expect(confirmedB.status).toBe("APPLIED");
    expect(confirmedB.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(confirmedB.snapshot.extended.entities.bans["ban-attempt-b" as never]).toBeTruthy();
    expect(confirmedB.snapshot.extended.entities.bans["ban-stale-a" as never]).toBeUndefined();
  });

  it("AM. late E-30 after External Entry applies facts once without restoring RB-03", () => {
    const displaced = {
      ...replyConfirmWorld(),
      controlState: "NOTIFICATIONS.INCOMING_BAN" as const,
    };
    const late = withOperation(
      displaced,
      pendingOp({
        kind: "REPLY_BAN_SEND",
        originatingState: "REPLY_BAN.CONFIRM.FROM_INCOMING_BAN",
        originatingItemId: INCOMING_ITEM_ID,
        supersededByExternalEntry: true,
      }),
    );
    const result = applied(
      late,
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
      }),
    );
    expect(result.outcome).toBe("APPLIED");
    expect(result.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(result.snapshot.extended.replyBanDraft).toBeNull();
    expect(result.snapshot.extended.entities.bans[REPLY_BAN_ID]?.banText).toBe("reply text");
    expect(result.snapshot.extended.entities.bans[BAN_ID]?.acceptance).toBe("ACCEPTED");
    expect(result.snapshot.extended.priorities.timerItemId).toBeNull();
    expect(Object.values(result.snapshot.extended.entities.domainTimers)).toHaveLength(1);
    const replyIncoming = Object.values(result.snapshot.extended.entities.notificationItems).filter(
      (item) =>
        item.kind === "INCOMING_BAN" && item.banId === REPLY_BAN_ID && item.ownerId === OTHER_USER,
    );
    expect(replyIncoming).toHaveLength(1);
    expect(replyIncoming[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    expect(result.snapshot.extended.activeNotificationItemId).not.toBe(replyIncoming[0]?.id);
  });

  it("AN. late E-30 after APP.FULL_CLOSE keeps facts and does not restore Success UI", async () => {
    const app = await start();
    const { incomingItem } = await reachReplyConfirm(app);
    const success = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"),
    );
    expect(success.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const closed = await executeAuthenticatedEvent(app.runtime, context, {
      name: "APP.FULL_CLOSE",
      payload: {},
    });
    expect(closed.status).toBe("APPLIED");
    const timerItems = Object.values(closed.snapshot.extended.entities.notificationItems).filter(
      (item) => item.kind === "TIMER",
    );
    expect(timerItems.every((item) => item.lifecycle.status === "PROCESSED")).toBe(true);
    expect(Object.values(closed.snapshot.extended.entities.domainTimers)[0]?.state).toBe("RUNNING");
    expect(
      closed.snapshot.extended.entities.notificationItems[incomingItem.id]?.lifecycle.status,
    ).toBe("PROCESSED");
    expect(closed.snapshot.runtime.session).toBe("CLOSED");
    expect(closed.snapshot.extended.priorities.timerItemId).toBeNull();
    const persisted = await snapshot(app.url, USER_B_TG);
    expect(timerItemsOf(persisted).every((item) => item.lifecycle.status === "PROCESSED")).toBe(
      true,
    );
    expect(domainTimersOf(persisted)[0]?.state).toBe("RUNNING");
    expect(bansOf(persisted).some((item) => item.senderId === persisted.currentUserId)).toBe(true);
    expect(persisted.activeNotificationItemId).not.toBe(timerItems[0]?.id);
  });

  it("RB-02 FULL_CLOSE → late E-30 → APP.NORMAL_OPEN reaches RIM.LOBBY without restoring Reply Ban UI", async () => {
    const app = await start();
    const { incomingItem } = await reachReplyConfirm(app);
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const started = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.PRESS_FORBID",
      payload: {},
    });
    expect(started.status).toBe("APPLIED");
    expect(started.snapshot.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    expect(started.snapshot.runtime.session).toBe("ACTIVE");
    expect(started.snapshot.extended.replyBanDraft?.banText).toBe(REPLY_TEXT);
    const pending = Object.values(started.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "REPLY_BAN_SEND",
    );
    expect(pending?.resultApplied).toBe(false);
    expect(pending?.sendDraft?.banText).toBe(REPLY_TEXT);
    expect(pending?.sendDraft?.durationMinutes).toBe(REPLY_DURATION);

    const closed = await executeAuthenticatedEvent(app.runtime, context, {
      name: "APP.FULL_CLOSE",
      payload: {},
    });
    expect(closed.status).toBe("APPLIED");
    expect(closed.result).toBe("SESSION_END");
    expect(closed.snapshot.controlState).toBeNull();
    expect(closed.snapshot.runtime.session).toBe("CLOSED");
    expect(closed.snapshot.extended.replyBanDraft).toBeNull();
    expect(closed.snapshot.controlState).not.toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    expect(closed.snapshot.controlState).not.toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");

    const beforeLate = await app.runtime.productStore.loadProductSnapshot(context.currentUserId);
    expect(beforeLate.snapshot.controlState).toBeNull();
    expect(beforeLate.snapshot.extended.replyBanDraft).toBeNull();
    const reloadedPending = Object.values(beforeLate.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "REPLY_BAN_SEND",
    );
    expect(reloadedPending?.sendDraft?.banText).toBe(REPLY_TEXT);

    const late = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.SEND_CONFIRMED",
      payload: {
        operationId: reloadedPending?.operationId,
        replyBanId: "ban-reply",
        source: beforeLate.snapshot.extended.replySource,
      },
    });
    expect(late.status).toBe("APPLIED");
    expect(late.outcome).toBe("APPLIED");
    expect(late.snapshot.controlState).toBeNull();
    expect(late.snapshot.controlState).not.toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(late.snapshot.controlState).not.toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    expect(late.snapshot.extended.replyBanDraft).toBeNull();
    const replyBan = Object.values(late.snapshot.extended.entities.bans).find(
      (ban) => ban.banText === REPLY_TEXT,
    );
    const original = Object.values(late.snapshot.extended.entities.bans).find(
      (ban) => ban.banText === BAN_TEXT,
    );
    expect(replyBan).toBeTruthy();
    expect(original?.acceptance).toBe("ACCEPTED");
    expect(
      late.snapshot.extended.entities.notificationItems[incomingItem.id]?.lifecycle.status,
    ).toBe("PROCESSED");
    const timerItems = Object.values(late.snapshot.extended.entities.notificationItems).filter(
      (item) => item.kind === "TIMER",
    );
    expect(timerItems).toHaveLength(1);
    expect(timerItems[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    expect(late.snapshot.extended.priorities.timerItemId).toBeNull();
    expect(Object.values(late.snapshot.extended.entities.domainTimers)[0]?.state).toBe("RUNNING");
    expect(Object.values(late.snapshot.runtime.pendingOperations)).toHaveLength(0);

    const persisted = await app.runtime.productStore.loadProductSnapshot(context.currentUserId);
    expect(persisted.snapshot.controlState).toBeNull();
    expect(persisted.snapshot.extended.replyBanDraft).toBeNull();
    expect(persisted.snapshot.extended.entities.bans[replyBan!.id]?.banText).toBe(REPLY_TEXT);
    expect(persisted.snapshot.extended.entities.bans[original!.id]?.acceptance).toBe("ACCEPTED");
    expect(
      persisted.snapshot.extended.entities.notificationItems[timerItems[0]!.id]?.lifecycle,
    ).toEqual({ status: "UNPROCESSED", display: "WAITING" });

    const aContext = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_A_TG,
    });
    const persistedA = await app.runtime.productStore.loadProductSnapshot(aContext.currentUserId);
    const replyIncomingA = Object.values(
      persistedA.snapshot.extended.entities.notificationItems,
    ).filter((item) => item.kind === "INCOMING_BAN" && item.banId === replyBan!.id);
    expect(replyIncomingA).toHaveLength(1);
    expect(replyIncomingA[0]?.ownerId).toBe(aContext.currentUserId);
    expect(replyIncomingA[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    expect(persistedA.snapshot.controlState).toBe("CREATE_BAN.SUCCESS");
    expect(persistedA.snapshot.controlState).not.toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(persistedA.snapshot.extended.activeNotificationItemId).not.toBe(replyIncomingA[0]?.id);

    const opened = await executeAuthenticatedEvent(app.runtime, context, {
      name: "APP.NORMAL_OPEN",
      payload: { serverState: {} },
    });
    expect(opened.status).toBe("APPLIED");
    expect(opened.snapshot.controlState).toBe("RIM.LOBBY");
    expect(opened.snapshot.runtime.session).toBe("ACTIVE");
    expect(opened.snapshot.extended.replyBanDraft).toBeNull();
    expect(opened.snapshot.controlState).not.toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    expect(opened.snapshot.controlState).not.toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(opened.snapshot.controlState).not.toBe("NOTIFICATIONS.TIMER");
    expect(opened.snapshot.controlState).not.toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(
      Object.values(opened.snapshot.extended.entities.notificationItems).some(
        (item) => item.kind === "TIMER" && item.lifecycle.status === "UNPROCESSED",
      ),
    ).toBe(true);

    const staleIncomingId = incomingItem.id;
    expect(opened.snapshot.extended.replySource?.itemId).toBe(staleIncomingId);
    const replyFromLobby = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.PRESS_REPLY_BAN",
      payload: {},
    });
    expect(replyFromLobby.status).toBe("NOT_APPLIED");
    const notifications = await executeAuthenticatedEvent(app.runtime, context, {
      name: "RIM.PRESS_NOTIFICATIONS",
      payload: {},
    });
    expect(notifications.status).toBe("APPLIED");
    expect(notifications.snapshot.controlState).toBe("NOTIFICATIONS.TIMER");
    const timerId = Object.values(notifications.snapshot.extended.entities.notificationItems).find(
      (item) => item.kind === "TIMER",
    )?.id;
    expect(notifications.snapshot.extended.activeNotificationItemId).toBe(timerId);
    expect(notifications.snapshot.extended.activeNotificationItemId).not.toBe(staleIncomingId);
    expect(notifications.traces.some((trace) => trace.eventId === "E-43")).toBe(true);
  });

  it("FULL_CLOSE without late E-30 then NORMAL_OPEN does not leak the old Reply Ban draft into a new E-14", async () => {
    const app = await start();
    const { incomingItem } = await reachReplyConfirm(app);
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.PRESS_FORBID",
      payload: {},
    });
    await executeAuthenticatedEvent(app.runtime, context, {
      name: "APP.FULL_CLOSE",
      payload: {},
    });
    const opened = await executeAuthenticatedEvent(app.runtime, context, {
      name: "APP.NORMAL_OPEN",
      payload: { serverState: {} },
    });
    expect(opened.snapshot.controlState).toBe("RIM.LOBBY");
    expect(opened.snapshot.extended.replyBanDraft).toBeNull();
    const notifications = await executeAuthenticatedEvent(app.runtime, context, {
      name: "RIM.PRESS_NOTIFICATIONS",
      payload: {},
    });
    expect(notifications.snapshot.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(notifications.snapshot.extended.activeNotificationItemId).toBe(incomingItem.id);
    expect(notifications.traces.some((trace) => trace.eventId === "E-43")).toBe(true);
    const reply = await executeAuthenticatedEvent(app.runtime, context, {
      name: "NOTIFICATIONS.PRESS_REPLY_BAN",
      payload: {},
    });
    expect(reply.snapshot.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(reply.snapshot.extended.replySource).toEqual({
      kind: "INCOMING_BAN",
      itemId: incomingItem.id,
      banId: incomingItem.banId,
    });
    expect(reply.snapshot.extended.replyBanDraft).toEqual({
      banText: "",
      durationMinutes: null,
    });
  });

  it("AG / AH / source-Timer. E-29 follows replySource Ban Timer, not an unrelated Timer", () => {
    const confirmed = applied(
      replyConfirmWorld(),
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
      }),
    );
    const sourceTimer = Object.values(confirmed.snapshot.extended.entities.notificationItems).find(
      (item) => item.kind === "TIMER" && item.banId === BAN_ID,
    );
    expect(sourceTimer).toBeTruthy();
    expect(confirmed.snapshot.extended.replySource?.banId).toBe(BAN_ID);

    const timerA = timerItem({
      id: "timer-item-a" as never,
      banId: "ban-a" as never,
      fifoSequence: 0,
      lifecycle: { status: "UNPROCESSED", display: "WAITING" },
      domainTimerId: "timer-a" as never,
    });
    const withUnrelatedA: ProductSnapshot = {
      ...confirmed.snapshot,
      extended: {
        ...confirmed.snapshot.extended,
        entities: {
          ...confirmed.snapshot.extended.entities,
          notificationItems: {
            ...confirmed.snapshot.extended.entities.notificationItems,
            [timerA.id]: timerA,
          },
        },
      },
    };
    const stillB = applied(withUnrelatedA, defaultEvent("REPLY_BAN.PRESS_FORBID_MORE"));
    expect(stillB.outcome).toBe("APPLIED");
    expect(stillB.traces.map((trace) => `${trace.eventId}:${trace.branch}`)).toEqual([
      "E-29:timer-still-unprocessed",
    ]);
    expect(stillB.controlState).toBe("NOTIFICATIONS.TIMER");
    expect(stillB.snapshot.extended.activeNotificationItemId).toBe(sourceTimer?.id);
    expect(stillB.snapshot.extended.activeNotificationItemId).not.toBe(timerA.id);
    expect(stillB.snapshot.extended.priorities.timerItemId).toBe(sourceTimer?.id);

    const processedTimer = {
      ...confirmed.snapshot,
      extended: {
        ...confirmed.snapshot.extended,
        entities: {
          ...confirmed.snapshot.extended.entities,
          notificationItems: {
            ...confirmed.snapshot.extended.entities.notificationItems,
            [sourceTimer!.id]: { ...sourceTimer!, lifecycle: { status: "PROCESSED" as const } },
          },
        },
      },
    };
    const processedWithA: ProductSnapshot = {
      ...processedTimer,
      extended: {
        ...processedTimer.extended,
        entities: {
          ...processedTimer.extended.entities,
          notificationItems: {
            ...processedTimer.extended.entities.notificationItems,
            [timerA.id]: timerA,
          },
        },
      },
    };
    const viaE43 = applied(processedWithA, defaultEvent("REPLY_BAN.PRESS_FORBID_MORE"));
    expect(viaE43.traces.some((trace) => trace.branch === "timer-still-unprocessed")).toBe(false);
    expect(viaE43.traces.map((trace) => `${trace.eventId}:${trace.branch}`)).toEqual([
      "E-29:timer-processed-other-items",
      "E-43:fifo-timer",
    ]);
    expect(viaE43.controlState).toBe("NOTIFICATIONS.TIMER");
    expect(viaE43.snapshot.extended.activeNotificationItemId).toBe(timerA.id);
    expect(viaE43.snapshot.extended.priorities.timerItemId).toBe(sourceTimer?.id);
  });

  it("AG / AH. E-29 Timer processed branches use Notifications/E-43, not Reply Ban FIFO", () => {
    const confirmed = applied(
      replyConfirmWorld(),
      eventOf("REPLY_BAN.SEND_CONFIRMED", {
        operationId: OP_ID,
        replyBanId: REPLY_BAN_ID,
        source: { kind: "INCOMING_BAN", itemId: INCOMING_ITEM_ID, banId: BAN_ID },
      }),
    );
    const timer = Object.values(confirmed.snapshot.extended.entities.notificationItems).find(
      (item) => item.kind === "TIMER",
    );
    expect(timer).toBeTruthy();
    const processedTimer = {
      ...confirmed.snapshot,
      extended: {
        ...confirmed.snapshot.extended,
        entities: {
          ...confirmed.snapshot.extended.entities,
          notificationItems: {
            ...confirmed.snapshot.extended.entities.notificationItems,
            [timer!.id]: { ...timer!, lifecycle: { status: "PROCESSED" as const } },
          },
        },
      },
    };
    const empty = applied(processedTimer, defaultEvent("REPLY_BAN.PRESS_FORBID_MORE"));
    expect(empty.outcome).toBe("APPLIED");
    expect(empty.controlState).toBe("RIM.LOBBY");

    const extraIncoming = incomingItem({
      id: "incoming-extra" as never,
      fifoSequence: 99,
      lifecycle: { status: "UNPROCESSED", display: "WAITING" },
    });
    const withOther: ProductSnapshot = {
      ...processedTimer,
      extended: {
        ...processedTimer.extended,
        entities: {
          ...processedTimer.extended.entities,
          notificationItems: {
            ...processedTimer.extended.entities.notificationItems,
            [extraIncoming.id]: extraIncoming,
          },
        },
      },
    };
    const other = applied(withOther, defaultEvent("REPLY_BAN.PRESS_FORBID_MORE"));
    expect(other.outcome).toBe("APPLIED");
    expect(other.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(other.snapshot.extended.activeNotificationItemId).toBe(extraIncoming.id);
  });

  it("H continuation. failure persist/reload remains actionable on RB-02", async () => {
    const runtime = createCreateBanContactRuntime({ replyBanCompletion: "failure" });
    const app = await start(runtime);
    await reachReplyConfirm(app);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"));
    const reloaded = await snapshot(app.url, USER_B_TG);
    expect(reloaded.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    expect(reloaded.replyBanDraft?.banText).toBe(REPLY_TEXT);
  });

  it("Correction 2. receiver non-displacement: E-30 leaves User A controlState untouched", async () => {
    const app = await start();
    await createRealIncomingFromA(app);
    const beforeA = await snapshot(app.url, USER_A_TG);
    expect(beforeA.controlState).toBe("CREATE_BAN.SUCCESS");
    const beforeActive = beforeA.activeNotificationItemId;
    await session(app.url, USER_B_TG);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"));
    await fillReplyDraft(app.url);
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    const success = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"),
    );
    const reply = bansOf(success).find((item) => item.banText === REPLY_TEXT)!;
    const afterA = await snapshot(app.url, USER_A_TG);
    expect(afterA.controlState).toBe(beforeA.controlState);
    expect(afterA.activeNotificationItemId).toBe(beforeActive);
    const waiting = itemsOf(afterA).filter(
      (item) => item.kind === "INCOMING_BAN" && item.banId === reply.id,
    );
    expect(waiting).toHaveLength(1);
    expect(waiting[0]?.lifecycle).toEqual({ status: "UNPROCESSED", display: "WAITING" });
    expect(afterA.activeNotificationItemId).not.toBe(waiting[0]?.id);
    expect(afterA.priorities.timerItemId).not.toBe(waiting[0]?.id);
    expect(afterA.priorities.statusItemId).not.toBe(waiting[0]?.id);
  });

  it("Correction 2. reply-of-reply N-01: User A opens Incoming Y; E-15 applies", async () => {
    const app = await start();
    const { ban } = await reachReplyConfirm(app);
    const success = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"),
    );
    const reply = bansOf(success).find((item) => item.id !== ban.id)!;
    expect(reply).toBeTruthy();

    await session(app.url, USER_A_TG);
    let opened = await snapshot(app.url, USER_A_TG);
    if (opened.controlState === "CREATE_BAN.SUCCESS") {
      opened = requireDiagnostics(
        await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE"),
      );
    }
    if (opened.controlState === "RIM.LOBBY") {
      opened = requireDiagnostics(await dispatch(app.url, USER_A_TG, "RIM.PRESS_NOTIFICATIONS"));
    }
    expect(opened.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    const openedIncoming = itemsOf(opened).find(
      (item) => item.kind === "INCOMING_BAN" && item.banId === reply.id,
    );
    expect(openedIncoming).toBeTruthy();
    expect(opened.activeNotificationItemId).toBe(openedIncoming!.id);
    expect(bansOf(opened).find((item) => item.id === reply.id)?.acceptance).toBe("PENDING");

    const overboard = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_OVERBOARD"),
    );
    expect(overboard.controlState).toBe("NOTIFICATIONS.STATUS.OVERBOARD.RECEIVER");
    expect(overboard.previousEvent).toEqual({ id: "E-15", name: "NOTIFICATIONS.PRESS_OVERBOARD" });
    expect(overboard.lastEvent).toEqual({
      id: "E-20",
      name: "NOTIFICATIONS.OVERBOARD_CONFIRMED",
    });
  });

  it("Correction 2. reply-of-reply: User A E-14 from Incoming Y reaches RB-01", async () => {
    const app = await start();
    const { ban } = await reachReplyConfirm(app);
    const success = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"),
    );
    const reply = bansOf(success).find((item) => item.id !== ban.id)!;
    await session(app.url, USER_A_TG);
    let opened = await snapshot(app.url, USER_A_TG);
    if (opened.controlState === "CREATE_BAN.SUCCESS") {
      opened = requireDiagnostics(
        await dispatch(app.url, USER_A_TG, "CREATE_BAN.PRESS_FORBID_MORE"),
      );
    }
    if (opened.controlState === "RIM.LOBBY") {
      opened = requireDiagnostics(await dispatch(app.url, USER_A_TG, "RIM.PRESS_NOTIFICATIONS"));
    }
    expect(opened.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(opened.activeNotificationItemId).toBe(
      itemsOf(opened).find((item) => item.kind === "INCOMING_BAN" && item.banId === reply.id)?.id,
    );
    const what = requireDiagnostics(
      await dispatch(app.url, USER_A_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"),
    );
    expect(what.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(what.lastEvent).toEqual({ id: "E-14", name: "NOTIFICATIONS.PRESS_REPLY_BAN" });
    expect(what.replySource?.banId).toBe(reply.id);
    expect(what.replyBanDraft).toEqual({ banText: "", durationMinutes: null });
  });

  it("MVP7 Correction 2. persisted draft lifecycle: Flow A clear → reload → Incoming Y fresh → preserve/success", async () => {
    const runtime = createCreateBanContactRuntime({
      clock: { nowMs: () => AUTHORITATIVE_NOW },
    });
    const app = await start(runtime);

    const { ban: banX } = await createRealIncomingFromA(app);
    const banY = await createAnotherIncomingFromA(app, {
      banText: "source Ban Y",
      durationMinutes: 12,
    });
    expect(banY.id).not.toBe(banX.id);

    const { incomingItem: incomingX } = await openIncomingAsB(app);
    expect(incomingX.banId).toBe(banX.id);
    const whatA = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"),
    );
    expect(whatA.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(whatA.replyBanDraft).toEqual({ banText: "", durationMinutes: null });
    expect(whatA.replySource).toEqual({
      kind: "INCOMING_BAN",
      itemId: incomingX.id,
      banId: banX.id,
    });

    await fillReplyDraft(app.url, { banText: "reply A", durationMinutes: 3 });
    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    const successA = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"),
    );
    expect(successA.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(successA.replyBanDraft).toBeNull();
    expect(successA.replyBanDraft?.banText).not.toBe("reply A");
    const replyA = bansOf(successA).find((item) => item.banText === "reply A");
    expect(replyA).toBeTruthy();

    const reloadedAfterA = await snapshot(app.url, USER_B_TG);
    expect(reloadedAfterA.replyBanDraft).toBeNull();

    const asA = await snapshot(app.url, USER_A_TG);
    expect(asA.replyBanDraft).toBeNull();
    expect(
      itemsOf(asA).some((item) => item.kind === "INCOMING_BAN" && item.banId === replyA!.id),
    ).toBe(true);

    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID_MORE"));
    const afterTimer = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_TO_BANS"),
    );
    expect(afterTimer.controlState).toBe("NOTIFICATIONS.INCOMING_BAN");
    expect(afterTimer.activeNotificationItemId).toBeTruthy();
    const incomingY = itemsOf(afterTimer).find(
      (item) =>
        item.kind === "INCOMING_BAN" &&
        item.banId === banY.id &&
        item.id === afterTimer.activeNotificationItemId,
    );
    expect(incomingY).toBeTruthy();
    expect(incomingY!.lifecycle.status).toBe("UNPROCESSED");
    expect(incomingY!.id).not.toBe(incomingX.id);
    expect(incomingY!.banId).not.toBe(banX.id);

    const whatB = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"),
    );
    expect(whatB.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(whatB.replySource).toEqual({
      kind: "INCOMING_BAN",
      itemId: incomingY!.id,
      banId: banY.id,
    });
    expect(whatB.replyBanDraft).toEqual({ banText: "", durationMinutes: null });
    expect(whatB.replyBanDraft?.banText).not.toBe("reply A");
    expect(JSON.stringify(whatB.replyBanDraft)).not.toContain("reply A");
    expect(whatB.replyBanDraft?.durationMinutes).not.toBe(3);
    expect(itemsOf(whatB).find((item) => item.id === incomingY!.id)?.lifecycle.status).toBe(
      "UNPROCESSED",
    );

    await fillReplyDraft(app.url, { banText: "reply B", durationMinutes: 7 });
    const confirmB = requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    expect(confirmB.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    expect(confirmB.replyBanDraft).toEqual({ banText: "reply B", durationMinutes: 7 });
    const backSameFlow = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_BACK"),
    );
    expect(backSameFlow.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(backSameFlow.replyBanDraft).toEqual({ banText: "reply B", durationMinutes: 7 });

    requireDiagnostics(await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_NEXT"));
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    const startedB = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.PRESS_FORBID",
      payload: {},
    });
    expect(startedB.status).toBe("APPLIED");
    const pendingB = Object.values(startedB.snapshot.runtime.pendingOperations).find(
      (operation) => operation.kind === "REPLY_BAN_SEND" && !operation.resultApplied,
    );
    expect(pendingB).toBeTruthy();
    const failedB = await executeAuthenticatedEvent(app.runtime, context, {
      name: "REPLY_BAN.SEND_FAILED",
      payload: { operationId: pendingB!.operationId, failure: { code: "REPLY_BAN_SEND_FAILED" } },
    });
    expect(failedB.status).toBe("APPLIED");
    expect(failedB.controlState).toBe("REPLY_BAN.CONFIRM.FROM_INCOMING_BAN");
    expect(failedB.snapshot.extended.replyBanDraft).toEqual({
      banText: "reply B",
      durationMinutes: 7,
    });
    expect(
      Object.values(failedB.snapshot.extended.entities.bans).some(
        (item) => item.banText === "reply B",
      ),
    ).toBe(false);

    const successB = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "REPLY_BAN.PRESS_FORBID"),
    );
    expect(successB.controlState).toBe("REPLY_BAN.SUCCESS.FROM_INCOMING_BAN");
    expect(successB.replyBanDraft).toBeNull();
    expect(bansOf(successB).some((item) => item.banText === "reply B")).toBe(true);

    const reloadedAfterB = await snapshot(app.url, USER_B_TG);
    expect(reloadedAfterB.replyBanDraft).toBeNull();
    expect(JSON.stringify(reloadedAfterB.replyBanDraft)).not.toContain("reply B");
  });

  it("MVP7 Correction 2. FULL_CLOSE clears draft; later E-14 starts empty; TEST UI binds diagnostics.replyBanDraft", async () => {
    const app = await start();
    await reachReplyConfirm(app);
    const context = await authenticateRuntime(app.runtime, {
      method: "development",
      secret: DEV_SECRET,
      telegramUserId: USER_B_TG,
    });
    await executeAuthenticatedEvent(app.runtime, context, {
      name: "APP.FULL_CLOSE",
      payload: {},
    });
    const opened = await executeAuthenticatedEvent(app.runtime, context, {
      name: "APP.NORMAL_OPEN",
      payload: { serverState: {} },
    });
    expect(opened.snapshot.extended.replyBanDraft).toBeNull();
    const reloaded = await snapshot(app.url, USER_B_TG);
    expect(reloaded.replyBanDraft).toBeNull();
    if (reloaded.controlState === "RIM.LOBBY") {
      requireDiagnostics(await dispatch(app.url, USER_B_TG, "RIM.PRESS_NOTIFICATIONS"));
    }
    const again = requireDiagnostics(
      await dispatch(app.url, USER_B_TG, "NOTIFICATIONS.PRESS_REPLY_BAN"),
    );
    expect(again.controlState).toBe("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(again.replyBanDraft).toEqual({ banText: "", durationMinutes: null });

    const screens = await fetch(`${app.url}/test-ui/product-screens.js`);
    const source = await screens.text();
    expect(source).toContain("diagnostics.replyBanDraft");
    expect(source).toContain('data-change-event="REPLY_BAN.CHANGE_BAN_TEXT"');
    expect(source).not.toContain("localStorage");
  });

  it("X. transport rejects E-30 / E-31 / E-43 from TEST UI", async () => {
    const app = await start();
    await session(app.url, USER_B_TG);
    for (const name of [
      "REPLY_BAN.SEND_CONFIRMED",
      "REPLY_BAN.SEND_FAILED",
      "NOTIFICATIONS.SELECT_NEXT",
    ]) {
      const result = await dispatch(app.url, USER_B_TG, name);
      expect(result.httpStatus).toBe(400);
      expect(result.error?.code).toBe("SERVER_RESULT_NOT_ACCEPTED");
    }
  });

  it("AX / AY. Stage 8 still excludes FROM_STATUS; Stage 10 registers FROM_STATUS screens", async () => {
    const app = await start();
    const meta = await fetch(`${app.url}/api/meta`);
    const body = (await meta.json()) as {
      REPLY_BAN_FROM_INCOMING_STAGE: number;
      TIMER_CHECK_STATUS_STAGE: number;
      REPLY_BAN_FROM_STATUS_STAGE: number;
      STAGE_8_EXCLUDES: readonly string[];
      STAGE_9_EXCLUDES: readonly string[];
      STAGE_10_EXCLUDES: readonly string[];
    };
    expect(body.REPLY_BAN_FROM_INCOMING_STAGE).toBe(8);
    expect(body.TIMER_CHECK_STATUS_STAGE).toBe(9);
    expect(body.REPLY_BAN_FROM_STATUS_STAGE).toBe(10);
    expect(body.STAGE_8_EXCLUDES).toEqual(
      expect.arrayContaining(["reply-ban-from-status", "timer-processing", "check"]),
    );
    expect(body.STAGE_9_EXCLUDES).toEqual(expect.arrayContaining(["reply-ban-from-status"]));
    expect(body.STAGE_9_EXCLUDES).not.toContain("timer-processing");
    expect(body.STAGE_9_EXCLUDES).not.toContain("check");
    expect(body.STAGE_10_EXCLUDES).not.toContain("reply-ban-from-status");
    const screens = await fetch(`${app.url}/test-ui/product-screens.js`);
    const source = await screens.text();
    expect(source).toContain("REPLY_BAN.WHAT.FROM_INCOMING_BAN");
    expect(source).toContain("REPLY_BAN.WHAT.FROM_STATUS");
    expect(source).toContain("PRESS_BAN_MORE");
    expect(source).toContain("NOTIFICATIONS.CHECK.RECEIVER");
    expect(source).toContain("NOTIFICATIONS.PRESS_TO_BANS");
    expect(source).not.toContain("Timer processing is deferred (Stage 9)");
  });
});
